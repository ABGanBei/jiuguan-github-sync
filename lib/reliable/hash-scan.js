'use strict';
/**
 * 内容哈希与扫描：逐文件 SHA-256（原字节）+ 路径安全校验 + chats/**\/*.jsonl 枚举。
 *
 * 职责边界（合同第 13/15 条；P1 第 2/9/11/13 项）：
 * - 哈希按文件原始字节计算（SHA-256 hex），与 Git object id 无关，用于三向比较；
 * - 只扫描 `chats/` 下的普通 .jsonl 文件，拒绝符号链接、junction、目录越界、反斜杠路径、NUL；
 * - bytes 与 hash 必须来自同一次 read：hashFile 直接返回 buf，scanLocal(keepBytes) 不再二次读；
 * - 校验数据根及其所有祖先（含 dataRoot 自身）不是 symlink/junction/其他 reparse point，
 *   拒绝 Windows 保留设备名段与同目录大小写不敏感碰撞（防止误写聊天）；
 * - 数据根缺失 / 扫描失败 / 路径不安全 → 抛阻断异常，绝不当作「空目录」。
 */
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

/** 阻断异常：带 code，便于 CLI/测试识别「扫描失败」与「路径不安全」。 */
class ScanError extends Error {
    constructor(message, code = 'SCAN_ERROR') {
        super(message);
        this.name = 'ScanError';
        this.code = code;
    }
}

/** Windows 保留设备名（任意扩展名均保留），拒绝作为路径段。
 *  含上标 ¹/²/³（U+00B9/00B2/00B3）——Windows 会把 COM¹ 等归一为 COM1 设备名，必须一并拒绝。 */
const WINDOWS_RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/i;
/** 段内冒号（Windows alternate data stream，如 `file.jsonl:stream`），一律拒绝。 */
const WINDOWS_ADS_COLON = /:/;
/** 尾随空格/点（Windows 无法作为真实目录项，且易别名混淆）。 */
const WINDOWS_TRAILING = /[ .]$/;
/** 段内 Windows 非法字符 `<>"|?*`（不能在文件名中出现）。 */
const WINDOWS_ILLEGAL_CHARS = /[<>"|?*]/;
/** 段内控制字符 0x01–0x1F（NUL 已在前置整体检查单独处理）。 */
const WINDOWS_CONTROL_CHARS = /[\u0001-\u001f]/;

/**
 * 判断一个路径段是否为 Windows 保留设备名（含「设备名.扩展名」形式，如 CON.jsonl / NUL.txt / COM1.jsonl）。
 * Windows 对 `CON`、`CON.txt`、`CON.foo.bar` 等一律解析为设备，任何扩展名都不能使其成为普通文件。
 */
function isWindowsReservedSegment(seg) {
    if (WINDOWS_RESERVED_BASENAME.test(seg)) return true;
    // 设备名后跟一个或多个点+扩展名：把第一个 `.` 之前的部分取出来判断。
    const dot = seg.indexOf('.');
    if (dot > 0) {
        const base = seg.slice(0, dot);
        if (WINDOWS_RESERVED_BASENAME.test(base)) return true;
    }
    return false;
}

/**
 * 逐段前缀大小写不敏感（casefold）碰撞检测。
 *
 * 在 Windows / 大小写不敏感文件系统上，两个路径若在「某个前缀段」上仅大小写不同，检出时会指向同一目录项，
 * 造成覆盖。不仅限于同目录 basename 碰撞（`A.jsonl` vs `a.jsonl`），还包括祖先目录别名
 * （`chats/Actor/a.jsonl` vs `chats/actor/a.jsonl`，`Actor` 与 `actor` 是同一目录）。
 *
 * 算法：对每条路径的**每个前缀**（逐段累积）做 `toLowerCase()` 折叠；若某 casefold 前缀已被另一条
 * **不同原始拼写**的前缀占用，即视为碰撞。这等价于「任何同一 casefold 前缀存在两种拼写 → 拒绝」。
 *
 * @param {Iterable<string>} rels  形如 `chats/A/x.jsonl` 的 posix 相对路径
 * @returns {{a: string, b: string}|null} 命中碰撞时返回冲突的原始前缀对；否则 null。
 *          纯函数，不抛错，由调用方决定抛何种错误（供 git-tree / planner 复用，避免循环依赖）。
 */
function findCasefoldCollision(rels) {
    const seen = new Map(); // casefold 前缀 -> 原始前缀
    for (const rel of rels) {
        const segs = rel.split('/');
        let prefix = '';
        let foldPrefix = '';
        for (let i = 0; i < segs.length; i++) {
            const seg = segs[i];
            prefix = i === 0 ? seg : `${prefix}/${seg}`;
            const foldSeg = seg.toLowerCase();
            foldPrefix = i === 0 ? foldSeg : `${foldPrefix}/${foldSeg}`;
            const prev = seen.get(foldPrefix);
            if (prev !== undefined && prev !== prefix) {
                return { a: prev, b: prefix };
            }
            seen.set(foldPrefix, prefix);
        }
    }
    return null;
}

function isReparsePoint(st) {
    // 不要用 mode/ino 位标志判断 reparse —— Windows 上 Node 的 ino 是文件索引哈希，不是属性标志，
    // 会产生大量误报（普通目录也可能带 0x1000 位），导致数据根祖先被误判为链接。
    return !!(st && typeof st.isSymbolicLink === 'function' && st.isSymbolicLink());
}

/**
 * 校验一个「相对路径」（POSIX 风格，斜杠分隔）是否安全，可作为 chats 下的子路径。
 * 拒绝：空、绝对路径、含 `..` 段、反斜杠、NUL、前导 `/`、盘符（`X:`）、
 *       空段、尾随 `.`（段内多点为非安全 Unicode 别名）、Windows 保留名（含「设备名.扩展名」如 CON.jsonl/NUL.txt/COM1.jsonl）、
 *       段内冒号（ADS 备用数据流）、尾随空格/点。
 * @param {string} rel
 * @returns {string} 归一化后的 posix 相对路径（去除前导 ./）
 */
function assertSafeRel(rel) {
    if (typeof rel !== 'string' || rel.length === 0) {
        throw new ScanError('非法相对路径：空路径', 'UNSAFE_PATH');
    }
    if (rel.indexOf('\0') !== -1) {
        throw new ScanError('非法相对路径：含 NUL 字符', 'UNSAFE_PATH');
    }
    if (rel.indexOf('\\') !== -1) {
        throw new ScanError(`非法相对路径：含反斜杠（Windows 风格分隔符）: ${rel}`, 'UNSAFE_PATH');
    }
    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) {
        throw new ScanError(`非法相对路径：绝对路径或盘符: ${rel}`, 'UNSAFE_PATH');
    }
    const segments = rel.split('/');
    const clean = [];
    for (const seg of segments) {
        if (seg === '' || seg === '.') {
            throw new ScanError(`非法相对路径：含空段或 "." 段: ${rel}`, 'UNSAFE_PATH');
        }
        if (seg === '..') {
            throw new ScanError(`非法相对路径：包含 .. 越界段: ${rel}`, 'UNSAFE_PATH');
        }
        if (seg !== '.' && seg.includes('..')) {
            throw new ScanError(`非法相对路径：段内含多点为不安全别名: ${rel}`, 'UNSAFE_PATH');
        }
        if (isWindowsReservedSegment(seg)) {
            throw new ScanError(`非法相对路径：Windows 保留设备名段（含设备名.扩展名）: ${rel}`, 'UNSAFE_PATH');
        }
        if (WINDOWS_ADS_COLON.test(seg)) {
            throw new ScanError(`非法相对路径：段含冒号（Windows 备用数据流）: ${rel}`, 'UNSAFE_PATH');
        }
        if (WINDOWS_TRAILING.test(seg)) {
            throw new ScanError(`非法相对路径：段尾含空格或点（Windows 别名风险）: ${rel}`, 'UNSAFE_PATH');
        }
        if (WINDOWS_ILLEGAL_CHARS.test(seg)) {
            throw new ScanError(`非法相对路径：段含 Windows 非法字符（<>"|?*）: ${rel}`, 'UNSAFE_PATH');
        }
        if (WINDOWS_CONTROL_CHARS.test(seg)) {
            throw new ScanError(`非法相对路径：段含控制字符（0x01-0x1F）: ${rel}`, 'UNSAFE_PATH');
        }
        clean.push(seg);
    }
    if (clean.length === 0) {
        throw new ScanError('非法相对路径：归一化后为空', 'UNSAFE_PATH');
    }
    return clean.join('/');
}

/** 把 chats 下的相对路径解析为数据根下的绝对路径，并做越界二次校验。 */
function resolveUnderDataRoot(stDataRoot, rel) {
    const clean = assertSafeRel(rel);
    const absRoot = path.resolve(stDataRoot);
    const abs = path.resolve(absRoot, clean);
    if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) {
        throw new ScanError(`路径越界已拒绝: ${rel}`, 'UNSAFE_PATH');
    }
    return abs;
}

/**
 * 校验数据根及其所有祖先（含 dataRoot 自身）不是 symlink/junction/其他 reparse point。
 * 任一祖先缺失 → 阻断（不得把数据根缺失当空目录）。
 */
async function assertDataRootReal(stDataRoot) {
    const absRoot = path.resolve(stDataRoot);
    const parts = path.parse(absRoot).root;
    // 从根开始逐段累积，校验到 dataRoot 为止的每一段都是真实目录（非 reparse）。
    const relSegs = absRoot.slice(parts.length).split(path.sep).filter(s => s !== '');
    let cur = parts;
    for (let i = 0; i < relSegs.length; i++) {
        cur = path.join(cur, relSegs[i]);
        let st;
        try {
            st = await fs.lstat(cur);
        } catch (e) {
            throw new ScanError(`数据根或其祖先缺失或不可读: ${cur}: ${e.message}`, 'CHATS_MISSING');
        }
        if (isReparsePoint(st)) {
            throw new ScanError(`数据根或其祖先是不安全的链接（symlink/junction）: ${cur}`, 'SYMLINK_REJECTED');
        }
        if (st.isSymbolicLink()) {
            throw new ScanError(`数据根或其祖先是符号链接，已拒绝: ${cur}`, 'SYMLINK_REJECTED');
        }
        if (!st.isDirectory()) {
            throw new ScanError(`数据根或其祖先不是目录: ${cur}`, 'CHATS_MISSING');
        }
    }
    return absRoot;
}

/**
 * 读取单文件原始字节并返回 { hash, size, buf }。
 * bytes 与 hash 来自同一次 read（P1 第 4 项）。符号链接 / junction / 非普通文件 → 阻断。
 * @param {string} absPath
 * @returns {Promise<{hash: string, size: number, buf: Buffer}>}
 */
async function hashFile(absPath) {
    const st = await fs.lstat(absPath);
    if (st.isSymbolicLink() || isReparsePoint(st)) {
        throw new ScanError(`拒绝符号链接/junction: ${absPath}`, 'SYMLINK_REJECTED');
    }
    if (!st.isFile()) {
        throw new ScanError(`拒绝非普通文件: ${absPath}`, 'NOT_REGULAR_FILE');
    }
    const buf = await fs.readFile(absPath);
    return { hash: sha256Buffer(buf), size: buf.length, buf };
}

function sha256Buffer(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 校验 JSONL：UTF-8 合法，且每个非空行都是合法 JSON。不重序列化、不改字节。
 * @param {Buffer} buf
 */
function assertValidJsonlBytes(buf, rel) {
    // UTF-8 合法性：strict decode 抛错则拒绝
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (e) {
        throw new ScanError(`JSONL 非合法 UTF-8: ${rel}: ${e.message}`, 'INVALID_UTF8');
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '') continue;
        try {
            JSON.parse(line);
        } catch (e) {
            throw new ScanError(`JSONL 第 ${i + 1} 行非法 JSON: ${rel}: ${e.message}`, 'INVALID_JSONL');
        }
    }
}

/**
 * 枚举数据根下 chats/**\/*.jsonl 文件。
 * - 只返回「普通文件」；目录内符号链接、junction、异常 mode 一律阻断（不跳过）。
 * - 数据根或 chats 目录缺失 → 阻断（不得当空目录）。
 * - 逐目录检测大小写不敏感同名校验（Windows 大小写碰撞），不提前拦截（需真实目录项）。
 * @param {string} stDataRoot
 * @returns {Promise<Array<{rel: string, absPath: string}>>}
 */
async function listChatJsonl(stDataRoot) {
    await assertDataRootReal(stDataRoot);
    const absRoot = path.resolve(stDataRoot);
    const chatsDir = path.join(absRoot, 'chats');

    let chatsStat;
    try {
        chatsStat = await fs.lstat(chatsDir);
    } catch (e) {
        throw new ScanError(`chats 目录缺失或不可读: ${chatsDir}`, 'CHATS_MISSING');
    }
    if (chatsStat.isSymbolicLink() || isReparsePoint(chatsStat)) {
        throw new ScanError(`chats 目录是符号链接/junction，已拒绝: ${chatsDir}`, 'SYMLINK_REJECTED');
    }
    if (!chatsStat.isDirectory()) {
        throw new ScanError(`chats 不是目录: ${chatsDir}`, 'CHATS_MISSING');
    }

    const result = [];
    async function walk(dirAbs, relPrefix) {
        let entries;
        try {
            entries = await fs.readdir(dirAbs, { withFileTypes: true });
        } catch (e) {
            throw new ScanError(`扫描失败: ${dirAbs}: ${e.message}`, 'SCAN_ERROR');
        }
        // 大小写不敏感碰撞检测（Windows 下 A.jsonl 与 a.jsonl 会指向同一文件）。
        const seenFold = new Map();
        for (const e of entries) {
            const fold = e.name.toLowerCase();
            if (seenFold.has(fold)) {
                throw new ScanError(`同目录大小写不敏感碰撞: ${seenFold.get(fold)} vs ${e.name}`, 'UNSAFE_PATH');
            }
            seenFold.set(fold, e.name);
        }
        // 稳定排序，保证跨平台可复现
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const abs = path.join(dirAbs, entry.name);
            const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
            // junction/symlink 可能不体现在 isSymbolicLink()，需再查 reparse 标志。
            if (entry.isSymbolicLink() || isReparsePoint(entry)) {
                throw new ScanError(`拒绝符号链接/junction: ${rel}`, 'SYMLINK_REJECTED');
            }
            if (entry.isDirectory()) {
                await walk(abs, rel);
            } else if (entry.isFile()) {
                if (!entry.name.endsWith('.jsonl')) continue;
                result.push({ rel, absPath: abs });
            } else {
                // socket / fifo / device 等非常规项
                throw new ScanError(`拒绝非常规文件类型: ${rel}`, 'NOT_REGULAR_FILE');
            }
        }
    }
    // rel 统一含 `chats/` 前缀，与 remoteHashesAt 的 ls-tree 结果一致
    await walk(chatsDir, 'chats');

    // 逐文件 lstat 确认普通文件（非 symlink/junction），配合 hashFile 一次读。
    const out = [];
    for (const item of result) {
        const st = await fs.lstat(item.absPath);
        if (st.isSymbolicLink() || isReparsePoint(st)) {
            throw new ScanError(`拒绝符号链接/junction: ${item.rel}`, 'SYMLINK_REJECTED');
        }
        if (!st.isFile()) {
            throw new ScanError(`拒绝非普通文件: ${item.rel}`, 'NOT_REGULAR_FILE');
        }
        out.push(item);
    }
    return out;
}

/**
 * 扫描并返回 { rel -> {hash, size, bytes?} } 映射。默认不保留 bytes（省内存）。
 * keepBytes=true 时 bytes 与 hash 来自同一次 read（不二次读）。
 * @param {string} stDataRoot
 * @param {{keepBytes?: boolean}} [opts]
 * @returns {Promise<Map<string, {hash: string, size: number, bytes?: Buffer}>>}
 */
async function scanLocal(stDataRoot, opts = {}) {
    const files = await listChatJsonl(stDataRoot);
    const map = new Map();
    for (const f of files) {
        const { hash, size, buf } = await hashFile(f.absPath);
        const entry = { hash, size };
        if (opts.keepBytes) {
            entry.bytes = buf;
        }
        map.set(f.rel, entry);
    }
    return map;
}

module.exports = {
    ScanError,
    assertSafeRel,
    resolveUnderDataRoot,
    hashFile,
    sha256Buffer,
    assertValidJsonlBytes,
    listChatJsonl,
    scanLocal,
    assertDataRootReal,
    isReparsePoint,
    isWindowsReservedSegment,
    findCasefoldCollision,
};

'use strict';
/**
 * 安装器 · 文件系统安全原语（无状态、纯函数）。
 *
 * 设计要点：
 *  - 所有路径先经 `safeResolve` / `safeFile`：逐段 lstat 校验祖先链，拒绝 symlink/junction。
 *    * `safeResolve`   最终节点必须是「已存在或无」的**目录**（用于目标目录、工作区）。
 *    * `safeFile`      祖先必须是真实目录、最终节点必须是**普通文件**（用于 config / journal / 备份 / 记录）。
 *  - 任何写操作只用「appDir 内按固定相对名推导」的路径；**journal 里的绝对路径一律不信任**。
 *  - 内容比较使用「相对路径 → sha256」稳定映射；链接/特殊文件以哨兵值参与比较（必然不等）。
 *  - 读 JSON 区分「不存在」（null）与「损坏/不可读」（抛 EACCES 等）——绝不把损坏吞成默认值。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const installer = require('../../bin/install-plugin.js');

const { InstallError, safeMkdirChain } = installer;

// 参与内容哈希时的特殊条目哨兵（真实文件的 sha256 为 64 位 hex，不会与之相等）。
const SENTINEL = {
    LINK: '@link',
    DIR: '@dir',
    OTHER: '@other',
};

/** lstat（不存在返回 null；其它错误**抛出**，不吞 EACCES/EIO 等）。 */
function lstatOrNull(p) {
    try {
        return fs.lstatSync(p);
    } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
        throw e;
    }
}

/** 是否链接（symlink / junction / reparse point）。把判定委托给安装器的同一实现。 */
function isLink(p) {
    return installer.isLink(p);
}

/** 判定路径自身是否为链接/reparse point（lstat 语义，用于「目录内容映射」）。 */
function isSelfLink(p) {
    const st = lstatOrNull(p);
    return !!(st && st.isSymbolicLink());
}

/** 是否存在（不跟随链接）。不存在返回 false；其它读取错误抛出（fail-closed）。 */
function exists(p) {
    return lstatOrNull(p) !== null;
}

/** 单个路径段必须是真实目录且非链接；`cur === abs` 时由调用方决定最终节点类型。 */
function assertRealDirSegment(cur, label) {
    const st = lstatOrNull(cur);
    if (!st) return null;
    if (st.isSymbolicLink()) {
        throw new InstallError('LINK_REJECTED', `路径含符号链接/junction（拒绝）: ${cur}${label ? ` [${label}]` : ''}`);
    }
    if (isLink(cur)) {
        // Windows junction：lstat 看似目录，实际指向别处（跟随链接的 stat 与 lstat 不一致）。
        throw new InstallError('LINK_REJECTED', `路径是 junction/重解析点（拒绝）: ${cur}${label ? ` [${label}]` : ''}`);
    }
    return st;
}

/**
 * 安全解析路径：从盘根到 base 的每个「已存在段」必须是真实目录（非链接），
 * 最终节点若存在也必须是目录（不存在则由后续 safeMkdirChain 逐段创建并复核）。
 * @param {string} base 绝对路径
 * @param {string} [label]
 * @returns {string} path.resolve(base)
 */
function safeResolve(base, label) {
    const abs = path.resolve(base);
    const rel = path.relative(path.parse(abs).root, abs);
    const segs = rel ? rel.split(path.sep).filter(Boolean) : [];
    let cur = path.parse(abs).root;
    for (const seg of segs) {
        cur = path.join(cur, seg);
        const st = assertRealDirSegment(cur, label);
        if (!st) break; // 剩余段均不存在：已校验的祖先都是真实目录
        if (!st.isDirectory()) {
            throw new InstallError(
                'NOT_DIRECTORY',
                cur === abs
                    ? `目标已存在但不是目录（拒绝）: ${cur}${label ? ` [${label}]` : ''}`
                    : `路径段不是目录（拒绝）: ${cur}${label ? ` [${label}]` : ''}`
            );
        }
    }
    return abs;
}

/**
 * 安全解析「文件」路径：祖先链（不含最终节点）必须是真实目录、非链接；
 * 最终节点**必须已存在**且是普通文件（isFile 且 !isSymbolicLink）。用于 config / journal / 备份 / 记录。
 * @param {string} file 绝对路径
 * @param {string} [label]
 * @returns {string}
 */
function safeFile(file, label) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) {
        throw new InstallError('PATH_INVALID', `需要绝对路径（拒绝）: ${file}${label ? ` [${label}]` : ''}`);
    }
    const abs = path.resolve(file);
    const root = path.parse(abs).root;
    if (abs === root) throw new InstallError('PATH_INVALID', `不能是盘根（拒绝）: ${abs}`);
    const segs = path.relative(root, abs).split(path.sep).filter(Boolean);
    let cur = root;
    for (let i = 0; i < segs.length; i++) {
        cur = path.join(cur, segs[i]);
        const last = i === segs.length - 1;
        const st = assertRealDirSegment(cur, label);
        if (!st) {
            if (last) {
                throw new InstallError('FILE_MISSING', `文件不存在（拒绝继续）: ${abs}${label ? ` [${label}]` : ''}`);
            }
            // 祖先缺失 → 最终文件必然不存在。
            throw new InstallError('FILE_MISSING', `文件不存在（祖先目录缺失）: ${abs}${label ? ` [${label}]` : ''}`);
        }
        if (last) {
            if (!st.isFile()) {
                throw new InstallError(
                    'NOT_REGULAR_FILE',
                    `不是普通文件（目录/设备/套接字均拒绝）: ${abs}${label ? ` [${label}]` : ''}`
                );
            }
        } else if (!st.isDirectory()) {
            throw new InstallError('PATH_INVALID', `路径段不是目录（拒绝）: ${cur}${label ? ` [${label}]` : ''}`);
        }
    }
    return abs;
}

/** 安全解析「目录」路径：祖先与最终节点都必须已存在且为真实目录。 */
function safeDirMustExist(dir, label) {
    const abs = safeResolve(dir, label);
    const st = lstatOrNull(abs);
    if (!st) throw new InstallError('DIR_MISSING', `目录不存在（拒绝继续）: ${abs}${label ? ` [${label}]` : ''}`);
    if (!st.isDirectory()) throw new InstallError('NOT_DIRECTORY', `不是目录（拒绝）: ${abs}${label ? ` [${label}]` : ''}`);
    return abs;
}

/** 校验 child 严格位于 parent 内（拒绝相等与越界），先做路径规范化。 */
function assertWithin(child, parent, code = 'PATH_ESCAPE') {
    const c = path.resolve(child);
    const p = path.resolve(parent);
    if (c === p || !c.startsWith(p + path.sep)) {
        throw new InstallError(code, `路径越界（拒绝）: ${c} 不在 ${p} 内`);
    }
    return c;
}

/**
 * 递归收集目录内容映射（相对 POSIX 路径 → sha256 | 哨兵）。不跟随链接。
 * @param {string} dir
 * @param {object} [opts]
 *   opts.onSpecial(rel, kind, abs) 见到链接/特殊文件时的回调（用于 fail-closed 判定）
 *   opts.acceptJunction  Windows junction 在 readdir 中呈现为目录，这里额外用 isLink 识别为特殊项
 */
function dirContentMap(dir, opts = {}) {
    const map = Object.create(null);
    const note = (rel, kind, abs) => {
        if (typeof opts.onSpecial === 'function') opts.onSpecial(rel, kind, abs);
    };
    const st = lstatOrNull(dir);
    if (!st) return map;
    if (st.isSymbolicLink()) {
        map['.'] = SENTINEL.LINK;
        note('.', 'link', dir);
        return map;
    }
    if (!st.isDirectory()) {
        map['.'] = SENTINEL.OTHER;
        note('.', 'other', dir);
        return map;
    }
    const walk = (d, parts) => {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
            const abs = path.join(d, ent.name);
            const relP = parts.concat(ent.name);
            const rel = relP.join('/');
            if (ent.isSymbolicLink()) {
                map[rel] = SENTINEL.LINK;
                note(rel, 'link', abs);
            } else if (ent.isDirectory()) {
                if (opts.acceptJunction !== false && isLink(abs)) {
                    // Windows junction / 重解析点：lstat 是目录但实际指向别处 → 视为特殊项（必然与真实文件不等）。
                    map[rel] = SENTINEL.LINK;
                    note(rel, 'junction', abs);
                    continue;
                }
                map[rel] = SENTINEL.DIR;
                walk(abs, relP);
            } else if (ent.isFile()) {
                map[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
            } else {
                map[rel] = SENTINEL.OTHER;
                note(rel, 'other', abs);
            }
        }
    };
    walk(dir, []);
    return map;
}

/** 两个映射是否完全相同（键集与值均一致）。 */
function mapsEqual(a, b) {
    if (!a || !b) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
        if (!(k in b) || a[k] !== b[k]) return false;
    }
    return true;
}

/** 映射差异摘要（用于错误信息，截断）。 */
function mapDiff(a, b) {
    const out = [];
    for (const k of Object.keys(a || {})) {
        if (!b || a[k] !== b[k]) out.push(k);
        if (out.length >= 8) break;
    }
    for (const k of Object.keys(b || {})) {
        if (out.length >= 8) break;
        if (!a || a[k] !== b[k]) out.push(k);
    }
    return out;
}

/** 映射的稳定摘要（持久化到 journal，供恢复时复核备份完整性）。 */
function mapDigest(map) {
    const keys = Object.keys(map || {}).sort();
    const h = crypto.createHash('sha256');
    h.update('v1\0');
    for (const k of keys) {
        h.update(k);
        h.update('\0');
        h.update(String(map[k]));
        h.update('\0');
    }
    return h.digest('hex');
}

/** 安全移动目录/文件（不删除 dst；dst 已存在则拒绝）。src 不存在返回 false。 */
function moveNoClobber(src, dst) {
    if (!safeEntry(src, '移动源')) return false;
    safeEntry(dst, '移动目标');
    safeMkdirChain(path.dirname(dst));
    if (safeEntry(dst, '移动目标')) {
        throw new InstallError('DEST_EXISTS', `目标已存在，拒绝覆盖: ${dst}`);
    }
    safeEntry(src, '移动源');
    fs.renameSync(src, dst);
    return true;
}

/** 安全移动，若 dst 已存在则移到 quarantine 子目录（不删任何内容）。 */
function moveToQuarantine(src, quarantineDir) {
    if (!safeEntry(src, '隔离源')) return null;
    safeResolve(quarantineDir, '隔离目录');
    safeMkdirChain(quarantineDir);
    let dst = path.join(quarantineDir, path.basename(src));
    for (let i = 1; safeEntry(dst, '隔离目标'); i++) dst = path.join(quarantineDir, `${path.basename(src)}-${i}`);
    safeEntry(src, '隔离源');
    fs.renameSync(src, dst);
    return dst;
}

/** 校验操作路径的祖先和最终节点；只允许普通文件/目录，不跟随链接或特殊文件。 */
function safeEntry(p, label, fileOnly = false) {
    const abs = path.resolve(p);
    if (abs === path.parse(abs).root) throw new InstallError('PATH_INVALID', `不能操作盘根（拒绝）: ${abs}`);
    safeResolve(path.dirname(abs), label);
    const st = assertRealDirSegment(abs, label);
    if (st && !(st.isFile() || (!fileOnly && st.isDirectory()))) {
        throw new InstallError('NOT_REGULAR_FILE', `不是允许的普通${fileOnly ? '文件' : '文件/目录'}（拒绝）: ${abs}`);
    }
    return st;
}

/** 原子写字节（同目录临时文件 + fsync + rename），校验祖先和最终文件均非链接。 */
function writeBytesAtomic(file, data, mode) {
    safeEntry(file, '写入目标', true);
    safeMkdirChain(path.dirname(file));
    const tmp = file + '.tmp-' + crypto.randomUUID();
    const fd = fs.openSync(tmp, 'wx', mode || 0o600);
    try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
    } finally {
        try { fs.closeSync(fd); } catch {}
    }
    try {
        safeEntry(file, '写入目标', true);
        fs.renameSync(tmp, file);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
    }
}

/** 原子写 JSON（同目录临时文件 + fsync + rename）。 */
function writeJsonAtomic(file, data) {
    writeBytesAtomic(file, Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
}

/**
 * 读 JSON：
 *  - 不存在 → null；路径必须为真实普通文件，祖先不得是链接；
 *  - JSON 必须是非数组对象，JSON null 和其它标量不代表「不存在」；
 *  - 其余错误（EACCES/EPERM/EIO/...）与 JSON 损坏 → 抛 InstallError（**绝不吞成 null**，否则会被当成「无事务」覆盖）。
 * @param {string} file
 * @param {object} [o] { code, label }
 */
function readJsonStrict(file, o = {}) {
    let raw;
    try {
        const checked = safeFile(path.resolve(file), o.label || 'JSON 文件');
        raw = fs.readFileSync(checked, 'utf8');
    } catch (e) {
        if (e.code === 'FILE_MISSING') return null;
        if (e instanceof InstallError) throw e;
        throw new InstallError(
            o.code || 'JOURNAL_UNREADABLE',
            `无法读取 ${o.label || '文件'} ${file}（${e.code || e.message}）：拒绝把不可读当成「不存在」，不做任何改动。`
        );
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('JSON 必须是非数组对象');
        }
        return parsed;
    } catch (e) {
        throw new InstallError(
            o.code || 'JOURNAL_CORRUPT',
            `${o.label || '文件'} 已损坏（JSON 解析失败或不是对象）：${file}。拒绝把它当成「无事务」而继续；请人工核对后处理。`
        );
    }
}

/** 兼容旧接口：不存在/损坏返回 null（仅用于**只读展示**，绝不用于决策）。 */
function readJsonOrNull(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

/** 文件 sha256（不存在返回 null；其它读取错误抛出）。 */
function fileSha256(file) {
    try {
        return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
        throw e;
    }
}

/** 生成唯一事务 ID / 备份 ID（时间戳 + 随机，字典序即时间序）。 */
function newId(prefix) {
    const ts = new Date().toISOString().replace(/[-:.]/g, '');
    return `${prefix}-${ts}-${crypto.randomBytes(3).toString('hex')}`;
}

/** 复制目录内容（不跟随链接；遇到链接/特殊文件直接拒绝，绝不静默跳过）。返回复制文件数。 */
function copyDirContents(src, dst) {
    let n = 0;
    safeMkdirChain(dst);
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
        const from = path.join(src, ent.name);
        const to = path.join(dst, ent.name);
        if (ent.isSymbolicLink()) {
            throw new InstallError('LINK_REJECTED', `复制源含符号链接（拒绝）: ${from}`);
        }
        if (ent.isDirectory()) {
            if (isLink(from)) throw new InstallError('LINK_REJECTED', `复制源含 junction/重解析点（拒绝）: ${from}`);
            n += copyDirContents(from, to);
        } else if (ent.isFile()) {
            fs.copyFileSync(from, to);
            n++;
        } else {
            throw new InstallError('SPECIAL_FILE', `复制源含特殊文件（拒绝）: ${from}`);
        }
    }
    return n;
}

module.exports = {
    SENTINEL,
    lstatOrNull,
    isLink,
    isSelfLink,
    exists,
    safeResolve,
    safeFile,
    safeDirMustExist,
    assertWithin,
    dirContentMap,
    mapsEqual,
    mapDiff,
    mapDigest,
    moveNoClobber,
    moveToQuarantine,
    writeBytesAtomic,
    writeJsonAtomic,
    readJsonStrict,
    readJsonOrNull,
    fileSha256,
    newId,
    copyDirContents,
};

'use strict';
/**
 * 状态与 journal：B 表、pending、stage、冲突快照、apply-journal、锁。
 *
 * 全部私有状态位于 `.git/dsr/`（maintDir），`git add '.'` 不可能提交（.git 对 index 不可见）。
 *
 * 硬性要求（合同第 21/24/26/27/28 条 + P1 初审第 3/7/8/10/12 条 + P1 二检第 3/5/6 条）：
 * - 所有本地 state/pending/stage/journal 结构严格 schema 校验，损坏 → 停止（抛 CorruptStateError），
 *   不隐式重置；合法 JSON 但字段损坏同样拒绝（不能覆盖配置文件）。
 * - pending 在 push 前原子持久化，含完整【原字节快照路径 + hash、原 B、L 快照 hash、H、目标身份、C】。
 * - 锁跨进程互斥；遗留锁不自动清理；相同 dataRoot 的不同 repoDir 共享互斥（同一把锁）。
 * - 目标身份绑定，改变需重新 init；init 不能互相覆盖。
 * - 快照/候选/备份/冲突路径用 SHA256(rel) + 独立 runId，避免 `chats/a/b.jsonl` 与
 *   `chats/a__b.jsonl` 扁平化碰撞，且重复冲突运行不覆盖旧双方。
 * - 所有 snapshot/candidate/backup/journal 路径限 maintDir 内，拒绝绝对路径/.. /设备名/ADS /
 *   symlink/junction 及祖先；state/pending/stage/journal 文件本身也拒绝链接（P1 二检第 3 条）。
 * - pending 的 snapshotPath 为 maintDir 内相对路径（非绝对路径），各 hash 字段一致，且实际
 *   快照读回校验（P1 二检第 3 条）。
 * - fs.write 可能短写：原子写用完整写入循环 + fsync（P1 二检第 6 条）。
 */
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { sha256Buffer, assertSafeRel, assertDataRootReal } = require('./hash-scan');

const SCHEMA_VERSION = 1;

class CorruptStateError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CorruptStateError';
        this.code = 'CORRUPT_STATE';
    }
}

class LockError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LockError';
        this.code = 'LOCKED';
    }
}

/** 维护目录名：位于 repo/.git/ 下 */
const DS_DIR_NAME = 'dsr';

function getMaintDir(repoDir) {
    const dotGit = path.join(repoDir, '.git');
    return path.join(dotGit, DS_DIR_NAME);
}

/**
 * 归一化身份/锁用的路径：Windows 文件系统大小写不敏感，`C:\Data` 与 `c:\data` 指向同一目录，
 * 若直接 resolve 参与哈希会产生两把锁 / 两个身份。统一小写后再哈希，保证别名一致（P1 二检第 5 条）。
 */
function normalizeIdentityPath(p) {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** 目标身份绑定串：sha256(repo|branch|normalize(stDataRoot)) 前 16 位 */
function bindTargetIdentity({ repo, branch, stDataRoot }) {
    const raw = `${repo}|${branch}|${normalizeIdentityPath(stDataRoot)}`;
    return crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
}

/** 相同 dataRoot 的锁名（跨 repoDir 共享互斥）。 */
function dataRootLockName(stDataRoot) {
    return 'lock-' + crypto.createHash('sha256')
        .update(normalizeIdentityPath(stDataRoot), 'utf8')
        .digest('hex').slice(0, 16);
}

// ============================== 原子写 ==============================

/**
 * 原子写（原始字节）：临时文件 open → 完整写入循环（防短写）→ fsync → close → rename。
 * 之后对所在目录做 fsync（POSIX 保证目录项持久；Windows 上 fsync 目录会抛错，
 * 已在 _fsyncDir 里按平台忽略）。
 */
async function _fsyncDir(dirAbs) {
    try {
        const fh = await fs.open(dirAbs, 'r');
        try {
            await fs.fsync(fh);
        } finally {
            await fs.close(fh);
        }
    } catch (e) {
        if (process.platform === 'win32') {
            // Windows 目录 fsync 不可用：文档化限制（POSIX 才保证目录项持久）。
            return;
        }
        throw e;
    }
}

/**
 * 完整写入：fs.write 对 fd 可能短写（尤其是大 buffer），必须循环直到全部字节写完。
 * @param {number} fh 已打开的文件描述符
 * @param {Buffer} buf
 */
async function _writeFully(fh, buf) {
    let off = 0;
    while (off < buf.length) {
        const { bytesWritten } = await fs.write(fh, buf, off, buf.length - off, null);
        if (!bytesWritten || bytesWritten <= 0) {
            throw new Error(`write 返回 0 字节（短写/失败）: off=${off}/${buf.length}`);
        }
        off += bytesWritten;
    }
    return off;
}

/**
 * 安全创建目录：先校验「从盘根到 dir（含 dir 自身）」的每个现有段都是真实目录（拒绝 symlink/junction），
 * 再对不存在的段**逐段 mkdir 并重新 lstat 验证**（防并发替换为链接）。
 * 绝不在先 ensureDir 写出外部子目录之后才发现是 junction（P1 三复审第 5 项）。
 * @param {string} dirAbs 要确保存在的目录绝对路径
 * @returns {Promise<string>} 解析后的绝对路径
 */
async function safeEnsureDir(dirAbs) {
    const absDir = path.resolve(dirAbs);
    const rootPart = path.parse(absDir).root;
    const relSegs = absDir.slice(rootPart.length).split(path.sep).filter(s => s !== '');
    let cur = rootPart;
    for (let i = 0; i < relSegs.length; i++) {
        cur = path.join(cur, relSegs[i]);
        let st;
        try {
            st = await fs.lstat(cur);
        } catch (e) {
            if (e && e.code === 'ENOENT') {
                // 该段不存在：mkdir 后重新 lstat 验证（防并发替换为链接/目录被抢占）
                await fs.mkdir(cur);
                let st2;
                try {
                    st2 = await fs.lstat(cur);
                } catch (e2) {
                    throw new CorruptStateError(`创建目录后 lstat 失败: ${cur}: ${e2.message}`);
                }
                if (st2.isSymbolicLink() || !st2.isDirectory()) {
                    throw new CorruptStateError(`创建后目录是符号链接/junction 或非目录: ${cur}`);
                }
                continue;
            }
            throw new CorruptStateError(`目录链 lstat 失败（非缺失）: ${cur}: ${e.message}`);
        }
        if (st.isSymbolicLink()) {
            throw new CorruptStateError(`目录链含符号链接/junction: ${cur}`);
        }
        if (!st.isDirectory()) {
            throw new CorruptStateError(`目录链非目录: ${cur}`);
        }
    }
    return absDir;
}

/**
 * 校验一个「待写入的目标文件」及其父目录链：
 * - 父目录链完整真实校验并逐段安全创建（safeEnsureDir）；
 * - 目标文件若已存在必须是普通文件且非符号链接；仅 ENOENT 视为「将创建」；
 *   EACCES/EIO 等其它错误一律抛出（P1 三次第 1 条）。
 * 用于 atomicWriteBytes / journal append 前（P1 三复审第 5 项：atomicWrite 已有目标必须普通文件且非链接）。
 * @param {string} absPath 目标文件绝对路径
 * @returns {Promise<string>} 目标绝对路径
 */
async function verifyFileForWrite(absPath) {
    const abs = path.resolve(absPath);
    await safeEnsureDir(path.dirname(abs));
    let st;
    try {
        st = await fs.lstat(abs);
    } catch (e) {
        if (e && e.code === 'ENOENT') return abs; // 不存在，将创建
        throw new CorruptStateError(`写入目标 lstat 失败（非缺失）: ${abs}: ${e.message}`);
    }
    if (st.isSymbolicLink()) {
        throw new CorruptStateError(`写入目标是符号链接/junction: ${abs}`);
    }
    if (!st.isFile()) {
        throw new CorruptStateError(`写入目标不是普通文件: ${abs}`);
    }
    return abs;
}

async function atomicWriteBytes(absPath, buf) {
    const abs = path.resolve(absPath);
    // 父目录链真实校验 + 逐段安全创建；目标若已存在必须普通文件且非链接（P1 三复审第 5 项）。
    await verifyFileForWrite(abs);
    const dir = path.dirname(abs);
    const tmp = path.join(dir, `.${path.basename(abs)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const fh = await fs.open(tmp, 'w');
    try {
        await _writeFully(fh, buf);
        await fs.fsync(fh);
    } finally {
        await fs.close(fh);
    }
    await fs.rename(tmp, abs);
    await _fsyncDir(dir);
}

/** 原子写 JSON：写临时文件 → fsync → rename。 */
async function atomicWriteJson(absPath, data) {
    await atomicWriteBytes(absPath, Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
}

/**
 * 读取 JSON（或 null）：若路径存在但为符号链接 → 抛 CorruptStateError（状态文件本身拒绝链接）。
 */
async function readJsonOrNull(absPath) {
    let st;
    try {
        st = await fs.lstat(absPath);
    } catch (e) {
        // P1 三次第 1 条：只有 ENOENT 表示缺失；EACCES/EIO 等其它错误必须抛出，不得当缺失。
        if (e && e.code === 'ENOENT') return null;
        throw new CorruptStateError(`状态文件读取失败（非缺失）: ${absPath}: ${e.message}`);
    }
    if (st.isSymbolicLink()) {
        throw new CorruptStateError(`状态文件是符号链接，拒绝读取: ${absPath}`);
    }
    if (!st.isFile()) {
        throw new CorruptStateError(`状态文件不是普通文件，拒绝读取: ${absPath}`);
    }
    let raw;
    try {
        raw = await fs.readFile(absPath, 'utf8');
    } catch (e) {
        throw new CorruptStateError(`状态文件不可读: ${absPath}: ${e.message}`);
    }
    try {
        return JSON.parse(raw);
    } catch (e) {
        throw new CorruptStateError(`状态文件损坏（非法 JSON）: ${absPath}: ${e.message}`);
    }
}

// ============================== schema 校验 ==============================

function isHex40(s) {
    return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
}
function isHex64(s) {
    return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}
function isHex16(s) {
    return typeof s === 'string' && /^[0-9a-f]{16}$/.test(s);
}
/** rel 必须严格为 chats/**\/*.jsonl（不只「数据根之内」）。 */
function isChatRelPath(s) {
    if (typeof s !== 'string' || s.length === 0) return false;
    if (s.indexOf('\\') !== -1 || s.indexOf('\0') !== -1) return false;
    if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return false;
    const segs = s.split('/');
    if (segs.length < 2) return false;              // 至少 chats/<file>.jsonl
    if (segs[0] !== 'chats') return false;
    if (!segs[segs.length - 1].endsWith('.jsonl')) return false;
    for (const seg of segs) {
        if (seg === '' || seg === '.' || seg === '..') return false;
    }
    return true;
}
function isRelPath(s) {
    return typeof s === 'string' && s.length > 0 && s.indexOf('\\') === -1 && !s.startsWith('/') && !/^[a-zA-Z]:/.test(s) && !s.split('/').includes('..') && !s.split('/').includes('');
}
function isIso(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s);
}

function assertSchema(cond, what) {
    if (!cond) throw new CorruptStateError(`状态 schema 校验失败: ${what}`);
}

/**
 * 校验「维护目录内相对路径」的**字符串层**：POSIX 相对、无 ..、无绝对、无盘符、
 * 无反斜杠、无空段、无设备名/ADS/尾随空格点（复用 hash-scan.assertSafeRel 的严格段校验）。
 * 文件系统层的 symlink/junction 祖先校验在 `assertRealWithinMaintDir` 单独做（需 async）。
 */
function assertRelWithinMaintDir(maintDir, relPath, what) {
    if (typeof relPath !== 'string' || relPath.length === 0) {
        throw new CorruptStateError(`${what}: 空路径`);
    }
    if (path.isAbsolute(relPath) || relPath.indexOf('\\') !== -1 || relPath.indexOf('\0') !== -1) {
        throw new CorruptStateError(`${what}: 绝对路径或非法分隔符: ${relPath}`);
    }
    if (relPath.split('/').includes('..') || relPath.split('/').includes('')) {
        throw new CorruptStateError(`${what}: 路径越界或空段: ${relPath}`);
    }
    // 段级严格校验（设备名/ADS/尾随空格点/多点别名等）
    try {
        assertSafeRel(relPath);
    } catch (e) {
        throw new CorruptStateError(`${what}: 段非法（设备名/ADS/别名等）: ${relPath}: ${e.message}`);
    }
    const abs = path.resolve(maintDir, relPath);
    const absMaint = path.resolve(maintDir);
    if (abs !== absMaint && !abs.startsWith(absMaint + path.sep)) {
        throw new CorruptStateError(`${what}: 路径越出维护目录: ${relPath}`);
    }
    return relPath;
}

/**
 * 校验维护目录内路径的**文件系统层**：maintDir 自身及其到目标父目录的每一段都不能是
 * symlink/junction，目标文件（若存在）也不能是符号链接。返回解析后的绝对路径。
 *
 * 读错误语义（P1 三次第 1 条）：lstat 仅 ENOENT 表示「该段不存在」；EACCES/EIO 等其它错误
 * 必须抛出，绝不能 catch-all 成 null/缺失。不存在的父段可逐段 mkdir 后重新 lstat 验证（确保
 * 新建目录未被并发替换为链接），但只对「明确需要创建」的场景（调用方传 allowCreate）创建。
 */
async function assertRealWithinMaintDir(maintDir, relPath, what, allowCreate = false) {
    assertRelWithinMaintDir(maintDir, relPath, what);
    const absMaint = path.resolve(maintDir);
    const abs = path.resolve(maintDir, relPath);

    // maintDir 自身：若存在必须是真实目录（非链接）
    let stMaint;
    try {
        stMaint = await fs.lstat(absMaint);
    } catch (e) {
        if (e && e.code !== 'ENOENT') {
            throw new CorruptStateError(`${what}: 维护目录 lstat 失败（非缺失）: ${maintDir}: ${e.message}`);
        }
        stMaint = null;
    }
    if (stMaint && stMaint.isSymbolicLink()) {
        throw new CorruptStateError(`${what}: 维护目录自身是符号链接: ${maintDir}`);
    }
    if (stMaint && !stMaint.isDirectory()) {
        throw new CorruptStateError(`${what}: 维护目录不是目录: ${maintDir}`);
    }

    const relParts = relPath.split('/');
    let cur = absMaint;
    for (let i = 0; i < relParts.length - 1; i++) {
        cur = path.join(cur, relParts[i]);
        let st;
        try {
            st = await fs.lstat(cur);
        } catch (e) {
            if (e && e.code === 'ENOENT') {
                if (!allowCreate) {
                    throw new CorruptStateError(`${what}: 路径祖先缺失: ${cur}`);
                }
                // 明确允许创建：mkdir 后重新 lstat 验证（防并发替换为链接）
                await fs.mkdir(cur);
                let st2;
                try {
                    st2 = await fs.lstat(cur);
                } catch (e2) {
                    throw new CorruptStateError(`${what}: 创建祖先后 lstat 失败: ${cur}: ${e2.message}`);
                }
                if (st2.isSymbolicLink() || !st2.isDirectory()) {
                    throw new CorruptStateError(`${what}: 创建后祖先是链接或非目录: ${cur}`);
                }
                continue;
            }
            throw new CorruptStateError(`${what}: 路径祖先 lstat 失败（非缺失）: ${cur}: ${e.message}`);
        }
        if (st.isSymbolicLink()) {
            throw new CorruptStateError(`${what}: 路径祖先是符号链接/junction: ${cur}`);
        }
        if (!st.isDirectory()) {
            throw new CorruptStateError(`${what}: 路径祖先不是目录: ${cur}`);
        }
    }

    // 目标文件本身（若存在）拒绝符号链接；非普通文件也拒绝
    let stTarget;
    try {
        stTarget = await fs.lstat(abs);
    } catch (e) {
        if (e && e.code !== 'ENOENT') {
            throw new CorruptStateError(`${what}: 目标 lstat 失败（非缺失）: ${abs}: ${e.message}`);
        }
        stTarget = null;
    }
    if (stTarget && stTarget.isSymbolicLink()) {
        throw new CorruptStateError(`${what}: 目标是符号链接/junction: ${abs}`);
    }
    if (stTarget && !stTarget.isFile()) {
        throw new CorruptStateError(`${what}: 目标不是普通文件: ${abs}`);
    }
    return abs;
}

/** 校验一个 baseline entry：{ hash, setAt } */
function validateBaselineEntry(entry, rel) {
    assertSchema(entry && typeof entry === 'object', `baseline["${rel}"] 非对象`);
    assertSchema(isHex64(entry.hash), `baseline["${rel}"].hash 非法`);
    assertSchema(isIso(entry.setAt), `baseline["${rel}"].setAt 非法`);
}

/** 校验 state.json 整体结构。 */
function validateState(state) {
    assertSchema(state && typeof state === 'object', 'state 非对象');
    assertSchema(state.schemaVersion === SCHEMA_VERSION, `schemaVersion 应为 ${SCHEMA_VERSION}`);
    assertSchema(isHex16(state.targetIdentity), 'targetIdentity 非法');
    assertSchema(typeof state.repo === 'string' && state.repo.length > 0, 'repo 非法');
    assertSchema(typeof state.branch === 'string' && state.branch.length > 0, 'branch 非法');
    assertSchema(typeof state.stDataRoot === 'string' && state.stDataRoot.length > 0, 'stDataRoot 非法');
    assertSchema(state.remoteHead === null || isHex40(state.remoteHead), 'remoteHead 非法');
    assertSchema(state.baseline && typeof state.baseline === 'object' && !Array.isArray(state.baseline), 'baseline 非法');
    for (const [rel, entry] of Object.entries(state.baseline)) {
        assertSchema(isChatRelPath(rel), `baseline 键非法路径（须 chats/**/*.jsonl）: ${rel}`);
        validateBaselineEntry(entry, rel);
    }
    return state;
}

/** 校验 pending.edits 里的快照路径（maintDir 内相对路径，非绝对）。 */
function validatePendingEdit(e, maintDir) {
    assertSchema(e && typeof e === 'object', 'pending.edits 项非对象');
    assertSchema(isChatRelPath(e.rel), `pending.edits[].rel 非法（须 chats/**/*.jsonl）: ${e.rel}`);
    assertSchema(isHex64(e.originalHash), `pending.edits[].originalHash 非法`);
    assertSchema(isHex64(e.publishHash), `pending.edits[].publishHash 非法`);
    assertSchema(isHex64(e.localSnapshotHash), `pending.edits[].localSnapshotHash 非法`);
    assertSchema(e.originalBaselineHash === null || isHex64(e.originalBaselineHash), `pending.edits[].originalBaselineHash 非法`);
    // P1 二检第 3 条：发布内容各 hash 字段必须一致（原字节快照 = 发布内容 = L 快照）。
    assertSchema(e.originalHash === e.publishHash, `pending.edits[].originalHash 与 publishHash 不一致`);
    assertSchema(e.localSnapshotHash === e.publishHash, `pending.edits[].localSnapshotHash 与 publishHash 不一致`);
    // snapshotPath 必须是 maintDir 内相对路径（非绝对）。
    assertSchema(typeof e.snapshotPath === 'string' && e.snapshotPath.length > 0, `pending.edits[].snapshotPath 非法`);
    assertRelWithinMaintDir(maintDir, e.snapshotPath, 'pending.edits[].snapshotPath');
    assertSchema(typeof e.absTargetPath === 'string', `pending.edits[].absTargetPath 非法`);
}

/** 校验 pending.json：必须含完整快照信息（合同第 21 条 + P1 第 5 条：原 B / Lsnap / hash / C / H）。 */
function validatePending(pending, maintDir) {
    assertSchema(pending && typeof pending === 'object', 'pending 非对象');
    assertSchema(typeof pending.runId === 'string' && pending.runId.length > 0, 'pending.runId 非法');
    assertSchema(isHex40(pending.remoteHead) || pending.remoteHead === null, 'pending.remoteHead 非法');
    assertSchema(isHex16(pending.targetIdentity), 'pending.targetIdentity 非法');
    assertSchema(['built', 'committed', 'pushing'].includes(pending.phase), 'pending.phase 非法');
    assertSchema(pending.treeId === null || isHex40(pending.treeId), 'pending.treeId 非法');
    assertSchema(pending.commitId === null || isHex40(pending.commitId), 'pending.commitId 非法');
    assertSchema(Array.isArray(pending.edits), 'pending.edits 非数组');
    for (const e of pending.edits) {
        validatePendingEdit(e, maintDir);
    }
    assertSchema(isIso(pending.createdAt), 'pending.createdAt 非法');
    return pending;
}

/** 校验 stage.json（pull 只暂存）。 */
function validateStage(stage, maintDir) {
    assertSchema(stage && typeof stage === 'object', 'stage 非对象');
    assertSchema(typeof stage.runId === 'string' && stage.runId.length > 0, 'stage.runId 非法');
    assertSchema(isHex40(stage.remoteHead), 'stage.remoteHead 非法');
    assertSchema(isHex16(stage.targetIdentity), 'stage.targetIdentity 非法');
    assertSchema(Array.isArray(stage.entries), 'stage.entries 非数组');
    for (const e of stage.entries) {
        assertSchema(e && typeof e === 'object', 'stage.entries 项非对象');
        assertSchema(isChatRelPath(e.rel), `stage.entries[].rel 非法`);
        assertSchema(e.expectedBaselineHash === null || isHex64(e.expectedBaselineHash), `stage.entries[].expectedBaselineHash 非法`);
        assertSchema(e.expectedLocalHash === null || isHex64(e.expectedLocalHash), `stage.entries[].expectedLocalHash 非法`);
        assertSchema(typeof e.expectedLocalMissing === 'boolean', `stage.entries[].expectedLocalMissing 非法`);
        assertSchema(isHex64(e.candidateHash), `stage.entries[].candidateHash 非法`);
        assertSchema(typeof e.candidatePath === 'string' && e.candidatePath.length > 0, `stage.entries[].candidatePath 非法`);
        assertRelWithinMaintDir(maintDir, e.candidatePath, 'stage.entries[].candidatePath');
        assertSchema(isHex40(e.remoteCommit), `stage.entries[].remoteCommit 非法`);
    }
    assertSchema(isIso(stage.createdAt), 'stage.createdAt 非法');
    return stage;
}

// ============================== 载入/保存 ==============================

async function loadState(maintDir) {
    const p = path.join(maintDir, 'state.json');
    const raw = await readJsonOrNull(p);
    if (raw === null) return null;
    return validateState(raw);
}

async function saveState(maintDir, state) {
    validateState(state); // 保存前再校验，防把坏数据落盘
    await atomicWriteJson(path.join(maintDir, 'state.json'), state);
}

async function loadPending(maintDir) {
    const p = path.join(maintDir, 'pending.json');
    const raw = await readJsonOrNull(p);
    if (raw === null) return null;
    return validatePending(raw, maintDir);
}

async function writePending(maintDir, pending) {
    validatePending(pending, maintDir);
    await atomicWriteJson(path.join(maintDir, 'pending.json'), pending);
}

async function clearPending(maintDir) {
    await clearStateFile(maintDir, 'pending.json');
}

/** 删除单个状态文件（非递归）：先校验祖先真实，再 unlink；仅 ENOENT 视为已清除。
 *  P1 三复审第 3 项：clearStateFile 自身要含 dsr 上层验证（maintDir 及其父链含 .git 都须真实目录），
 *  且绝不递归删除（fs.unlink 单文件，目录/链接目标会被 assertRealWithinMaintDir 拒绝）。
 */
async function clearStateFile(maintDir, relName) {
    // dsr 上层验证：maintDir 自身及从盘根到 maintDir 的每一段（含 repo/.git）都须真实目录。
    await assertMaintDirChainReal(maintDir);
    const abs = await assertRealWithinMaintDir(maintDir, relName, `clear.${relName}`);
    try {
        await fs.unlink(abs);
    } catch (e) {
        if (e && e.code === 'ENOENT') return;
        throw new CorruptStateError(`清除状态文件失败: ${abs}: ${e.message}`);
    }
}

async function loadStage(maintDir) {
    const p = path.join(maintDir, 'stage', 'stage.json');
    const raw = await readJsonOrNull(p);
    if (raw === null) return null;
    return validateStage(raw, maintDir);
}

async function writeStage(maintDir, stage) {
    validateStage(stage, maintDir);
    // 校验每个候选文件存在且内容哈希匹配，且不在 symlink 祖先下（P1 二检第 3 条）
    for (const e of stage.entries) {
        const abs = await assertRealWithinMaintDir(maintDir, e.candidatePath, 'stage.entries[].candidatePath');
        if (!(await fs.pathExists(abs))) {
            throw new CorruptStateError(`stage 候选快照缺失: ${e.candidatePath}`);
        }
        const buf = await fs.readFile(abs);
        if (sha256Buffer(buf) !== e.candidateHash) {
            throw new CorruptStateError(`stage 候选快照哈希不匹配: ${e.candidatePath}`);
        }
    }
    await atomicWriteJson(path.join(maintDir, 'stage', 'stage.json'), stage);
}

async function clearStage(maintDir) {
    await clearStateFile(maintDir, 'stage/stage.json');
}

/**
 * 为某 rel 生成唯一、可复现、且跨 runId 不碰撞的快照基名：
 * SHA256(rel)（前 16 hex）保证 `chats/a/b.jsonl` 与 `chats/a__b.jsonl` 不同名。
 * 调用方还需追加独立 runId 前缀目录，使重复运行不覆盖旧版本。
 */
function fileKeyForRel(rel) {
    return crypto.createHash('sha256').update(rel, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 保存冲突双方快照，返回 {localPath, remotePath}（相对 maintDir）。
 * 使用独立 runId 子目录 + SHA256(rel) 基名，重复冲突运行不覆盖旧双方。
 */
async function writeConflictSnapshot(maintDir, rel, localBytes, remoteBytes) {
    assertSchema(isChatRelPath(rel), `writeConflictSnapshot rel 非法: ${rel}`);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = path.join(maintDir, 'conflict', runId);
    await safeEnsureDir(dir);
    const base = fileKeyForRel(rel);
    const localRel = `conflict/${runId}/${base}.local`;
    const remoteRel = `conflict/${runId}/${base}.remote`;
    await atomicWriteBytes(path.join(maintDir, localRel), localBytes);
    await atomicWriteBytes(path.join(maintDir, remoteRel), remoteBytes);
    return {
        localPath: path.join(maintDir, localRel),
        remotePath: path.join(maintDir, remoteRel),
        localAbs: path.join(maintDir, localRel),
        remoteAbs: path.join(maintDir, remoteRel),
        localRel,
        remoteRel,
        runId,
    };
}

/**
 * 追加 apply-journal 记录（append-only，先写数据并 fsync）。
 * 记录需含每文件 expected/candidate/backup 与进度，见 apply.js 构造。
 */
async function appendApplyJournal(maintDir, rec) {
    assertSchema(rec && typeof rec === 'object', 'journal 记录非对象');
    assertSchema(typeof rec.runId === 'string' && rec.runId.length > 0, 'journal.runId 非法');
    assertSchema(isChatRelPath(rec.rel), `journal.rel 非法（须 chats/**/*.jsonl）: ${rec.rel}`);
    assertSchema(['plan', 'applied', 'backup-failed', 'precheck-failed', 'replace-failed'].includes(rec.status), `journal.status 非法`);
    assertSchema(isIso(rec.ts), 'journal.ts 非法');
    // 校验引用维护目录内路径的字段（若存在）
    for (const k of ['candidatePath', 'backupPath', 'expectedPath']) {
        if (rec[k] != null) {
            assertRelWithinMaintDir(maintDir, rec[k], `journal.${k}`);
        }
    }
    if (rec.expectedHash != null) assertSchema(isHex64(rec.expectedHash), 'journal.expectedHash 非法');
    if (rec.candidateHash != null) assertSchema(isHex64(rec.candidateHash), 'journal.candidateHash 非法');
    if (rec.backupHash != null) assertSchema(isHex64(rec.backupHash), 'journal.backupHash 非法');
    await _appendJournalLine(maintDir, rec);
}

/**
 * 追加 apply 事务「完成」标志（P1 二检第 2/6 条）：状态保存成功后持久化，
 * 使 recoverApply 只处理未完成事务，不把历史 plan 永远视为恢复项。
 * 完成记录不含 rel（事务级）。
 */
async function appendApplyComplete(maintDir, runId) {
    assertSchema(typeof runId === 'string' && runId.length > 0, 'journal.runId 非法');
    await _appendJournalLine(maintDir, { runId, status: 'complete', ts: new Date().toISOString() });
}

async function _appendJournalLine(maintDir, rec) {
    const p = path.join(maintDir, 'apply-journal.jsonl');
    // 父目录链真实校验 + 逐段安全创建；目标若已存在必须普通文件且非链接（P1 三复审第 5 项）。
    await verifyFileForWrite(p);
    const line = JSON.stringify(rec) + '\n';
    // append + fsync（数据先落盘，再依赖调用方顺序）
    const fh = await fs.open(p, 'a');
    try {
        await _writeFully(fh, Buffer.from(line, 'utf8'));
        await fs.fsync(fh);
    } finally {
        await fs.close(fh);
    }
}

/** 读取 apply-journal 全部记录（损坏即抛 CorruptStateError）。 */
async function readApplyJournal(maintDir) {
    const p = path.join(maintDir, 'apply-journal.jsonl');
    let st;
    try {
        st = await fs.lstat(p);
    } catch (e) {
        // 只有 ENOENT 表示无 journal；EACCES/EIO 等必须抛出（P1 三次第 1 条）。
        if (e && e.code === 'ENOENT') return [];
        throw new CorruptStateError(`apply-journal lstat 失败（非缺失）: ${p}: ${e.message}`);
    }
    if (st.isSymbolicLink()) {
        throw new CorruptStateError(`apply-journal 是符号链接，拒绝读取: ${p}`);
    }
    if (!st.isFile()) {
        throw new CorruptStateError(`apply-journal 不是普通文件: ${p}`);
    }
    const text = await fs.readFile(p, 'utf8');
    const lines = text.split('\n').filter(l => l.trim() !== '');
    const recs = [];
    for (let i = 0; i < lines.length; i++) {
        let obj;
        try {
            obj = JSON.parse(lines[i]);
        } catch (e) {
            throw new CorruptStateError(`apply-journal 第 ${i + 1} 行损坏: ${e.message}`);
        }
        if (!obj || typeof obj !== 'object') {
            throw new CorruptStateError(`apply-journal 第 ${i + 1} 行非对象`);
        }
        if (obj.status === 'complete') {
            if (typeof obj.runId !== 'string' || !isIso(obj.ts)) {
                throw new CorruptStateError(`apply-journal 第 ${i + 1} 行完成标志 schema 非法`);
            }
            recs.push(obj);
            continue;
        }
        if (typeof obj.runId !== 'string' || !isChatRelPath(obj.rel) || !isIso(obj.ts) ||
            !['plan', 'applied', 'backup-failed', 'precheck-failed', 'replace-failed'].includes(obj.status)) {
            throw new CorruptStateError(`apply-journal 第 ${i + 1} 行 schema 非法`);
        }
        recs.push(obj);
    }
    return recs;
}

// ============================== 快照读回校验 ==============================

/**
 * 读回并校验维护目录内的快照文件：路径限定 maintDir 且非符号链接（含祖先），
 * 内容哈希必须等于期望值（P1 二检第 3 条：pending 快照读回校验）。
 * @returns {Promise<Buffer>}
 */
async function readVerifiedSnapshot(maintDir, relPath, expectedHash, what) {
    const abs = await assertRealWithinMaintDir(maintDir, relPath, what || 'snapshot');
    if (!(await fs.pathExists(abs))) {
        throw new CorruptStateError(`${what || 'snapshot'}: 快照缺失: ${relPath}`);
    }
    const buf = await fs.readFile(abs);
    if (sha256Buffer(buf) !== expectedHash) {
        throw new CorruptStateError(`${what || 'snapshot'}: 快照哈希不匹配: ${relPath}`);
    }
    return buf;
}

/**
 * 校验整个 pending 的快照：每个 edit 的 snapshotPath 实际读回，内容哈希 == publishHash，
 * 且路径非符号链接（含祖先）。任一不符 → CorruptStateError（不覆盖原 pending）。
 */
async function verifyPendingSnapshots(maintDir, pending) {
    for (const e of pending.edits) {
        await readVerifiedSnapshot(maintDir, e.snapshotPath, e.publishHash, 'pending.edits[].snapshotPath');
    }
    return true;
}

// ============================== apply-active 完整 manifest ==============================

/**
 * 原子完整 apply manifest（P1 三次第 12 条）：单份 apply-active.json，任何 rename 前写完并读回
 * 验证。它是恢复的唯一真相；apply-journal 仅审计，不作为唯一恢复依据。
 *
 * schema:
 * {
 *   schemaVersion: 1,
 *   runId: string,
 *   targetIdentity: hex16,
 *   stageId: string,
 *   remoteHead: hex40,
 *   createdAt: ISO,
 *   entries: [{
 *     rel: chats/**\/*.jsonl,
 *     expectedBaselineHash: hex64|null,
 *     expectedLocalHash: hex64|null,
 *     expectedLocalMissing: boolean,
 *     candidateHash: hex64,
 *     candidatePath: maintDir 内相对路径,
 *     backupPath: maintDir 内相对路径|null（原缺失时 null）,
 *     backupHash: hex64|null,
 *   }]
 * }
 */
const MANIFEST_SCHEMA_VERSION = 1;

function validateManifestEntry(e, maintDir) {
    assertSchema(e && typeof e === 'object', 'manifest.entries 项非对象');
    assertSchema(isChatRelPath(e.rel), `manifest.entries[].rel 非法（须 chats/**/*.jsonl）: ${e.rel}`);
    assertSchema(e.expectedBaselineHash === null || isHex64(e.expectedBaselineHash), `manifest.entries[].expectedBaselineHash 非法`);
    assertSchema(e.expectedLocalHash === null || isHex64(e.expectedLocalHash), `manifest.entries[].expectedLocalHash 非法`);
    assertSchema(typeof e.expectedLocalMissing === 'boolean', `manifest.entries[].expectedLocalMissing 非法`);
    assertSchema(isHex64(e.candidateHash), `manifest.entries[].candidateHash 非法`);
    assertSchema(typeof e.candidatePath === 'string' && e.candidatePath.length > 0, `manifest.entries[].candidatePath 非法`);
    assertRelWithinMaintDir(maintDir, e.candidatePath, 'manifest.entries[].candidatePath');
    // 语义一致性：expectedLocalMissing 与 expectedLocalHash 互斥
    assertSchema(e.expectedLocalMissing === (e.expectedLocalHash === null), `manifest.entries[].expectedLocalMissing 与 expectedLocalHash 不一致`);

    // P1 三复审第 4 项：backupPath 与 expectedLocalMissing 严格绑定。
    // 原文件缺失 → backupPath 必须 null 且 backupHash 为 null；
    // 原文件存在 → backupPath 必须非 null（有真实备份），且 backupHash === expectedLocalHash（备份=原内容）。
    assertSchema((e.backupPath === null) === e.expectedLocalMissing,
        `manifest.entries[].backupPath 与 expectedLocalMissing 不一致（缺失时 backupPath 须 null，存在时须非 null）`);
    if (e.expectedLocalMissing) {
        assertSchema(e.backupPath === null && e.backupHash === null,
            `manifest.entries[].缺失文件 backupPath/backupHash 应为 null`);
    } else {
        assertSchema(typeof e.backupPath === 'string' && e.backupPath.length > 0,
            `manifest.entries[].backupPath 非法（原文件存在必须记录备份）`);
        assertRelWithinMaintDir(maintDir, e.backupPath, 'manifest.entries[].backupPath');
        assertSchema(isHex64(e.backupHash), `manifest.entries[].backupHash 非法`);
        assertSchema(e.backupHash === e.expectedLocalHash,
            `manifest.entries[].backupHash 应等于 expectedLocalHash（原文件存在时备份即原内容）`);
    }
}

function validateManifest(m, maintDir) {
    assertSchema(m && typeof m === 'object', 'manifest 非对象');
    assertSchema(m.schemaVersion === MANIFEST_SCHEMA_VERSION, `manifest.schemaVersion 应为 ${MANIFEST_SCHEMA_VERSION}`);
    assertSchema(typeof m.runId === 'string' && m.runId.length > 0, 'manifest.runId 非法');
    assertSchema(isHex16(m.targetIdentity), 'manifest.targetIdentity 非法');
    assertSchema(typeof m.stageId === 'string' && m.stageId.length > 0, 'manifest.stageId 非法');
    assertSchema(isHex40(m.remoteHead), 'manifest.remoteHead 非法');
    assertSchema(isIso(m.createdAt), 'manifest.createdAt 非法');
    assertSchema(Array.isArray(m.entries), 'manifest.entries 非数组');
    // rel 不可重复
    const seen = new Set();
    for (const e of m.entries) {
        validateManifestEntry(e, maintDir);
        assertSchema(!seen.has(e.rel), `manifest.entries 重复 rel: ${e.rel}`);
        seen.add(e.rel);
    }
    return m;
}

/** apply-active.json 的绝对路径。 */
function activeManifestPath(maintDir) {
    return path.join(maintDir, 'apply-active.json');
}

/** 读取 apply-active manifest；不存在返回 null（仅 ENOENT 视为无，其它错误抛出）。 */
async function loadApplyActive(maintDir) {
    const p = activeManifestPath(maintDir);
    let st;
    try {
        st = await fs.lstat(p);
    } catch (e) {
        if (e && e.code === 'ENOENT') return null;
        throw new CorruptStateError(`apply-active lstat 失败（非缺失）: ${p}: ${e.message}`);
    }
    if (st.isSymbolicLink()) {
        throw new CorruptStateError(`apply-active 是符号链接，拒绝读取: ${p}`);
    }
    if (!st.isFile()) {
        throw new CorruptStateError(`apply-active 不是普通文件: ${p}`);
    }
    const raw = await fs.readFile(p, 'utf8');
    let obj;
    try {
        obj = JSON.parse(raw);
    } catch (e) {
        throw new CorruptStateError(`apply-active 损坏（非法 JSON）: ${p}: ${e.message}`);
    }
    return validateManifest(obj, maintDir);
}

/**
 * 原子写 apply-active manifest 并**读回验证**（P1 三次第 14 条：任何 rename 前写完并读回验证）。
 * 写入后重新 loadApplyActive 校验 schema 一致，确保落盘的是一份完整可恢复的 manifest。
 */
async function writeApplyActive(maintDir, manifest) {
    validateManifest(manifest, maintDir);
    await atomicWriteJson(activeManifestPath(maintDir), manifest);
    // 读回验证：确保落盘内容可被严格解析（防短写/半份），且**整份 manifest 结构规范 JSON 一致**（P1 三复审第 4 项）。
    const back = await loadApplyActive(maintDir);
    if (!back) {
        throw new CorruptStateError('apply-active 写入后读回为空（写入失败）');
    }
    // 整份比较：规范化 JSON 字符串逐字段一致（非仅 runId/count），捕获字段值被截断/篡改/丢失。
    const canonWritten = JSON.stringify(manifest);
    const canonReadBack = JSON.stringify(back);
    if (canonWritten !== canonReadBack) {
        throw new CorruptStateError('apply-active 写入后读回不一致（整份 manifest 结构/字段不一致，半份或截断）');
    }
    return back;
}

/** 清除 apply-active manifest（复用 clearStateFile：全祖先/目标普通文件检查 + fs.unlink，不递归删除，
 *  目录/链接目标拒绝）。仅 ENOENT 视为已清除（P1 三复审第 3 项）。 */
async function clearApplyActive(maintDir) {
    await clearStateFile(maintDir, 'apply-active.json');
}

// ============================== 锁 ==============================

/**
 * 验证从盘根到 repoDir（含 repoDir 自身）的每个现有祖先都是真实目录，拒绝 symlink/junction
 * （P1 三次第 7 条：在任何维护写入、锁创建之前验证）。不存在的下层允许后续 mkdir。
 * @param {string} repoDir
 */
async function assertRepoDirReal(repoDir) {
    const absRoot = path.resolve(repoDir);
    const rootPart = path.parse(absRoot).root;
    const relSegs = absRoot.slice(rootPart.length).split(path.sep).filter(s => s !== '');
    let cur = rootPart;
    for (let i = 0; i < relSegs.length; i++) {
        cur = path.join(cur, relSegs[i]);
        let st;
        try {
            st = await fs.lstat(cur);
        } catch (e) {
            if (e && e.code === 'ENOENT') continue; // 尚未存在，允许后续创建
            throw new CorruptStateError(`repoDir 或其祖先 lstat 失败（非缺失）: ${cur}: ${e.message}`);
        }
        if (st.isSymbolicLink()) {
            throw new CorruptStateError(`repoDir 或其祖先是符号链接/junction: ${cur}`);
        }
        if (!st.isDirectory()) {
            throw new CorruptStateError(`repoDir 或其祖先不是目录: ${cur}`);
        }
    }
    return absRoot;
}

/**
 * 验证从盘根到 maintDir（repo/.git/dsr）的每个现有祖先都是真实目录，拒绝 symlink/junction
 * （P1 三复审第 2 项：run 锁前、锁创建前、所有维护写入前都要覆盖到 .git/dsr 全链，不只是 repo）。
 * 不存在的下层段**逐段 mkdir 并重新 lstat 验证**（防并发替换为链接）。
 * @param {string} maintDir 维护目录绝对路径（repo/.git/dsr）
 * @returns {Promise<string>} 解析后的 maintDir 绝对路径
 */
async function assertMaintDirChainReal(maintDir) {
    return safeEnsureDir(maintDir);
}

/**
 * 验证并安全创建 repo/.git/dsr 全链（含 repo、.git、dsr 每一段），返回 maintDir。
 * 供 orchestrator.run 在锁创建前调用（P1 三复审第 2 项）。
 * @param {string} repoDir
 * @returns {Promise<string>} maintDir 绝对路径
 */
async function ensureMaintDirReal(repoDir) {
    await assertRepoDirReal(repoDir);
    const dotGit = path.join(path.resolve(repoDir), '.git');
    const maintDir = path.join(dotGit, DS_DIR_NAME);
    await safeEnsureDir(maintDir);
    return maintDir;
}

/**
 * 获取一层锁（O_EXCL 原子创建 + fsync）。遗留锁不自动清理：
 * - 持有者 PID 存活 → LockError（被占用）；
 * - 持有者 PID 已不在 → LockError（遗留锁，须人工清理，不自动删）。
 * @param {string} lockPath 锁文件绝对路径
 */
async function _acquireLockAt(lockPath) {
    // 锁文件父目录链完整校验 + 逐段安全创建（防锁被 junction 重定向）；锁文件若已存在必须普通文件（O_EXCL 处理 EEXIST）。
    await verifyFileForWrite(lockPath);
    const myToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
        const fd = await fs.open(lockPath, 'wx');
        await fs.write(fd, JSON.stringify({ pid: process.pid, token: myToken, createdAt: new Date().toISOString() }), null, 'utf8');
        await fs.fsync(fd);
        await fs.close(fd);
        return { token: myToken, lockPath };
    } catch (e) {
        if (e.code === 'EEXIST') {
            let holder = null;
            try {
                holder = JSON.parse(await fs.readFile(lockPath, 'utf8'));
            } catch { holder = { pid: null }; }
            let alive = false;
            if (typeof holder.pid === 'number') {
                try { process.kill(holder.pid, 0); alive = true; } catch { alive = false; }
            }
            if (alive) {
                throw new LockError(`已被进程 ${holder.pid} 锁定（${holder.createdAt || 'unknown'}）: ${lockPath}`);
            }
            throw new LockError(`存在遗留锁（持有者 PID ${holder.pid} 已不在）。请人工检查并删除 ${lockPath} 后重试。`);
        }
        throw e;
    }
}

function _releaseLockAt(lock) {
    const lockPath = lock.lockPath;
    try {
        const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (cur.token === lock.token) {
            fs.removeSync(lockPath);
        }
    } catch { /* 已不存在或非本 token，忽略 */ }
}

/**
 * repo 锁（maintDir/lock）：同一 repoDir 维护互斥。
 * 自守：完整链校验 + 逐段安全创建（不能先 ensureDir 再查，P1 三复审第 2 项）。
 */
async function acquireLock(maintDir) {
    await assertMaintDirChainReal(maintDir);
    return _acquireLockAt(path.join(maintDir, 'lock'));
}

async function releaseLock(maintDir, lock) {
    _releaseLockAt(lock);
}

/**
 * dataRoot 锁：相同 dataRoot 的不同 repoDir 共享互斥。
 * 锁文件位置由 dataRoot 绝对路径（Windows 大小写归一）派生（`<dataRoot 父目录>/.dsr-lock-<sha256(dataRoot)[:16]>`），
 * 因此两个不同 repoDir 只要指向同一 dataRoot 就会解析到同一把锁，实现跨 repo 互斥。
 * 该锁文件是「互斥锁」而非同步状态，落在数据根**之外**（父目录），不污染 chats 数据。
 * 先验证数据根及祖先为真实目录（非 symlink/junction），保证锁的是真实路径（P1 二检第 5 条）。
 */
function dataRootLockPath(stDataRoot) {
    const absRoot = normalizeIdentityPath(stDataRoot);
    const h = crypto.createHash('sha256').update(absRoot, 'utf8').digest('hex').slice(0, 16);
    return path.join(path.dirname(absRoot), `.dsr-lock-${h}`);
}

async function acquireDataRootLock(stDataRoot) {
    // 先验证真实根与祖先（非 symlink/junction），再取锁。
    await assertDataRootReal(stDataRoot);
    const lp = dataRootLockPath(stDataRoot);
    await safeEnsureDir(path.dirname(lp));
    return _acquireLockAt(lp);
}

function releaseDataRootLock(lock) {
    _releaseLockAt(lock);
}

module.exports = {
    SCHEMA_VERSION,
    CorruptStateError,
    LockError,
    DS_DIR_NAME,
    getMaintDir,
    bindTargetIdentity,
    normalizeIdentityPath,
    dataRootLockName,
    fileKeyForRel,
    assertRelWithinMaintDir,
    assertRealWithinMaintDir,
    atomicWriteJson,
    atomicWriteBytes,
    loadState,
    saveState,
    loadPending,
    writePending,
    clearPending,
    loadStage,
    writeStage,
    clearStage,
    writeConflictSnapshot,
    appendApplyJournal,
    appendApplyComplete,
    readApplyJournal,
    readVerifiedSnapshot,
    verifyPendingSnapshots,
    acquireLock,
    releaseLock,
    dataRootLockPath,
    acquireDataRootLock,
    releaseDataRootLock,
    isHex40,
    isHex64,
    isHex16,
    isRelPath,
    isChatRelPath,
    MANIFEST_SCHEMA_VERSION,
    activeManifestPath,
    loadApplyActive,
    writeApplyActive,
    clearApplyActive,
    clearStateFile,
    assertRepoDirReal,
    assertMaintDirChainReal,
    ensureMaintDirReal,
    safeEnsureDir,
    verifyFileForWrite,
};

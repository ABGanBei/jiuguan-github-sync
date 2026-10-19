'use strict';
/**
 * Git 对象与传输：fetch 固定 H → 临时 index 构造 tree（保留远端未改文件）→ commit-tree（唯一父 H）→ 普通 push。
 *
 * 关键（合同第 18/19/37/38 条；P1 第 2/11/12/14 项）：
 * - 复用 git-ops.gitWithEnv 的凭据/超时/重试，但**统一**凭据 transport：
 *   固定 ST_GITHUB_SYNC_TOKEN=resolveGithubToken(config)、ST_GITHUB_SYNC_TOKEN_FILE=''，
 *   避免 GITHUB_TOKEN 优先级不一致；不改真实凭据或 HOME。真实令牌不打印。
 * - 远端 tree 用 `ls-tree -rz` 以 NUL 枚举 mode/type/path（支持中文/空格/安全 Unicode），
 *   严格拒绝 symlink/submodule（gitlink）等非普通 blob；blob 以 Buffer 原字节读取（不丢 CRLF/BOM）。
 * - tree 从固定 H read-tree 到临时 index，只改本轮「确认可上传」路径；
 *   hash-object --no-filters（原字节，不经 CRLF filter）；绝不 git.add('.')。
 * - commit-tree 唯一父 H；push `commitId:refs/heads/<branch>`，禁止 force/pull/merge。
 * - 远端无分支 → 明确报「需先初始化」；网络/权限失败与空分支/未初始化区分，不统称 REMOTE_UNINITIALIZED。
 */
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const simpleGit = require('simple-git');
const gitOps = require('../git-ops');
const syncConfig = require('../sync-config');
const secrets = require('../secrets');
const { sha256Buffer, assertValidJsonlBytes, assertSafeRel, findCasefoldCollision } = require('./hash-scan');

class GitTreeError extends Error {
    constructor(message, code = 'GIT_TREE_ERROR') {
        super(message);
        this.name = 'GitTreeError';
        this.code = code;
    }
}

/** 基础 env（继承 process.env、剔除被 simple-git 拦截的键、注入超时/凭据相关）。 */
function baseEnv(config) {
    const env = gitOps.buildGitEnv(config);
    // 统一凭据 transport：ST_GITHUB_SYNC_TOKEN 优先，TOKEN_FILE 置空，
    // 使 askpass 回退优先级与 resolveGithubToken 一致（env 优先于 file）。
    const token = config ? syncConfig.resolveGithubToken(config) : '';
    env.ST_GITHUB_SYNC_TOKEN = token;
    env.ST_GITHUB_SYNC_TOKEN_FILE = '';
    return env;
}

/** 统一凭据 + askpass 的 env（用于 execFile 直接跑 git，绕过 simple-git 的 utf8 转换）。 */
function credEnv(config, extraEnv = {}) {
    const env = { ...baseEnv(config), ...extraEnv };
    const token = config ? syncConfig.resolveGithubToken(config) : '';
    if (token) {
        try {
            env.GIT_ASKPASS = secrets.ensureAskpassSync();
        } catch { /* 创建失败时降级为无凭据：git 会快速报鉴权错误 */ }
    }
    return env;
}

/**
 * 构造统一凭据 transport 的 git 实例（simple-git env 是「替换」语义，需整体重建）。
 * @param {string} repoDir
 * @param {Object} [config]
 * @param {Object} [extraEnv] 额外注入的 env（如 GIT_INDEX_FILE）
 */
function reliableGit(repoDir, config, extraEnv = {}) {
    const opts = {
        unsafe: { allowUnsafeAskPass: true },
        timeout: { block: gitOps.GIT_TIMEOUT_MS },
    };
    const git = repoDir ? simpleGit(repoDir, opts) : simpleGit(opts);
    const env = { ...credEnv(config), ...extraEnv };
    return git.env(env);
}

/** 脱敏：用已知 token 替换，避免 git 错误回显秘密。 */
function redactKnownToken(config, str) {
    const token = config ? syncConfig.resolveGithubToken(config) : '';
    let out = String(str);
    if (token) out = out.split(token).join('***');
    return gitOps.redactToken(out);
}

/**
 * 校验分支名符合 git check-ref-format，拒绝以 `-` 开头等可注入/非法名字。
 * @param {string} branch
 * @param {string} repoDir
 * @returns {Promise<string>} 规范化后的分支名
 */
async function checkBranchRef(branch, repoDir) {
    const git = reliableGit(repoDir, null);
    const b = String(branch || '').trim();
    if (!b || b.startsWith('-') || b.indexOf('\0') !== -1 || b.indexOf('\\') !== -1) {
        throw new GitTreeError(`分支名非法（禁止以 "-" 开头等）: ${branch}`, 'INVALID_BRANCH');
    }
    let out;
    try {
        out = await git.raw(['check-ref-format', '--branch', b]);
        out = String(out || '').trim();
    } catch (e) {
        throw new GitTreeError(`分支名未通过 git check-ref-format: ${branch}: ${redactKnownToken(null, e.message)}`, 'INVALID_BRANCH');
    }
    if (!out) {
        throw new GitTreeError(`分支名未通过 git check-ref-format: ${branch}`, 'INVALID_BRANCH');
    }
    return out;
}

/** 判断错误是否为「认证/权限/仓库不存在」类（不可重试、不应按未初始化处理）。 */
function isAuthOrNotFound(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return /authentication failed|invalid username or token|invalid credentials|permission denied|repository not found|could not read username|could not read password|not permitted|does not exist|not a git repository|remote.*not found|fatal:.*not found/.test(msg);
}

/** 判断错误是否为「远端确实没有该分支/引用」类（可视为未初始化）。 */
function isMissingRef(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return /couldn't find remote ref|could not find remote ref|remote ref.*not found|fatal: couldn't find/.test(msg);
}

/**
 * fetch 远端，固定 H = refs/remotes/origin/<branch>。
 * 区分：网络/权限失败 → GIT_FETCH_FAILED；远端无该分支（空仓库/未初始化）→ REMOTE_UNINITIALIZED。
 */
async function fetchRemote(config, repoDir) {
    await checkBranchRef(config.branch, repoDir);
    const git = reliableGit(repoDir, config);
    const remoteUrl = gitOps.buildRemoteUrl(config);
    await git.remote(['set-url', 'origin', remoteUrl]);
    try {
        await gitOps.withGitRetry(() => git.fetch('origin', config.branch), '抓取远程');
    } catch (e) {
        if (isMissingRef(e)) {
            throw new GitTreeError(
                `远端分支 "${config.branch}" 不存在（远端尚未初始化该分支，需先在远端初始化）: ${redactKnownToken(config, e.message)}`,
                'REMOTE_UNINITIALIZED'
            );
        }
        throw new GitTreeError(
            `抓取远端失败（网络或权限）: ${redactKnownToken(config, e.message)}`,
            'GIT_FETCH_FAILED'
        );
    }
    return resolveRemoteHead(config, repoDir);
}

/** 读 refs/remotes/origin/<branch>，得到固定 H。 */
async function resolveRemoteHead(config, repoDir) {
    await checkBranchRef(config.branch, repoDir);
    const git = reliableGit(repoDir, config);
    let head;
    try {
        head = await git.raw(['rev-parse', `refs/remotes/origin/${config.branch}`]);
        head = String(head || '').trim();
    } catch (e) {
        throw new GitTreeError(
            `远端分支 "${config.branch}" 不存在，需先初始化远端分支: ${redactKnownToken(config, e.message)}`,
            'REMOTE_UNINITIALIZED'
        );
    }
    if (!/^[0-9a-f]{40}$/.test(head)) {
        throw new GitTreeError(`远端 head 非法: ${head}`, 'REMOTE_UNINITIALIZED');
    }
    return head;
}

/**
 * 读取远端提交 H 的 tree 中某路径的 blob 内容（**原字节**，不经 simple-git 的 utf8 转换）。
 * - tree 证实该路径不存在 → 返回 null（唯一允许的 null）；
 * - commit 对象缺失 / 读取失败 / 非法 UTF-8（仅对 .jsonl）→ 抛错（不吞成 null）。
 *
 * 区分依据（P1 第 11 项）：`git show <commit>:<path>` 对「路径缺失」与「对象缺失」返回同样的
 * "path ... does not exist in ..." 错误，无法区分。改用两步：
 *   1) `git ls-tree -z <commit> -- <rel>`：commit 缺失 → 报 "not a tree object"（抛错）；
 *      路径缺失 → 空输出（exit 0）→ 返回 null；存在 → 返回该条目的 mode/type/hash。
 *   2) `git cat-file blob <hash>`：按对象 id 读原字节（不经过路径/quotePath 转换）。
 */
function readRemoteBlob(repoDir, commitH, rel) {
    const clean = assertSafeRel(rel);
    return new Promise((resolve, reject) => {
        const env = credEnv(null, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
        const run = (args, cb) => execFile('git', ['-C', repoDir, ...args], {
            env, timeout: gitOps.GIT_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024,
            encoding: 'buffer', // 关键：不按 UTF-8 解码，拿到原始字节（避免非法字节被转成 U+FFFD）
        }, cb);
        run(['ls-tree', '-z', commitH, '--', clean], (err, stdout, stderr) => {
            if (err) {
                reject(new GitTreeError(`读取远端 tree 条目失败（commit 可能缺失）: ${clean}: ${String(stderr || err.message || '')}`, 'BLOB_READ_FAILED'));
                return;
            }
            const out = Buffer.from(stdout || '');
            if (out.length === 0) {
                resolve(null); // tree 证实缺失（唯一允许的 null）
                return;
            }
            const entries = parseLsTreeZ(out);
            const ent = entries.find(e => e.path === clean) || entries[0];
            if (!ent || !/^[0-9a-f]{40}$/.test(ent.hash)) {
                reject(new GitTreeError(`远端 tree 条目非法: ${clean}`, 'BLOB_READ_FAILED'));
                return;
            }
            run(['cat-file', 'blob', ent.hash], (err2, stdout2, stderr2) => {
                if (err2) {
                    reject(new GitTreeError(`读取远端 blob 对象失败: ${clean}: ${String(stderr2 || err2.message || '')}`, 'BLOB_READ_FAILED'));
                    return;
                }
                let buf;
                try {
                    buf = Buffer.from(stdout2);
                } catch (e) {
                    reject(new GitTreeError(`读取远端 blob 失败: ${clean}: ${e.message}`, 'BLOB_READ_FAILED'));
                    return;
                }
                // 只有 .jsonl 才要求合法 UTF-8（严格校验后仍保留原字节，不重序列化）。
                if (clean.endsWith('.jsonl')) {
                    try {
                        assertValidJsonlBytes(buf, clean);
                    } catch (e) {
                        reject(new GitTreeError(`远端 ${clean} 非法 UTF-8/JSONL: ${e.message}`, 'INVALID_UTF8'));
                        return;
                    }
                }
                resolve(buf);
            });
        });
    });
}

/**
 * 解析 `ls-tree -rz` 的 NUL 分隔输出：每个条目为 `<mode> <type> <hash>\t<path>`。
 * 路径部分用严格 UTF-8（fatal）解码：非法 UTF-8 文件名直接抛错，绝不替换为 U+FFFD 或漏掉。
 */
function parseLsTreeZ(buf) {
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(buf));
    } catch (e) {
        throw new GitTreeError(`ls-tree 输出含非法 UTF-8（文件名编码非法，拒绝）: ${e.message}`, 'INVALID_UTF8');
    }
    const parts = text.split('\0');
    const entries = [];
    for (const raw of parts) {
        if (raw === '') continue;
        const tab = raw.indexOf('\t');
        if (tab < 0) continue;
        const meta = raw.slice(0, tab);
        const relPath = raw.slice(tab + 1);
        const m = meta.split(' ');
        if (m.length < 3) continue;
        entries.push({ mode: m[0], type: m[1], hash: m[2], path: relPath });
    }
    return entries;
}

/**
 * 跨路径大小写不敏感（casefold）碰撞检测：**逐段前缀**折叠，任何同一 casefold 前缀出现两种拼写即拒绝。
 * 覆盖同目录 basename 碰撞（`A.jsonl` vs `a.jsonl`）与祖先目录别名（`chats/Actor/a.jsonl` vs `chats/actor/a.jsonl`）。
 * 复用 hash-scan.findCasefoldCollision（纯函数，避免循环依赖），此处包装为 GitTreeError。
 * @param {Iterable<string>} rels  形如 `chats/A/x.jsonl` 的 posix 相对路径
 */
function assertNoCasefoldCollision(rels) {
    const hit = findCasefoldCollision(rels);
    if (hit) {
        throw new GitTreeError(
            `远端 tree 存在大小写不敏感碰撞（casefold 前缀冲突）: ${hit.a} vs ${hit.b}`,
            'UNSAFE_PATH'
        );
    }
}

/**
 * 读取远端 H 的 tree 中 chats/**\/*.jsonl 的每文件 blob 与哈希。
 * - 用 `ls-tree -rz` 以 NUL 枚举 mode/type/path（支持中文/空格/安全 Unicode）；输出走 execFile Buffer，
 *   严格 UTF-8（fatal）解码，非法文件名拒绝（不经 simple-git 的 UTF-8 替换）。
 * - **先**校验 `chats` 根及其全部后代条目的 mode/type（symlink/gitlink/tree 一律阻断），**再**做 .jsonl 后缀筛选；
 *   非 .jsonl 的 symlink/gitlink 也不能当「无数据」跳过。
 * - 严格拒绝 symlink/submodule 等非普通 blob（只有 `100644/100755` 普通 blob 参与 planner）；
 * - 远端「未改文件」也一并保留（不丢）；
 * - 同一目录内大小写不敏感碰撞（A.jsonl vs a.jsonl）阻断（跨路径 casefold 检测）；
 * - 读取错误抛错，只有 tree 证实缺失才把 blob 记 null（此处直接跳过缺失路径）。
 */
async function remoteHashesAt(repoDir, commitH, listBlobs = false) {
    // 1) 校验 chats 根条目本身（非递归 ls-tree）：拒绝 symlink/gitlink；缺失视为无数据。
    const rootEntries = await lsTreeRaw(repoDir, commitH, [], ['chats']);
    if (rootEntries.length > 0) {
        const root = rootEntries[0];
        assertBlobEntry(root, 'chats', true /* allowTree */);
    }

    // 2) 递归枚举 chats 下全部条目（execFile Buffer + fatal 解码）
    const entries = await lsTreeRaw(repoDir, commitH, ['-r'], ['chats']);

    // 3) 先校验全部后代条目的 mode/type，再筛选 .jsonl（问题 1：后缀筛选前阻断非 blob）
    const map = new Map();
    const allRels = []; // 所有后代条目的 rel（含非 .jsonl），供 casefold 碰撞检测
    for (const ent of entries) {
        let rel;
        try {
            rel = assertSafeRel(ent.path);
        } catch (e) {
            // 远端 tree 里的路径不安全（含 `..`/反斜杠等）→ 拒绝，不当作普通文件。
            throw new GitTreeError(`远端 tree 含不安全路径: ${ent.path}`, 'UNSAFE_PATH');
        }
        // 任何后代条目（无论是否 .jsonl）都必须先通过 mode/type 校验：symlink/gitlink/tree 一律阻断。
        assertBlobEntry(ent, rel, false);
        allRels.push(rel);

        if (!ent.path.endsWith('.jsonl')) continue;
        const blob = await readRemoteBlob(repoDir, commitH, rel);
        if (blob === null) continue; // tree 证实缺失：跳过
        map.set(rel, { hash: sha256Buffer(blob), size: blob.length, bytes: listBlobs ? blob : undefined, gitMode: ent.mode });
    }

    // 4) 跨路径大小写不敏感（casefold）碰撞检测：逐段前缀折叠，任何同一 casefold 前缀两种拼写一律拒绝
    //    （含非 .jsonl 条目、祖先目录别名 Actor vs actor）。即便远端 Git 对象可在大小写敏感文件系统上
    //    同时容纳，Windows 检出时会相互覆盖，属于远端输入边界，必须在读取时阻断。
    assertNoCasefoldCollision(allRels);
    return map;
}

/**
 * 校验单个 ls-tree 条目是「安全普通 blob」（或 tree，仅 chats 根允许）。
 * - symlink(120000) / submodule-gitlink(160000) / tree（后代里不允许）一律阻断。
 * - mode 只接受 100644/100755（普通 blob）。
 * @param {{mode:string,type:string,hash:string,path:string}} ent
 * @param {string} rel
 * @param {boolean} allowTree 是否允许 tree（仅 chats 根条目允许）
 */
function assertBlobEntry(ent, rel, allowTree) {
    if (!ent) {
        throw new GitTreeError(`远端 tree 条目缺失: ${rel}`, 'NON_BLOB_REJECTED');
    }
    if (ent.type === 'commit') {
        // submodule/gitlink
        throw new GitTreeError(`远端 ${rel} 是 submodule(gitlink)，拒绝`, 'NON_BLOB_REJECTED');
    }
    if (allowTree) {
        // chats 根条目必须严格是 tree（type==='tree' 且 mode==='040000'）；
        // 普通 blob（100644/100755）也明确抛错，不得因 rel 不含 chats/ 而当作「无数据」跳过。
        if (ent.type !== 'tree' || ent.mode !== '040000') {
            const what = ent.mode === '120000' ? 'symlink' : (ent.type === 'blob' ? '普通 blob' : `type=${ent.type}`);
            throw new GitTreeError(
                `远端 ${rel} 必须是目录（tree，mode=040000），实际是 ${what}（mode=${ent.mode}），拒绝`,
                'NON_BLOB_REJECTED'
            );
        }
        return;
    }
    if (ent.type === 'tree') {
        throw new GitTreeError(`远端 ${rel} 是目录（tree），不应出现在文件枚举中`, 'NON_BLOB_REJECTED');
    }
    if (ent.type !== 'blob') {
        // symlink 等在 ls-tree 中 type 也是 'blob' 但 mode=120000；这里兜底其他未知类型
        throw new GitTreeError(`远端 ${rel} 不是普通 blob（type=${ent.type}, mode=${ent.mode}）`, 'NON_BLOB_REJECTED');
    }
    if (ent.mode !== '100644' && ent.mode !== '100755') {
        throw new GitTreeError(`远端 ${rel} 的 mode 非法（${ent.mode}，symlink=120000 等一律拒绝）`, 'NON_BLOB_REJECTED');
    }
    if (!/^[0-9a-f]{40}$/.test(ent.hash)) {
        throw new GitTreeError(`远端 ${rel} 的 object id 非法: ${ent.hash}`, 'TREE_CORRUPT');
    }
}

/**
 * 直接 execFile 跑 `git ls-tree`（encoding:buffer），fatal 解码，不经 simple-git 的 UTF-8 替换。
 * 语法：`git ls-tree [-r] -z <commitH> [path...]`（tree-ish 必须在路径之前）。
 * @param {string} repoDir
 * @param {string} commitH
 * @param {string[]} opts  传给 ls-tree 的选项（不含 -z），如 ['-r'] 或 []
 * @param {string[]} paths 要枚举的路径（如 ['chats']）
 * @returns {Promise<Array<{mode:string,type:string,hash:string,path:string}>>}
 */
function lsTreeRaw(repoDir, commitH, opts, paths) {
    return new Promise((resolve, reject) => {
        const env = credEnv(null, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
        const fullArgs = ['-C', repoDir, 'ls-tree', '-z', ...opts, commitH, ...paths];
        execFile('git', fullArgs, {
            env, timeout: gitOps.GIT_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024,
            encoding: 'buffer',
        }, (err, stdout, stderr) => {
            if (err) {
                reject(new GitTreeError(`读取远端 tree 失败: ${String(stderr || err.message || '')}`, 'BLOB_READ_FAILED'));
                return;
            }
            const out = Buffer.from(stdout || '');
            if (out.length === 0) {
                resolve([]);
                return;
            }
            let entries;
            try {
                entries = parseLsTreeZ(out);
            } catch (e) {
                reject(e);
                return;
            }
            resolve(entries);
        });
    });
}

/**
 * 把 bytes 作为 blob 写入对象库并**读回验证**，返回 blob id。
 * - 落临时文件 → `hash-object --no-filters -w`（不经 CRLF filter，原字节）；
 * - 再 `cat-file blob <id>` 读回，逐字节比对，确保实际写入的 blob 与给定 bytes 完全一致
 *   （防「读 A → 写 B」的 TOCTOU：全程只依赖这一份 bytes，绝不二次读源路径）。
 * @param {string} repoDir
 * @param {import('simple-git').SimpleGit} git  已指向 GIT_INDEX_FILE 临时 index 的实例
 * @param {string} tmpDir
 * @param {Buffer} bytes
 * @param {string} rel
 * @returns {Promise<string>} blob object id
 */
async function writeBlobFromBytes(repoDir, git, tmpDir, bytes, rel) {
    const tmpFile = path.join(tmpDir, `dsr-blob-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    let blobId;
    await fs.writeFile(tmpFile, bytes);
    try {
        blobId = await git.raw(['hash-object', '--no-filters', '-w', '--', tmpFile]);
    } finally {
        await fs.remove(tmpFile).catch(() => {});
    }
    blobId = String(blobId || '').trim();
    if (!/^[0-9a-f]{40}$/.test(blobId)) {
        throw new GitTreeError(`hash-object 返回非法 blob id: ${blobId}`, 'BUILD_TREE_FAILED');
    }
    // 读回实际对象，逐字节比对，确保写入的 blob === 给定 bytes。
    // 用 execFile + encoding:buffer（simple-git .raw 会按 UTF-8 解码成 string，破坏原字节比对）。
    const written = await catFileBuffer(repoDir, blobId, rel);
    if (written.length !== bytes.length || !written.equals(bytes)) {
        throw new GitTreeError(`写入的 blob 与期望内容不一致（对象校验失败）: ${rel}`, 'BLOB_MISMATCH');
    }
    return blobId;
}

/**
 * 读对象库中某 blob 的原字节（execFile + encoding:buffer，不经 UTF-8 转换）。
 * @param {string} repoDir
 * @param {string} blobId
 * @param {string} rel
 * @returns {Promise<Buffer>}
 */
function catFileBuffer(repoDir, blobId, rel) {
    return new Promise((resolve, reject) => {
        const env = credEnv(null, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
        execFile('git', ['-C', repoDir, 'cat-file', 'blob', blobId], {
            env, timeout: gitOps.GIT_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024,
            encoding: 'buffer',
        }, (err, stdout, stderr) => {
            if (err) {
                reject(new GitTreeError(`cat-file 读取 blob 失败: ${rel}: ${String(stderr || err.message || '')}`, 'BLOB_READ_FAILED'));
                return;
            }
            resolve(Buffer.from(stdout || ''));
        });
    });
}

/**
 * 构造 tree：从 H read-tree 到临时 index，保留所有远端条目，仅覆盖 edits 中「确认可上传」的路径。
 * - edits 每个条目可带 bytes 或 absSnapshotPath；**两者都只读取一次**，从该份 bytes 构造 blob 并读回验证实际对象，
 *   绝不二次读源路径（防 path read A → Git read B 的 TOCTOU）。
 * - 若调用方提供 edit.hash，则额外校验 sha256(bytes) === edit.hash（内容哈希一致性）。
 * - 不用 shell 插值（全部走 raw 参数数组）。
 * @param {Object} config
 * @param {string} repoDir
 * @param {string} parentH   固定父提交
 * @param {Array<{rel: string, absSnapshotPath?: string, bytes?: Buffer, hash?: string}>} edits  已确认可上传路径
 * @returns {Promise<{treeId: string}>}
 */
async function buildTreeFromRemote(config, repoDir, parentH, edits) {
    const tmpIndex = path.join(os.tmpdir(), `dsr-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const tmpDir = path.dirname(tmpIndex);
    // 单独实例：GIT_INDEX_FILE 指向临时 index（read-tree/update-index/write-tree 全程）
    const git = reliableGit(repoDir, config, { GIT_INDEX_FILE: tmpIndex });
    try {
        // 1) read-tree 到临时 index（继承 H 全部条目）
        await git.raw(['read-tree', parentH]);
        // 2) 对每个确认上传文件：单次读取 bytes → hash-object --no-filters + cat-file 验证 → update-index --cacheinfo
        for (const edit of edits) {
            const rel = assertSafeRel(edit.rel);
            let actualBytes;
            if (Buffer.isBuffer(edit.bytes)) {
                actualBytes = Buffer.from(edit.bytes);
            } else {
                if (!edit.absSnapshotPath) {
                    throw new GitTreeError(`edit 缺少 bytes 或 absSnapshotPath: ${rel}`);
                }
                // 单次读取（问题 4）：读一次 bytes，后续构造/校验全部基于这一份，绝不二次读源路径。
                actualBytes = await fs.readFile(edit.absSnapshotPath);
            }
            // 校验期望 hash（若调用方提供）：确保这份 bytes 与期望内容一致。
            if (edit.hash && sha256Buffer(actualBytes) !== edit.hash) {
                throw new GitTreeError(`构造 tree 前内容哈希不匹配（期望 ${edit.hash}）: ${rel}`, 'HASH_MISMATCH');
            }
            const blobId = await writeBlobFromBytes(repoDir, git, tmpDir, actualBytes, rel);
            await git.raw(['update-index', '--add', '--cacheinfo', `100644,${blobId},${rel}`]);
        }
        // 3) write-tree
        let treeId = await git.raw(['write-tree']);
        treeId = String(treeId || '').trim();
        if (!/^[0-9a-f]{40}$/.test(treeId)) {
            throw new GitTreeError(`write-tree 返回非法 tree id: ${treeId}`);
        }
        return { treeId, tmpIndex };
    } catch (e) {
        if (e instanceof GitTreeError) throw e;
        throw new GitTreeError(`构造 tree 失败: ${redactKnownToken(config, e.message)}`, 'BUILD_TREE_FAILED');
    } finally {
        await fs.remove(tmpIndex).catch(() => {});
    }
}

/** commit-tree：以 parentH 为唯一父。 */
async function commitTree(config, repoDir, treeId, parentH, message) {
    const git = reliableGit(repoDir, config);
    const author = config.commitAuthor || { name: '酒管 Sync', email: 'st-sync@localhost' };
    const env = {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
    };
    const gitWithAuthor = reliableGit(repoDir, config, env);
    let commitId = await gitWithAuthor.raw(['commit-tree', treeId, '-p', parentH, '-m', message]);
    commitId = String(commitId || '').trim();
    if (!/^[0-9a-f]{40}$/.test(commitId)) {
        throw new GitTreeError(`commit-tree 返回非法 commit id: ${commitId}`);
    }
    return commitId;
}

/** 普通 push：commitId:refs/heads/<branch>，禁止 force。 */
async function pushBranch(config, repoDir, commitId) {
    await checkBranchRef(config.branch, repoDir);
    const git = reliableGit(repoDir, config);
    const remoteUrl = gitOps.buildRemoteUrl(config);
    await git.remote(['set-url', 'origin', remoteUrl]);
    try {
        await gitOps.withGitRetry(
            () => git.push('origin', `${commitId}:refs/heads/${config.branch}`, ['--no-force']),
            '推送'
        );
    } catch (e) {
        throw new GitTreeError(
            `推送失败（远端可能已被并发更新，非快进）: ${redactKnownToken(config, e.message)}`,
            'PUSH_REJECTED'
        );
    }
}

/** 判定 commitId 是否在远端分支可达：fetch 后 merge-base --is-ancestor。 */
async function isAncestorOfRemote(config, repoDir, commitId) {
    await checkBranchRef(config.branch, repoDir);
    const git = reliableGit(repoDir, config);
    try {
        await gitOps.withGitRetry(() => git.fetch('origin', config.branch), '抓取远程');
    } catch {
        // fetch 失败：无法确认可达，返回 false（调用方按不可达处理）
        return false;
    }
    const remoteRef = `refs/remotes/origin/${config.branch}`;
    try {
        await git.raw(['merge-base', '--is-ancestor', commitId, remoteRef]);
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    GitTreeError,
    reliableGit,
    redactKnownToken,
    fetchRemote,
    resolveRemoteHead,
    readRemoteBlob,
    remoteHashesAt,
    buildTreeFromRemote,
    commitTree,
    pushBranch,
    isAncestorOfRemote,
    checkBranchRef,
    parseLsTreeZ,
    lsTreeRaw,
    assertBlobEntry,
    assertNoCasefoldCollision,
    writeBlobFromBytes,
    catFileBuffer,
};

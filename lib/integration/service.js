'use strict';
/**
 * 服务工厂 createService(deps)：后端集成的核心编排。
 *
 * 只做「摘要安全」返回；所有真实 Git / 核心操作都在专用 worker 里跑；token 只经私有 tokenFile，
 * 绝不进 HTTP 参数 / URL / 进程参数 / 日志。自动检查默认关闭，开启仅定时 pull 暂存（不 apply）。
 *
 * 依赖注入（integration-contract.md 后端安全）：storageBase/home/hostRoot/dataRoot/workerRunner
 * 可注入用于测试；HTTP 层绝不控制 runner，远端 URL 映射只来自工厂参数，不来自请求体。
 */
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const crypto = require('crypto');
const storage = require('./storage');
const workerMod = require('./worker');
const redactMod = require('./redact');
const stateCore = require('../reliable/state'); // 仅用 bindTargetIdentity / openMaint 辅助，不接管锁

const VERSION = '1.3.0-preview.1';

class IntegrationError extends Error {
    constructor(message, code = 'INTEGRATION_ERROR', statusCode = 500) {
        super(message);
        this.name = 'IntegrationError';
        this.code = code;
        this.statusCode = statusCode;
    }
}

function err(message, code, statusCode = 500) {
    return new IntegrationError(message, code, statusCode);
}

/** 从请求对象解析当前用户身份；无身份 → 401。 */
function identityFromReq(req, service) {
    const handle = req && req.user && req.user.profile && req.user.profile.handle;
    const root = req && req.user && req.user.directories && req.user.directories.root;
    if (typeof handle !== 'string' || handle.length === 0) {
        throw err('缺少用户身份', 'UNAUTHORIZED', 401);
    }
    if (typeof root !== 'string' || root.length === 0) {
        throw err('缺少用户数据根', 'UNAUTHORIZED', 401);
    }
    storage.assertSafeHandle(handle);
    service._assertRootMatches(handle, root);
    return { handle, dataRoot: path.resolve(root) };
}

/** 校验请求体字段白名单；未知字段 → 400。 */
function assertKnownFields(body, allowed) {
    if (body == null) return;
    if (typeof body !== 'object' || Array.isArray(body)) {
        throw err('请求体必须是对象', 'BAD_REQUEST', 400);
    }
    for (const k of Object.keys(body)) {
        if (!allowed.includes(k)) {
            throw err(`未知请求字段: ${k}`, 'BAD_REQUEST', 400);
        }
    }
}

/** 计算目标身份（复用核心 bindTargetIdentity，保证与 .git/dsr 状态一致）。 */
function targetIdentityOf(githubRepo, branch, dataRoot) {
    return stateCore.bindTargetIdentity({ repo: githubRepo, branch, stDataRoot: dataRoot });
}

/**
 * 工厂入口。
 * @param {Object} deps
 * @param {string} [deps.storageBase]  每用户存储根（默认 ~/.jiuguan-github-sync）
 * @param {string} [deps.dataRoot]     全局 dataRoot（必须显式注入或来自真实 globalThis.DATA_ROOT；缺失抛 NO_DATA_ROOT，绝不 cwd fallback）
 * @param {string} [deps.hostRoot]     宿主根（默认 process.cwd()）
 * @param {Function} [deps.workerRunner]  测试注入：({task, env}) => Promise（默认真实 fork worker）
 * @param {Function} [deps.getUsers]     测试/生产注入：() => Promise<Array<{handle, directories:{root}}>>
 * @param {Function} [deps.failClosed]   测试注入：失败关闭（默认 process.exit）
 * @param {Function} [deps.log]          日志（默认 console）
 * @param {Function} [deps.loadRuntime]  测试注入：冷初始化加载 ({config, token}) 的可控钩子（默认真实 storage 读）
 * @param {Function} [deps.setTimeout]   测试注入时钟（默认全局 setTimeout）
 * @param {Function} [deps.clearTimeout] 测试注入时钟（默认全局 clearTimeout）
 */
function createService(deps = {}) {
    const storageBase = path.resolve(deps.storageBase || storage.DEFAULT_STORAGE_BASE);
    // 全局 dataRoot 必须显式注入（deps.dataRoot）或来自真实 globalThis.DATA_ROOT；
    // 缺失一律明确拒绝（P1 复审：不许 cwd fallback 冒充全局数据根）。
    const rawDataRoot = deps.dataRoot !== undefined ? deps.dataRoot : globalThis.DATA_ROOT;
    if (typeof rawDataRoot !== 'string' || rawDataRoot.length === 0) {
        throw new IntegrationError('缺少全局 dataRoot（未注入 dataRoot 且 globalThis.DATA_ROOT 缺失，拒绝 cwd fallback）', 'NO_DATA_ROOT', 500);
    }
    const globalDataRoot = path.resolve(rawDataRoot);
    const hostRoot = path.resolve(deps.hostRoot || process.cwd());
    const workerRunner = deps.workerRunner || ((task, opts) => {
        if (task.op === 'core') return workerMod.runCore(task, opts);
        if (task.op === 'connect') return workerMod.runConnect(task, opts);
        return workerMod.runWorkerTask(task, opts);
    });
    const getUsers = deps.getUsers || null; // 生产在 createPlugin 注入；此处 null 表示不扫描
    const failClosed = deps.failClosed || ((code) => { process.exit(code); });
    const log = deps.log || ((...a) => console.error('[github-data-sync]', ...a));
    // 测试注入：远端 URL 到本地 bare 的 insteadOf 映射（只来自工厂参数，HTTP 绝无控制）。
    const insteadOf = deps.insteadOf || null;
    // 测试注入时钟：不暴露 HTTP，仅工厂参数；生产用真实 setTimeout/clearTimeout。
    const setTimeoutFn = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const clearTimeoutFn = deps.clearTimeout || ((t) => clearTimeout(t));

    // per-user 运行时：{ config, busy, timer, lastOperation, lastError, lastOpAt, tokenKnown }
    const users = new Map();
    // per-handle 冷初始化去重：同一 handle 首次多请求并发进入 _getRuntime 时，只允许一个初始化 Promise，
    // 成功只落一个 runtime，失败 finally 清掉该 Promise 允许下次重试（防止 uA/uB 覆盖 busy）。
    const initializing = new Map();

    function _key(handle) {
        return storage.storageKey(globalDataRoot, handle);
    }

    async function _userDir(handle) {
        return storage.userDir(storageBase, globalDataRoot, handle);
    }

    function _repoDir(userDir) {
        return path.join(userDir, 'repo');
    }

    async function _maintDir(userDir) {
        return path.join(userDir, 'repo', '.git', 'dsr');
    }

    function _tokenKnown(handle) {
        const u = users.get(handle);
        return (u && u.tokenKnown) || '';
    }

    async function _loadConfig(handle) {
        const dir = await _userDir(handle);
        const raw = await storage.loadJson(storage.configPath(dir));
        const cfg = raw && typeof raw === 'object' ? raw : {};
        return {
            githubRepo: typeof cfg.githubRepo === 'string' ? cfg.githubRepo : '',
            branch: typeof cfg.branch === 'string' ? cfg.branch : 'main',
            autoCheckEnabled: cfg.autoCheckEnabled === true,
            autoCheckMinutes: Number.isFinite(cfg.autoCheckMinutes) ? cfg.autoCheckMinutes : 30,
        };
    }

    async function _saveConfig(handle, cfg) {
        const dir = await _userDir(handle);
        await storage.saveJson(storage.configPath(dir), {
            schemaVersion: 1,
            githubRepo: cfg.githubRepo,
            branch: cfg.branch,
            autoCheckEnabled: cfg.autoCheckEnabled,
            autoCheckMinutes: cfg.autoCheckMinutes,
        });
    }

    async function _loadIntent(handle) {
        const dir = await _userDir(handle);
        const raw = await storage.loadJson(storage.intentPath(dir));
        return raw && typeof raw === 'object' ? raw : null;
    }

    async function _saveIntent(handle, intent) {
        const dir = await _userDir(handle);
        await storage.saveJson(storage.intentPath(dir), intent);
    }

    async function _clearIntent(handle) {
        const dir = await _userDir(handle);
        const p = storage.intentPath(dir);
        await storage.removeFile(p);
    }

    // ---- 持久化执行 receipt（三次复审第 3 项：无 stage 幂等须真实凭据，不冒认成功） ----
    function _receiptPath(userDir) {
        return path.join(userDir, 'receipt.json');
    }

    async function _loadReceipt(handle) {
        const dir = await _userDir(handle);
        const raw = await storage.loadJson(_receiptPath(dir));
        return raw && typeof raw === 'object' ? raw : null;
    }

    async function _saveReceipt(handle, receipt) {
        const dir = await _userDir(handle);
        await storage.saveJson(_receiptPath(dir), receipt);
    }

    async function _clearReceipt(handle) {
        const dir = await _userDir(handle);
        await storage.removeFile(_receiptPath(dir));
    }

    async function _hasState(userDir) {
        return fs.pathExists(path.join(await _maintDir(userDir), 'state.json'));
    }

    // 冷初始化加载：默认走 storage（loadConfig + readToken）；测试可注入 deps.loadRuntime 制造可控并发窗口。
    // 只做「读」：绝不持有/重置 busy（busy 由 _tryAcquireBusy 统一管理）。
    const loadRuntime = deps.loadRuntime || (async (handle) => {
        const cfg = await _loadConfig(handle);
        const dir = await _userDir(handle);
        // storage.readToken 对「secrets 目录尚未创建（首次尚无 token）」仅 ENOENT 返回 ''，
        // 无需 pathExists workaround（pathExists 反而会吞掉 EACCES/link 等真实异常）。
        const token = await storage.readToken(dir);
        return { config: cfg, token };
    });

    async function _getRuntime(handle) {
        let u = users.get(handle);
        if (u) return u;
        // 已在初始化中：复用同一 Promise（成功只一个 runtime，失败 finally 清掉允许重试）。
        const existing = initializing.get(handle);
        if (existing) return existing;
        const p = (async () => {
            const loaded = await loadRuntime(handle);
            const runtime = {
                config: loaded.config,
                busy: false,
                timer: null,
                timerStopped: false,
                lastOperation: null,
                lastError: null,
                lastOpAt: null,
                lastConflicts: [],
                backoffMs: 0,
                tokenKnown: loaded.token,
            };
            users.set(handle, runtime);
            return runtime;
        })();
        initializing.set(handle, p);
        try {
            return await p;
        } finally {
            // 失败（loadRuntime 抛错）时清掉该 handle 的初始化 Promise，允许下次重试；成功也已清理。
            if (initializing.get(handle) === p) initializing.delete(handle);
        }
    }

    function _redactToken(handle, msg) {
        return redactMod.redact(_tokenKnown(handle), msg);
    }

    function _assertRootMatches(handle, root) {
        const abs = path.resolve(root);
        const expected = path.resolve(globalDataRoot, handle);
        // 精确匹配：root 必须严格等于 DATA_ROOT/handle（大小写不敏感平台归一），
        // 不允许 alice 的请求携带 bob 的 root（仅「在 base 之下」会放过 alice→bob 越权）。
        if (stateCore.normalizeIdentityPath(abs) !== stateCore.normalizeIdentityPath(expected)) {
            throw err('用户数据根与全局数据根/身份不符', 'UNAUTHORIZED', 401);
        }
        return abs;
    }

    /**
     * 异步校验 dataRoot 的目录链（DATA_ROOT → DATA_ROOT/handle）真实无 symlink/junction。
     * 精确匹配之外的「真实目录链」防御：不创建缺失段（handle 目录应由宿主存在），
     * 仅 ENOENT 视为「该用户数据根不存在」→ 401；其它 lstat 错误 / 链接 / 非目录 → 401。
     */
    async function _assertRootChainReal(handle, dataRoot) {
        const abs = _assertRootMatches(handle, dataRoot);
        for (const seg of [globalDataRoot, abs]) {
            let st;
            try {
                st = await fs.lstat(seg);
            } catch (e) {
                if (e && e.code === 'ENOENT') {
                    throw err(`用户数据根目录不存在: ${seg}`, 'UNAUTHORIZED', 401);
                }
                throw err(`数据根链 lstat 失败（非缺失）: ${seg}: ${e.message}`, 'UNAUTHORIZED', 401);
            }
            if (st.isSymbolicLink()) {
                throw err(`数据根链含符号链接/junction: ${seg}`, 'UNAUTHORIZED', 401);
            }
            if (!st.isDirectory()) {
                throw err(`数据根链非目录: ${seg}`, 'UNAUTHORIZED', 401);
            }
        }
        return abs;
    }

    /** 校验目标身份是否已绑定（换目标时拒绝）。 */
    async function _assertTargetUnchanged(handle, nextRepo, nextBranch, dataRoot) {
        const u = await _getRuntime(handle);
        const oldRepo = u.config.githubRepo;
        const oldBranch = u.config.branch || 'main';
        if (!oldRepo) return; // 从未配置过，允许
        if (oldRepo === nextRepo && oldBranch === nextBranch) return;
        // 目标变了：检查是否已有 state/pending/stage，有则拒绝（不清历史）
        const dir = await _userDir(handle);
        const maint = await _maintDir(dir);
        const hasState = await fs.pathExists(path.join(maint, 'state.json'));
        const hasPending = await fs.pathExists(path.join(maint, 'pending.json'));
        const hasStage = await fs.pathExists(path.join(maint, 'stage', 'stage.json'));
        if (hasState || hasPending || hasStage) {
            throw err('已有同步状态/pending/stage，拒绝切换目标（不清历史）。', 'TARGET_SWITCH_REJECTED', 409);
        }
    }

    // ============================== 公开方法 ==============================

    async function health() {
        return {
            success: true,
            version: VERSION,
            capabilities: { onlineSnapshot: true, startupApply: true },
            startupApplyOnly: true,
        };
    }

    async function getConfig(user) {
        const u = await _getRuntime(user.handle);
        return {
            success: true,
            config: {
                githubRepo: u.config.githubRepo,
                branch: u.config.branch || 'main',
                autoCheckEnabled: u.config.autoCheckEnabled,
                autoCheckMinutes: u.config.autoCheckMinutes,
            },
            hasToken: !!u.tokenKnown,
        };
    }

    async function putConfig(user, partial) {
        assertKnownFields(partial, ['githubRepo', 'branch', 'autoCheckEnabled', 'autoCheckMinutes', 'token']);
        return _withBusy(user, 'put-config', async () => {
            const u = await _getRuntime(user.handle);

            let repo = typeof partial.githubRepo === 'string' ? partial.githubRepo.trim() : u.config.githubRepo;
            let branch = typeof partial.branch === 'string' ? partial.branch.trim() : (u.config.branch || 'main');
            const autoCheckEnabled = typeof partial.autoCheckEnabled === 'boolean' ? partial.autoCheckEnabled : u.config.autoCheckEnabled;
            const autoCheckMinutes = Number.isFinite(partial.autoCheckMinutes) ? partial.autoCheckMinutes : u.config.autoCheckMinutes;

            if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
                throw err('githubRepo 必须为 "owner/repo"', 'INVALID_CONFIG', 400);
            }
            if (!branch || !/^[^\s~^:?*[\\]+$/.test(branch)) {
                throw err('branch 非法', 'INVALID_CONFIG', 400);
            }
            if (autoCheckMinutes < 1 || autoCheckMinutes > 10080) {
                throw err('autoCheckMinutes 必须在 1~10080', 'INVALID_CONFIG', 400);
            }

            // 换目标前校验（有 state/pending/stage 时拒绝）
            if (repo && (repo !== u.config.githubRepo || branch !== (u.config.branch || 'main'))) {
                await _assertTargetUnchanged(user.handle, repo, branch, user.dataRoot);
            }

            // token：仅非空时写入（空 token 保留原有）
            if (partial.token !== undefined && partial.token !== null) {
                const tok = String(partial.token);
                if (tok.trim()) {
                    const dir = await _userDir(user.handle);
                    await storage.writeToken(dir, tok.trim());
                    u.tokenKnown = tok.trim();
                }
            }

            const cfg = {
                githubRepo: repo || '',
                branch: branch || 'main',
                autoCheckEnabled,
                autoCheckMinutes,
            };
            u.config = cfg;
            await _saveConfig(user.handle, cfg);

            // 定时器随配置启停
            await _syncTimer(user.handle);

            return { success: true, config: { githubRepo: cfg.githubRepo, branch: cfg.branch, autoCheckEnabled: cfg.autoCheckEnabled, autoCheckMinutes: cfg.autoCheckMinutes }, hasToken: !!u.tokenKnown };
        });
    }

    async function connect(user, body) {
        assertKnownFields(body, ['initializeEmptyBranch']);
        return _withBusy(user, 'connect', async () => {
            const u = await _getRuntime(user.handle);
            if (!u.config.githubRepo) {
                throw err('尚未配置 githubRepo', 'NOT_CONFIGURED', 400);
            }
            const initializeEmptyBranch = body.initializeEmptyBranch === true;
            const dir = await _userDir(user.handle);
            const repoDir = _repoDir(dir);
            const tokenFile = (u.tokenKnown) ? path.join(dir, 'secrets', 'token') : '';
            const remoteUrl = `https://github.com/${u.config.githubRepo}.git`;

            // 1) 先 worker connect：本地 git init（建立 .git）+ add origin + 探测远端 +（可选）空分支 bootstrap。
            let res;
            try {
                res = await workerRunner({
                    op: 'connect',
                    repoDir,
                    branch: u.config.branch,
                    remoteUrl,
                    tokenFile,
                    initializeEmptyBranch,
                    insteadOf,
                    commitAuthor: { name: '酒管 Sync', email: 'st-sync@localhost' },
                });
            } catch (e) {
                u.lastError = _redactToken(user.handle, e.message);
                const code = e.code || 'CONNECT_FAILED';
                throw err(`连接失败：${u.lastError}`, code, code === 'GIT_AUTH_FAILED' ? 403 : 502);
            }

            // 2) 连接即「在线 init 真实 dataRoot」：建立本地 state（B 保留、身份一致幂等），
            //    否则后续 push/pull 会 NOT_INITIALIZED。init 在 connect 的 worker 里跑（同 worker，互斥）。
            try {
                await _runCore(user, 'init');
            } catch (e) {
                const code = e.code || 'CONNECT_INIT_FAILED';
                throw err(`连接初始化失败：${_redactToken(user.handle, e.message)}`, code, code === 'GIT_AUTH_FAILED' ? 403 : 502);
            }

            u.lastError = null;
            return { success: true, connected: true, initializedRemote: !!res.initializedRemote, needsRemoteInit: !!res.needsRemoteInit };
        });
    }

    /** 通用执行核心命令（在线 snapshot 模式，不伪造 offlineConfirmed）。 */
    async function _runCore(user, command, extra = {}) {
        const u = await _getRuntime(user.handle);
        const dir = await _userDir(user.handle);
        const repoDir = _repoDir(dir);
        const tokenFile = (u.tokenKnown) ? path.join(dir, 'secrets', 'token') : '';
        const task = {
            op: 'core',
            command,
            repoDir,
            dataRoot: user.dataRoot,
            githubRepo: u.config.githubRepo,
            branch: u.config.branch || 'main',
            tokenFile,
            executionMode: 'online-snapshot',
            commitAuthor: { name: '酒管 Sync', email: 'st-sync@localhost' },
            ...extra,
        };
        return workerRunner(task);
    }

    /**
     * 原子占用当前用户的同步互斥（与 _withBusy / _autoPull / status 共用同一个 u.busy gate）。
     * 先校验数据根目录链真实（DATA_ROOT → DATA_ROOT/handle 无 symlink/junction），
     * 再在单线程事件循环内同步判读并置位 u.busy（中间无 await，故原子）。
     * 返回「实际占用的 runtime 对象（lease）」；返回 null 表示已有操作在途（不抛错，调用方自行处理）。
     * 调用方必须在 try/finally 中释放**返回的同一对象**（u.busy=false），绝不重新查 map，
     * 避免冷初始化去重期间拿到不同对象导致永久 busy 或第二 worker 绕过。
     */
    async function _tryAcquireBusy(user) {
        await _assertRootChainReal(user.handle, user.dataRoot);
        const u = await _getRuntime(user.handle);
        if (u.busy) return null;
        u.busy = true;
        return u;
    }

    async function _withBusy(user, op, fn) {
        const u = await _tryAcquireBusy(user);
        if (!u) {
            throw err('已有同步操作进行中', 'LOCKED', 409);
        }
        u.lastOperation = op;
        u.lastError = null;
        u.lastOpAt = new Date().toISOString();
        try {
            return await fn();
        } catch (e) {
            u.lastError = _redactToken(user.handle, e.message);
            throw e;
        } finally {
            u.busy = false;
        }
    }

    async function push(user, body) {
        assertKnownFields(body, []); // push 不接受任何请求体字段（未知字段 400）
        return _withBusy(user, 'push', async () => {
            const u = await _getRuntime(user.handle);
            let res;
            try {
                res = await _runCore(user, 'push');
            } catch (e) {
                throw err(`推送失败：${_redactToken(user.handle, e.message)}`, e.code || 'PUSH_FAILED', e.code === 'PENDING_BLOCKED' || e.code === 'DELETE_PENDING' ? 409 : 502);
            }
            // 最近冲突结果安全保留（status 用，不永远 []）
            if (res && Array.isArray(res.conflicts)) u.lastConflicts = res.conflicts;
            else if (res && res.conflicts === undefined) { /* 无 conflict 键：保留上次 */ }
            return { success: true, result: _safeCoreResult(user.handle, res) };
        });
    }

    async function pull(user, body) {
        assertKnownFields(body, []); // pull 不接受任何请求体字段（未知字段 400）
        return _withBusy(user, 'pull', async () => {
            const u = await _getRuntime(user.handle);
            let res;
            try {
                res = await _runCore(user, 'pull');
            } catch (e) {
                throw err(`拉取失败：${_redactToken(user.handle, e.message)}`, e.code || 'PULL_FAILED', 502);
            }
            if (res && Array.isArray(res.conflicts)) u.lastConflicts = res.conflicts;
            return { success: true, result: _safeCoreResult(user.handle, res) };
        });
    }

    /** 仅摘要安全返回：去除 bytes/绝对路径/堆栈；字符串脱敏；**数组保持数组**（不得变 {0:...}），布尔/数字原样。 */
    function _safeCoreResult(handle, res) {
        if (Array.isArray(res)) {
            return res.map(v => _safeCoreResult(handle, v));
        }
        if (Buffer.isBuffer(res)) return undefined;
        if (typeof res === 'object' && res !== null) {
            const out = {};
            for (const [k, v] of Object.entries(res)) {
                const sv = _safeCoreResult(handle, v);
                if (sv === undefined) continue;
                out[k] = sv;
            }
            return out;
        }
        if (typeof res === 'string') {
            return _redactToken(handle, res);
        }
        return res; // boolean / number 原样
    }

    /**
     * 计算 stage / active manifest 的统一 canonical 摘要（用于 intent 绑定与恢复校验）。
     * 接受 stage 或 active manifest（二者 entries 均含 rel/candidatePath/candidateHash/
     * expectedBaselineHash/expectedLocalHash/expectedLocalMissing），绑定完整投影而非只 rel/hash：
     *   { stageId, targetIdentity, remoteHead, entries:[{rel, candidatePath, candidateHash,
     *     expectedBaselineHash, expectedLocalHash, expectedLocalMissing}] }
     * entries 按 rel 升序稳定排序，保证同一事务多次计算 digest 一致。
     */
    async function _stageDigest(stageOrActive) {
        if (!stageOrActive || !Array.isArray(stageOrActive.entries)) {
            throw err('stage/active manifest 缺少 entries，无法计算摘要', 'BAD_REQUEST', 500);
        }
        // 真实 active manifest 同时含 runId（apply 事务 id）与 stageId（pull 暂存 id），
        // 摘要绑定必须优先 stageId（intent 绑定的暂存身份），stage 本身只有 runId。
        const stageId = stageOrActive.stageId || stageOrActive.runId;
        if (typeof stageId !== 'string' || !stageId) {
            throw err('stage/active manifest 缺少 stageId/runId', 'BAD_REQUEST', 500);
        }
        const entries = stageOrActive.entries.map(e => ({
            rel: e.rel,
            candidatePath: e.candidatePath,
            candidateHash: e.candidateHash,
            expectedBaselineHash: e.expectedBaselineHash,
            expectedLocalHash: e.expectedLocalHash,
            expectedLocalMissing: e.expectedLocalMissing,
        })).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
        const canonical = {
            stageId,
            targetIdentity: stageOrActive.targetIdentity,
            remoteHead: stageOrActive.remoteHead,
            entries,
        };
        return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
    }

    async function scheduleApply(user, body) {
        assertKnownFields(body, ['stageId', 'clientsWillBeClosed']);
        return _withBusy(user, 'schedule-apply', async () => {
            const u = await _getRuntime(user.handle);
            if (body.clientsWillBeClosed !== true) {
                throw err('必须声明将关闭所有客户端（clientsWillBeClosed:true）', 'CLIENTS_NOT_CLOSED', 400);
            }
            const stageId = body.stageId;
            if (typeof stageId !== 'string' || !stageId) {
                throw err('需要 stageId', 'BAD_REQUEST', 400);
            }
            const dir = await _userDir(user.handle);
            const maint = await _maintDir(dir);
            const stage = await stateCore.loadStage(maint);
            if (!stage) {
                throw err('当前没有待应用的暂存（请先 pull）', 'NO_STAGE', 409);
            }
            if (stage.runId !== stageId) {
                throw err('stageId 与当前暂存不匹配', 'STAGE_ID_MISMATCH', 409);
            }
            const identity = targetIdentityOf(u.config.githubRepo, u.config.branch || 'main', user.dataRoot);
            if (stage.targetIdentity !== identity) {
                throw err('暂存目标身份与当前配置不符', 'STAGE_STALE', 409);
            }
            const digest = await _stageDigest(stage);
            const intent = {
                schemaVersion: 1,
                stageId,
                targetIdentity: identity,
                digest,
                entryCount: stage.entries.length,
                clientsWillBeClosed: true,
                createdAt: new Date().toISOString(),
            };
            await _saveIntent(user.handle, intent);
            u.lastOperation = 'schedule-apply';
            u.lastOpAt = new Date().toISOString();
            return { success: true, scheduled: { stageId } };
        });
    }

    async function cancelApply(user, body) {
        assertKnownFields(body, []); // cancel-apply 不接受请求体字段（未知字段 400）
        return _withBusy(user, 'cancel-apply', async () => {
            const u = await _getRuntime(user.handle);
            await _clearIntent(user.handle);
            u.lastOpAt = new Date().toISOString();
            return { success: true, cancelled: true };
        });
    }

    async function status(user) {
        await _assertRootChainReal(user.handle, user.dataRoot);
        const u = await _getRuntime(user.handle);
        const configured = !!u.config.githubRepo;
        let core = null;
        let stageId = null;
        let stagedFiles = [];
        let remoteSource = 'cached';
        let connected = false;
        let busy = u.busy;
        let probeError = null;

        // status 与所有 mutation/timer core 共享同一用户互斥：原子占用 u.busy。
        // 已有操作在途（mutation 或另一 status）→ 只返回 cached（不并发核心锁）；
        // 成功占用则 try/finally 释放（失败/异常也不漏释放）。
        if (configured) {
            const acquired = await _tryAcquireBusy(user);
            if (acquired) {
                const u = acquired; // 占用返回的同一对象（lease），finally 释放它，不重查 map
                try {
                    try {
                        const res = await _runCore(user, 'status');
                        core = _safeCoreResult(user.handle, res);
                        if (core && core.stage && Array.isArray(core.stage.entries)) {
                            stageId = core.stage.runId || null;
                            stagedFiles = core.stage.entries.map(e => (typeof e === 'string' ? e : (e && e.rel))).filter(Boolean);
                        }
                        connected = !!core && !core.remoteError;
                        remoteSource = (core && core.remoteHeadSource) || 'cached';
                        // 只读探测：远端错误通过 connected=false / core.remoteError 反映，
                        // 不写 lastOperation/lastError（不污染 mutation 的操作结果记录）。
                    } catch (e) {
                        // 核心 status 异常：不吞成 core=null 且不返回原因；用本次响应 probeError
                        // 单独字段承载脱敏后的原因（前端另任务接入），绝不写 lastOperation/lastError。
                        core = null;
                        connected = false;
                        probeError = _redactToken(user.handle, (e && e.message) || String(e));
                    }
                } finally {
                    u.busy = false;
                }
            } else {
                busy = true; // 已有 mutation/其它 status 在途：返回 cached + busy
            }
        }

        // conflicts 从最近一次真实操作结果安全保留（而非永远 []）。
        let conflicts = [];
        const lastConflicts = u.lastConflicts;
        if (Array.isArray(lastConflicts)) {
            conflicts = lastConflicts.map(c => _safeCoreResult(user.handle, c));
        }

        const intent = await _loadIntent(user.handle);
        return {
            success: true,
            status: {
                configured,
                connected,
                busy,
                stageId,
                stagedFiles,
                scheduledApply: intent ? { stageId: intent.stageId, createdAt: intent.createdAt } : null,
                lastOperation: u.lastOperation,
                lastError: u.lastError ? _redactToken(user.handle, u.lastError) : null,
                conflicts,
                core,
                remoteSource,
                probeError,
            },
        };
    }

    // ============================== 定时器 ==============================

    /** 基础间隔（毫秒）：autoCheckMinutes 分钟。 */
    function _baseMs(u) {
        return (u.config.autoCheckMinutes || 30) * 60 * 1000;
    }

    /** 退避封顶：至少 base 间隔，且封顶到 max(base, 1 小时) 的合理上限（不无限增长）。 */
    function _maxBackoffMs(u) {
        return Math.max(_baseMs(u), 60 * 60 * 1000);
    }

    /**
     * 单次调度下一次自动检查（setTimeout 单发，非 setInterval）。
     * 退避语义：每次 pull 完成后按结果决定下次延后；stopAll 后（timerStopped）绝不再重挂。
     */
    function _scheduleNext(handle, delayMs) {
        const u = users.get(handle);
        if (!u) return;
        if (u.timerStopped) return; // stopAll 后在途 auto 不重挂
        if (!u.config.autoCheckEnabled) return;
        if (u.timer) clearTimeoutFn(u.timer);
        u.timer = setTimeoutFn(() => {
            u.timer = null;
            _autoPull(handle).catch(() => {});
        }, delayMs);
        // unref：定时器不阻止进程退出（软关闭/休眠不保证，见 contract）。
        if (u.timer && typeof u.timer.unref === 'function') u.timer.unref();
    }

    /** 手动（重新）启用定时器：清旧 timer + 解除 stop 标记 + 若开启则立即调度一次。 */
    async function _syncTimer(handle) {
        const u = await _getRuntime(handle);
        if (u.timer) clearTimeoutFn(u.timer);
        u.timer = null;
        u.timerStopped = false;
        if (u.config.autoCheckEnabled) {
            _scheduleNext(handle, _baseMs(u));
        }
    }

    function _stopTimer(handle) {
        const u = users.get(handle);
        if (u && u.timer) {
            clearTimeoutFn(u.timer);
            u.timer = null;
        }
        if (u) u.timerStopped = true; // stop 后不再自动重挂
    }

    /** 自动检查：仅定时 pull 暂存（不 apply）；失败指数退避 + 记录真实最后错误；成功重置退避并恢复基础间隔。 */
    async function _autoPull(handle) {
        const u = await _getRuntime(handle);
        let delay = _baseMs(u);
        if (!u.config.githubRepo) return; // 未配置：不调度（等待 putConfig 再启用）
        if (!u.config.autoCheckEnabled) return;
        // 与 mutation/status 共用同一互斥：走 _tryAcquireBusy 拿 lease 对象（同 gate 原则）。
        // 已有操作在途 → 只重排下一次，不抢锁。
        const dataRoot = await _dataRootFor(handle);
        const lease = await _tryAcquireBusy({ handle, dataRoot });
        if (!lease) { _scheduleNext(handle, delay); return; }
        try {
            // 自动检查一致性：拿到同用户 lease 后、调用 core 前，先确认没有待应用 intent。
            // 若存在任何待应用 intent（用户已安排 stage），则保留原 stage/intent，绝不生成新 stage.runId
            // 覆盖用户安排，否则重启后会恒 stage mismatch（自动检查周期内重复 pull，B 未 apply 仍旧）。
            // 只重排 timer，不调用 pull、不更新 lastOperation/lastError。
            let intent;
            try {
                intent = await _loadIntent(handle);
            } catch (e) {
                // 读 intent 失败（EACCES/link/损坏 schema 等）：如实记录错误并退避，绝不吞成「无 intent」。
                lease.lastOperation = 'auto-pull';
                lease.lastOpAt = new Date().toISOString();
                lease.lastError = _redactToken(handle, (e && e.message) || String(e));
                lease.backoffMs = lease.backoffMs ? Math.min(lease.backoffMs * 2, _maxBackoffMs(lease)) : _baseMs(lease);
                delay = lease.backoffMs;
                return;
            }
            if (intent) {
                // 有 pending intent：保留原 stage/intent，仅正常重排 timer。
                delay = _baseMs(lease);
                return;
            }
            lease.lastOperation = 'auto-pull';
            lease.lastOpAt = new Date().toISOString();
            try {
                const res = await _runCore({ handle, dataRoot }, 'pull');
                // 自动 pull 与手动 pull 同一摘要逻辑：真实冲突也更新 u.lastConflicts（status 可见，不隐藏）。
                if (res && Array.isArray(res.conflicts)) lease.lastConflicts = res.conflicts;
                lease.lastError = null;
                lease.backoffMs = 0; // 成功重置
                delay = _baseMs(lease); // 成功恢复正常间隔
            } catch (e) {
                lease.lastError = _redactToken(handle, e.message);
                // 指数退避：首次失败=基础间隔，连续失败逐次翻倍，封顶 _maxBackoffMs（至少 base 间隔）。
                lease.backoffMs = lease.backoffMs ? Math.min(lease.backoffMs * 2, _maxBackoffMs(lease)) : _baseMs(lease);
                delay = lease.backoffMs;
            }
        } finally {
            // 释放 lease 与重排下一次调度放在同一 finally：保证任何 return（intent 存在 / 读 intent 失败）
            // 也必经此重排，定时器不停摆；stopAll 后 _scheduleNext 内部有 timerStopped 守卫不再挂。
            lease.busy = false;
            _scheduleNext(handle, delay);
        }
    }

    /** 启动时恢复「持久化已开启」的定时器：从官方枚举初始化并安排 timer，无需用户再保存。 */
    async function startTimers() {
        if (!getUsers) return;
        const list = await getUsers();
        if (!Array.isArray(list)) return;
        for (const item of list) {
            if (!item || typeof item.handle !== 'string') continue;
            const rt = await _getRuntime(item.handle);
            if (rt.config.autoCheckEnabled) {
                await _syncTimer(item.handle);
            }
        }
    }

    /** 记录启动期预检失败到 runtime lastError（status 可见，不只 console）。 */
    async function recordPrecheckFailed(handle, message) {
        const u = await _getRuntime(handle);
        u.lastOperation = 'startup-precheck';
        u.lastOpAt = new Date().toISOString();
        u.lastError = `启动期应用预检失败: ${_redactToken(handle, message || '')}`;
    }

    /** 反查某用户的数据根（严格：只从 getUsers 的 {handle,root} 取，绝不 fallback 到 globalDataRoot）。 */
    async function _dataRootFor(handle) {
        if (!getUsers) {
            throw err('缺少用户枚举（getUsers 未注入），无法解析数据根', 'UNAUTHORIZED', 401);
        }
        const list = await getUsers();
        if (!Array.isArray(list)) {
            throw err('用户枚举返回非数组', 'UNAUTHORIZED', 401);
        }
        const hit = list.find(x => x && x.handle === handle);
        if (!hit || typeof hit.root !== 'string' || !hit.root) {
            throw err(`无法解析用户 ${handle} 的数据根`, 'UNAUTHORIZED', 401);
        }
        const root = path.resolve(hit.root);
        // 精确校验 root === DATA_ROOT/handle，且目录链真实（拒绝 fallback / 越权）。
        await _assertRootChainReal(handle, root);
        return root;
    }

    function stopAll() {
        for (const handle of users.keys()) {
            _stopTimer(handle);
        }
    }

    // 暴露给 startup / api 使用
    const service = {
        VERSION,
        globalDataRoot,
        storageBase,
        hostRoot,
        getUsers,
        failClosed,
        log,
        identityFromReq: (req) => identityFromReq(req, service),
        _assertRootMatches,
        _assertRootChainReal,
        _dataRootFor,
        assertKnownFields,
        health,
        getConfig,
        putConfig,
        connect,
        push,
        pull,
        scheduleApply,
        cancelApply,
        status,
        _runCore,
        _tryAcquireBusy,
        _safeCoreResult,
        _loadIntent,
        _clearIntent,
        _saveIntent,
        _loadReceipt,
        _saveReceipt,
        _clearReceipt,
        _getRuntime,
        _userDir,
        _repoDir,
        _maintDir,
        _hasState,
        _stageDigest,
        _tokenKnown,
        _redactToken,
        stopAll,
        _stopTimer,
        _syncTimer,
        _scheduleNext,
        _autoPull,
        startTimers,
        recordPrecheckFailed,
    };
    return service;
}

module.exports = {
    IntegrationError,
    VERSION,
    createService,
    identityFromReq,
    assertKnownFields,
    targetIdentityOf,
    err,
};

'use strict';
/**
 * worker 运行器：fork `process.execPath`（无 shell）跑专用子进程入口 worker-entry.js。
 *
 * 安全（integration-contract.md 后端安全）：
 * - fork 前清空继承的 token / GIT_CONFIG* / askpass / SSH / 凭据环境变量；
 * - 忽略系统全局 Git 配置（GIT_CONFIG_NOSYSTEM=1），禁交互；
 * - 为**每个用户 worker**创建专用 private git-home（真实无链接，位于 task.repoDir 之上的
 *   存储目录内），worker 的 HOME / USERPROFILE / XDG_CONFIG_HOME 指向该 home，
 *   GIT_CONFIG_GLOBAL 指向该 home 下的空 .gitconfig —— 彻底隔离宿主 HOME/.gitconfig
 *   （删除 GIT_CONFIG_GLOBAL 变量并不等于忽略 HOME/.gitconfig）；
 * - 额外剔除 GIT_TRACE* / GIT_CURL_VERBOSE / NODE_OPTIONS 等可注入/泄密环境，保留 PATH；
 * - token 只从「当前用户」私有 tokenFile 读取，绝不进命令行参数 / URL / 进程参数 / 日志；
 * - 结果回传后主动 disconnect + kill，worker 自然退出、不常驻；超时兜底杀子树（含 Git 子进程）；
 * - stderr 不直接继承泄漏，收集后经通用脱敏再决定是否附带。
 *
 * 测试注入：`runner` 可被 createService 依赖注入替换（但 HTTP 层绝不控制 runner，
 * 远端 URL 映射只来自工厂参数，不来自请求体）。
 */
const { fork, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

const redact = require('./redact');
const storage = require('./storage');

const WORKER_ENTRY = path.join(__dirname, 'worker-entry.js');

/**
 * 需要从子进程环境剔除的键：
 * - **默认剔除全部继承的 `GIT_*`**（含 GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR / GIT_INDEX_FILE /
 *   GIT_OBJECT_DIRECTORY / GIT_ALTERNATE_OBJECT_DIRECTORIES / GIT_NAMESPACE / GIT_DISCOVERY_ACROSS_FILESYSTEM
 *   等目录/索引重定向键——否则会让 git config / remote 作用到宿主其它仓库）；
 * - 凭据/注入/泄密类非 GIT 键（GITHUB_TOKEN / GH_TOKEN / SSH_* / NODE_OPTIONS / EDITOR / PAGER / VISUAL …）。
 *
 * 显式安全白名单（GIT_ENV_SAFE）：worker 自身需要的、既不重定向目录也不泄密的键，
 * 剔除后由 scrubbedEnv 显式加回（或仅允许从 opts.env 工厂参数注入），其余 GIT_* 一律不保留。
 */
const SCRUB_ENV_RE = /^(GIT_.*|GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|GH_PAT|GH_ENTERPRISE_TOKEN|ST_GITHUB_SYNC_TOKEN|ST_GITHUB_SYNC_TOKEN_FILE|SSH_ASKPASS|SSH_AUTH_SOCK|NODE_OPTIONS|NODE_REPL_HISTORY|EDITOR|PAGER|PREFIX|VISUAL)$/i;

/** worker 显式允许的 GIT 白名单（非目录重定向、非泄密）。GCM_INTERACTIVE 不以 GIT_ 开头，走普通 extra。 */
const GIT_ENV_SAFE = new Set(['GIT_ALLOW_PROTOCOL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT']);

class WorkerError extends Error {
    constructor(message, code = 'WORKER_ERROR', extra) {
        super(message);
        this.name = 'WorkerError';
        this.code = code;
        if (extra) Object.assign(this, extra);
    }
}

/**
 * 校验一个「必须为空」的 git 配置文件（.gitconfig / XDG git/config）：
 * - 父链已由调用方 safeEnsureDir 保证真实无链接；
 * - 目标若存在必须是普通文件且非链接；内容必须为空（不信其 include / helper / 任何键）；
 * - 仅 ENOENT 视为「将生成」，安全创建为空的普通配置（0600）。
 * @param {string} absPath
 * @param {string} what 用途名（错误信息用）
 */
async function verifyEmptyGitConfig(absPath, what) {
    let st;
    try {
        st = await fs.lstat(absPath);
    } catch (e) {
        if (e && e.code === 'ENOENT') {
            await fs.writeFile(absPath, '', { mode: 0o600 });
            return;
        }
        throw new WorkerError(`${what} lstat 失败（非缺失）: ${e.message}`, 'GIT_HOME_UNSAFE');
    }
    if (st.isSymbolicLink()) throw new WorkerError(`${what} 是符号链接，拒绝`, 'GIT_HOME_UNSAFE');
    if (!st.isFile()) throw new WorkerError(`${what} 不是普通文件，拒绝`, 'GIT_HOME_UNSAFE');
    let content;
    try {
        content = await fs.readFile(absPath, 'utf8');
    } catch (e) {
        throw new WorkerError(`${what} 读取失败: ${e.message}`, 'GIT_HOME_UNSAFE');
    }
    if (String(content || '').trim() !== '') {
        throw new WorkerError(`${what} 非空，拒绝（不信其 include/helper/配置）`, 'GIT_HOME_UNSAFE');
    }
}

/**
 * 每用户专用 private git-home：位于 task.repoDir 之上的存储目录内（repo 的同级 `git-home/`）。
 * 真实无链接、逐段安全创建；内含空 .gitconfig 供 GIT_CONFIG_GLOBAL 指向（隔离宿主 HOME/.gitconfig）。
 * 同时核验 XDG_CONFIG_HOME（$git-home/.config/git/config）亦为空普通文件，彻底不信宿主配置。
 * @param {Object} task
 * @returns {Promise<string>} git-home 绝对路径
 */
async function prepareGitHome(task) {
    const repoDir = path.resolve(task.repoDir || '');
    // git-home 必须位于 repoDir 的父目录（用户存储目录）之内，而非 repoDir 自身。
    const parent = path.dirname(repoDir);
    const gitHome = path.join(parent, 'git-home');
    // 真实无链接：逐段校验/创建（拒绝 symlink/junction 祖先），不 realpath 解析链接。
    await storage.safeEnsureDir(gitHome);
    let st = await fs.lstat(gitHome);
    if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new WorkerError(`git-home 是链接或非目录: ${gitHome}`, 'GIT_HOME_UNSAFE');
    }
    try { await fs.chmod(gitHome, 0o700); } catch { /* Windows chmod 非 ACL，忽略 */ }

    // XDG_CONFIG_HOME 指向 $git-home/.config：真实无链接创建，且其中 git/config（若存在）必须为空普通文件。
    const xdgDir = path.join(gitHome, '.config');
    await storage.safeEnsureDir(xdgDir);
    const xdgGitConfig = path.join(xdgDir, 'git', 'config');
    // 仅当 xdg/git 目录已存在时才核验（避免为「空配置」主动创建 xdg/git 结构）；不存在则 git 回退 HOME/.gitconfig。
    if (await fs.pathExists(path.join(xdgDir, 'git'))) {
        const gitDirSt = await fs.lstat(path.join(xdgDir, 'git')).catch(() => null);
        if (gitDirSt && (gitDirSt.isSymbolicLink() || !gitDirSt.isDirectory())) {
            throw new WorkerError(`XDG git 目录是链接或非目录: ${path.join(xdgDir, 'git')}`, 'GIT_HOME_UNSAFE');
        }
        await verifyEmptyGitConfig(xdgGitConfig, 'XDG git/config');
    }

    // 空 .gitconfig：让 GIT_CONFIG_GLOBAL 指向它，忽略宿主 HOME/.gitconfig。
    await verifyEmptyGitConfig(path.join(gitHome, '.gitconfig'), '.gitconfig');
    return gitHome;
}

/** 构造净化后的子进程环境：默认剔除全部继承 GIT_* 与泄密键，再显式加回安全白名单。 */
function scrubbedEnv(extra = {}) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue;
        if (SCRUB_ENV_RE.test(k)) continue;
        env[k] = v;
    }
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_TERMINAL_PROMPT = '0';
    env.GCM_INTERACTIVE = 'never';
    // extra 仅允许显式安全白名单键（如工厂参数注入的 GIT_ALLOW_PROTOCOL=file）；
    // 其余 GIT_* 目录/索引重定向键即使出现在 extra 也一律不保留（不保留目标重定向）。
    for (const [k, v] of Object.entries(extra || {})) {
        if (v === undefined) continue;
        if (/^GIT_/i.test(k) && !GIT_ENV_SAFE.has(String(k).toUpperCase())) continue;
        env[k] = v;
    }
    return env;
}

/** 强制杀子树（含 git 子进程），Windows 用 taskkill /T，POSIX 用 detached 进程组负 pid SIGKILL。 */
function killTree(child) {
    if (!child || !child.pid) return;
    try {
        if (process.platform === 'win32') {
            execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
            // fork 时已设 detached:true → 子进程自成进程组，-pid 即整个进程组（含其下 git 子进程）。
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 非进程组 */ }
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
}

/**
 * fork 并执行一个任务（op='core'|'connect'），返回结果或抛 WorkerError。
 * @param {Object} task  含 op 与 payload（含 repoDir，用于派生专用 git-home）
 * @param {Object} [opts]  { timeoutMs, env }
 * @returns {Promise<any>}
 */
async function runWorkerTask(task, opts = {}) {
    const timeoutMs = opts.timeoutMs || 180000;
    const gitHome = await prepareGitHome(task);
    const childEnv = scrubbedEnv({
        HOME: gitHome,
        USERPROFILE: gitHome,
        XDG_CONFIG_HOME: path.join(gitHome, '.config'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        ...(opts.env || {}),
    });

    return new Promise((resolve, reject) => {
        let settled = false;
        let stderrBuf = Buffer.alloc(0);

        const forkOpts = {
            execPath: process.execPath,
            env: childEnv,
            // stderr 收集（不直接 inherit），避免 git 回显 token 到父进程日志。
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        };
        // POSIX 设 detached:true → worker 自成进程组，超时 killTree 可用负 pid 回收整组（含 git 子进程）。
        if (process.platform !== 'win32') forkOpts.detached = true;
        const child = fork(WORKER_ENTRY, [], forkOpts);

        const finish = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { child.disconnect(); } catch { /* ignore */ }
            // 双保险：短时间后仍未退出则杀子树，确保 worker 不常驻/不残留 Git。
            const killT = setTimeout(() => { if (!child.killed && child.exitCode === null) killTree(child); }, 1500);
            killT.unref && killT.unref();
            if (err) reject(err);
            else resolve(child._result);
        };

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            killTree(child);
            const extra = stderrBuf.length ? { stderr: redact.redact('', stderrBuf.toString('utf8').slice(0, 4096)) } : {};
            reject(new WorkerError(`worker 超时（${timeoutMs}ms）`, 'WORKER_TIMEOUT', extra));
        }, timeoutMs);

        child.stderr.on('data', (d) => {
            if (stderrBuf.length < 64 * 1024) stderrBuf = Buffer.concat([stderrBuf, d]);
        });

        child.on('message', (msg) => {
            if (msg && msg.ready) return;
            if (settled) return;
            clearTimeout(timer);
            if (!msg || typeof msg !== 'object') {
                const extra = stderrBuf.length ? { stderr: redact.redact('', stderrBuf.toString('utf8').slice(0, 4096)) } : {};
                finish(new WorkerError('worker 返回异常消息', 'WORKER_ERROR', extra));
                return;
            }
            if (msg.ok) {
                child._result = msg.result;
                finish(null);
            } else {
                const code = (msg.error && msg.error.code) || 'WORKER_ERROR';
                const extra = stderrBuf.length ? { stderr: redact.redact('', stderrBuf.toString('utf8').slice(0, 4096)) } : {};
                finish(new WorkerError((msg.error && msg.error.message) || 'worker 失败', code, extra));
            }
        });

        child.on('error', (err) => {
            if (settled) return;
            const extra = stderrBuf.length ? { stderr: redact.redact('', stderrBuf.toString('utf8').slice(0, 4096)) } : {};
            finish(new WorkerError(`worker 启动失败: ${err.message}`, 'WORKER_ERROR', extra));
        });

        child.on('exit', (code) => {
            // worker 提前退出（未回传结果）→ 视为失败；已 settle 则忽略。
            if (settled) return;
            const extra = stderrBuf.length ? { stderr: redact.redact('', stderrBuf.toString('utf8').slice(0, 4096)) } : {};
            finish(new WorkerError(`worker 提前退出（code=${code}）`, 'WORKER_ERROR', extra));
        });

        child.send(task);
    });
}

/** 跑核心命令。 */
function runCore(task, opts) {
    return runWorkerTask({ op: 'core', ...task }, opts);
}

/** 跑 connect。 */
function runConnect(task, opts) {
    return runWorkerTask({ op: 'connect', ...task }, opts);
}

module.exports = {
    WorkerError,
    WORKER_ENTRY,
    SCRUB_ENV_RE,
    GIT_ENV_SAFE,
    scrubbedEnv,
    prepareGitHome,
    verifyEmptyGitConfig,
    killTree,
    runWorkerTask,
    runCore,
    runConnect,
};

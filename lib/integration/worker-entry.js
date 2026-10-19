'use strict';
/**
 * 专用 worker 子进程入口：在 fork 出来的干净环境里执行 Git / 核心操作。
 *
 * 与 lib/integration/worker.js 配套：父进程 fork 本文件（process.execPath，无 shell），
 * 通过 IPC 发送 JSON 任务，本文件执行后回传 `{ id, ok, result | error }`，随后**自然退出**
 * （不常驻监听，避免父进程忘记 disconnect 时泄漏 worker / Git 子进程）。
 *
 * 安全（integration-contract.md 后端安全）：
 * - fork 前父进程已清空继承的 token / GIT_CONFIG* / askpass / SSH / trace / NODE_OPTIONS 环境；
 * - 这里再兜底忽略系统全局 Git 配置、禁交互、`credential.helper=` 置空；
 * - connect 用 git-ops.buildGitEnv 接入私有 tokenFile（token 只文件读取，不进命令行/URL/日志），
 *   覆盖 fetch 探测与空分支 bootstrap push；
 * - 回传 error 前用已知 token 脱敏，避免 git 错误回显秘密。
 */
const path = require('path');
const fs = require('fs-extra');
const simpleGit = require('simple-git');
const orchestrator = require('../reliable/orchestrator');
const gitOps = require('../git-ops');
const secrets = require('../secrets');
const stateMod = require('../reliable/state');

const redact = require('./redact');

/**
 * 兜底环境清理（与父进程 worker.js 的 scrubbedEnv 对齐）：
 * - **默认剔除全部继承的 `GIT_*`**（含 GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR / GIT_INDEX_FILE /
 *   GIT_OBJECT_DIRECTORY / GIT_ALTERNATE_OBJECT_DIRECTORIES 等目录/索引重定向键）；
 * - 凭据/注入/泄密类非 GIT 键；
 * - 显式安全白名单（GIT_ALLOW_PROTOCOL / GIT_CONFIG_NOSYSTEM / GIT_TERMINAL_PROMPT / GCM_INTERACTIVE）
 *   由本函数显式加回，不误清 worker 自己需要设置的安全值。
 * 返回净化后的新环境对象（纯函数，供调用方应用）。
 */
const SCRUB_ENV_RE = /^(GIT_.*|GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|GH_PAT|GH_ENTERPRISE_TOKEN|ST_GITHUB_SYNC_TOKEN|ST_GITHUB_SYNC_TOKEN_FILE|SSH_ASKPASS|SSH_AUTH_SOCK|NODE_OPTIONS|NODE_REPL_HISTORY|EDITOR|PAGER|PREFIX|VISUAL)$/i;

function scrubEnv(env) {
    const out = {};
    for (const [k, v] of Object.entries(env || process.env)) {
        if (v === undefined) continue;
        if (SCRUB_ENV_RE.test(k)) continue;
        out[k] = v;
    }
    out.GIT_CONFIG_NOSYSTEM = '1';
    out.GIT_TERMINAL_PROMPT = '0';
    out.GCM_INTERACTIVE = 'never';
    return out;
}

/**
 * 真正执行环境兜底清理：把 process.env 替换为 scrubEnv 的结果。
 * （此前 scrubEnv 定义了却从未被调用，是死代码——继承的 GIT_* 目录重定向未被兜底清除。）
 * 在任务执行前调用一次即可：之后 buildGitEnv 基于净化后的 process.env 构造凭据 env，
 * 注入的 GIT_ASKPASS / ST_GITHUB_SYNC_TOKEN_FILE 只进 simple-git 的 env，不再写回 process.env。
 */
function applyEnvScrub() {
    const cleaned = scrubEnv(process.env);
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, cleaned);
}
// 作为 IPC 子进程时（process.send 存在）自动兜底清理继承环境；
// 被测试直接 require 时（无 process.send）不自动执行，由测试显式调用 applyEnvScrub()。
if (typeof process.send === 'function') applyEnvScrub();

/** 读取 tokenFile 的 token（仅用于脱敏回传错误；真实凭据由 buildGitEnv/askpass 走文件读取）。 */
function readTokenForRedact(tokenFile) {
    try {
        if (tokenFile && typeof tokenFile === 'string') return secrets.readTokenFromFile(tokenFile);
    } catch { /* ignore */ }
    return '';
}

/** 构造 connect 用的 simple-git 实例：凭据走 gitOps.buildGitEnv（token 只文件读取）。 */
function connectGit(repoDir, task) {
    const cfg = {
        githubRepo: task.githubRepo || '',
        branch: task.branch || 'main',
        tokenFile: task.tokenFile || '',
    };
    // buildGitEnv 继承当前（已净化的）process.env、剔除被 simple-git 拦截的键、注入 askpass + tokenFile。
    const env = gitOps.buildGitEnv(cfg);
    // 隔离全局/系统配置：HOME/USERPROFILE 已被父进程指向专用 git-home（空 .gitconfig），
    // 不手动注入 GIT_CONFIG_GLOBAL（会被 simple-git 拦截且 buildGitEnv 已按安全策略剔除该键）。
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_TERMINAL_PROMPT = '0';
    env.GCM_INTERACTIVE = 'never';
    const opts = {
        unsafe: {
            allowUnsafeAskPass: true,
            allowUnsafeCredentialHelper: true,
            allowUnsafePager: true,
            allowUnsafeConfig: true,
            allowUnsafeRemote: true,
            allowUnsafeUrl: true,
        },
        timeout: { block: gitOps.GIT_TIMEOUT_MS },
    };
    return simpleGit(repoDir, opts).env(env);
}

/** 跑核心命令：透传 executionMode 给 orchestrator.run（在线 snapshot 模式等待核心落地）。 */
async function runCore(task) {
    const opts = {
        command: task.command,
        repoDir: task.repoDir,
        dataRoot: task.dataRoot,
        githubRepo: task.githubRepo,
        branch: task.branch || 'main',
        tokenFile: task.tokenFile || '',
        executionMode: task.executionMode || 'offline',
        blockPendingRecovery: task.command === 'pull',
        // 仅「真正应用」（startup apply）由用户显式安排关客户端后，才带 offlineConfirmed。
        offlineConfirmed: task.offlineConfirmed === true ? true : undefined,
        stageId: task.stageId,
        commitAuthor: task.commitAuthor,
    };
    return orchestrator.run(opts);
}

/** 判断 git 错误是否属于「远端无该分支/引用」类。 */
function isMissingRefMsg(msg) {
    return /couldn't find remote ref|could not find remote ref|remote ref.*not found|fatal: couldn't find/.test(msg);
}

/** 判断 git 错误是否属于「鉴权/权限/仓库不存在」类。 */
function isAuthMsg(msg) {
    return /authentication failed|invalid username or token|invalid credentials|permission denied|repository not found|not found|could not read username|could not read password/.test(msg);
}

/**
 * 校验一个 `.git` 条目：若存在必须是真实目录（非 symlink/junction、非 gitdir 指针文件）。
 * 返回是否存在。仅 ENOENT 视为不存在；其它错误（EACCES/EIO/ENOTDIR）抛（fail-closed）。
 * @param {string} dotGit
 * @returns {Promise<boolean>}
 */
async function verifyDotGitReal(dotGit) {
    let st;
    try {
        st = await fs.lstat(dotGit);
    } catch (e) {
        if (e && e.code === 'ENOENT') return false;
        throw Object.assign(new Error(`.git lstat 失败（非缺失）: ${e.message}`), { code: 'REPO_UNSAFE' });
    }
    if (st.isSymbolicLink()) throw Object.assign(new Error('.git 是符号链接/junction，拒绝'), { code: 'REPO_UNSAFE' });
    if (!st.isDirectory()) throw Object.assign(new Error('.git 不是目录（gitdir 指针/文件），拒绝'), { code: 'REPO_UNSAFE' });
    return true;
}

/** connect：本地 init repo + add origin + （可选）空分支 bootstrap。凭据走 tokenFile（文件读取）。 */
async function runConnect(task) {
    const repoDir = path.resolve(task.repoDir);
    const branch = task.branch || 'main';

    // 第一条 git 命令前：安全核 repo 目录与 .git 全链（拒绝 repo/.git junction 重定向外部 git）。
    // 用 state.safeEnsureDir（逐段校验/创建、拒绝 symlink/junction）替代裸 fs.ensureDir；
    // 不调用 ensureMaintDirReal（它会先造 .git/dsr，可能干扰后续 git.init 的 fresh repo 判断）。
    await stateMod.safeEnsureDir(repoDir);
    let hasGit = await verifyDotGitReal(path.join(repoDir, '.git'));

    const git = connectGit(repoDir, task);

    // 本地 init（幂等）
    if (!hasGit) {
        await git.init(['-b', branch]);
        // init 后复核 .git 是真实目录非链接（防并发替换为 junction）。
        hasGit = await verifyDotGitReal(path.join(repoDir, '.git'));
        if (!hasGit) throw Object.assign(new Error('git init 后 .git 缺失'), { code: 'REPO_UNSAFE' });
    }
    // 忽略全局/系统 Git 配置 + 禁用凭据 helper（凭据只走私有 tokenFile / askpass）。
    await git.raw(['config', 'credential.helper', '']);
    await git.raw(['config', 'user.name', task.commitAuthor?.name || '酒管 Sync']);
    await git.raw(['config', 'user.email', task.commitAuthor?.email || 'st-sync@localhost']);
    // 测试注入：远端 URL → 本地 bare 的 insteadOf 映射（只来自工厂参数，HTTP 绝无控制）。
    if (task.insteadOf && typeof task.insteadOf === 'object') {
        for (const [target, replacement] of Object.entries(task.insteadOf)) {
            await git.raw(['config', `url.${replacement}.insteadOf`, target]);
        }
    }
    // 远端 URL 固定 GitHub（fresh init 无 origin → 先 add，已存在则 set-url）。
    try {
        await git.remote(['add', 'origin', task.remoteUrl]);
    } catch (e) {
        await git.remote(['set-url', 'origin', task.remoteUrl]);
    }

    // 探测远端分支是否存在（凭据走 tokenFile）。
    let remoteExists = true;
    try {
        await git.fetch('origin', branch);
    } catch (e) {
        const msg = String(e?.message || e || '').toLowerCase();
        if (isMissingRefMsg(msg)) {
            remoteExists = false;
        } else if (isAuthMsg(msg)) {
            throw Object.assign(new Error(`远端鉴权/权限失败：${e.message}`), { code: 'GIT_AUTH_FAILED' });
        } else {
            throw Object.assign(new Error(`连接远端失败（网络）：${e.message}`), { code: 'GIT_FETCH_FAILED' });
        }
    }

    if (remoteExists) {
        return { initializedRemote: false, connected: true, needsRemoteInit: false, remoteEmpty: false };
    }

    // Distinguish an empty repository from a missing branch. No test commits.
    const remoteHeads = await git.raw(['ls-remote', '--heads', 'origin']);
    const remoteEmpty = !String(remoteHeads).trim();

    // 远端无该分支：仅当显式 initializeEmptyBranch 才 bootstrap（普通 push，不 force）。
    if (task.initializeEmptyBranch !== true) {
        return { initializedRemote: false, connected: false, needsRemoteInit: true, remoteEmpty };
    }

    await git.raw(['commit', '--allow-empty', '-m', 'chore: init sync branch']);
    // 普通 push：HEAD:refs/heads/<branch>，禁止 force（凭据走 tokenFile）。
    try {
        await git.push('origin', `HEAD:refs/heads/${branch}`, ['--no-force']);
    } catch (e) {
        const msg = String(e?.message || e || '').toLowerCase();
        if (isAuthMsg(msg)) {
            throw Object.assign(new Error(`远端鉴权/权限失败：${e.message}`), { code: 'GIT_AUTH_FAILED' });
        }
        throw Object.assign(new Error(`初始化远端分支失败：${e.message}`), { code: 'PUSH_REJECTED' });
    }
    return { initializedRemote: true, connected: true, needsRemoteInit: false, remoteEmpty };
}

function handleTask(task) {
    const id = task && task.id;
    const token = readTokenForRedact(task && task.tokenFile);
    return Promise.resolve()
        .then(async () => {
            let result;
            if (task.op === 'core') result = await runCore(task);
            else if (task.op === 'connect') result = await runConnect(task);
            else if (task.op === 'preflight') result = await require('./preflight').preflight(task);
            else throw new Error(`未知 worker 操作: ${task.op}`);
            return { id, ok: true, result };
        })
        .catch((e) => {
            const msg = e && e.message ? e.message : String(e);
            const code = e && e.code ? e.code : 'WORKER_ERROR';
            return { id, ok: false, error: { message: redact.redact(token, msg), code } };
        });
}

process.on('message', async (task) => {
    if (task && task.op && task.op !== 'noop') {
        const msg = await handleTask(task);
        // 回传后自然退出：send 回调在消息刷出后触发，process.disconnect 关闭 ipc，进程随即结束。
        try {
            process.send(msg, () => process.exit(msg.ok ? 0 : 1));
        } catch {
            process.exit(msg.ok ? 0 : 1);
        }
    }
});

if (typeof process.send === 'function') process.send({ ready: true });

// 供测试单测（fork 场景下这些导出不影响 IPC 入口）。
module.exports = { scrubEnv, applyEnvScrub, verifyDotGitReal, runConnect, runCore };

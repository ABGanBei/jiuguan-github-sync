#!/usr/bin/env node
'use strict';
/**
 * 酒管可靠同步 · 故障注入 worker（真实集成测试，配合 test/reliable-sync.test.js）。
 *
 * 本文件是「真实故障窗口」的独立进程载体：它**包装真实操作**（真实 git push / 真实 fs.rename /
 * 真实 state 保存），在真实操作完成之后精确抛错或 process.exit，模拟「确认丢失」「rename 后
 * journal 前崩溃」「state 保存失败」等窗口；随后由**另一个全新进程**（recover 任务）恢复。
 *
 * 硬性约束（P1_SECOND_REVIEW / P1_TEST_REVIEW）：
 * - 不允许 mock 算法、不允许伪造 pending、不允许手写 B 冒充真实故障；
 * - 包装的是真实 git / fs 调用，注入点在真实操作边界之后；
 * - 故障进程用 spawn 独立启动；遗留锁只由父进程在证明子进程已结束后清理 test-artifacts 内合成锁；
 * - 隔离 HOME/TMP、GIT_ALLOW_PROTOCOL=file、url.insteadOf 本地 bare 映射，不碰真实数据/令牌/远端。
 *
 * 用法（由 sync test 的 child 进程 spawn）：
 *   node test/reliable-fault-worker.js --child <run> --spec <spec.json>
 *
 * spec.json 结构：
 *   {
 *     "task": "fault" | "recover" | "inspect",
 *     "command": "push"|"pull"|"apply"|"recover"|"init",   // task=fault/recover 时
 *     "repoDir": "...", "dataRoot": "...", "repo": "fixture/n", "branch": "main",
 *     "bare": "...", "seed": "...",
 *     "offlineConfirmed": true,
 *     "fault": { "target": "pushBranch"|"saveState"|"fs.rename"|"commitTree"|"fetchRemote"|"appendApplyJournal",
 *                "module": "git-tree"|"state"|"apply"|"fs-extra",
 *                "when": "after"|"before", "action": "throw"|"exit", "exitCode": 77,
 *                "skipCalls": 0, "message": "..." },
 *     "advanceRemote": { "rel": "chats/Actor/a.jsonl", "content_b64": "..." } | null,  // 第二端推进远端
 *     "resultFile": "..."   // 写回结果 JSON
 *   }
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const args = process.argv.slice(2);
const runIdx = args.indexOf('--child');
const specIdx = args.indexOf('--spec');
const RUN = path.resolve(args[runIdx + 1]);
const SPEC_FILE = path.resolve(args[specIdx + 1]);

const spec = JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8'));

// ============================ 环境隔离 ============================
const HOME = path.join(RUN, 'home');
const TMP = path.join(RUN, 'tmp');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
if (!fs.existsSync(path.join(HOME, '.gitconfig'))) {
    fs.writeFileSync(path.join(HOME, '.gitconfig'), '');
}
const SCRUB = /^(GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|GH_ENTERPRISE_TOKEN|ST_GITHUB_SYNC_TOKEN|ST_GITHUB_SYNC_TOKEN_FILE|GIT_ASKPASS|SSH_ASKPASS|GIT_ASKPASS_.*|GIT_CONFIG|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CURL_VERBOSE|GIT_TRACE.*|GIT_SSH.*|GIT_PROXY_COMMAND|SSH_AUTH_SOCK)$/i;
for (const k of Object.keys(process.env)) if (SCRUB.test(k)) delete process.env[k];
Object.assign(process.env, {
    HOME, USERPROFILE: HOME, TMP, TEMP: TMP,
    GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: RUN,
});

// ============================ 真实模块 ============================
const orchestrator = require(path.join(ROOT, 'lib', 'reliable', 'orchestrator.js'));
const gitTree = require(path.join(ROOT, 'lib', 'reliable', 'git-tree.js'));
const stateMod = require(path.join(ROOT, 'lib', 'reliable', 'state.js'));
const applyMod = require(path.join(ROOT, 'lib', 'reliable', 'apply.js'));
const fsExtra = require('fs-extra');

const shaBuf = b => crypto.createHash('sha256').update(b).digest('hex');

function git(args, cwd) {
    const r = spawnSync('git', args, { cwd: cwd || RUN, env: process.env, timeout: 60000, encoding: 'utf8' });
    return { ok: r.status === 0, out: String(r.stdout || ''), err: String(r.stderr || '').trim() };
}
function must(args, cwd) {
    const r = git(args, cwd);
    if (!r.ok) throw new Error(`git ${args.join(' ')} 失败: ${r.err || r.out}`);
    return r.out;
}

function opts() {
    return {
        command: spec.command,
        repoDir: spec.repoDir,
        dataRoot: spec.dataRoot,
        githubRepo: spec.repo,
        branch: spec.branch || 'main',
        commitAuthor: { name: 'Reliable', email: 'reliable@localhost' },
        tokenFile: '',
        offlineConfirmed: spec.offlineConfirmed !== false,
    };
}

/** 读取远端 head（本地 bare）。 */
function remoteHead() {
    const r = git(['--git-dir', spec.bare, 'rev-parse', 'main']);
    return r.ok ? r.out.trim() : null;
}

/** 读取远端 main 的提交历史（hash 列表）。 */
function remoteLog() {
    const r = git(['--git-dir', spec.bare, 'log', '--format=%H', 'main']);
    if (!r.ok) return [];
    return r.out.split('\n').filter(s => /^[0-9a-f]{40}$/.test(s.trim()));
}

/** 第二端：在独立目录 clone bare、写入新内容、commit、push，推进远端（真实 git，不 mock）。 */
function advanceRemote(rel, contentBuf) {
    const advAbs = path.resolve(spec.seed, '..', `advance-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    must(['clone', '-q', spec.bare, advAbs]);
    const abs = path.join(advAbs, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contentBuf);
    must(['add', '-A'], advAbs);
    must(['-c', 'user.name=peer', '-c', 'user.email=peer@localhost', 'commit', '-qm', 'peer advance'], advAbs);
    must(['push', '-q', spec.bare, 'main'], advAbs);
    return remoteHead();
}

/**
 * 包装真实操作注入故障：先执行真实操作（when=after）或先注入（when=before），再 throw/exit。
 * 返回包装后的函数。
 * - skipCalls：跳过前 N 次调用（不注入）；
 * - matchDestPrefix：仅当目标路径（第 2 个参数，即 fs.rename 的 dest）以该前缀开头时才注入，
 *   用于精确定位「聊天文件 rename」而非「备份/journal 的 atomicWriteBytes rename」。
 */
function wrapWithFault(realFn, fault) {
    const skipCalls = fault.skipCalls || 0;
    let calls = 0;
    return async function (...fnArgs) {
        const destPrefix = fault.matchDestPrefix;
        if (destPrefix) {
            const dest = fnArgs.length > 1 ? String(fnArgs[1]) : '';
            if (!dest.startsWith(destPrefix)) {
                return realFn.apply(this, fnArgs);
            }
        }
        calls++;
        if (calls <= skipCalls) {
            return realFn.apply(this, fnArgs);
        }
        const doInject = (action) => {
            if (action === 'exit') {
                // 在真实操作之后 exit：模拟进程在临界窗口被杀死
                process.exit(fault.exitCode || 77);
            }
            const err = new Error(fault.message || 'injected fault');
            err.code = 'FAULT_INJECTED';
            throw err;
        };
        if (fault.when === 'before') {
            doInject(fault.action);
            return realFn.apply(this, fnArgs); // 不可达
        }
        // when === 'after'：先真实操作，再注入
        const result = await realFn.apply(this, fnArgs);
        doInject(fault.action);
        return result; // 不可达（throw/exit）
    };
}

/**
 * 依据 spec.fault 安装故障包装到对应模块对象。
 * 支持三种注入风格：
 *  1) throw / exit（when=after/before）：包装真实操作后抛错或退出；
 *  2) advance-remote：包装 pushBranch，在真实 push **之前**用第二端真实推进远端（制造 NFF），
 *     随后调用真实 pushBranch（会因非快进而失败）。
 */
function installFault() {
    const fault = spec.fault;
    if (!fault) return;

    if (fault.action === 'advance-remote') {
        if (fault.target !== 'pushBranch' || fault.module !== 'git-tree') {
            throw new Error(`advance-remote 只能作用于 git-tree.pushBranch`);
        }
        const realPush = gitTree.pushBranch.bind(gitTree);
        gitTree.pushBranch = async function (config, repoDir, commitId) {
            // 真实第二端推进远端（fetch 之后、push 之前的窗口）
            for (const adv of (fault.advanceRemote || [])) {
                const buf = Buffer.from(adv.content_b64, 'base64');
                advanceRemote(adv.rel, buf);
            }
            // 真实 push（远端已变 → 非快进失败）
            return realPush(config, repoDir, commitId);
        };
        return;
    }

    if (fault.module === 'git-tree') {
        gitTree[fault.target] = wrapWithFault(gitTree[fault.target].bind(gitTree), fault);
    } else if (fault.module === 'state') {
        stateMod[fault.target] = wrapWithFault(stateMod[fault.target].bind(stateMod), fault);
    } else if (fault.module === 'apply') {
        applyMod[fault.target] = wrapWithFault(applyMod[fault.target].bind(applyMod), fault);
    } else if (fault.module === 'fs-extra') {
        fsExtra[fault.target] = wrapWithFault(fsExtra[fault.target].bind(fsExtra), fault);
    } else {
        throw new Error(`未知 fault.module: ${fault.module}`);
    }
}

/** 读取当前维护状态（用于 recover/inspect 后写回结果供父进程断言）。 */
async function dumpState() {
    const maintDir = path.join(spec.repoDir, '.git', 'dsr');
    const state = await stateMod.loadState(maintDir);
    const pending = await stateMod.loadPending(maintDir);
    return {
        state: state ? {
            baseline: state.baseline,
            remoteHead: state.remoteHead,
            targetIdentity: state.targetIdentity,
        } : null,
        pendingExists: !!pending,
        pending: pending ? {
            runId: pending.runId,
            commitId: pending.commitId,
            phase: pending.phase,
            edits: pending.edits.map(e => ({ rel: e.rel, publishHash: e.publishHash, originalBaselineHash: e.originalBaselineHash })),
        } : null,
        remoteHead: remoteHead(),
        remoteLog: remoteLog(),
    };
}

function writeResult(obj) {
    fs.writeFileSync(spec.resultFile, JSON.stringify(obj, null, 2));
}

(async () => {
    const task = spec.task;

    if (task === 'fault') {
        installFault();
        try {
            const r = await orchestrator.run(opts());
            writeResult({ ok: true, command: spec.command, result: r, faultNotFired: true });
            process.exit(0);
        } catch (e) {
            // 注入的 throw 或真实错误：记录结果（含当前 pending/B/远端状态）
            const dump = await dumpState().catch(() => null);
            writeResult({
                ok: false,
                command: spec.command,
                error: String(e && e.message || e),
                code: e && e.code,
                ...dump,
            });
            process.exit(0);
        }
        return;
    }

    if (task === 'recover') {
        // 全新进程恢复：不安装任何故障，直接 recover
        const r = await orchestrator.run({ ...opts(), command: 'recover' });
        const dump = await dumpState();
        writeResult({ ok: true, recoverResult: r, ...dump });
        process.exit(0);
        return;
    }

    if (task === 'inspect') {
        const dump = await dumpState();
        writeResult({ ok: true, ...dump });
        process.exit(0);
        return;
    }

    throw new Error(`未知 task: ${task}`);
})().catch(err => {
    console.error('[fault-worker] 未捕获异常:', err);
    writeResult({ ok: false, fatal: String(err && err.stack || err) });
    process.exit(1);
});

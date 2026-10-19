#!/usr/bin/env node
'use strict';
/**
 * 酒管可靠同步 · online-snapshot 模式测试（真实本地 bare Git，不 mock 同步算法或 Git 调用）。
 *
 * 覆盖集成合同 online-snapshot 语义：
 * - 显式 executionMode='online-snapshot' 只允许 init/status/push/pull；
 * - 不要求 offlineConfirmed（操作真实 dataRoot，但不改写聊天）；
 * - apply/recover 无条件拒绝（offlineConfirmed:true 也不能覆盖模式限制）；
 * - push/pull 在 pending 恢复之前先检查「活动 apply manifest / 无 manifest 未 complete 审计」，
 *   命中即 NEEDS_OFFLINE_RECOVERY 阻断，绝不调用 recoverOrBlockApply（不写聊天/不推进 apply B/不清 active/不动 stage）；
 * - 仅 pending push 恢复支持；
 * - 默认（无 executionMode）离线语义完全不变：缺 offlineConfirmed 仍拒绝。
 *
 * 结构：父进程创建隔离运行目录并 spawn 本文件 --child <run>；子进程隔离 HOME/TMP、
 * GIT_ALLOW_PROTOCOL=file、url.insteadOf 本地 bare 映射后 require 真实 lib/reliable/* 模块。
 * 真实 apply 中断复用 test/reliable-fault-worker.js（独立进程包装真实 fs.rename 后 exit）；
 * 合成 manifest / 合成 plan 用例明确是「单测」，不冒称集成（主集成测试在 reliable-sync.test.js）。
 *
 * 用法：node test/online-snapshot.test.js [--keep]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

if (process.argv[2] !== '--child') {
    parentMain();
} else {
    childMain().catch(err => {
        console.error('[child] 未捕获异常:', err);
        process.exit(1);
    });
}

function parentMain() {
    const run = path.join(ROOT, 'test-artifacts', `online-${crypto.randomUUID()}`);
    fs.mkdirSync(run, { recursive: true });
    const r = spawnSync(process.execPath, [__filename, '--child', run], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    const out = path.join(ROOT, 'test-artifacts', 'online-snapshot-results.json');
    const produced = path.join(run, 'results.json');
    if (fs.existsSync(produced)) fs.copyFileSync(produced, out);
    console.log(`[parent] run=${path.relative(ROOT, run)}  exit=${r.status}`);
    process.exit(r.status === null ? 1 : r.status);
}

async function childMain() {
    const RUN = path.resolve(process.argv[3]);
    const assert = require('assert');

    // ---- 1) 环境隔离 ----
    const HOME = path.join(RUN, 'home');
    const TMP = path.join(RUN, 'tmp');
    fs.mkdirSync(HOME, { recursive: true });
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(path.join(HOME, '.gitconfig'), '');
    const SCRUB = /^(GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|GH_ENTERPRISE_TOKEN|ST_GITHUB_SYNC_TOKEN|ST_GITHUB_SYNC_TOKEN_FILE|GIT_ASKPASS|SSH_ASKPASS|GIT_ASKPASS_.*|GIT_CONFIG|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CURL_VERBOSE|GIT_TRACE.*|GIT_SSH.*|GIT_PROXY_COMMAND|SSH_AUTH_SOCK)$/i;
    for (const k of Object.keys(process.env)) if (SCRUB.test(k)) delete process.env[k];
    Object.assign(process.env, {
        HOME, USERPROFILE: HOME, TMP, TEMP: TMP,
        GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file',
        GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: RUN,
    });

    // ---- 2) 真实模块（隔离后 require） ----
    const orchestrator = require(path.join(ROOT, 'lib', 'reliable', 'orchestrator.js'));
    const stateMod = require(path.join(ROOT, 'lib', 'reliable', 'state.js'));

    // ---- 3) 工具 ----
    const shaBuf = b => crypto.createHash('sha256').update(b).digest('hex');
    const sha = p => shaBuf(fs.readFileSync(p));
    const b64 = s => Buffer.from(s).toString('base64');
    const git = (args, cwd) => {
        const r = spawnSync('git', args, { cwd: cwd || RUN, env: process.env, timeout: 60000, encoding: 'utf8' });
        return { ok: r.status === 0, out: String(r.stdout || '').replace(/\r\n/g, '\n').replace(/\n$/, ''), err: String(r.stderr || '').replace(/\r\n/g, '\n').trim() };
    };
    const must = (args, cwd) => {
        const r = git(args, cwd);
        if (!r.ok) throw new Error(`git ${args.join(' ')} 失败: ${r.err || r.out}`);
        return r.out;
    };
    const show = (bare, p) => {
        const r = spawnSync('git', ['--git-dir', bare, 'show', `main:${p}`], { env: process.env, timeout: 60000 });
        return r.status === 0 ? r.stdout : null;
    };
    const jl = (mes, extra) => JSON.stringify({
        name: 'Actor', is_user: false, is_system: false, mes,
        chat_metadata: { char_id: 0, msgs: 2, stop: ['</s>'] },
        swipes: ['hello *waves*', 'second swipe'],
        swipe_info: [{ send_date: 'Oct 1, 2026 10:00am', gen_started: 'x', gen_finished: 'y' }],
        extra: { api: 'openai', model: 'gpt-4o', bookmarked: false, note: 'n' },
        ...extra,
    }) + '\n';

    const ART = 'chats/Actor/a.jsonl';

    function setupScenario(n, seedFiles, repoId) {
        const S = path.join(RUN, `s${n}`);
        const bare = path.join(S, 'bare.git');
        const seed = path.join(S, 'seed');
        const repoDir = path.join(S, 'repo');
        const dataRoot = path.join(S, 'data');
        const repo = repoId || `fixture/${n}`;
        fs.mkdirSync(seed, { recursive: true });
        for (const f of seedFiles) {
            const abs = path.join(seed, f.rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, f.content);
        }
        must(['init', '-q', '--bare', '-b', 'main', bare]);
        must(['init', '-q', '-b', 'main', seed]);
        must(['add', '-A'], seed);
        must(['-c', 'user.name=seed', '-c', 'user.email=seed@localhost', 'commit', '-qm', 'base'], seed);
        must(['push', '-q', bare, 'main'], seed);

        must(['clone', '-q', bare, repoDir]);
        const bareUrl = `file:///${bare.replace(/\\/g, '/')}`;
        must(['config', '--local', `url.${bareUrl}.insteadOf`, `https://github.com/${repo}.git`], repoDir);
        for (const [k, v] of [['credential.helper', ''], ['user.name', 'reliable'], ['user.email', 'reliable@localhost'],
            ['core.autocrlf', 'false'], ['core.safecrlf', 'false']]) {
            must(['config', '--local', k, v], repoDir);
        }

        fs.mkdirSync(path.join(dataRoot, 'chats'), { recursive: true });
        for (const f of seedFiles) {
            const abs = path.join(dataRoot, f.rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, f.content);
        }
        return { S, bare, seed, repoDir, dataRoot, repo };
    }

    function makeSecondEndpoint(baseC, suffix) {
        const S2 = path.join(baseC.S, `peer${suffix}`);
        const repoDir = path.join(S2, 'repo');
        const dataRoot = path.join(S2, 'data');
        fs.mkdirSync(S2, { recursive: true });
        must(['clone', '-q', baseC.bare, repoDir]);
        const bareUrl = `file:///${baseC.bare.replace(/\\/g, '/')}`;
        must(['config', '--local', `url.${bareUrl}.insteadOf`, `https://github.com/${baseC.repo}.git`], repoDir);
        for (const [k, v] of [['credential.helper', ''], ['user.name', 'reliable'], ['user.email', 'reliable@localhost'],
            ['core.autocrlf', 'false'], ['core.safecrlf', 'false']]) {
            must(['config', '--local', k, v], repoDir);
        }
        fs.mkdirSync(path.join(dataRoot, 'chats'), { recursive: true });
        const seedRoot = path.join(baseC.S, 'seed');
        if (fs.existsSync(seedRoot)) {
            const copyDir = (src, dst) => {
                fs.mkdirSync(dst, { recursive: true });
                for (const e of fs.readdirSync(src, { withFileTypes: true })) {
                    const s = path.join(src, e.name);
                    const d = path.join(dst, e.name);
                    if (e.isDirectory()) copyDir(s, d);
                    else fs.copyFileSync(s, d);
                }
            };
            copyDir(seedRoot, dataRoot);
        }
        return { ...baseC, repoDir, dataRoot, S: S2 };
    }

    /** 在线快照 opts：显式 executionMode，不传 offlineConfirmed（证明不要求离线声明）。 */
    function onlineOpts(c, cmd, extra = {}) {
        return {
            command: cmd,
            repoDir: c.repoDir,
            dataRoot: c.dataRoot,
            githubRepo: c.repo,
            branch: 'main',
            commitAuthor: { name: 'Reliable', email: 'reliable@localhost' },
            tokenFile: '',
            executionMode: 'online-snapshot',
            ...extra,
        };
    }
    /** 离线 opts：无 executionMode（默认离线），用于验证离线语义不变。 */
    function offlineOpts(c, cmd, extra = {}) {
        return {
            command: cmd,
            repoDir: c.repoDir,
            dataRoot: c.dataRoot,
            githubRepo: c.repo,
            branch: 'main',
            commitAuthor: { name: 'Reliable', email: 'reliable@localhost' },
            tokenFile: '',
            ...extra,
        };
    }

    const workerPath = path.join(__dirname, 'reliable-fault-worker.js');
    let specSeq = 0;
    function spawnWorker(spec) {
        specSeq++;
        const resultFile = path.join(RUN, `worker-result-${specSeq}-${crypto.randomUUID()}.json`);
        spec.resultFile = resultFile;
        const specFile = path.join(RUN, `worker-spec-${specSeq}-${crypto.randomUUID()}.json`);
        fs.writeFileSync(specFile, JSON.stringify(spec));
        const r = spawnSync(process.execPath, [workerPath, '--child', RUN, '--spec', specFile], {
            cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000,
        });
        let result = null;
        if (fs.existsSync(resultFile)) {
            try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch { result = { parseError: true }; }
        }
        return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), result };
    }
    function cleanupSyntheticLocks(c) {
        const maintDir = path.join(c.repoDir, '.git', 'dsr');
        for (const p of [path.join(maintDir, 'lock'), stateMod.dataRootLockPath(c.dataRoot)]) {
            try { if (fs.existsSync(p)) fs.rmSync(p); } catch { /* 忽略 */ }
        }
    }

    const results = [];
    function runTest(id, title, fn) {
        return { id, title, fn };
    }
    async function execute(t) {
        const rec = { id: t.id, title: t.title, verdict: 'fail', error: null };
        try {
            await t.fn(assert);
            rec.verdict = 'pass';
        } catch (e) {
            rec.verdict = 'fail';
            rec.error = String(e && e.stack || e);
        }
        return rec;
    }
    const tests = [];

    // ===== 1. online 正常双向：init/push/pull 无需 offlineConfirmed，远端内容正确 =====
    tests.push(runTest(1, 'online 正常双向：init/push/pull 无需 offlineConfirmed，远端内容正确、pull 只暂存', async () => {
        const c = setupScenario(1, [{ rel: ART, content: jl('base', {}) }]);
        // init + push（在线，无 offlineConfirmed）建共同 B
        const r0 = await orchestrator.run(onlineOpts(c, 'init'));
        assert.strictEqual(r0.initialized, true, 'online init 应初始化');
        const r1 = await orchestrator.run(onlineOpts(c, 'push'));
        assert.strictEqual(r1.pushed, false, '首次 push 无改动应不产生提交');
        const st1 = await stateMod.loadState(path.join(c.repoDir, '.git', 'dsr'));
        assert.ok(st1.baseline[ART], 'ok 应持久化共同 B');

        // 第二端也建立共同 B（两端都在编辑前确认旧 B）
        const c2 = makeSecondEndpoint(c, 'peer');
        await orchestrator.run({ ...onlineOpts(c2, 'init'), githubRepo: c.repo });
        await orchestrator.run({ ...onlineOpts(c2, 'push'), githubRepo: c.repo }); // c2 建 B=base

        // c 端编辑并在线 push
        fs.writeFileSync(path.join(c.dataRoot, ART), jl('a-edit', {}));
        const r2 = await orchestrator.run(onlineOpts(c, 'push'));
        assert.deepStrictEqual(r2.published, [ART], '在线 push 应发布 a');
        assert.strictEqual(shaBuf(show(c.bare, ART)), shaBuf(Buffer.from(jl('a-edit', {}))), '远端 a 应为 a-edit');

        // c2 在线 pull（只暂存，不写本地聊天）
        const pullR = await orchestrator.run({ ...onlineOpts(c2, 'pull'), githubRepo: c.repo });
        assert.strictEqual(pullR.staged.length, 1, '在线 pull 应暂存 1 个文件');
        assert.strictEqual(sha(path.join(c2.dataRoot, ART)), shaBuf(Buffer.from(jl('base', {}))), 'pull 只暂存，不应写本地聊天');
        const stage = await stateMod.loadStage(path.join(c2.repoDir, '.git', 'dsr'));
        assert.ok(stage && stage.entries.length === 1, '应写入 stage');
        assert.strictEqual(stage.entries[0].candidateHash, shaBuf(Buffer.from(jl('a-edit', {}))), '候选哈希应为远端 a-edit');
    }));

    // ===== 2. online apply/recover 无条件拒绝（offlineConfirmed:true 也不覆盖） =====
    tests.push(runTest(2, 'online apply/recover 无条件拒绝：offlineConfirmed:true 也不能覆盖模式限制', async () => {
        const c = setupScenario(2, [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(onlineOpts(c, 'init'));
        await orchestrator.run(onlineOpts(c, 'push'));
        await assert.rejects(
            () => orchestrator.run(onlineOpts(c, 'apply', { offlineConfirmed: true })),
            /online-snapshot 模式不支持 apply/,
            'online apply（即使 offlineConfirmed:true）应拒绝'
        );
        await assert.rejects(
            () => orchestrator.run(onlineOpts(c, 'recover', { offlineConfirmed: true })),
            /online-snapshot 模式不支持 recover/,
            'online recover（即使 offlineConfirmed:true）应拒绝'
        );
    }));

    // ===== 3. 默认离线语义不变：缺 offlineConfirmed 仍拒绝 init =====
    tests.push(runTest(3, '默认离线（无 executionMode）缺 offlineConfirmed 仍拒绝（离线语义不变）', async () => {
        const c = setupScenario(3, [{ rel: ART, content: jl('base', {}) }]);
        // 无 executionMode 且无 offlineConfirmed → init 拒绝
        await assert.rejects(
            () => orchestrator.run(offlineOpts(c, 'init')),
            /要求显式声明已停止服务并关闭所有客户端/,
            '离线 init 缺 offlineConfirmed 应拒绝'
        );
    }));

    // ===== 4. 合成 active manifest（单测）→ online push/pull 阻断，不触聊天/旧B/active/stage =====
    tests.push(runTest(4, '合成 active manifest（单测）：online push/pull NEEDS_OFFLINE_RECOVERY 阻断，不触聊天/旧B/active/stage', async () => {
        const c = setupScenario(4, [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(onlineOpts(c, 'init'));
        await orchestrator.run(onlineOpts(c, 'push')); // 建 B=base
        const maintDir = path.join(c.repoDir, '.git', 'dsr');
        const dataRoot = c.dataRoot;

        // 合成合法候选 + 备份 + stage + active manifest（属单测，不冒称集成）。
        const runId = 'r4';
        const candBuf = Buffer.from(jl('candidate'));
        const expectedBuf = Buffer.from(jl('base', {})); // 原文件内容（expected=base）
        const stageDir = path.join(maintDir, 'stage', runId);
        fs.mkdirSync(stageDir, { recursive: true });
        const candPath = `stage/${runId}/abc.content`;
        fs.writeFileSync(path.join(maintDir, candPath), candBuf);
        const backupsDir = path.join(maintDir, 'backups', runId);
        fs.mkdirSync(backupsDir, { recursive: true });
        const backupPath = `backups/${runId}/abc.backup`;
        fs.writeFileSync(path.join(maintDir, backupPath), expectedBuf);

        const st = await stateMod.loadState(maintDir);
        const candHash = shaBuf(candBuf);
        // 合成合法 stage（runId 与 manifest.stageId 一致），使「不动 stage」的断言有真实 stage.json 可核验。
        const stage = {
            runId,
            remoteHead: st.remoteHead,
            targetIdentity: st.targetIdentity,
            entries: [{
                rel: ART,
                expectedBaselineHash: st.baseline[ART].hash,
                expectedLocalHash: shaBuf(expectedBuf),
                expectedLocalMissing: false,
                candidateHash: candHash,
                candidatePath: candPath,
                remoteCommit: st.remoteHead,
            }],
            createdAt: new Date().toISOString(),
        };
        await stateMod.writeStage(maintDir, stage);

        const manifest = {
            schemaVersion: stateMod.MANIFEST_SCHEMA_VERSION,
            runId,
            targetIdentity: st.targetIdentity,
            stageId: runId,
            remoteHead: st.remoteHead,
            createdAt: new Date().toISOString(),
            entries: [{
                rel: ART,
                expectedBaselineHash: st.baseline[ART].hash,
                expectedLocalHash: shaBuf(expectedBuf),
                expectedLocalMissing: false,
                candidateHash: candHash,
                candidatePath: candPath,
                backupPath,
                backupHash: shaBuf(expectedBuf),
            }],
        };
        await stateMod.writeApplyActive(maintDir, manifest);

        // 快照：聊天字节 / 旧 B / active manifest 文本 / stage 文本（阻断前后应完全不变）
        const chatBefore = sha(path.join(dataRoot, ART));
        const bBefore = st.baseline[ART].hash;
        const activeBefore = fs.readFileSync(path.join(maintDir, 'apply-active.json'), 'utf8');
        const stageBefore = fs.readFileSync(path.join(maintDir, 'stage', 'stage.json'), 'utf8');

        await assert.rejects(
            () => orchestrator.run(onlineOpts(c, 'push')),
            /活动 apply 事务/,
            '有 active manifest 时 online push 应阻断'
        );
        await assert.rejects(
            () => orchestrator.run(onlineOpts(c, 'pull')),
            /活动 apply 事务/,
            '有 active manifest 时 online pull 应阻断'
        );

        // 聊天 / 旧 B / active / stage 完全不变（绝不写聊天、推进 apply B、清 active、动 stage）
        assert.strictEqual(sha(path.join(dataRoot, ART)), chatBefore, '阻断后聊天字节不变');
        const stAfter = await stateMod.loadState(maintDir);
        assert.strictEqual(stAfter.baseline[ART].hash, bBefore, '阻断后旧 B 不变（不推进 apply B）');
        assert.strictEqual(fs.readFileSync(path.join(maintDir, 'apply-active.json'), 'utf8'), activeBefore, '阻断后 active manifest 不变（不清 active）');
        assert.strictEqual(fs.readFileSync(path.join(maintDir, 'stage', 'stage.json'), 'utf8'), stageBefore, '阻断后 stage 不变（不动 stage）');
    }));

    // ===== 5. 合成「无 manifest 但有未 complete plan」→ online push/pull 阻断（单测） =====
    tests.push(runTest(5, '合成无 manifest 未 complete plan（单测）：online push/pull NEEDS_OFFLINE_RECOVERY 阻断；complete 后恢复', async () => {
        const c = setupScenario(5, [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(onlineOpts(c, 'init'));
        await orchestrator.run(onlineOpts(c, 'push'));
        const maintDir = path.join(c.repoDir, '.git', 'dsr');
        // 写一条未 complete 的 plan 审计（无 manifest），属单测，不冒称集成。
        await stateMod.appendApplyJournal(maintDir, {
            runId: 'r5', rel: ART, status: 'plan',
            expectedHash: shaBuf(Buffer.from(jl('base', {}))), candidateHash: shaBuf(Buffer.from(jl('candidate', {}))),
            ts: new Date().toISOString(),
        });
        await assert.rejects(
            () => orchestrator.run(onlineOpts(c, 'push')),
            /不完整 apply 计划/,
            '无 manifest 但有未 complete plan 时 online push 应阻断'
        );
        await assert.rejects(
            () => orchestrator.run(onlineOpts(c, 'pull')),
            /不完整 apply 计划/,
            '无 manifest 但有未 complete plan 时 online pull 应阻断'
        );
        // 有 complete 标志后不再阻断（历史完整日志不算活动事务）
        await stateMod.appendApplyComplete(maintDir, 'r5');
        const r = await orchestrator.run(onlineOpts(c, 'push'));
        assert.strictEqual(r.pushed, false, 'complete 后 online push 应恢复可用（无 publish）');
    }));

    // ===== 6. 真实 apply 中断（复用 worker）→ online push 阻断，不触聊天/旧B/active/stage =====
    tests.push(runTest(6, '真实 apply 中断（复用 worker）：online push NEEDS_OFFLINE_RECOVERY 阻断，不写聊天/推进 B/清 active/动 stage', async () => {
        const c = setupScenario(6, [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(onlineOpts(c, 'init'));
        await orchestrator.run(onlineOpts(c, 'push')); // 建 B=base
        const c2 = makeSecondEndpoint(c, 'peer');
        await orchestrator.run({ ...onlineOpts(c2, 'init'), githubRepo: c.repo });
        await orchestrator.run({ ...onlineOpts(c2, 'push'), githubRepo: c.repo }); // c2 建 B=base
        fs.writeFileSync(path.join(c2.dataRoot, ART), jl('remote-edit', {}));
        await orchestrator.run({ ...onlineOpts(c2, 'push'), githubRepo: c.repo });
        await orchestrator.run({ ...onlineOpts(c, 'pull'), githubRepo: c.repo }); // c 端暂存

        // 真实 apply 中断：包装真实 fs.rename（聊天目标）成功后 exit(77)，留下活动 manifest
        const spec = {
            task: 'fault',
            command: 'apply',
            repoDir: c.repoDir, dataRoot: c.dataRoot, repo: c.repo, branch: 'main', bare: c.bare,
            offlineConfirmed: true,
            fault: { target: 'rename', module: 'fs-extra', when: 'after', action: 'exit', exitCode: 77, matchDestPrefix: c.dataRoot },
        };
        const w = spawnWorker(spec);
        assert.strictEqual(w.status, 77, `故障进程应以 77 退出（实际 ${w.status}）: ${w.stderr}`);
        cleanupSyntheticLocks(c);

        const maintDir = path.join(c.repoDir, '.git', 'dsr');
        // rename 已发生：本地聊天 == candidate（remote-edit）
        assert.strictEqual(sha(path.join(c.dataRoot, ART)), shaBuf(Buffer.from(jl('remote-edit', {}))), 'rename 后本地应为候选内容');
        const active = await stateMod.loadApplyActive(maintDir);
        assert.ok(active, '真实 apply 中断后应有活动 manifest');

        // 快照：聊天 / 旧 B / active / stage（online push 阻断前后应完全不变）
        const chatBefore = sha(path.join(c.dataRoot, ART));
        const stBefore = await stateMod.loadState(maintDir);
        const bBefore = stBefore.baseline[ART].hash;
        const activeBefore = fs.readFileSync(path.join(maintDir, 'apply-active.json'), 'utf8');
        const stageBefore = fs.readFileSync(path.join(maintDir, 'stage', 'stage.json'), 'utf8');

        await assert.rejects(
            () => orchestrator.run(onlineOpts(c, 'push')),
            /活动 apply 事务/,
            '真实 apply 中断后 online push 应阻断'
        );

        assert.strictEqual(sha(path.join(c.dataRoot, ART)), chatBefore, '阻断后聊天字节不变');
        const stAfter = await stateMod.loadState(maintDir);
        assert.strictEqual(stAfter.baseline[ART].hash, bBefore, '阻断后旧 B 不变');
        assert.strictEqual(fs.readFileSync(path.join(maintDir, 'apply-active.json'), 'utf8'), activeBefore, '阻断后 active 不变');
        assert.strictEqual(fs.readFileSync(path.join(maintDir, 'stage', 'stage.json'), 'utf8'), stageBefore, '阻断后 stage 不变');
    }));

    // ===== 7. 真实 push 确认前 exit77（复用 worker）→ 新 run online push 恢复未知 pending =====
    // 注：本用例仅在“恢复完成之后”才写本地新编辑，只能证明恢复后 B 已确认、可继续正常发布；
    // 它不能证明“pending 存在期间”本地新编辑不被误覆盖/误推进 —— 该项由 test 9 单独覆盖。
    tests.push(runTest(7, '真实 push 确认前 exit77（复用 worker）：online push 恢复未知 pending，B 只确认原快照、不重复提交；恢复完成后本地新编辑可正常发布', async () => {
        const c = setupScenario(7, [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(onlineOpts(c, 'init'));
        await orchestrator.run(onlineOpts(c, 'push')); // 建 B=base

        // 本地编辑 a-edit
        fs.writeFileSync(path.join(c.dataRoot, ART), jl('a-edit', {}));
        const aEditBuf = Buffer.from(jl('a-edit', {}));
        const aEditHash = shaBuf(aEditBuf);
        const baseHash = shaBuf(Buffer.from(jl('base', {})));

        // 用 fault-worker 离线 push：真实 pushBranch 成功后 exit77（确认前崩溃 → pending 保留、远端已含 a-edit、B 未推进）
        const spec = {
            task: 'fault',
            command: 'push',
            repoDir: c.repoDir, dataRoot: c.dataRoot, repo: c.repo, branch: 'main', bare: c.bare,
            offlineConfirmed: true,
            fault: { target: 'pushBranch', module: 'git-tree', when: 'after', action: 'exit', exitCode: 77 },
        };
        const w = spawnWorker(spec);
        assert.strictEqual(w.status, 77, `故障进程应以 77 退出（实际 ${w.status}）: ${w.stderr}`);
        cleanupSyntheticLocks(c);

        const maintDir = path.join(c.repoDir, '.git', 'dsr');
        // 确认真实故障窗口：pending 保留（committed+commitId）、远端已含 a-edit、B 未推进（真实 push 确认前崩溃）
        const pend = await stateMod.loadPending(maintDir);
        assert.ok(pend, 'exit77 后应保留 pending（真实 push 确认前崩溃）');
        assert.strictEqual(pend.phase, 'committed', 'pending 应为 committed 阶段');
        assert.ok(pend.commitId, 'pending 应含真实 commitId');
        let st = await stateMod.loadState(maintDir);
        assert.strictEqual(st.baseline[ART].hash, baseHash, 'B 未推进（仍 base，确认前崩溃）');
        assert.strictEqual(shaBuf(show(c.bare, ART)), aEditHash, '远端已含 a-edit（pushBranch 真实成功）');
        const logLenAfterFault = must(['--git-dir', c.bare, 'log', '--format=%H', 'main']).split('\n').length;

        // 新 run（主测试进程是独立进程）：online push 恢复未知 pending —— B 只确认原快照 a-edit，不重复提交
        const r = await orchestrator.run(onlineOpts(c, 'push'));
        assert.strictEqual(r.pushed, false, '恢复后本地==远端==B，无新 publish');
        st = await stateMod.loadState(maintDir);
        assert.strictEqual(st.baseline[ART].hash, aEditHash, 'B 只确认原快照（a-edit hash），非覆盖为本地新值');
        assert.strictEqual(await stateMod.loadPending(maintDir), null, '恢复后 pending 清除');
        const logLenAfterRecover = must(['--git-dir', c.bare, 'log', '--format=%H', 'main']).split('\n').length;
        assert.strictEqual(logLenAfterRecover, logLenAfterFault, '恢复不产生重复提交');

        // 恢复完成后本地新编辑 a-edit2：保留并正常发布（新提交）。
        // 注意：这里是在恢复之后才编辑，仅证明恢复后仍可正常发布，不等价于 pending 期间编辑保护（见 test 9）。
        fs.writeFileSync(path.join(c.dataRoot, ART), jl('a-edit2', {}));
        const aEdit2Buf = Buffer.from(jl('a-edit2', {}));
        const r2 = await orchestrator.run(onlineOpts(c, 'push'));
        assert.deepStrictEqual(r2.published, [ART], '本地新编辑应正常发布');
        assert.strictEqual(sha(path.join(c.dataRoot, ART)), shaBuf(aEdit2Buf), '本地新编辑保留');
        assert.strictEqual(shaBuf(show(c.bare, ART)), shaBuf(aEdit2Buf), '远端应为 a-edit2');
    }));

    // ===== 8. 合成目录同时有合法 active + pending（组合单测）→ 屏障先于 pending 恢复 =====
    tests.push(runTest(8, '合成 active+pending 共存（组合单测）：online push/pull 屏障先于 pending 恢复，pending/B/active/stage/聊天/远端 head 均不变', async () => {
        const c = setupScenario(8, [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(onlineOpts(c, 'init'));
        await orchestrator.run(onlineOpts(c, 'push')); // 建 B=base
        const maintDir = path.join(c.repoDir, '.git', 'dsr');
        const dataRoot = c.dataRoot;
        const baseBuf = Buffer.from(jl('base', {}));
        const baseHash = shaBuf(baseBuf);
        const aEditBuf = Buffer.from(jl('a-edit', {}));
        const aEditHash = shaBuf(aEditBuf);

        const st = await stateMod.loadState(maintDir);
        const identity = stateMod.bindTargetIdentity({ repo: c.repo, branch: 'main', stDataRoot: c.dataRoot });
        const remoteHead = st.remoteHead;
        const fileKey = stateMod.fileKeyForRel(ART);

        // 合成合法 pending（快照 a-edit，hash==publishHash）
        const runIdP = 'r8p';
        const snapDir = path.join(maintDir, 'snapshots', runIdP);
        fs.mkdirSync(snapDir, { recursive: true });
        const snapRelPath = `snapshots/${runIdP}/${fileKey}.snapshot`;
        fs.writeFileSync(path.join(maintDir, snapRelPath), aEditBuf);
        const pending = {
            runId: runIdP,
            remoteHead,
            targetIdentity: identity,
            treeId: null,
            commitId: remoteHead, // 合法 hex40；屏障先触发，recoverPending 不应执行
            phase: 'committed',
            edits: [{
                rel: ART,
                originalHash: aEditHash,
                publishHash: aEditHash,
                originalBaselineHash: baseHash,
                localSnapshotHash: aEditHash,
                snapshotPath: snapRelPath,
                absTargetPath: path.join(dataRoot, ART),
            }],
            createdAt: new Date().toISOString(),
        };
        await stateMod.writePending(maintDir, pending);

        // 合成合法 active manifest（候选 a-edit + 备份 base）与合法 stage
        const runIdA = 'r8a';
        const stageDir = path.join(maintDir, 'stage', runIdA);
        fs.mkdirSync(stageDir, { recursive: true });
        const candPath = `stage/${runIdA}/${fileKey}.content`;
        fs.writeFileSync(path.join(maintDir, candPath), aEditBuf);
        const backupsDir = path.join(maintDir, 'backups', runIdA);
        fs.mkdirSync(backupsDir, { recursive: true });
        const backupPath = `backups/${runIdA}/${fileKey}.backup`;
        fs.writeFileSync(path.join(maintDir, backupPath), baseBuf);

        await stateMod.writeStage(maintDir, {
            runId: runIdA,
            remoteHead,
            targetIdentity: identity,
            entries: [{
                rel: ART,
                expectedBaselineHash: baseHash,
                expectedLocalHash: baseHash,
                expectedLocalMissing: false,
                candidateHash: aEditHash,
                candidatePath: candPath,
                remoteCommit: remoteHead,
            }],
            createdAt: new Date().toISOString(),
        });
        await stateMod.writeApplyActive(maintDir, {
            schemaVersion: stateMod.MANIFEST_SCHEMA_VERSION,
            runId: runIdA,
            targetIdentity: identity,
            stageId: runIdA,
            remoteHead,
            createdAt: new Date().toISOString(),
            entries: [{
                rel: ART,
                expectedBaselineHash: baseHash,
                expectedLocalHash: baseHash,
                expectedLocalMissing: false,
                candidateHash: aEditHash,
                candidatePath: candPath,
                backupPath,
                backupHash: baseHash,
            }],
        });

        // 快照：所有状态（阻断前后应完全不变）
        const chatBefore = sha(path.join(dataRoot, ART));
        const activeBefore = fs.readFileSync(path.join(maintDir, 'apply-active.json'), 'utf8');
        const stageBefore = fs.readFileSync(path.join(maintDir, 'stage', 'stage.json'), 'utf8');
        const pendingBefore = fs.readFileSync(path.join(maintDir, 'pending.json'), 'utf8');
        const headBefore = must(['--git-dir', c.bare, 'rev-parse', 'main']);

        // 屏障先于 pending 恢复：online push/pull 都应阻断（active manifest 命中）
        await assert.rejects(
            () => orchestrator.run(onlineOpts(c, 'push')),
            /活动 apply 事务/,
            '有 active manifest 时 online push 应阻断（先于 pending 恢复）'
        );
        await assert.rejects(
            () => orchestrator.run(onlineOpts(c, 'pull')),
            /活动 apply 事务/,
            '有 active manifest 时 online pull 应阻断（先于 pending 恢复）'
        );

        // 全部不变：pending / B / active / stage / 聊天 / 远端 head
        assert.strictEqual(await stateMod.loadPending(maintDir) !== null, true, '阻断后 pending 仍保留（未被 recoverPending 清除）');
        assert.strictEqual(fs.readFileSync(path.join(maintDir, 'pending.json'), 'utf8'), pendingBefore, '阻断后 pending 文本不变');
        const stAfter = await stateMod.loadState(maintDir);
        assert.strictEqual(stAfter.baseline[ART].hash, baseHash, '阻断后 B 不变（未推进为快照）');
        assert.strictEqual(fs.readFileSync(path.join(maintDir, 'apply-active.json'), 'utf8'), activeBefore, '阻断后 active 不变');
        assert.strictEqual(fs.readFileSync(path.join(maintDir, 'stage', 'stage.json'), 'utf8'), stageBefore, '阻断后 stage 不变');
        assert.strictEqual(sha(path.join(dataRoot, ART)), chatBefore, '阻断后聊天字节不变');
        assert.strictEqual(must(['--git-dir', c.bare, 'rev-parse', 'main']), headBefore, '阻断后远端 head 不变');
    }));

    // ===== 9. 真实 push 确认前 exit77 → 恢复前本地新编辑 → online pull 恢复 pending（B 只确认原快照，不覆盖本地新编辑） =====
    tests.push(runTest(9, '真实 push 确认前 exit77（复用 worker）：恢复前写本地新编辑，online pull 恢复 pending —— B 只确认原 a-edit 快照而非新 a-edit2、本地 a-edit2 保留、远端仅 a-edit、pending 清、commit 不增、无不当 stage 覆盖本地新编辑；之后独立 online push 正常发布 a-edit2', async () => {
        const c = setupScenario(9, [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(onlineOpts(c, 'init'));
        await orchestrator.run(onlineOpts(c, 'push')); // 建 B=base

        // 本地编辑 a-edit
        fs.writeFileSync(path.join(c.dataRoot, ART), jl('a-edit', {}));
        const aEditBuf = Buffer.from(jl('a-edit', {}));
        const aEditHash = shaBuf(aEditBuf);
        const aEdit2Buf = Buffer.from(jl('a-edit2', {}));
        const aEdit2Hash = shaBuf(aEdit2Buf);
        const baseHash = shaBuf(Buffer.from(jl('base', {})));

        // 用 fault-worker 离线 push：真实 pushBranch 成功后 exit77（确认前崩溃 → pending 保留、远端已含 a-edit、B 未推进）
        const spec = {
            task: 'fault',
            command: 'push',
            repoDir: c.repoDir, dataRoot: c.dataRoot, repo: c.repo, branch: 'main', bare: c.bare,
            offlineConfirmed: true,
            fault: { target: 'pushBranch', module: 'git-tree', when: 'after', action: 'exit', exitCode: 77 },
        };
        const w = spawnWorker(spec);
        assert.strictEqual(w.status, 77, `故障进程应以 77 退出（实际 ${w.status}）: ${w.stderr}`);
        cleanupSyntheticLocks(c);

        const maintDir = path.join(c.repoDir, '.git', 'dsr');
        // 确认真实故障窗口：pending 保留（committed+commitId）、远端已含 a-edit、B 未推进
        const pend = await stateMod.loadPending(maintDir);
        assert.ok(pend, 'exit77 后应保留 pending（真实 push 确认前崩溃）');
        assert.strictEqual(pend.phase, 'committed', 'pending 应为 committed 阶段');
        assert.ok(pend.commitId, 'pending 应含真实 commitId');
        let st = await stateMod.loadState(maintDir);
        assert.strictEqual(st.baseline[ART].hash, baseHash, 'B 未推进（仍 base，确认前崩溃）');
        assert.strictEqual(shaBuf(show(c.bare, ART)), aEditHash, '远端已含 a-edit（pushBranch 真实成功）');
        const logLenAfterFault = must(['--git-dir', c.bare, 'log', '--format=%H', 'main']).split('\n').length;

        // 关键：在恢复之前写本地新编辑 a-edit2（pending 存在期间），验证 recoverPending 不读实时 L、不覆盖本地新编辑
        fs.writeFileSync(path.join(c.dataRoot, ART), jl('a-edit2', {}));
        const aEdit2Before = sha(path.join(c.dataRoot, ART));
        assert.strictEqual(aEdit2Before, aEdit2Hash, '恢复前本地已写 a-edit2');

        // online pull 恢复 pending（避免用 push 把新编辑正常发布混淆）：recoverPending 应推进 B 为原快照 a-edit，而非 a-edit2
        const r = await orchestrator.run(onlineOpts(c, 'pull'));

        // B 只确认原 a-edit 快照，而非恢复前新写入的 a-edit2
        st = await stateMod.loadState(maintDir);
        assert.strictEqual(st.baseline[ART].hash, aEditHash, 'B 只确认原 a-edit 快照（a-edit hash），非恢复前新 a-edit2');
        // 本地字节 a-edit2 保留（pull 只暂存/冲突快照，不写聊天）
        assert.strictEqual(sha(path.join(c.dataRoot, ART)), aEdit2Hash, '本地 a-edit2 字节保留（pull 不覆盖聊天）');
        // pending 清除
        assert.strictEqual(await stateMod.loadPending(maintDir), null, '恢复后 pending 清除');
        // 远端仅 a-edit，commit 不增
        assert.strictEqual(shaBuf(show(c.bare, ART)), aEditHash, '远端仍为 a-edit（不因恢复产生新内容）');
        const logLenAfterRecover = must(['--git-dir', c.bare, 'log', '--format=%H', 'main']).split('\n').length;
        assert.strictEqual(logLenAfterRecover, logLenAfterFault, '恢复不产生重复提交');

        // 恢复后 pull 的 plan 阶段：本地 L=a-edit2、B=a-edit、R=a-edit → 三方冲突，应写冲突快照而非 stage 覆盖本地
        // 无 stage 覆盖：stage 集合应不含 ART（或整体为空），本地聊天字节不变
        assert.strictEqual(sha(path.join(c.dataRoot, ART)), aEdit2Hash, '无不当 stage 覆盖本地新编辑（聊天字节仍 a-edit2）');
        // 冲突应被报告（双方保留），但至少断言不产生对 ART 的 stage（不把本地新编辑当成待应用远端内容覆盖）
        const stage = await stateMod.loadStage(maintDir);
        const stageRels = stage && stage.entries ? stage.entries.map(e => e.rel) : [];
        assert.ok(!stageRels.includes(ART), '恢复后 pull 不应为 ART 写入 stage（本地新编辑不被误判为待应用远端内容）');

        // 独立 online push 能正常发布 a-edit2（本地编辑未被 pending 恢复破坏）
        const r2 = await orchestrator.run(onlineOpts(c, 'push'));
        assert.deepStrictEqual(r2.published, [ART], '独立 online push 应正常发布 a-edit2');
        assert.strictEqual(shaBuf(show(c.bare, ART)), aEdit2Hash, '远端应为 a-edit2');
        assert.strictEqual(sha(path.join(c.dataRoot, ART)), aEdit2Hash, '本地 a-edit2 保留');
    }));

    tests.push(runTest(10, '集成检查遇到真实未发布 pending 时在锁内停止；显式上传仍可安全重试', async () => {
        const c = setupScenario(10, [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(onlineOpts(c, 'init'));
        await orchestrator.run(onlineOpts(c, 'push'));
        fs.writeFileSync(path.join(c.dataRoot, ART), jl('not-published-yet', {}));
        const w = spawnWorker({ task: 'fault', command: 'push', repoDir: c.repoDir,
            dataRoot: c.dataRoot, repo: c.repo, branch: 'main', bare: c.bare,
            offlineConfirmed: true,
            fault: { target: 'pushBranch', module: 'git-tree', when: 'before', action: 'exit', exitCode: 77 } });
        assert.strictEqual(w.status, 77, w.stderr);
        cleanupSyntheticLocks(c);
        const maint = path.join(c.repoDir, '.git', 'dsr');
        const pendingPath = path.join(maint, 'pending.json');
        const pending = fs.readFileSync(pendingPath);
        const savedState = fs.readFileSync(path.join(maint, 'state.json'));
        const head = must(['--git-dir', c.bare, 'rev-parse', 'main']);
        const chat = fs.readFileSync(path.join(c.dataRoot, ART));
        const worker = require('../lib/integration/worker-entry');
        await assert.rejects(() => worker.runCore({ ...onlineOpts(c, 'pull'), op: 'core' }),
            e => e.code === 'PENDING_UPLOAD_REQUIRES_RETRY');
        assert.deepStrictEqual(fs.readFileSync(pendingPath), pending);
        assert.deepStrictEqual(fs.readFileSync(path.join(maint, 'state.json')), savedState);
        assert.deepStrictEqual(fs.readFileSync(path.join(c.dataRoot, ART)), chat);
        assert.strictEqual(must(['--git-dir', c.bare, 'rev-parse', 'main']), head);
        await worker.runCore({ ...onlineOpts(c, 'push'), op: 'core' });
        assert.strictEqual(await stateMod.loadPending(maint), null);
        assert.deepStrictEqual(show(c.bare, ART), chat);
    }));

    // ---- 汇总 ----
    const coreModules = ['orchestrator', 'state', 'apply', 'planner', 'git-tree', 'hash-scan'];
    const coreHashes = {};
    for (const m of coreModules) {
        const p = path.join(ROOT, 'lib', 'reliable', `${m}.js`);
        coreHashes[m] = fs.existsSync(p) ? sha(p) : null;
    }
    const report = {
        generator: 'test/online-snapshot.test.js',
        disclaimer: '真实 lib/reliable/* + 真实 git 二进制；远端为 url.insteadOf 重写后的本地 bare，未起 HTTP/UI、未用真实凭据、未互联网 push。真实 apply 中断复用 reliable-fault-worker（包装真实 fs.rename 后 exit）；合成 manifest / 合成 plan 用例为单测，不冒称集成。',
        createdAt: new Date().toISOString(),
        versions: { node: process.version, git: must(['--version']) },
        coreHashes,
        summary: { total: 0, pass: 0, fail: 0, skip: 0 },
        tests: [],
    };

    for (const t of tests) {
        const rec = await execute(t);
        report.tests.push(rec);
        if (rec.verdict === 'pass') report.summary.pass++;
        else if (rec.verdict === 'skip') report.summary.skip++;
        else report.summary.fail++;
        report.summary.total++;
        console.log(`[${rec.verdict === 'pass' ? 'PASS' : rec.verdict === 'skip' ? 'SKIP' : 'FAIL'}] test ${rec.id}: ${rec.title}`);
        if (rec.error) console.log(`    error: ${rec.error.split('\n').slice(0, 4).join(' | ')}`);
    }

    report.exitCode = report.summary.fail > 0 ? 1 : 0;
    fs.writeFileSync(path.join(RUN, 'results.json'), JSON.stringify(report, null, 2));
    console.log(`[child] summary=${JSON.stringify(report.summary)}`);
    process.exit(report.exitCode);
}

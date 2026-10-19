#!/usr/bin/env node
'use strict';
/**
 * 酒管可靠同步 · 启动期应用安全测试（startup.js 完成态复审）。
 *
 * 覆盖（对应完成态复审 P1 阻断项）：
 *  1. 真实核心 apply 成功后 _saveReceipt 抛（receipt 崩溃窗口）→ 下次 precheck-failed 保留 intent
 *     （数据/B 已正确应用，可 UI 取消；**不做** journal 历史推断、不假 idempotent）；
 *  2. 无法证实（无 complete journal）但无 active 且无未 complete plan → 保守 precheck-failed
 *     保留安排供 UI 取消（不假成功、不 exit70）；
 *  2b. 历史 stageA 已完成 + 当前 stageB 缺 stage 同 entryCount 不同 digest → 不得误清意图（历史 complete 不冒认）；
 *  3. active 同 id 但候选摘要（_stageDigest(active)）与 intent.digest 不符 → 阻断不写聊天不 recover；
 *     stage 缺失时 active 仍严格（不因 stage 缺失跳过绑定校验）；
 *  4. active 合法 + digest 匹配 + stage 存在但不是 intent stage（runId 不符）→ 阻断；
 *  5. 损坏 active 无 intent → 非零退出（fail-closed，损坏不吞成 null）；
 *  6. 损坏 journal 无 intent → 非零退出（fail-closed，损坏不吞成 []）；
 *  7. intent clientsWillBeClosed=false / schema 损坏（schemaVersion≠1）→ 拒绝（precheck-failed 保留，不应用）。
 *
 * 边界：真实 lib/reliable/orchestrator 核心（本地 bare + url.insteadOf），service 注入 fakeWorkerRunner
 * （直接调 orchestrator.run，不起 fork/HTTP）；fail-closed 用 spawn 真实子进程（--fc）验证退出码。
 * 合成隔离，不触真实安装/聊天/PAT/互联网 push。
 *
 * 用法：node test/startup-safety.test.js [--keep]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

if (process.argv[2] === '--fc') {
    fcMain().catch(err => { console.error('[fc] 未捕获异常:', err && err.stack ? err.stack : err); process.exit(72); });
} else if (process.argv[2] !== '--child') {
    parentMain();
} else {
    childMain().catch(err => {
        console.error('[child] 未捕获异常:', err && err.stack ? err.stack : err);
        process.exit(1);
    });
}

function parentMain() {
    const keep = process.argv.includes('--keep');
    const run = path.join(ROOT, 'test-artifacts', `startup-${crypto.randomUUID()}`);
    fs.mkdirSync(run, { recursive: true });
    const r = spawnSync(process.execPath, [__filename, '--child', run], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    const produced = path.join(run, 'results.json');
    if (fs.existsSync(produced)) {
        fs.copyFileSync(produced, path.join(ROOT, 'test-artifacts', 'startup-safety-results.json'));
    }
    if (!keep) {
        try { fs.rmSync(run, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
    console.log(`[parent] run=${path.relative(ROOT, run)}  exit=${r.status}`);
    process.exit(r.status === null ? 1 : r.status);
}

function isolateEnv(RUN) {
    const HOME = path.join(RUN, 'home');
    const TMP = path.join(RUN, 'tmp');
    fs.mkdirSync(HOME, { recursive: true });
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(path.join(HOME, '.gitconfig'), '');
    const SCRUB = /^(GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|GH_ENTERPRISE_TOKEN|ST_GITHUB_SYNC_TOKEN|ST_GITHUB_SYNC_TOKEN_FILE|GIT_ASKPASS|SSH_ASKPASS|GIT_ASKPASS_.*|GIT_CONFIG|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CURL_VERBOSE|GIT_TRACE.*|GIT_SSH.*|GIT_PROXY_COMMAND|SSH_AUTH_SOCK|NODE_OPTIONS)$/i;
    for (const k of Object.keys(process.env)) if (SCRUB.test(k)) delete process.env[k];
    Object.assign(process.env, {
        HOME, USERPROFILE: HOME, TMP, TEMP: TMP,
        GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file',
        GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
        GIT_CEILING_DIRECTORIES: RUN,
    });
}

async function childMain() {
    const RUN = path.resolve(process.argv[3]);
    const assert = require('assert');
    isolateEnv(RUN);

    const integration = require(path.join(ROOT, 'lib', 'integration'));
    const startup = require(path.join(ROOT, 'lib', 'integration', 'startup'));
    const storageMod = require(path.join(ROOT, 'lib', 'integration', 'storage'));
    const stateCore = require(path.join(ROOT, 'lib', 'reliable', 'state'));
    const orchestrator = require(path.join(ROOT, 'lib', 'reliable', 'orchestrator'));
    const fsExtra = require('fs-extra');

    const shaBuf = b => crypto.createHash('sha256').update(b).digest('hex');
    const git = (args, cwd) => {
        const r = spawnSync('git', args, { cwd: cwd || RUN, env: process.env, timeout: 60000, encoding: 'utf8' });
        return { ok: r.status === 0, out: String(r.stdout || '').replace(/\r\n/g, '\n').replace(/\n$/, ''), err: String(r.stderr || '').replace(/\r\n/g, '\n').trim() };
    };
    const must = (args, cwd) => {
        const r = git(args, cwd);
        if (!r.ok) throw new Error(`git ${args.join(' ')} 失败: ${r.err || r.out}`);
        return r.out;
    };
    const jl = mes => JSON.stringify({ name: 'Actor', mes }) + '\n';

    const storageBase = path.join(RUN, 'home', '.jiuguan-github-sync');
    const globalDataRoot = path.join(RUN, 'data-root');
    const repo = 'owner/repo';
    const branch = 'main';

    // service 的 repoDir 派生（与 service._userDir/_repoDir 完全一致）。
    function serviceRepoDir(handle) {
        return path.join(storageBase, storageMod.storageKey(globalDataRoot, handle), 'repo');
    }

    // 注入 fakeWorkerRunner：直接跑真实 orchestrator.run（不起 fork/HTTP），仍走真实核心。
    function fakeWorkerRunner(task) {
        if (task.op === 'preflight') return require(path.join(ROOT, 'lib', 'integration', 'preflight')).preflight(task);
        return orchestrator.run({
            command: task.command,
            repoDir: task.repoDir,
            dataRoot: task.dataRoot,
            githubRepo: task.githubRepo,
            branch: task.branch,
            tokenFile: task.tokenFile || '',
            executionMode: task.executionMode,
            offlineConfirmed: task.offlineConfirmed,
            stageId: task.stageId,
            commitAuthor: task.commitAuthor,
        });
    }

    function makeService(handle, dataRoot, overrides = {}) {
        return integration.createService({
            storageBase,
            dataRoot: globalDataRoot,
            hostRoot: RUN,
            getUsers: () => [{ handle, root: dataRoot }],
            workerRunner: fakeWorkerRunner,
            log: () => {},
            ...overrides,
        });
    }

    /** 建立本地 bare + seed(A) → clone 到 service 一致的 repoDir(带 insteadOf) → 返回场景对象。 */
    function setupGitScene(tag, contentA, handle) {
        const S = path.join(RUN, tag);
        const bare = path.join(S, 'bare.git');
        const seed = path.join(S, 'seed');
        const dataRoot = path.join(globalDataRoot, handle);
        const repoDir = serviceRepoDir(handle);
        const ART = 'chats/Actor/a.jsonl';
        fs.mkdirSync(seed, { recursive: true });
        fs.mkdirSync(path.join(seed, 'chats', 'Actor'), { recursive: true });
        fs.writeFileSync(path.join(seed, ART), contentA);
        must(['init', '-q', '--bare', '-b', 'main', bare]);
        must(['init', '-q', '-b', 'main', seed]);
        must(['add', '-A'], seed);
        must(['-c', 'user.name=seed', '-c', 'user.email=seed@localhost', 'commit', '-qm', 'base'], seed);
        must(['push', '-q', bare, 'main'], seed);
        fs.mkdirSync(path.dirname(repoDir), { recursive: true });
        must(['clone', '-q', bare, repoDir]);
        const bareUrl = `file:///${bare.replace(/\\/g, '/')}`;
        must(['config', '--local', `url.${bareUrl}.insteadOf`, `https://github.com/${repo}.git`], repoDir);
        for (const [k, v] of [['credential.helper', ''], ['user.name', 'reliable'], ['user.email', 'reliable@localhost'],
            ['core.autocrlf', 'false'], ['core.safecrlf', 'false']]) {
            must(['config', '--local', k, v], repoDir);
        }
        fs.mkdirSync(path.join(dataRoot, 'chats', 'Actor'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, ART), contentA);
        return { S, bare, repoDir, dataRoot, ART, contentA };
    }

    const results = [];
    const tests = [];
    function runTest(id, title, fn) { tests.push({ id, title, fn }); }
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

    // ===== 1. receipt 崩溃窗口：apply 成功 + _saveReceipt 抛 → 下次 precheck-failed（数据已应用，可 UI 取消） =====
    runTest(1, 'receipt 崩溃窗口：apply 成功 + _saveReceipt 抛 → 下次 precheck-failed 保留 intent（数据已应用，可 UI 取消）', async () => {
        const contentA = jl('a-base');
        const contentA2 = jl('a-peer');
        const handle = 'u-s1';
        const sc = setupGitScene('s1', contentA, handle);
        const svc = makeService(handle, sc.dataRoot);
        const user = { handle, dataRoot: sc.dataRoot };
        await svc.putConfig(user, { githubRepo: repo, branch: 'main' });

        // 直接用真实核心跑 init + push（建 B=A）
        await orchestrator.run({ command: 'init', offlineConfirmed: true, repoDir: sc.repoDir, dataRoot: sc.dataRoot, githubRepo: repo, branch });
        await orchestrator.run({ command: 'push', offlineConfirmed: true, repoDir: sc.repoDir, dataRoot: sc.dataRoot, githubRepo: repo, branch });

        // 对端推进远端 A → A2
        const adv = path.join(sc.S, 'advance');
        must(['clone', '-q', sc.bare, adv]);
        fs.writeFileSync(path.join(adv, sc.ART), contentA2);
        must(['add', '-A'], adv);
        must(['-c', 'user.name=peer', '-c', 'user.email=peer@localhost', 'commit', '-qm', 'peer'], adv);
        must(['push', '-q', sc.bare, 'main'], adv);

        // pull → 产生 stage
        await orchestrator.run({ command: 'pull', offlineConfirmed: true, repoDir: sc.repoDir, dataRoot: sc.dataRoot, githubRepo: repo, branch });

        const maint = await svc._maintDir(await svc._userDir(handle));
        const stage = await stateCore.loadStage(maint);
        assert.ok(stage, 'pull 后应有 stage');

        // schedule-apply 写 intent（digest 由 _stageDigest(stage) 计算）
        const sched = await svc.scheduleApply(user, { stageId: stage.runId, clientsWillBeClosed: true });
        assert.strictEqual(sched.success, true);
        const intent = await svc._loadIntent(handle);
        assert.ok(intent, 'schedule 后应有 intent');
        const stageId = intent.stageId;

        // 记录真实 _saveReceipt，然后 monkey-patch 抛错（模拟 apply 完成清 stage+complete+clearActive 之后、receipt 之前的崩溃窗口）
        const realSaveReceipt = svc._saveReceipt.bind(svc);
        let patched = false;
        svc._saveReceipt = async () => { patched = true; const e = new Error('injected: receipt write failed'); e.code = 'FAULT_INJECTED'; throw e; };

        // 第一次启动期应用：核心 apply 成功，但 _saveReceipt 抛 → 异常向上（runStartupApply 捕获为 blocked）
        const r1 = await integration.runStartupApply(svc);
        assert.ok(patched, '_saveReceipt 故障应确实触发');
        assert.strictEqual(r1.applied, 0, '第一次因 _saveReceipt 抛，不应记 applied');
        assert.strictEqual(r1.blocked.length, 1, '第一次应记为 blocked（exception）');

        // 中间态：核心 apply 已完成（stage 清、active 清、journal 有 complete、本地=B=A2），但 receipt 未写、intent 还在
        assert.strictEqual(await stateCore.loadStage(maint), null, 'apply 后 stage 应已清');
        assert.strictEqual(await stateCore.loadApplyActive(maint), null, 'apply 后 active 应已清');
        const midState = await stateCore.loadState(maint);
        assert.strictEqual(midState.baseline[sc.ART].hash, shaBuf(Buffer.from(contentA2)), 'apply 后 B 应推进到 A2');
        assert.ok(fs.readFileSync(path.join(sc.dataRoot, sc.ART)).equals(Buffer.from(contentA2)), 'apply 后本地应为 A2');
        const midJournal = await stateCore.readApplyJournal(maint);
        assert.ok(midJournal.some(r => r.status === 'complete'), 'apply 后 journal 应有 complete');
        assert.ok(await svc._loadIntent(handle), '崩溃窗口 intent 应仍在');

        // 恢复 _saveReceipt，再次启动期应用 → **不得**从 journal 假收敛；应 precheck-failed 保留 intent（数据已应用，可 UI 取消）
        svc._saveReceipt = realSaveReceipt;
        const r2 = await integration.runStartupApply(svc);
        assert.strictEqual(r2.applied, 0, '第二次不得假 idempotent/applied（不做历史推断）');
        assert.strictEqual(r2.blocked.length, 0, '第二次不应阻断（无 active、无未 complete plan）');
        assert.strictEqual(r2.precheckFailed.length, 1, '第二次应 precheck-failed');
        assert.strictEqual(r2.precheckFailed[0].handle, handle);
        assert.ok(r2.precheckFailed[0].error.includes('stage-missing-no-receipt') || r2.precheckFailed[0].error.includes('无法确认'), 'precheck 原因应为 stage-missing-no-receipt');

        // 数据已正确应用，但 intent 保留（用户可 UI 取消），receipt 未写
        assert.ok(fs.readFileSync(path.join(sc.dataRoot, sc.ART)).equals(Buffer.from(contentA2)), '数据已正确应用（A2）');
        assert.ok(await svc._loadIntent(handle), 'intent 应保留（供 UI 取消）');
        assert.strictEqual(await svc._loadReceipt(handle), null, '不应写 receipt（无精确凭据）');
        // 基线仍推进到 A2（数据/B 正确）
        const finalState = await stateCore.loadState(maint);
        assert.strictEqual(finalState.baseline[sc.ART].hash, shaBuf(Buffer.from(contentA2)), 'B 应已推进到 A2');
    });

    // ===== 2. 无法证实：无 active + 无 stage + 空 journal + intent → precheck-failed（可取消） =====
    runTest(2, '无法证实（无 complete journal）→ precheck-failed 保留安排（不假成功不 exit70）', async () => {
        const contentA = jl('x-base');
        const handle = 'u-s2';
        const sc = setupGitScene('s2', contentA, handle);
        const svc = makeService(handle, sc.dataRoot);
        const user = { handle, dataRoot: sc.dataRoot };

        await svc.putConfig(user, { githubRepo: repo, branch: 'main' });
        await orchestrator.run({ command: 'init', offlineConfirmed: true, repoDir: sc.repoDir, dataRoot: sc.dataRoot, githubRepo: repo, branch });
        const identity = stateCore.bindTargetIdentity({ repo, branch, stDataRoot: sc.dataRoot });

        // 构造：无 stage、无 active、无 journal（空）、有 intent、无 receipt
        const intent = { schemaVersion: 1, stageId: 'stage-x', targetIdentity: identity, digest: 'd'.repeat(64), entryCount: 1, clientsWillBeClosed: true, createdAt: new Date().toISOString() };
        await svc._saveIntent(handle, intent);

        const outcome = await startup.applyStartupIntent(svc, { handle, dataRoot: sc.dataRoot, intent });
        assert.strictEqual(outcome.outcome, 'precheck-failed', '无法证实应 precheck-failed 而非 blocked/applied');
        assert.strictEqual(outcome.reason, 'stage-missing-no-receipt');
        assert.ok(await svc._loadIntent(handle), 'precheck-failed 应保留 intent（供 UI 取消）');
        // 不写 receipt、不改聊天
        assert.strictEqual(await svc._loadReceipt(handle), null, '不应写 receipt');
        assert.ok(fs.readFileSync(path.join(sc.dataRoot, sc.ART)).equals(Buffer.from(contentA)), '本地不应被改写');
    });

    // ===== 2b. 历史 stageA 已完成 + 当前 stageB 缺 stage 同 entryCount 不同 digest → 不得误清意图 =====
    runTest('2b', '历史 complete（不同 stage）+ 当前缺 stage 同 entryCount 不同 digest → 不误 idempotent/不清意图', async () => {
        const contentA = jl('x2-base');
        const handle = 'u-s2b';
        const sc = setupGitScene('s2b', contentA, handle);
        const svc = makeService(handle, sc.dataRoot);
        const user = { handle, dataRoot: sc.dataRoot };
        await svc.putConfig(user, { githubRepo: repo, branch: 'main' });
        await orchestrator.run({ command: 'init', offlineConfirmed: true, repoDir: sc.repoDir, dataRoot: sc.dataRoot, githubRepo: repo, branch });
        const identity = stateCore.bindTargetIdentity({ repo, branch, stDataRoot: sc.dataRoot });
        const maint = await svc._maintDir(await svc._userDir(handle));
        await fs.promises.mkdir(maint, { recursive: true });

        // 历史 stageA 已完整完成：journal 里有 runId=old-run 的 plan + complete（B/L 均指向 A 的候选），
        // 但这是**另一个 stage**（stageId 不同、digest 不同）。当前 intent 是 stageB。
        await stateCore.appendApplyJournal(maint, { runId: 'old-run', rel: 'chats/Actor/a.jsonl', status: 'plan', ts: new Date().toISOString(), candidatePath: 'stage/stageA/a.content', candidateHash: 'a'.repeat(64) });
        await stateCore.appendApplyComplete(maint, 'old-run');

        // 当前 intent：stageB，同 entryCount=1，但 digest 与 stageA 完全不同
        const intentB = { schemaVersion: 1, stageId: 'stageB', targetIdentity: identity, digest: 'b'.repeat(64), entryCount: 1, clientsWillBeClosed: true, createdAt: new Date().toISOString() };
        await svc._saveIntent(handle, intentB);

        const outcome = await startup.applyStartupIntent(svc, { handle, dataRoot: sc.dataRoot, intent: intentB });
        // 无 stage → 只接受匹配 receipt，历史 complete 不冒认
        assert.strictEqual(outcome.outcome, 'precheck-failed', '历史 complete 不得冒认为本次 intent 完成');
        assert.strictEqual(outcome.reason, 'stage-missing-no-receipt');
        assert.ok(await svc._loadIntent(handle), 'intent 应保留（不误清）');
        assert.strictEqual(await svc._loadReceipt(handle), null, '不应写 receipt');
        assert.ok(fs.readFileSync(path.join(sc.dataRoot, sc.ART)).equals(Buffer.from(contentA)), '本地不应被改写');
    });

    // ===== 3. active 同 id 但候选摘要不符 → 阻断不 recover（stage 缺失仍严格） =====
    runTest(3, 'active 同 id 候选摘要不符 → 阻断不 recover；stage 缺失仍严格', async () => {
        const contentA = jl('y-base');
        const handle = 'u-s3';
        const sc = setupGitScene('s3', contentA, handle);
        const svc = makeService(handle, sc.dataRoot);
        const user = { handle, dataRoot: sc.dataRoot };
        await svc.putConfig(user, { githubRepo: repo, branch: 'main' });
        await orchestrator.run({ command: 'init', offlineConfirmed: true, repoDir: sc.repoDir, dataRoot: sc.dataRoot, githubRepo: repo, branch });
        const maint = await svc._maintDir(await svc._userDir(handle));
        const identity = stateCore.bindTargetIdentity({ repo, branch, stDataRoot: sc.dataRoot });

        // 合法 active manifest（candidate/backup 路径合法即可，recover 前不碰文件）
        const active = {
            schemaVersion: stateCore.MANIFEST_SCHEMA_VERSION, runId: 'run-s3', targetIdentity: identity, stageId: 'stage-s3',
            remoteHead: '0'.repeat(40), createdAt: new Date().toISOString(),
            entries: [{ rel: 'chats/Actor/a.jsonl', expectedBaselineHash: null, expectedLocalHash: 'a'.repeat(64), expectedLocalMissing: false, candidateHash: 'b'.repeat(64), candidatePath: 'stage/stage-s3/a.content', backupPath: 'backups/run-s3/a.backup', backupHash: 'a'.repeat(64) }],
        };
        await stateCore.writeApplyActive(maint, active);

        // intent stageId 匹配，但 digest 用与 active 摘要不同的值（候选摘要不符）
        const intent = { schemaVersion: 1, stageId: 'stage-s3', targetIdentity: identity, digest: 'c'.repeat(64), entryCount: 1, clientsWillBeClosed: true, createdAt: new Date().toISOString() };
        const outcome = await startup.applyStartupIntent(svc, { handle, dataRoot: sc.dataRoot, intent });
        assert.strictEqual(outcome.outcome, 'blocked');
        assert.strictEqual(outcome.reason, 'digest-mismatch', 'active 候选摘要与 intent 不符应 digest-mismatch');
        // 未 recover、未清 active、未写聊天
        const activeAfter = await stateCore.loadApplyActive(maint);
        assert.ok(activeAfter, 'active 不应被 recover 清除');
        assert.strictEqual(activeAfter.runId, 'run-s3');
        assert.ok(fs.readFileSync(path.join(sc.dataRoot, sc.ART)).equals(Buffer.from(contentA)), '聊天不应被改写');
    });

    // ===== 4. active 合法 + digest 匹配 + stage 存在但 runId 不符 → 阻断 =====
    runTest(4, 'active 合法 + digest 匹配 + stage 存在但不是 intent stage → 阻断', async () => {
        const contentA = jl('z-base');
        const handle = 'u-s4';
        const sc = setupGitScene('s4', contentA, handle);
        const svc = makeService(handle, sc.dataRoot);
        const user = { handle, dataRoot: sc.dataRoot };
        await svc.putConfig(user, { githubRepo: repo, branch: 'main' });
        await orchestrator.run({ command: 'init', offlineConfirmed: true, repoDir: sc.repoDir, dataRoot: sc.dataRoot, githubRepo: repo, branch });
        const maint = await svc._maintDir(await svc._userDir(handle));
        const identity = stateCore.bindTargetIdentity({ repo, branch, stDataRoot: sc.dataRoot });

        const active = {
            schemaVersion: stateCore.MANIFEST_SCHEMA_VERSION, runId: 'run-s4', targetIdentity: identity, stageId: 'stage-s4',
            remoteHead: '0'.repeat(40), createdAt: new Date().toISOString(),
            entries: [{ rel: 'chats/Actor/a.jsonl', expectedBaselineHash: null, expectedLocalHash: 'a'.repeat(64), expectedLocalMissing: false, candidateHash: 'b'.repeat(64), candidatePath: 'stage/stage-s4/a.content', backupPath: 'backups/run-s4/a.backup', backupHash: 'a'.repeat(64) }],
        };
        await stateCore.writeApplyActive(maint, active);
        const digest = await svc._stageDigest(active); // 与 active 一致的 digest

        // stage 存在但 runId 是另一个（≠ intent.stageId）
        const stageOther = {
            runId: 'stage-other', remoteHead: '0'.repeat(40), targetIdentity: identity,
            entries: [{ rel: 'chats/Actor/a.jsonl', expectedBaselineHash: null, expectedLocalHash: 'a'.repeat(64), expectedLocalMissing: false, candidateHash: 'b'.repeat(64), candidatePath: 'stage/stage-other/a.content', remoteCommit: '0'.repeat(40) }],
            createdAt: new Date().toISOString(),
        };
        fsExtra.mkdirpSync(path.join(maint, 'stage'));
        fs.writeFileSync(path.join(maint, 'stage', 'stage.json'), JSON.stringify(stageOther, null, 2));

        const intent = { schemaVersion: 1, stageId: 'stage-s4', targetIdentity: identity, digest, entryCount: 1, clientsWillBeClosed: true, createdAt: new Date().toISOString() };
        const outcome = await startup.applyStartupIntent(svc, { handle, dataRoot: sc.dataRoot, intent });
        assert.strictEqual(outcome.outcome, 'blocked');
        assert.strictEqual(outcome.reason, 'stage-mismatch', 'stage.runId 与 intent.stageId 不符应 stage-mismatch');
        assert.ok(await stateCore.loadApplyActive(maint), 'active 不应被 recover 清除');
        assert.ok(fs.readFileSync(path.join(sc.dataRoot, sc.ART)).equals(Buffer.from(contentA)), '聊天不应被改写');
    });

    // ===== 5/6. 损坏 active / journal 无 intent → fail-closed exit 70（子进程） =====
    runTest(5, '损坏 active / journal 无 intent → fail-closed process.exit 非零（70）', () => {
        for (const mode of ['corrupt-active', 'corrupt-journal']) {
            const w = path.join(RUN, `fc-${mode}`);
            fs.mkdirSync(w, { recursive: true });
            const r = spawnSync(process.execPath, [__filename, '--fc', w, mode], { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 60000 });
            assert.strictEqual(r.status, 70, `mode=${mode} 应 fail-closed 退出 70，实际 ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
        }
    });

    // ===== 7. 关闭声明 false / schema 损坏 → 拒绝（precheck-failed 保留，不应用） =====
    runTest(7, 'intent clientsWillBeClosed=false / schemaVersion≠1 → 拒绝不应用', async () => {
        const contentA = jl('w-base');
        const handle = 'u-s7';
        const sc = setupGitScene('s7', contentA, handle);
        const svc = makeService(handle, sc.dataRoot);
        const user = { handle, dataRoot: sc.dataRoot };
        await svc.putConfig(user, { githubRepo: repo, branch: 'main' });
        await orchestrator.run({ command: 'init', offlineConfirmed: true, repoDir: sc.repoDir, dataRoot: sc.dataRoot, githubRepo: repo, branch });
        const identity = stateCore.bindTargetIdentity({ repo, branch, stDataRoot: sc.dataRoot });

        // (a) clientsWillBeClosed=false → 拒绝（无 active → precheck-failed）
        const intentFalse = { schemaVersion: 1, stageId: 'stage-s7', targetIdentity: identity, digest: 'e'.repeat(64), entryCount: 1, clientsWillBeClosed: false, createdAt: new Date().toISOString() };
        const r1 = await startup.applyStartupIntent(svc, { handle, dataRoot: sc.dataRoot, intent: intentFalse });
        assert.strictEqual(r1.outcome, 'precheck-failed', 'clientsWillBeClosed=false 应拒绝');
        assert.strictEqual(r1.reason, 'intent-schema-invalid');
        assert.ok(fs.readFileSync(path.join(sc.dataRoot, sc.ART)).equals(Buffer.from(contentA)), '本地不应被改写');

        // (b) schemaVersion≠1 → 拒绝
        const intentBadSchema = { schemaVersion: 2, stageId: 'stage-s7', targetIdentity: identity, digest: 'e'.repeat(64), entryCount: 1, clientsWillBeClosed: true, createdAt: new Date().toISOString() };
        const r2 = await startup.applyStartupIntent(svc, { handle, dataRoot: sc.dataRoot, intent: intentBadSchema });
        assert.strictEqual(r2.outcome, 'precheck-failed', 'schemaVersion≠1 应拒绝');
        assert.strictEqual(r2.reason, 'intent-schema-invalid');
        assert.ok(fs.readFileSync(path.join(sc.dataRoot, sc.ART)).equals(Buffer.from(contentA)), '本地不应被改写');
    });

    // ---- 汇总 ----
    const report = {
        generator: 'test/startup-safety.test.js',
        disclaimer: '合成测试（synthetic）：真实 lib/reliable/orchestrator 核心 + 本地 bare（url.insteadOf 重写）；service 注入 fakeWorkerRunner（直接 orchestrator.run，不起 fork/HTTP）；fail-closed 用 spawn 真实子进程（--fc）验证退出码 70；隔离 HOME/TMP；不触真实安装/聊天/PAT/互联网 push。',
        createdAt: new Date().toISOString(),
        versions: { node: process.version, git: (git(['--version']).out || '').trim() },
        summary: { total: 0, pass: 0, fail: 0, skip: 0 },
        tests: [],
    };

    for (const t of tests) {
        const rec = await execute(t);
        report.tests.push(rec);
        report.summary.total++;
        if (rec.verdict === 'pass') report.summary.pass++;
        else report.summary.fail++;
        console.log(`[${rec.verdict.toUpperCase()}] test ${rec.id}: ${t.title}`);
        if (rec.verdict === 'fail' && rec.error) console.log(`    error: ${rec.error.split('\n').slice(0, 6).join(' | ')}`);
    }

    report.exitCode = report.summary.fail > 0 ? 1 : 0;
    fs.writeFileSync(path.join(RUN, 'results.json'), JSON.stringify(report, null, 2));
    console.log(`[child] summary=${JSON.stringify(report.summary)}`);
    process.exit(report.exitCode);
}

// ===== --fc worker：构造损坏 active / journal 无 intent，跑 createPlugin.start → failClosed(70) =====
async function fcMain() {
    const RUN = path.resolve(process.argv[3]);
    const mode = process.argv[4] || 'corrupt-active';
    isolateEnv(RUN);

    const integration = require(path.join(ROOT, 'lib', 'integration'));
    const fsExtra = require('fs-extra');

    const storageBase = path.join(RUN, 'home', '.jiuguan-github-sync');
    const globalDataRoot = path.join(RUN, 'data-root');
    const handle = 'alice';
    const dataRoot = path.join(globalDataRoot, handle);
    fs.mkdirSync(path.join(dataRoot, 'chats', 'Actor'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'chats', 'Actor', 'a.jsonl'), JSON.stringify({ name: 'Actor', mes: 'seed' }) + '\n');

    const router = { get() {}, post() {}, put() {} };
    const plugin = integration.createPlugin({
        router,
        deps: {
            storageBase,
            dataRoot: globalDataRoot,
            hostRoot: RUN,
            getUsers: () => [{ handle, root: dataRoot }],
            failClosed: (code) => process.exit(code),
            log: () => {},
        },
    });
    const service = plugin.service();
    // 写 config（用户「有 config」），无 intent
    await service.putConfig({ handle, dataRoot }, { githubRepo: 'owner/repo', branch: 'main' });
    const maint = await service._maintDir(await service._userDir(handle));
    await fsExtra.ensureDir(maint);

    if (mode === 'corrupt-active') {
        // 损坏 apply-active.json（非法 JSON）→ loadApplyActive 抛 CorruptStateError（不得吞成 null）
        fs.writeFileSync(path.join(maint, 'apply-active.json'), '{ not valid json');
    } else if (mode === 'corrupt-journal') {
        // 损坏 apply-journal.jsonl（非法 JSON）→ readApplyJournal 抛 CorruptStateError（不得吞成 []）
        fs.writeFileSync(path.join(maint, 'apply-journal.jsonl'), '{ not valid json\n');
    }

    // start() 里 runStartupApply → collectIntents → hasActiveOrIncompletePlan 抛 → failClosed(70)
    await plugin.start();

    // 走到这里说明未 fail-closed
    process.exit(71);
}

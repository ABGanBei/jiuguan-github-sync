#!/usr/bin/env node
'use strict';
/**
 * 酒管可靠同步 · 后端集成测试（integration-contract.md）。
 *
 * 覆盖：
 *  1. 身份：无 req.user → 401；数据根越界 → 401；
 *  2. 越权字段：未知请求字段 → 400；HTTP 传 handle/dataRoot/repoDir/tokenFile/remoteURL/env/command/offlineConfirmed → 400；
 *  3. secret 不输出：config/token 脱敏，错误不含 token/堆栈/绝对路径；
 *  4. 目标切换保留：有 state/pending/stage 时换目标 → 409，不清历史；
 *  5. worker 真实 fork（无 shell）+ 环境净化 + 本地 bare 跑核心 status；
 *  6. connect：本地 init repo + add origin + initializeEmptyBranch 引导空分支（普通 push，非 force）；
 *  7. 启动期应用：真实核心 + 本地 bare，精确绑定 stageId/targetIdentity/摘要，应用成功；摘要不符 → 阻断不应用；
 *  8. fail-closed：真实子进程验证「启动期应用无法收敛 → process.exit 非零」；
 *  9. 自动检查默认关闭；stopAll 清定时器。
 *
 * 边界：HTTP router 用轻量 stub（非 Express 实测，Codex 后补真实 Express）；远端为 url.insteadOf
 * 重写后的本地 bare；不触真实安装/聊天/PAT/互联网 push。
 *
 * 用法：node test/integration-server.test.js [--keep]
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
    const keep = process.argv.includes('--keep');
    const run = path.join(ROOT, 'test-artifacts', `integration-${crypto.randomUUID()}`);
    fs.mkdirSync(run, { recursive: true });
    const r = spawnSync(process.execPath, [__filename, '--child', run], { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    const produced = path.join(run, 'results.json');
    if (fs.existsSync(produced)) {
        fs.copyFileSync(produced, path.join(ROOT, 'test-artifacts', 'integration-results.json'));
    }
    if (!keep) {
        try { fs.rmSync(run, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
    console.log(`[parent] run=${path.relative(ROOT, run)}  exit=${r.status}`);
    process.exit(r.status === null ? 1 : r.status);
}

async function childMain() {
    const RUN = path.resolve(process.argv[3]);
    const assert = require('assert');
    const integration = require(path.join(ROOT, 'lib', 'integration'));
    const { createService, registerRoutes } = integration;
    const storageMod = require(path.join(ROOT, 'lib', 'integration', 'storage'));
    const workerMod = require(path.join(ROOT, 'lib', 'integration', 'worker'));
    const startup = require(path.join(ROOT, 'lib', 'integration', 'startup'));
    const stateCore = require(path.join(ROOT, 'lib', 'reliable', 'state'));
    const orchestrator = require(path.join(ROOT, 'lib', 'reliable', 'orchestrator'));

    // ---- 环境隔离 ----
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
        GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
        GIT_CEILING_DIRECTORIES: RUN,
    });

    const shaBuf = b => crypto.createHash('sha256').update(b).digest('hex');
    const mustGit = (args, cwd) => {
        const r = spawnSync('git', args, { cwd: cwd || RUN, env: process.env, encoding: 'utf8', timeout: 60000 });
        if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr || r.stdout}`);
        return String(r.stdout || '').trim();
    };
    // 轮询等待异步条件成立（用于 deferred worker 挂起的确定性断言，无睡眠等待的不确定性）。
    async function waitUntil(cond, label = '条件', timeoutMs = 5000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (cond()) return;
            await new Promise(r => setTimeout(r, 5));
        }
        if (cond()) return;
        throw new Error(`等待超时: ${label}`);
    }

    const storageBase = path.join(HOME, '.jiuguan-github-sync');
    const globalDataRoot = path.join(RUN, 'data-root');
    const handle = 'alice';
    const dataRoot = path.join(globalDataRoot, handle);
    fs.mkdirSync(path.join(dataRoot, 'chats', 'Actor'), { recursive: true });

    const repo = 'owner/repo';
    const branch = 'main';
    const syntheticToken = 'ghp_' + 'e'.repeat(32);
    // Metadata is injected: all transport still targets the isolated local bare repositories.
    const repositoryInspector = async ({ repo: inspectedRepo, token }) => {
        assert.strictEqual(inspectedRepo, repo);
        assert.strictEqual(token, syntheticToken, '连接验证只使用固定合成 token');
        return { private: true, fullName: repo, writePermissionHint: true };
    };

    // 每个「需要 git 仓库」的测试用独立 handle，避免共享 repoDir 互相污染。
    function ctxFor(tag) {
        const h = `alice-${tag}`;
        const dr = path.join(globalDataRoot, h);
        fs.mkdirSync(path.join(dr, 'chats', 'Actor'), { recursive: true });
        const ud = path.join(storageBase, storageMod.storageKey(globalDataRoot, h));
        const rd = path.join(ud, 'repo');
        const makeServiceFor = (overrides = {}) => createService({
            storageBase,
            dataRoot: globalDataRoot,
            hostRoot: RUN,
            getUsers: () => [{ handle: h, root: dr }],
            log: () => {},
            repositoryInspector,
            ...overrides,
        });
        return { handle: h, dataRoot: dr, userDirAbs: ud, repoDirAbs: rd, makeService: makeServiceFor, user: { handle: h, dataRoot: dr } };
    }

    // ---- 轻量 router stub（非 Express 实测） ----
    function stubRouter() {
        const methods = { get: {}, post: {}, put: {} };
        const reg = m => (p, fn) => { methods[m][p] = fn; };
        const r = { get: reg('get'), post: reg('post'), put: reg('put') };
        r.invoke = async (method, p, req, res) => {
            const fn = methods[method][p];
            if (!fn) { res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'not found' }); return; }
            return fn(req, res);
        };
        return r;
    }
    function fakeRes() {
        const o = { statusCode: 200, body: null, headers: {} };
        o.status = (c) => { o.statusCode = c; return o; };
        o.json = (b) => { o.body = b; return o; };
        return o;
    }

    function makeService(overrides = {}) {
        return createService({
            storageBase,
            dataRoot: globalDataRoot,
            hostRoot: RUN,
            getUsers: () => [{ handle, root: dataRoot }],
            workerRunner: null, // 用真实 worker
            log: () => {},
            repositoryInspector,
            ...overrides,
        });
    }
    const user = { handle, dataRoot };
    // Stubbed worker tests use the real local init/state format and public connect gate.
    // This helper never substitutes a hand-written verification record or contacts GitHub.
    async function configureStubbedSync(svc, c, config = {}) {
        await svc.putConfig(c.user, { githubRepo: repo, branch, token: syntheticToken, ...config });
        fs.mkdirSync(c.repoDirAbs, { recursive: true });
        mustGit(['init', '-q', '-b', branch], c.repoDirAbs);
        await orchestrator.run({ command: 'init', offlineConfirmed: true, repoDir: c.repoDirAbs,
            dataRoot: c.dataRoot, githubRepo: repo, branch });
        const connected = await svc.connect(c.user, {});
        assert.strictEqual(connected.connected, true, '合成 worker 也必须通过 connect 验证门禁');
    }
    function reqOf(over = {}) {
        return { user: { profile: { handle }, directories: { root: dataRoot } }, body: {}, ...over };
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

    // ===== 1. 身份：无 req.user → 401；数据根越界 → 401 =====
    runTest(1, '无身份/数据根越界/错用户 root → 401', async () => {
        const svc = makeService();
        assert.throws(() => svc.identityFromReq({}), (e) => e.statusCode === 401 && e.code === 'UNAUTHORIZED');
        assert.throws(() => svc.identityFromReq({ user: { profile: {} } }), (e) => e.statusCode === 401);
        // 数据根不在 globalDataRoot 之内
        assert.throws(() => svc.identityFromReq({ user: { profile: { handle }, directories: { root: path.join(RUN, 'evil') } } }), (e) => e.statusCode === 401);
        // 错用户 root：alice 请求携带 bob 的 root（在 base 之下但非 DATA_ROOT/alice）→ 401（精确匹配）
        const bobRoot = path.join(globalDataRoot, 'bob');
        assert.throws(() => svc.identityFromReq({ user: { profile: { handle }, directories: { root: bobRoot } } }), (e) => e.statusCode === 401 && e.code === 'UNAUTHORIZED', 'alice 携带 bob root 应 401');
        // 正常
        const id = svc.identityFromReq(reqOf());
        assert.strictEqual(id.handle, handle);
        assert.strictEqual(id.dataRoot, path.resolve(dataRoot));
    });

    // ===== 2. 越权字段：未知字段 → 400；HTTP 禁传敏感字段 =====
    runTest(2, '未知/越权请求字段 → 400', async () => {
        const svc = makeService();
        // 未知字段
        await assert.rejects(() => svc.putConfig(user, { bogus: 1 }), (e) => e.statusCode === 400 && e.code === 'BAD_REQUEST');
        // 越权字段：HTTP 禁止传 handle/dataRoot/repoDir/tokenFile/remoteURL/env/command/offlineConfirmed
        for (const field of ['handle', 'dataRoot', 'repoDir', 'tokenFile', 'remoteURL', 'env', 'command', 'offlineConfirmed']) {
            await assert.rejects(() => svc.putConfig(user, { [field]: 'x' }), (e) => e.statusCode === 400, `字段 ${field} 应被拒绝`);
        }
    });

    // ===== 3. secret 不输出：config 不含 token，错误脱敏 =====
    runTest(3, 'token/堆栈/绝对路径不输出', async () => {
        const svc = makeService();
        const secret = 'ghp_' + 'a'.repeat(32);
        const r1 = await svc.putConfig(user, { githubRepo: 'owner/repo', branch: 'main', token: secret });
        assert.strictEqual(r1.success, true);
        // config 响应不含 token 字段
        const cfg = await svc.getConfig(user);
        assert.strictEqual(cfg.hasToken, true);
        assert.ok(!('token' in cfg.config), 'config 不应含 token');
        assert.ok(!JSON.stringify(cfg).includes(secret), '响应不应含真实 token');
        // 脱敏函数：真实 token 与常见格式都不泄漏
        const redactMod = require(path.join(ROOT, 'lib', 'integration', 'redact'));
        const out = redactMod.redact(secret, `error: ${secret} at C:\\Users\\x\\y.js:1:1`);
        assert.ok(!out.includes(secret), '脱敏后不应含真实 token');
        assert.ok(!redactMod.containsSecret(secret, out), 'containsSecret 应判定无泄漏');
        assert.ok(!out.includes('C:\\Users'), '不应泄漏绝对路径');
        assert.ok(!/\bat\s+\S+:\d+:\d+/.test(out), '不应含堆栈');
    });

    // ===== 4. 目标切换保留：有 state 时换目标 → 409 =====
    runTest(4, '有 state/pending/stage 时换目标 → 409 且不清历史', async () => {
        const svc = makeService();
        await svc.putConfig(user, { githubRepo: 'owner/repo', branch: 'main' });
        // 模拟已有 state.json（不跑核心）
        const maint = await svc._maintDir(await svc._userDir(handle));
        fs.mkdirSync(maint, { recursive: true });
        await fs.promises.writeFile(path.join(maint, 'state.json'), '{}');
        // 换目标 → 拒绝
        await assert.rejects(
            () => svc.putConfig(user, { githubRepo: 'owner/other', branch: 'main' }),
            (e) => e.statusCode === 409 && e.code === 'TARGET_SWITCH_REJECTED'
        );
        await assert.rejects(() => svc.putConfig(user, { githubRepo: '' }),
            (e) => e.statusCode === 409 && e.code === 'TARGET_SWITCH_REJECTED', '不得先清目标再换仓库');
        // 历史仍在（state.json 未被清）
        assert.ok(fs.existsSync(path.join(maint, 'state.json')), '历史 state.json 不应被清除');
    });

    // ===== 5. worker 真实 fork + 环境净化 + 本地 bare 跑核心 status =====
    runTest(5, 'worker 真实 fork 净化环境跑核心 status（本地 bare）', async () => {
        const c = ctxFor('w5');
        const seed = Buffer.from(JSON.stringify({ mes: 'seed-1' }) + '\n');
        const bare = path.join(RUN, 'bare5.git');
        mustGit(['init', '-q', '--bare', '-b', 'main', bare]);
        const seedDir = path.join(RUN, 'seed5');
        fs.mkdirSync(path.join(seedDir, 'chats', 'Actor'), { recursive: true });
        fs.writeFileSync(path.join(seedDir, 'chats', 'Actor', 'a.jsonl'), seed);
        mustGit(['init', '-q', '-b', 'main', seedDir]);
        mustGit(['add', '-A'], seedDir);
        mustGit(['-c', 'user.name=seed', '-c', 'user.email=s@l', 'commit', '-qm', 'base'], seedDir);
        mustGit(['push', '-q', bare, 'main'], seedDir);

        // repoDir 放在 service 的路径上
        fs.mkdirSync(path.dirname(c.repoDirAbs), { recursive: true });
        mustGit(['clone', '-q', bare, c.repoDirAbs]);
        const bareUrl = `file:///${bare.replace(/\\/g, '/')}`;
        mustGit(['config', '--local', `url.${bareUrl}.insteadOf`, `https://github.com/${repo}.git`], c.repoDirAbs);
        for (const [k, v] of [['credential.helper', ''], ['core.autocrlf', 'false'], ['core.safecrlf', 'false']]) {
            mustGit(['config', '--local', k, v], c.repoDirAbs);
        }
        fs.writeFileSync(path.join(c.dataRoot, 'chats', 'Actor', 'a.jsonl'), seed);

        // 先保存目标，再建立绑定 state；已有 state 时不允许事后补改目标。
        const svc = c.makeService();
        await svc.putConfig(c.user, { githubRepo: repo, branch: 'main' });
        // 直接核心 init（建立 state，offline 合法）
        await orchestrator.run({ command: 'init', offlineConfirmed: true, repoDir: c.repoDirAbs, dataRoot: c.dataRoot, githubRepo: repo, branch });

        const st = await svc.status(c.user);
        assert.strictEqual(st.success, true);
        assert.strictEqual(st.status.configured, true);
        assert.strictEqual(st.status.remoteSource, 'cached');
        assert.ok(st.status.core && st.status.core.initialized === true, `core status 应返回 initialized=true，实际=${JSON.stringify(st.status.core)}`);
    });

    // ===== 6. connect：本地 init repo + add origin + 引导空分支 =====
    runTest(6, 'connect 本地 init + initializeEmptyBranch 引导空分支', async () => {
        const c = ctxFor('c6');
        // 空 bare（无分支）
        const bare = path.join(RUN, 'bare6.git');
        mustGit(['init', '-q', '--bare', '-b', 'main', bare]);
        const bareUrl = `file:///${bare.replace(/\\/g, '/')}`;

        const svc = c.makeService({ insteadOf: { [`https://github.com/${repo}.git`]: bareUrl } });
        await svc.putConfig(c.user, { githubRepo: repo, branch: 'main', token: syntheticToken });

        // 不传 initializeEmptyBranch：远端无分支 → 报告 needsRemoteInit
        const r1 = await svc.connect(c.user, {});
        assert.strictEqual(r1.success, true);
        assert.strictEqual(r1.needsRemoteInit, true);
        // 再次 connect 传 initializeEmptyBranch:true → 引导
        const r2 = await svc.connect(c.user, { initializeEmptyBranch: true });
        assert.strictEqual(r2.success, true);
        assert.strictEqual(r2.initializedRemote, true);
        // bare 已有 main 分支
        const branches = mustGit(['--git-dir', bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads']);
        assert.ok(branches.split('\n').includes('main'), 'bare 应已有 main 分支');
    });

    // ===== 7. 启动期应用：真实核心精确绑定，应用成功 / 摘要不符阻断 =====
    runTest(7, '启动期应用精确绑定 stageId/targetIdentity/摘要', async () => {
        const c = ctxFor('s7');
        const seed = Buffer.from(JSON.stringify({ mes: 'seed' }) + '\n');
        const bare = path.join(RUN, 'bare7.git');
        mustGit(['init', '-q', '--bare', '-b', 'main', bare]);
        const seedDir = path.join(RUN, 'seed7');
        fs.mkdirSync(path.join(seedDir, 'chats', 'Actor'), { recursive: true });
        fs.writeFileSync(path.join(seedDir, 'chats', 'Actor', 'a.jsonl'), seed);
        mustGit(['init', '-q', '-b', 'main', seedDir]);
        mustGit(['add', '-A'], seedDir);
        mustGit(['-c', 'user.name=seed', '-c', 'user.email=s@l', 'commit', '-qm', 'base'], seedDir);
        mustGit(['push', '-q', bare, 'main'], seedDir);

        fs.mkdirSync(path.dirname(c.repoDirAbs), { recursive: true });
        mustGit(['clone', '-q', bare, c.repoDirAbs]);
        const bareUrl = `file:///${bare.replace(/\\/g, '/')}`;
        mustGit(['config', '--local', `url.${bareUrl}.insteadOf`, `https://github.com/${repo}.git`], c.repoDirAbs);
        for (const [k, v] of [['credential.helper', ''], ['core.autocrlf', 'false'], ['core.safecrlf', 'false']]) {
            mustGit(['config', '--local', k, v], c.repoDirAbs);
        }
        fs.writeFileSync(path.join(c.dataRoot, 'chats', 'Actor', 'a.jsonl'), seed);

        const svc = c.makeService();
        await svc.putConfig(c.user, { githubRepo: repo, branch: 'main' });
        // 建立基线：init + push（L=R → 建 B）
        await orchestrator.run({ command: 'init', offlineConfirmed: true, repoDir: c.repoDirAbs, dataRoot: c.dataRoot, githubRepo: repo, branch });
        await orchestrator.run({ command: 'push', offlineConfirmed: true, repoDir: c.repoDirAbs, dataRoot: c.dataRoot, githubRepo: repo, branch });

        // 另一设备推进远端
        const otherContent = Buffer.from(JSON.stringify({ mes: 'other-edit' }) + '\n');
        const otherWork = path.join(RUN, 'other7');
        mustGit(['clone', '-q', bare, otherWork]);
        mustGit(['config', '--local', 'user.name', 'other'], otherWork);
        mustGit(['config', '--local', 'user.email', 'other@l'], otherWork);
        fs.writeFileSync(path.join(otherWork, 'chats', 'Actor', 'a.jsonl'), otherContent);
        mustGit(['add', '-A'], otherWork);
        mustGit(['commit', '-qm', 'other'], otherWork);
        mustGit(['push', '-q', bare, 'main'], otherWork);

        // pull（offline 合法）→ 产生 stage
        await orchestrator.run({ command: 'pull', offlineConfirmed: true, repoDir: c.repoDirAbs, dataRoot: c.dataRoot, githubRepo: repo, branch });

        // 读 stage，构造正确 intent
        const maint = await svc._maintDir(await svc._userDir(c.handle));
        const stage = await stateCore.loadStage(maint);
        assert.ok(stage, 'pull 后应有 stage');
        const identity = stateCore.bindTargetIdentity({ repo, branch, stDataRoot: c.dataRoot });
        assert.strictEqual(stage.targetIdentity, identity, 'stage 身份应一致');
        const digest = await svc._stageDigest(stage);

        // 摘要不符 → 预检失败（无活动事务，继续启动让 UI 取消），不应用、不 fail-closed
        const badIntent = { schemaVersion: 1, stageId: stage.runId, targetIdentity: identity, digest: '0'.repeat(64), entryCount: stage.entries.length, clientsWillBeClosed: true, createdAt: new Date().toISOString() };
        await svc._saveIntent(c.handle, badIntent);
        const rBad = await integration.runStartupApply(svc);
        assert.strictEqual(rBad.blocked.length, 0, '摘要不符（无活动事务）不应阻断');
        assert.strictEqual(rBad.precheckFailed.length, 1, '摘要不符应记为预检失败');
        assert.strictEqual(rBad.applied, 0);
        // 本地聊天未被改写
        assert.ok(fs.readFileSync(path.join(c.dataRoot, 'chats', 'Actor', 'a.jsonl')).equals(seed), '预检失败后本地不应被改写');
        // intent 保留（预检失败不清 intent，让 UI 取消或重试）
        assert.ok(await svc._loadIntent(c.handle), '预检失败后 intent 应保留');

        // 正确 intent → 应用成功
        await svc._saveIntent(c.handle, { schemaVersion: 1, stageId: stage.runId, targetIdentity: identity, digest, entryCount: stage.entries.length, clientsWillBeClosed: true, createdAt: new Date().toISOString() });
        const rOk = await integration.runStartupApply(svc);
        assert.strictEqual(rOk.applied, 1, '正确 intent 应应用');
        assert.strictEqual(rOk.blocked.length, 0);
        // 本地聊天应变为 otherContent
        assert.ok(fs.readFileSync(path.join(c.dataRoot, 'chats', 'Actor', 'a.jsonl')).equals(otherContent), '应用后本地应等于远端领先内容');
        // intent 已清
        const intentAfter = await svc._loadIntent(c.handle);
        assert.strictEqual(intentAfter, null, '成功后 intent 应清除');
    });

    // ===== 8. fail-closed：子进程验证 process.exit 非零 =====
    runTest(8, '启动期应用无法收敛 / 无 intent 有活动事务 / 枚举异常 → fail-closed process.exit 非零', () => {
        for (const mode of ['active-no-intent', 'active-unresolved', 'corrupt-intent-with-active', 'enum-throws']) {
            const w = path.join(RUN, `fc-${mode}`);
            fs.mkdirSync(w, { recursive: true });
            const r = spawnSync(process.execPath, [path.join(ROOT, 'test', 'integration-worker.js'), w, mode], { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 120000 });
            assert.strictEqual(r.status, 70, `mode=${mode} 应 fail-closed 退出 70，实际 ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
        }
    });

    // ===== 9. 自动检查默认关闭 + stopAll 清定时器 =====
    runTest(9, '自动检查默认关闭，stopAll 清定时器', async () => {
        const svc = makeService();
        const u = await svc._getRuntime(handle);
        assert.strictEqual(u.config.autoCheckEnabled, false, '默认关闭');
        assert.strictEqual(u.timer, null, '默认无定时器');
        // 开启后应有定时器
        await svc.putConfig(user, { githubRepo: 'owner/repo', autoCheckEnabled: true, autoCheckMinutes: 30 });
        const u2 = await svc._getRuntime(handle);
        assert.ok(u2.timer, '开启后应有定时器');
        // stopAll 清定时器
        svc.stopAll();
        assert.strictEqual(u2.timer, null, 'stopAll 后定时器应清除');
    });

    // ===== HTTP stub 层冒烟：/health、/status、401 =====
    runTest(10, 'HTTP stub 冒烟：health 需身份 / 无身份 401', async () => {
        const router = stubRouter();
        const svc = makeService();
        registerRoutes(router, svc);

        // health 有身份 → 200
        const resH = fakeRes();
        await router.invoke('get', '/health', reqOf(), resH);
        assert.strictEqual(resH.statusCode, 200);
        assert.strictEqual(resH.body.success, true);
        assert.strictEqual(resH.body.version, require(path.join(ROOT, 'package.json')).version);
        assert.strictEqual(resH.body.startupApplyOnly, true);

        // health 无身份 → 401（身份策略统一）
        const resH401 = fakeRes();
        await router.invoke('get', '/health', {}, resH401);
        assert.strictEqual(resH401.statusCode, 401);
        assert.strictEqual(resH401.body.code, 'UNAUTHORIZED');

        // 无身份 → 401（/config）
        const res401 = fakeRes();
        await router.invoke('get', '/config', {}, res401);
        assert.strictEqual(res401.statusCode, 401);
        assert.strictEqual(res401.body.success, false);
        assert.strictEqual(res401.body.code, 'UNAUTHORIZED');
        // 错误不含堆栈/绝对路径
        assert.ok(!/\bat\s+\S+:\d+/.test(JSON.stringify(res401.body)), '401 响应不应含堆栈');
    });

    // ===== 11. 真实用户枚举 ESM 官方形状（getAllUserHandles + getUserDirectories，动态 import pathToFileURL） =====
    runTest(11, 'loadUserDirectories 动态 import 官方 ESM users.js（root=DATA_ROOT/handle）', async () => {
        // 构造官方 1.17 ESM 形状的 host：package.json type:module + src/users.js
        const hostRoot = path.join(RUN, 'host-esm');
        fs.mkdirSync(path.join(hostRoot, 'src'), { recursive: true });
        fs.writeFileSync(path.join(hostRoot, 'package.json'), JSON.stringify({ name: 'host', type: 'module' }));
        const drAbs = globalDataRoot.replace(/\\/g, '/');
        fs.writeFileSync(path.join(hostRoot, 'src', 'users.js'),
            `import path from 'node:path';\n` +
            `const DATA_ROOT = ${JSON.stringify(drAbs)};\n` +
            `export async function getAllUserHandles() { return ['alice', 'bob']; }\n` +
            `export function getUserDirectories(handle) { return { root: path.join(DATA_ROOT, handle), chats: path.join(DATA_ROOT, handle, 'chats') }; }\n`);

        const list = await startup.loadUserDirectories(hostRoot);
        assert.strictEqual(list.length, 2, '应枚举两个用户');
        const alice = list.find(u => u.handle === 'alice');
        const bob = list.find(u => u.handle === 'bob');
        assert.ok(alice && bob, '应含 alice/bob');
        assert.strictEqual(alice.root, path.resolve(globalDataRoot, 'alice'), 'alice root 应精确 DATA_ROOT/alice');
        assert.strictEqual(bob.root, path.resolve(globalDataRoot, 'bob'), 'bob root 应精确 DATA_ROOT/bob');

        // 非官方形状（缺 getAllUserHandles）→ 抛错（不静默返回 []）
        const badRoot = path.join(RUN, 'host-bad');
        fs.mkdirSync(path.join(badRoot, 'src'), { recursive: true });
        fs.writeFileSync(path.join(badRoot, 'package.json'), JSON.stringify({ name: 'host', type: 'module' }));
        fs.writeFileSync(path.join(badRoot, 'src', 'users.js'), `export const x = 1;\n`);
        await assert.rejects(() => startup.loadUserDirectories(badRoot), /getAllUserHandles/, '缺 getAllUserHandles 应抛错');
    });

    // ===== 12. _safeCoreResult 数组保持数组（不回 bytes/路径/PAT） =====
    runTest(12, '_safeCoreResult 保留数组（不塌成 {0:...}），脱敏绝对路径/bytes', async () => {
        const svc = makeService();
        const secret = 'ghp_' + 'b'.repeat(32);
        await svc.putConfig(user, { githubRepo: 'owner/repo', branch: 'main', token: secret });
        const res = {
            applied: ['chats/Actor/a.jsonl', 'chats/Actor/b.jsonl'],
            staged: [{ rel: 'chats/Actor/c.jsonl', remoteHash: 'a'.repeat(64) }],
            remoteHead: '0'.repeat(40),
            absolutePath: 'C:\\Users\\x\\secret.json',
            buf: Buffer.from('secret'),
            pat: secret,
            nested: { list: [1, 2, 3] },
        };
        const out = svc._safeCoreResult(handle, res);
        assert.ok(Array.isArray(out.applied), 'applied 应是数组');
        assert.strictEqual(out.applied.length, 2);
        assert.strictEqual(out.applied[0], 'chats/Actor/a.jsonl');
        assert.ok(Array.isArray(out.staged), 'staged 应是数组');
        assert.ok(Array.isArray(out.staged[0]) === false && typeof out.staged[0] === 'object', 'staged 元素应是对象');
        assert.strictEqual(out.staged[0].rel, 'chats/Actor/c.jsonl');
        assert.ok(Array.isArray(out.nested.list), '嵌套 list 应是数组');
        assert.strictEqual(out.nested.list.length, 3);
        // bytes / 绝对路径 / PAT 不输出
        assert.ok(!('buf' in out), 'bytes 不应输出');
        assert.ok(!JSON.stringify(out).includes('C:\\Users'), '绝对路径应脱敏');
        assert.ok(!JSON.stringify(out).includes(secret), 'PAT 不应输出');
    });

    // ===== 13. 错误 intent 不 recover：有 active + intent 身份不符 → 阻断，不写聊天/不 recover =====
    runTest(13, '错误 intent 身份不符 + 有 active → 阻断不 recover（不写聊天）', async () => {
        const c = ctxFor('e13');
        const seed = Buffer.from(JSON.stringify({ mes: 'seed' }) + '\n');
        fs.writeFileSync(path.join(c.dataRoot, 'chats', 'Actor', 'a.jsonl'), seed);
        const svc = c.makeService();
        await svc.putConfig(c.user, { githubRepo: repo, branch: 'main' });

        const maint = await svc._maintDir(await svc._userDir(c.handle));
        await fs.promises.mkdir(maint, { recursive: true });
        const identity = stateCore.bindTargetIdentity({ repo, branch, stDataRoot: c.dataRoot });
        const state = { schemaVersion: stateCore.SCHEMA_VERSION, targetIdentity: identity, repo, branch, stDataRoot: c.dataRoot, remoteHead: null, baseline: {} };
        await stateCore.saveState(maint, state);

        // 合法 active manifest（candidate/backup 指向不存在的文件，但 recover 前不该被碰）
        const manifest = {
            schemaVersion: stateCore.MANIFEST_SCHEMA_VERSION, runId: 'run-e13', targetIdentity: identity, stageId: 'stage-e13',
            remoteHead: '0'.repeat(40), createdAt: new Date().toISOString(),
            entries: [{ rel: 'chats/Actor/a.jsonl', expectedBaselineHash: null, expectedLocalHash: 'a'.repeat(64), expectedLocalMissing: false, candidateHash: 'b'.repeat(64), candidatePath: 'stage/stage-e13/missing.content', backupPath: 'backups/run-e13/x.backup', backupHash: 'a'.repeat(64) }],
        };
        await stateCore.writeApplyActive(maint, manifest);

        // intent 身份不符（错误 targetIdentity）
        const badIntent = { schemaVersion: 1, stageId: 'stage-e13', targetIdentity: 'deadbeefdeadbeef', digest: '0'.repeat(64), entryCount: 1, clientsWillBeClosed: true, createdAt: new Date().toISOString() };
        const outcome = await startup.applyStartupIntent(svc, { handle: c.handle, dataRoot: c.dataRoot, intent: badIntent });
        assert.strictEqual(outcome.outcome, 'blocked', '身份不符 + 有 active 应阻断');
        assert.strictEqual(outcome.reason, 'identity-mismatch');
        // active 未被 recover/清除
        const activeAfter = await stateCore.loadApplyActive(maint);
        assert.ok(activeAfter, 'active 不应被误恢复清除');
        assert.strictEqual(activeAfter.runId, 'run-e13');
        // 聊天未变
        assert.ok(fs.readFileSync(path.join(c.dataRoot, 'chats', 'Actor', 'a.jsonl')).equals(seed), '聊天不应被改写');
    });

    // ===== 14. 无 stage 幂等精确凭据（receipt）：匹配清 intent，不匹配 precheck-failed 保留 =====
    runTest(14, '无 stage 时 receipt 幂等确认（匹配清 intent / 不匹配 precheck-failed 保留）', async () => {
        const c = ctxFor('r14');
        const svc = c.makeService();
        await svc.putConfig(c.user, { githubRepo: repo, branch: 'main' });
        const identity = stateCore.bindTargetIdentity({ repo, branch, stDataRoot: c.dataRoot });
        const intent = { schemaVersion: 1, stageId: 'stage-r14', targetIdentity: identity, digest: 'd'.repeat(64), entryCount: 1, clientsWillBeClosed: true, createdAt: new Date().toISOString() };
        await svc._saveIntent(c.handle, intent);

        // 无 stage、无 receipt → precheck-failed（保留 intent，不冒认成功，可 UI 取消）
        const r1 = await startup.applyStartupIntent(svc, { handle: c.handle, dataRoot: c.dataRoot, intent });
        assert.strictEqual(r1.outcome, 'precheck-failed');
        assert.strictEqual(r1.reason, 'stage-missing-no-receipt');
        assert.ok(await svc._loadIntent(c.handle), 'precheck-failed 后 intent 应保留');

        // 匹配 receipt（新 schema：applyRunId 非空）→ idempotent（清 intent）
        await svc._saveReceipt(c.handle, { schemaVersion: 1, stageId: 'stage-r14', targetIdentity: identity, digest: 'd'.repeat(64), applyRunId: 'run-r14', remoteHead: '0'.repeat(40), appliedAt: new Date().toISOString() });
        const r2 = await startup.applyStartupIntent(svc, { handle: c.handle, dataRoot: c.dataRoot, intent });
        assert.strictEqual(r2.outcome, 'idempotent');
        assert.strictEqual(await svc._loadIntent(c.handle), null, '确认已应用后 intent 应清除');
    });

    // ===== 15. 每用户互斥：并发 push 第二个 LOCKED =====
    runTest(15, '每用户互斥：并发第二个 mutation LOCKED', async () => {
        const c = ctxFor('m15');
        const svc = c.makeService();
        await svc.putConfig(c.user, { githubRepo: repo, branch: 'main' });
        const u = await svc._getRuntime(c.handle);
        // 手动置 busy 模拟进行中的操作
        u.busy = true;
        await assert.rejects(() => svc.push(c.user, {}), (e) => e.statusCode === 409 && e.code === 'LOCKED', 'busy 时第二个 push 应 LOCKED');
        await assert.rejects(() => svc.connect(c.user, {}), (e) => e.statusCode === 409 && e.code === 'LOCKED', 'busy 时 connect 应 LOCKED');
        await assert.rejects(() => svc.putConfig(c.user, { branch: 'main' }), (e) => e.statusCode === 409 && e.code === 'LOCKED', 'busy 时 putConfig 应 LOCKED');
        u.busy = false;
    });

    // ===== 16. 重启 timer：config 持久化 autoCheckEnabled 后新 service startTimers 恢复 timer（无需再保存） =====
    runTest(16, '重启后 startTimers 恢复已开启的 auto timer（config 持久化，无需再保存）', async () => {
        const c = ctxFor('t16');
        // 先写入 config 开启 autoCheck
        const svc1 = c.makeService();
        await svc1.putConfig(c.user, { githubRepo: repo, branch: 'main', autoCheckEnabled: true, autoCheckMinutes: 30 });
        svc1.stopAll();
        // 新 service（模拟重启）读取同一 config → startTimers 恢复 timer（不再次 putConfig）
        const svc2 = c.makeService();
        const u2 = await svc2._getRuntime(c.handle);
        assert.strictEqual(u2.config.autoCheckEnabled, true, 'config 应持久化 autoCheckEnabled=true');
        assert.strictEqual(u2.timer, null, 'startTimers 前不应有 timer');
        // 真正从持久化配置启动定时器（非再次 putConfig 伪证明）
        await svc2.startTimers();
        const u3 = await svc2._getRuntime(c.handle);
        assert.ok(u3.timer, 'startTimers 后应恢复 timer');
        assert.ok(u3.timer.unref, 'timer 应可 unref');
        assert.strictEqual(u3.timerStopped, false, 'startTimers 后 timerStopped 应为 false');
        svc2.stopAll();
        assert.strictEqual(u3.timer, null, 'stopAll 后 timer 应清除');
        assert.strictEqual(u3.timerStopped, true, 'stopAll 后 timerStopped 应为 true');
    });

    // ===== 17. 真实在线往返：connect(在线 init) → push → 对端推进 → pull → schedule → startup 应用 =====
    runTest(17, '在线往返：connect(在线init)+push+pull+schedule+startup（非 offlineConfirmed 伪造）', async () => {
        const c = ctxFor('o17');
        const seed = Buffer.from(JSON.stringify({ mes: 'seed' }) + '\n');
        const bare = path.join(RUN, 'bare17.git');
        mustGit(['init', '-q', '--bare', '-b', 'main', bare]);
        const seedDir = path.join(RUN, 'seed17');
        fs.mkdirSync(path.join(seedDir, 'chats', 'Actor'), { recursive: true });
        fs.writeFileSync(path.join(seedDir, 'chats', 'Actor', 'a.jsonl'), seed);
        mustGit(['init', '-q', '-b', 'main', seedDir]);
        mustGit(['add', '-A'], seedDir);
        mustGit(['-c', 'user.name=seed', '-c', 'user.email=s@l', 'commit', '-qm', 'base'], seedDir);
        mustGit(['push', '-q', bare, 'main'], seedDir);
        const bareUrl = `file:///${bare.replace(/\\/g, '/')}`;

        // 本地 dataRoot 初始与远端一致（seed）
        fs.writeFileSync(path.join(c.dataRoot, 'chats', 'Actor', 'a.jsonl'), seed);

        const svc = c.makeService({ insteadOf: { [`https://github.com/${repo}.git`]: bareUrl } });
        await svc.putConfig(c.user, { githubRepo: repo, branch: 'main', token: syntheticToken });

        // 1) connect：本地 init repo + origin + 在线 init（建立 state）
        const conn = await svc.connect(c.user, {});
        assert.strictEqual(conn.success, true);
        assert.strictEqual(conn.connected, true);

        // 2) push（在线）：L==R → 推进 B（无需 offlineConfirmed）
        const pushRes = await svc.push(c.user, {});
        assert.strictEqual(pushRes.success, true);
        const baseState = await stateCore.loadState(await svc._maintDir(await svc._userDir(c.handle)));
        const baseHash = baseState.baseline['chats/Actor/a.jsonl'].hash;
        assert.ok(baseHash, 'push 后应建立 B');
        assert.strictEqual(baseHash, shaBuf(seed), 'B 应等于 seed 哈希');

        // 3) 另一设备推进远端
        const otherContent = Buffer.from(JSON.stringify({ mes: 'other-edit' }) + '\n');
        const otherWork = path.join(RUN, 'other17');
        mustGit(['clone', '-q', bare, otherWork]);
        mustGit(['config', '--local', 'user.name', 'other'], otherWork);
        mustGit(['config', '--local', 'user.email', 'other@l'], otherWork);
        fs.writeFileSync(path.join(otherWork, 'chats', 'Actor', 'a.jsonl'), otherContent);
        mustGit(['add', '-A'], otherWork);
        mustGit(['commit', '-qm', 'other'], otherWork);
        mustGit(['push', '-q', bare, 'main'], otherWork);

        // 4) pull（在线）：只暂存，产生 stage
        const pullRes = await svc.pull(c.user, {});
        assert.strictEqual(pullRes.success, true);
        const maint = await svc._maintDir(await svc._userDir(c.handle));
        const stage = await stateCore.loadStage(maint);
        assert.ok(stage, 'pull 后应有 stage');
        assert.strictEqual(stage.runId, (pullRes.result && pullRes.result.stage && pullRes.result.stage.runId) || stage.runId);

        // 5) schedule-apply：绑定 stageId + 写 intent
        const sched = await svc.scheduleApply(c.user, { stageId: stage.runId, clientsWillBeClosed: true });
        assert.strictEqual(sched.success, true);
        assert.strictEqual(sched.scheduled.stageId, stage.runId);

        // 6) startup 应用：应用 otherContent（本地聊天变为远端领先内容）
        const rOk = await integration.runStartupApply(svc);
        assert.strictEqual(rOk.applied, 1, 'startup 应应用');
        assert.strictEqual(rOk.blocked.length, 0);
        assert.ok(fs.readFileSync(path.join(c.dataRoot, 'chats', 'Actor', 'a.jsonl')).equals(otherContent), '应用后本地应等于远端领先内容');
        assert.strictEqual(await svc._loadIntent(c.handle), null, '成功后 intent 应清除');
    });

    // ===== 18. 定时器实际 setTimeout 单发 + 退避/成功/stop 语义（注入时钟，无睡眠） =====
    runTest(18, 'auto timer 单发调度：失败退避、成功重置、stop 后不重排（注入时钟）', async () => {
        const c = ctxFor('t18');
        // 注入 fake 时钟：记录所有 setTimeout 延迟，不真正睡眠
        const scheduled = [];
        const fakeSetTimeout = (fn, ms) => { scheduled.push(ms); return { id: scheduled.length, ms, fn }; };
        const fakeClearTimeout = (t) => { /* no-op */ };
        // 注入 workerRunner 桩：可控成功/失败，不真实 fork
        let workerMode = 'ok';
        const fakeRunner = async (task) => {
            if (workerMode === 'fail') throw Object.assign(new Error('远端不可达'), { code: 'PULL_FAILED' });
            return { success: true, staged: [] };
        };
        const svc = c.makeService({ setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, workerRunner: fakeRunner });

        // 配置：启用 autoCheck，1 分钟间隔（base=60000ms）
        await configureStubbedSync(svc, c, { autoCheckEnabled: true, autoCheckMinutes: 1 });
        const u = await svc._getRuntime(c.handle);
        assert.strictEqual(scheduled.length, 1, 'putConfig 启用后应调度一次');
        assert.strictEqual(scheduled[0], 60000, '首次调度延迟应为 base=60000ms');
        assert.ok(u.timer, '应有 timer');
        assert.strictEqual(u.backoffMs, 0, '初始 backoffMs=0');

        // 首次失败：退避=base（至少 base 间隔）
        workerMode = 'fail';
        const beforeFail = scheduled.length;
        await svc._autoPull(c.handle);
        const uAfterFail = await svc._getRuntime(c.handle);
        assert.strictEqual(uAfterFail.backoffMs, 60000, '首次失败退避=base=60000（至少 base 间隔）');
        assert.strictEqual(scheduled.length, beforeFail + 1, '失败后应调度下一次');
        assert.strictEqual(scheduled[scheduled.length - 1], 60000, '首次失败后延迟=base=60000');

        // 再次失败：退避翻倍（60000 → 120000）
        await svc._autoPull(c.handle);
        const uAfterFail2 = await svc._getRuntime(c.handle);
        assert.strictEqual(uAfterFail2.backoffMs, 120000, '连续失败退避翻倍=120000');
        assert.strictEqual(scheduled[scheduled.length - 1], 120000, '退避后延迟=120000');

        // 成功：重置退避 + 恢复正常间隔
        workerMode = 'ok';
        const beforeOk = scheduled.length;
        await svc._autoPull(c.handle);
        const uAfterOk = await svc._getRuntime(c.handle);
        assert.strictEqual(uAfterOk.backoffMs, 0, '成功后 backoffMs 应重置为 0');
        assert.strictEqual(scheduled.length, beforeOk + 1, '成功后应调度下一次');
        assert.strictEqual(scheduled[scheduled.length - 1], 60000, '成功后延迟应恢复正常间隔 base=60000');

        // stopAll 后在途 auto 不重挂：_scheduleNext 看到 timerStopped 不应再 push 延迟
        const beforeStop = scheduled.length;
        svc.stopAll();
        const uStop = await svc._getRuntime(c.handle);
        assert.strictEqual(uStop.timerStopped, true, 'stopAll 后 timerStopped=true');
        svc._scheduleNext(c.handle, 60000); // 尝试重排
        assert.strictEqual(scheduled.length, beforeStop, 'stop 后 _scheduleNext 不应再重排');

        svc.stopAll();
    });

    // ===== 19. createService 缺 dataRoot 明确拒绝（不许 cwd fallback） =====
    runTest(19, 'createService 缺 dataRoot 明确拒绝（NO_DATA_ROOT，不许 cwd fallback）', async () => {
        const { createService } = integration;
        // 显式 dataRoot=undefined + 临时清掉 globalThis.DATA_ROOT → 拒绝
        const saved = globalThis.DATA_ROOT;
        try {
            delete globalThis.DATA_ROOT;
            assert.throws(() => createService({ storageBase, hostRoot: RUN, getUsers: () => [], log: () => {} }),
                (e) => e.code === 'NO_DATA_ROOT', '缺 dataRoot 应抛 NO_DATA_ROOT');
        } finally {
            if (saved !== undefined) globalThis.DATA_ROOT = saved;
        }
        // 空字符串 dataRoot → 拒绝
        assert.throws(() => createService({ storageBase, dataRoot: '', hostRoot: RUN, getUsers: () => [], log: () => {} }),
            (e) => e.code === 'NO_DATA_ROOT', '空 dataRoot 应抛 NO_DATA_ROOT');
        // 正常注入 dataRoot → 成功
        const svc = createService({ storageBase, dataRoot: globalDataRoot, hostRoot: RUN, getUsers: () => [], log: () => {} });
        assert.strictEqual(svc.globalDataRoot, path.resolve(globalDataRoot));
    });

    // ===== 20. _stageDigest 统一 canonical 投影（绑定完整字段，entries 按 rel 排序） =====
    runTest(20, '_stageDigest 统一 canonical 投影（stageId/targetIdentity/remoteHead/完整 entries 按 rel 排序）', async () => {
        const c = ctxFor('d20');
        const svc = c.makeService();
        const identity = stateCore.bindTargetIdentity({ repo, branch, stDataRoot: c.dataRoot });
        const stage = {
            runId: 'stage-d20',
            targetIdentity: identity,
            remoteHead: '0'.repeat(40),
            entries: [
                { rel: 'chats/Actor/b.jsonl', candidatePath: 'stage/stage-d20/b.content', candidateHash: 'b'.repeat(64), expectedBaselineHash: 'c'.repeat(64), expectedLocalHash: 'd'.repeat(64), expectedLocalMissing: false, remoteCommit: '1'.repeat(40) },
                { rel: 'chats/Actor/a.jsonl', candidatePath: 'stage/stage-d20/a.content', candidateHash: 'a'.repeat(64), expectedBaselineHash: 'e'.repeat(64), expectedLocalHash: 'f'.repeat(64), expectedLocalMissing: true, remoteCommit: '2'.repeat(40) },
            ],
        };
        // 1) 摘要包含完整绑定（rel 不同顺序不影响结果——entries 按 rel 排序）
        const d1 = await svc._stageDigest(stage);
        const reversed = { ...stage, entries: [stage.entries[1], stage.entries[0]] };
        const d2 = await svc._stageDigest(reversed);
        assert.strictEqual(d1, d2, 'entries 顺序无关（按 rel 排序）');
        assert.strictEqual(d1.length, 64, 'digest 应为 sha256 hex64');

        // 2) 任一绑定字段变化 → digest 变化（不能只 rel/hash）
        const changedCandidatePath = { ...stage, entries: [{ ...stage.entries[0], candidatePath: 'stage/stage-d20/b-other.content' }, stage.entries[1]] };
        assert.notStrictEqual(await svc._stageDigest(changedCandidatePath), d1, 'candidatePath 变化应改变 digest');
        const changedTargetIdentity = { ...stage, targetIdentity: 'deadbeefdeadbeef' };
        assert.notStrictEqual(await svc._stageDigest(changedTargetIdentity), d1, 'targetIdentity 变化应改变 digest');
        const changedRemoteHead = { ...stage, remoteHead: 'f'.repeat(40) };
        assert.notStrictEqual(await svc._stageDigest(changedRemoteHead), d1, 'remoteHead 变化应改变 digest');
        const changedBaseline = { ...stage, entries: [{ ...stage.entries[0], expectedBaselineHash: '9'.repeat(64) }, stage.entries[1]] };
        assert.notStrictEqual(await svc._stageDigest(changedBaseline), d1, 'expectedBaselineHash 变化应改变 digest');

        // 3) 真实 active manifest 形状：同时含 runId（apply 事务 id，不同于 stageId）与 stageId（pull 暂存 id）。
        //    摘要必须优先 stageId（而非 runId），故 active 与 stage 摘要应一致（同 stageId 同绑定）；
        //    不得删除 active.runId 伪验证（否则无法证明优先 stageId 而非 runId）。
        const active = { runId: 'run-d20-apply-tx', stageId: 'stage-d20', targetIdentity: identity, remoteHead: '0'.repeat(40), entries: stage.entries.map(e => ({ rel: e.rel, candidatePath: e.candidatePath, candidateHash: e.candidateHash, expectedBaselineHash: e.expectedBaselineHash, expectedLocalHash: e.expectedLocalHash, expectedLocalMissing: e.expectedLocalMissing })) };
        assert.notStrictEqual(active.runId, active.stageId, '真实 active 的 runId 与 stageId 应不同（apply 事务 id vs pull 暂存 id）');
        const da = await svc._stageDigest(active);
        assert.strictEqual(da, d1, 'active(stageId 优先于 runId) 与 stage(runId) 摘要应一致（同 stageId 同绑定）');

        // 3b) 反证：若错误地优先 runId，则把 stageId 改为别的值不应改变 digest；此处证明 stageId 参与绑定（优先级正确）。
        const activeWrongStage = { ...active, stageId: 'stage-d20-OTHER' };
        assert.notStrictEqual(await svc._stageDigest(activeWrongStage), d1, 'stageId 变化必须改变 digest（证明优先 stageId，非 runId）');

        // 4) 缺 entries → 拒绝
        await assert.rejects(() => svc._stageDigest({ runId: 'x', targetIdentity: identity, remoteHead: '0'.repeat(40) }),
            (e) => e.code === 'BAD_REQUEST', '缺 entries 应拒绝');
    });

    // ===== 21. startup 预检失败 → status.lastError 可见（recordPrecheckFailed 记录到 runtime） =====
    runTest(21, 'startup 预检失败记录到 runtime lastError（status 可见，不只 console）', async () => {
        const c = ctxFor('p21');
        const svc = c.makeService();
        // 不配置 githubRepo：status 不触发 core status（避免覆盖 lastError），只读 runtime 记录
        const rt = await svc._getRuntime(c.handle);
        assert.strictEqual(rt.config.githubRepo, '', '未配置 githubRepo');
        // 记录预检失败
        await svc.recordPrecheckFailed(c.handle, '摘要与 intent 不符');
        const st = await svc.status(c.user);
        assert.strictEqual(st.success, true);
        assert.strictEqual(st.status.configured, false, '未配置时不触发 core status');
        assert.strictEqual(st.status.lastOperation, 'startup-precheck', 'lastOperation 应为 startup-precheck');
        assert.ok(st.status.lastError && st.status.lastError.includes('启动期应用预检失败'), `lastError 应含预检失败，实际=${st.status.lastError}`);
        assert.ok(st.status.lastError.includes('摘要与 intent 不符'), 'lastError 应含具体原因');
    });

    // ===== 22. 自动 pull 冲突摘要：workerRunner 返回 conflicts array → u.lastConflicts 更新（与手动 pull 同一逻辑） =====
    runTest(22, '自动 pull 真实冲突更新 u.lastConflicts（status 可见，不隐藏）', async () => {
        const c = ctxFor('a22');
        const scheduled = [];
        const fakeSetTimeout = (fn, ms) => { scheduled.push(ms); return { id: scheduled.length, ms, fn }; };
        const fakeClearTimeout = (t) => { /* no-op */ };
        const conflicts = [
            { rel: 'chats/Actor/a.jsonl', localHash: 'a'.repeat(64), remoteHash: 'b'.repeat(64), resolved: false },
        ];
        const fakeRunner = async (task) => ({ success: true, staged: [], conflicts });
        const svc = c.makeService({ setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, workerRunner: fakeRunner, getUsers: () => [{ handle: c.handle, root: c.dataRoot }] });
        await configureStubbedSync(svc, c, { autoCheckEnabled: true, autoCheckMinutes: 1 });
        const u0 = await svc._getRuntime(c.handle);
        assert.deepStrictEqual(u0.lastConflicts, [], '初始 lastConflicts 应为空');

        // 触发一次自动 pull（注入 runner 返回 conflicts）
        await svc._autoPull(c.handle);
        const u1 = await svc._getRuntime(c.handle);
        assert.strictEqual(u1.backoffMs, 0, '成功应重置退避');
        assert.deepStrictEqual(u1.lastConflicts, conflicts, '自动 pull 应把 result.conflicts 写入 lastConflicts（与手动 pull 同一摘要逻辑）');

        // status 可见冲突（配置已启用 autoCheck，但通过注入 runner 无真实 git，status 走 cached 路径不覆盖）
        const st = await svc.status(c.user);
        assert.ok(Array.isArray(st.status.conflicts), 'status.conflicts 应是数组');
        assert.strictEqual(st.status.conflicts.length, 1, 'status 应返回 1 条冲突');
        assert.strictEqual(st.status.conflicts[0].rel, 'chats/Actor/a.jsonl', '冲突 rel 应可见');

        svc.stopAll();
    });

    // ===== 23. status 与 mutation 共享互斥：status 在途时 push/pull 不启动第二 worker（LOCKED） =====
    runTest(23, 'status 在途时 push/pull 共享互斥 LOCKED（不启动第二 worker）', async () => {
        const c = ctxFor('m23');
        // 可控 deferred workerRunner：记录每次 command，status 挂起直到手动 resolve
        const calls = [];
        const pending = new Map();
        const deferredRunner = async (task) => {
            calls.push({ op: task.op, command: task.command });
            if (task.command === 'status') {
                return new Promise((resolve, reject) => { pending.set('status', { resolve, reject }); });
            }
            return { success: true, staged: [], initialized: true, stage: null, remoteHead: '0'.repeat(40) };
        };
        const svc = c.makeService({ workerRunner: deferredRunner });
        await configureStubbedSync(svc, c);
        calls.length = 0; // 互斥断言只统计完成连接后的操作。

        // 启动 status（不 await）：占用 busy 后进入 core status worker 挂起
        const sp = svc.status(c.user);
        await waitUntil(() => pending.has('status'), 'status worker 应挂起');
        assert.strictEqual(calls.length, 1, '应只有 1 次 status 调用');
        assert.strictEqual(calls[0].command, 'status');

        // status 在途：push / pull 均 LOCKED，且绝不启动第二 worker
        await assert.rejects(() => svc.push(c.user, {}), (e) => e.statusCode === 409 && e.code === 'LOCKED', 'status 在途时 push 应 LOCKED');
        await assert.rejects(() => svc.pull(c.user, {}), (e) => e.statusCode === 409 && e.code === 'LOCKED', 'status 在途时 pull 应 LOCKED');
        assert.strictEqual(calls.length, 1, 'push/pull 被 LOCKED 不应启动任何第二 worker');

        // 释放 status 后应正常结束且释放互斥
        pending.get('status').resolve({ success: true, initialized: true, stage: null });
        const st = await sp;
        assert.strictEqual(st.success, true);
        assert.strictEqual(st.status.busy, false, 'status 完成后 busy 应释放');

        // 之后 push 能正常（不再 LOCKED）
        const pr = await svc.push(c.user, {});
        assert.strictEqual(pr.success, true);
    });

    // ===== 24. mutation 在途时 status 返回 cached + busy（不并发核心锁） =====
    runTest(24, 'mutation 在途时 status 返回 cached+busy（不抢核心锁）', async () => {
        const c = ctxFor('m24');
        const calls = [];
        const pending = new Map();
        const deferredRunner = async (task) => {
            calls.push({ op: task.op, command: task.command });
            if (task.command === 'push') {
                return new Promise((resolve, reject) => { pending.set('push', { resolve, reject }); });
            }
            return { success: true, staged: [], initialized: true, stage: null, remoteHead: '0'.repeat(40) };
        };
        const svc = c.makeService({ workerRunner: deferredRunner });
        await configureStubbedSync(svc, c);
        calls.length = 0;

        // 启动 push（不 await）：占用 busy 后进入 core push worker 挂起
        const pp = svc.push(c.user, {});
        await waitUntil(() => pending.has('push'), 'push worker 应挂起');
        assert.strictEqual(calls.length, 1, '应只有 1 次 push 调用');

        // push 在途：status 应返回 cached + busy，且不发起 core status（不新增 worker 调用）
        const st = await svc.status(c.user);
        assert.strictEqual(st.success, true);
        assert.strictEqual(st.status.busy, true, 'mutation 在途时 status 应报 busy');
        assert.strictEqual(st.status.connected, false, 'cached 状态不应宣称实时连通');
        assert.strictEqual(st.status.core, null, '忙时不应并发核心 status');
        assert.strictEqual(calls.length, 1, 'status 忙时不启动第二 worker');

        // 释放 push
        pending.get('push').resolve({ success: true, published: [] });
        const pr = await pp;
        assert.strictEqual(pr.success, true);

        // push 结束后 status 可正常占用互斥并发起 core status
        const st2 = await svc.status(c.user);
        assert.strictEqual(st2.status.busy, false, 'push 结束后 status 应不再 busy');
        assert.strictEqual(calls.length, 2, 'push 结束后 status 应发起一次 core status');
        assert.strictEqual(calls[1].command, 'status');
    });

    // ===== 25. status 失败正确释放互斥 + 重复 status 不并发 core（只读不污染 lastOperation/lastError） =====
    runTest(25, 'status 失败释放互斥；重复 status 不并发 core；只读不污染 mutation 记录', async () => {
        const c = ctxFor('m25');
        const calls = [];
        const pending = new Map();
        let statusCount = 0;
        // 仅第一次 status 挂起（deferred），后续 status 直接返回，模拟「释放后再次 status 正常」。
        const deferredRunner = async (task) => {
            calls.push({ op: task.op, command: task.command });
            if (task.command === 'status') {
                statusCount++;
                if (statusCount === 1) {
                    return new Promise((resolve, reject) => { pending.set('status1', { resolve, reject }); });
                }
            }
            return { success: true, staged: [], initialized: true, stage: null, remoteHead: '0'.repeat(40) };
        };
        const svc = c.makeService({ workerRunner: deferredRunner });
        await svc.putConfig(c.user, { githubRepo: repo, branch: 'main' });

        // 并发两个 status：第一个占用互斥挂起，第二个应 cached 且不发起第二 worker
        const s1 = svc.status(c.user);
        await waitUntil(() => pending.has('status1'), '第一个 status 应挂起');
        const s2 = await svc.status(c.user);
        assert.strictEqual(s2.status.busy, true, '第二个 status 在第一个在途时应报 busy');
        assert.strictEqual(s2.status.core, null, '重复 status 不并发 core');
        assert.strictEqual(calls.length, 1, '第二个 status 不应启动第二 worker');

        // 第一个 status 的 worker 抛错 → status 返回 core=null/connected=false，且必须释放互斥
        pending.get('status1').reject(new Error('status boom'));
        const r1 = await s1;
        assert.strictEqual(r1.success, true);
        assert.strictEqual(r1.status.connected, false);
        assert.strictEqual(r1.status.core, null);
        assert.strictEqual(r1.status.busy, false, 'status 失败后 busy 应释放');
        // 只读 status 失败不污染 mutation 的 lastOperation/lastError
        const u = await svc._getRuntime(c.handle);
        assert.strictEqual(u.lastOperation, 'put-config', 'status 失败不应改 lastOperation（仍为最近一次 mutation put-config）');
        assert.strictEqual(u.lastError, null, 'status 失败不应写 lastError');

        // 释放后再次 status 能正常占用并发起 core status
        const st3 = await svc.status(c.user);
        assert.strictEqual(st3.status.busy, false, '释放后 status 应正常');
        assert.strictEqual(calls.length, 2, '释放后 status 应发起新的 core status');
        assert.strictEqual(calls[1].command, 'status');
    });

    // ===== 26. 冷初始化并发 getConfig+status+push：去重只初始化一次、lease 全释放、无永久 busy =====
    runTest(26, '冷初始化并发 getConfig+status+push：只初始化一次、lease 全释放、无永久 busy', async () => {
        const c = ctxFor('cold26');
        // 用独立 service 完成首次配置/验证，再用全新实例验证真正的冷入口竞争。
        const setupSvc = c.makeService({ workerRunner: async () => ({ success: true }) });
        await configureStubbedSync(setupSvc, c);
        let loadCalls = 0;
        const pendingLoad = new Map();
        const readyCfg = { githubRepo: repo, branch: 'main', autoCheckEnabled: false, autoCheckMinutes: 30 };
        // loadRuntime 第一次挂起制造冷初始化并发窗口（同一 handle 三请求同时进入 _getRuntime）。
        const loadRuntime = async () => {
            loadCalls++;
            if (loadCalls === 1) {
                return new Promise((resolve) => { pendingLoad.set('load', resolve); });
            }
            return { config: { ...readyCfg }, token: syntheticToken };
        };
        const workerCalls = [];
        const fakeRunner = async (task) => {
            workerCalls.push(task.command);
            return { success: true, staged: [], initialized: true, stage: null, remoteHead: '0'.repeat(40) };
        };
        const svc = c.makeService({ loadRuntime, workerRunner: fakeRunner });

        // 三个冷入口并发（不先 putConfig 预热）
        const pGet = svc.getConfig(c.user);
        const pStatus = svc.status(c.user);
        const pPush = svc.push(c.user, {});

        // 三个请求都进入同一初始化 Promise（去重），loadRuntime 只挂起一次
        await waitUntil(() => pendingLoad.has('load'), 'loadRuntime 应挂起（三请求进入同一初始化）');
        assert.strictEqual(loadCalls, 1, '并发冷入口 loadRuntime 只调用一次（per-handle 去重）');

        // 释放初始化：三请求复用同一 runtime，不产生 uA/uB 覆盖 busy
        pendingLoad.get('load')({ config: { ...readyCfg }, token: syntheticToken });
        const [g, s, pr] = await Promise.all([pGet, pStatus, pPush]);
        assert.strictEqual(loadCalls, 1, '释放后 loadRuntime 仍只调用一次（成功只落一个 runtime）');
        assert.strictEqual(g.config.githubRepo, repo, 'getConfig 应读到已配置 githubRepo');
        assert.strictEqual(s.status.configured, true, 'status 应视为已配置');
        assert.strictEqual(pr.success, true, 'push 应成功（config 已就绪）');

        // 只初始化一个 runtime，且所有操作结束后 busy 已释放（无永久 busy）
        const u = await svc._getRuntime(c.handle);
        assert.strictEqual(u.config.githubRepo, repo, 'runtime 唯一且 config 正确');
        assert.strictEqual(u.busy, false, '所有操作结束后 busy 应释放（lease 释放同一对象，无永久 busy）');
    });

    // ===== 27. 冷初始化失败可重试：loadRuntime 抛错清理 initializing，下次成功 =====
    runTest(27, '冷初始化失败可重试：loadRuntime 首次抛错清理 initializing，下次成功', async () => {
        const c = ctxFor('cold27');
        let calls = 0;
        const loadRuntime = async () => {
            calls++;
            if (calls === 1) throw new Error('冷初始化失败（合成）');
            return { config: { githubRepo: repo, branch: 'main', autoCheckEnabled: false, autoCheckMinutes: 30 }, token: '' };
        };
        const svc = c.makeService({ loadRuntime, workerRunner: async () => ({ success: true, staged: [], initialized: true, stage: null }) });

        await assert.rejects(() => svc.getConfig(c.user), /冷初始化失败/);
        assert.strictEqual(calls, 1, '首次初始化失败');

        // 失败后 initializing 应清理，允许重试成功
        const g = await svc.getConfig(c.user);
        assert.strictEqual(calls, 2, '失败后应允许重试（initializing 已清理）');
        assert.strictEqual(g.config.githubRepo, repo);

        // 成功后 runtime 缓存，不再重复初始化
        await svc.getConfig(c.user);
        assert.strictEqual(calls, 2, '成功后 runtime 已缓存，不再触发 loadRuntime');
    });

    // ===== 28. status 读取异常不吞成 core:null：probeError 承载原因（脱敏），不污染 lastError =====
    runTest(28, 'status 读取异常记录 probeError（脱敏），不吞原因、不污染 lastError', async () => {
        const c = ctxFor('cold28');
        const secret = 'ghp_' + 'c'.repeat(32);
        const loadRuntime = async () => ({ config: { githubRepo: repo, branch: 'main', autoCheckEnabled: false, autoCheckMinutes: 30 }, token: secret });
        const fakeRunner = async (task) => {
            if (task.command === 'status') throw new Error(`status 读取失败: ${secret}`);
            return { success: true, staged: [], initialized: true, stage: null };
        };
        const svc = c.makeService({ loadRuntime, workerRunner: fakeRunner });

        const st = await svc.status(c.user);
        assert.strictEqual(st.success, true);
        assert.strictEqual(st.status.connected, false);
        assert.strictEqual(st.status.core, null);
        // 异常原因通过 probeError 单独字段承载（不静默吞），且已脱敏不含 secret
        assert.ok(st.status.probeError, 'probeError 应承载 status 读取异常原因');
        assert.ok(st.status.probeError.includes('status 读取失败'), 'probeError 应含具体原因');
        assert.ok(!st.status.probeError.includes(secret), 'probeError 应脱敏，不含 secret');
        // 不污染 mutation 的 lastOperation/lastError
        const u = await svc._getRuntime(c.handle);
        assert.strictEqual(u.lastError, null, 'status 异常不写 lastError');
        assert.strictEqual(u.lastOperation, null, 'status 异常不写 lastOperation');
    });

    // ===== 29. 自动检查一致性：有 pending intent 时不调 core pull，保留原 stage/intent（不覆盖用户安排） =====
    runTest(29, '自动检查有 pending intent 时不调 pull、保留原 stage/intent、只重排 timer', async () => {
        const c = ctxFor('auto29');
        const calls = [];
        const fakeRunner = async (task) => {
            calls.push(task.command);
            return { success: true, staged: [], stage: null };
        };

        // 可控时钟：记录 active timers（未触发），手动触发当前 setTimeout 回调验证「真实重排产生新 timer」。
        const activeTimers = new Map(); // id -> { id, ms, fn }
        let nextId = 0;
        const fakeSetTimeout = (fn, ms) => {
            const t = { id: ++nextId, ms, fn };
            activeTimers.set(t.id, t);
            return t;
        };
        const fakeClearTimeout = (t) => { if (t && activeTimers.has(t.id)) activeTimers.delete(t.id); };

        const svc = c.makeService({ setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, workerRunner: fakeRunner });
        await svc.putConfig(c.user, { githubRepo: repo, branch: 'main', autoCheckEnabled: true, autoCheckMinutes: 1 });
        // putConfig 会 _syncTimer 安排第一个 timer；后续验证必须基于「当前实际 active timer」而非这个旧的。
        assert.strictEqual(activeTimers.size, 1, 'putConfig 后应有 1 个 active timer');

        // 安排一个待应用 intent（stage 已安排，用户尚未取消/应用）
        const stage = { runId: 'stage-run-auto29', entries: [{ rel: 'chats/Actor/a.jsonl', candidateHash: 'a'.repeat(64), expectedBaselineHash: 'b'.repeat(64) }] };
        const intent = {
            schemaVersion: 1,
            stageId: stage.runId,
            targetIdentity: 'ab'.repeat(8),
            digest: 'c'.repeat(64),
            entryCount: stage.entries.length,
            clientsWillBeClosed: true,
            createdAt: new Date().toISOString(),
        };
        await svc._saveIntent(c.handle, intent);
        // 写入真实 stage 文件（hash 前后相等证明未被覆盖/篡改）
        const uDir = await svc._userDir(c.handle);
        const maintDir = await svc._maintDir(uDir);
        const stageDir = path.join(maintDir, 'stage');
        fs.mkdirSync(stageDir, { recursive: true });
        const stagePath = path.join(stageDir, 'stage.json');
        const stageJson = JSON.stringify(stage);
        fs.writeFileSync(stagePath, stageJson, 'utf8');
        const stageHashBefore = crypto.createHash('sha256').update(fs.readFileSync(stagePath)).digest('hex');
        const intentBefore = await svc._loadIntent(c.handle);
        assert.ok(intentBefore, '安排后 intent 应存在');
        assert.strictEqual(intentBefore.stageId, 'stage-run-auto29');

        // 触发自动检查 tick（当前 active timer 是 putConfig 留下的那个）
        const beforeCalls = calls.length;
        await svc._autoPull(c.handle);

        // 不调用 core pull（无新增 worker 调用）
        assert.strictEqual(calls.length, beforeCalls, '有 pending intent 时自动检查不应调用 core pull');
        // intent 字节不变（stage/intent 未被覆盖）
        const intentAfter = await svc._loadIntent(c.handle);
        assert.ok(intentAfter, 'intent 应保留');
        assert.strictEqual(intentAfter.stageId, 'stage-run-auto29', 'stageId 不变（未被新 stage.runId 覆盖）');
        assert.strictEqual(intentAfter.digest, 'c'.repeat(64), 'digest 不变');
        // 真实 stage 文件 hash 前后相等（未被覆盖）
        const stageHashAfter = crypto.createHash('sha256').update(fs.readFileSync(stagePath)).digest('hex');
        assert.strictEqual(stageHashAfter, stageHashBefore, 'stage 文件字节不变（hash 前后相等）');
        // 不污染 lastOperation/lastError（不被 auto-pull 覆盖）
        const u = await svc._getRuntime(c.handle);
        assert.strictEqual(u.lastError, null, '不更新 lastError');
        assert.strictEqual(u.lastOperation, 'put-config', '不更新 lastOperation（保持 put-config，不被 auto-pull 覆盖）');

        // 真实调度验证：_autoPull 后必须产生一个新 timer（重排），active 恰 1 个。
        // 关键：不能拿 putConfig 的旧 timer 冒充重排 —— 必须证明 _autoPull 自身重排了。
        assert.strictEqual(activeTimers.size, 1, '_autoPull 后 active timer 恰 1 个（旧 timer 被清、新 timer 挂上）');
        const timer1 = [...activeTimers.values()][0];
        assert.strictEqual(timer1.ms, 60000, '有 intent 时重排为基础间隔 60000ms');
        // 模拟触发该 timer（从 active timers 移除 → 触发其回调）。回调内 _autoPull 是异步的，
        // 用 waitUntil 等待它重排产生新 timer（不靠旧 timer 冒充）。
        activeTimers.delete(timer1.id);
        timer1.fn();
        await waitUntil(() => activeTimers.size === 1, '触发后应产生新 timer（重排不停摆）');
        const timer2 = [...activeTimers.values()][0];
        assert.notStrictEqual(timer2.id, timer1.id, '必须是新 timer id（非旧 timer 冒充）');
        assert.strictEqual(timer2.ms, 60000, '再次重排仍为 60000ms');
        // 连续再触发一次，仍重排
        activeTimers.delete(timer2.id);
        timer2.fn();
        await waitUntil(() => activeTimers.size === 1, '连续触发仍重排');
        const timer3 = [...activeTimers.values()][0];
        assert.notStrictEqual(timer3.id, timer2.id, '第三次必须是新 timer id');
        assert.strictEqual(timer3.ms, 60000, '第三次重排仍 60000ms');
        // 触发期间仍不调 core pull（intent 仍在）
        assert.strictEqual(calls.length, beforeCalls, '连续触发期间有 intent 始终不调 core pull');

        svc.stopAll();
    });

    // ===== 30. 取消安排后下一 tick 恢复 pull（旧绑定不静默重指向） =====
    runTest(30, '取消安排后自动检查恢复 pull（下一 tick 正常拉取）', async () => {
        const c = ctxFor('auto30');
        const scheduled = [];
        const fakeSetTimeout = (fn, ms) => { scheduled.push(ms); return { id: scheduled.length, ms, fn }; };
        const fakeClearTimeout = (t) => { /* no-op */ };
        const calls = [];
        const fakeRunner = async (task) => {
            calls.push(task.command);
            return { success: true, staged: [], stage: null };
        };
        const svc = c.makeService({ setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, workerRunner: fakeRunner });
        await configureStubbedSync(svc, c, { autoCheckEnabled: true, autoCheckMinutes: 1 });

        // 先安排 intent
        const intent = {
            schemaVersion: 1, stageId: 'stage-run-auto30', targetIdentity: 'ab'.repeat(8),
            digest: 'd'.repeat(64), entryCount: 1, clientsWillBeClosed: true, createdAt: new Date().toISOString(),
        };
        await svc._saveIntent(c.handle, intent);
        const before1 = calls.length;
        await svc._autoPull(c.handle);
        assert.strictEqual(calls.length, before1, '有 intent 时不调 pull');

        // 取消安排（用户取消，或已应用）
        await svc._clearIntent(c.handle);
        assert.strictEqual(await svc._loadIntent(c.handle), null, '取消后 intent 应清除');

        // 下一 tick 恢复 pull
        const before2 = calls.length;
        await svc._autoPull(c.handle);
        assert.strictEqual(calls.length, before2 + 1, '取消安排后应恢复 pull');
        assert.strictEqual(calls[calls.length - 1], 'pull', '应调用 core pull');

        // 成功后 lastError 清空、backoff 重置
        const u = await svc._getRuntime(c.handle);
        assert.strictEqual(u.lastError, null, '成功后 lastError=null');
        assert.strictEqual(u.backoffMs, 0, '成功后 backoff 重置');

        svc.stopAll();
    });

    // ===== 31. 读 intent 失败如实记录错误并退避，且释放 lease =====
    runTest(31, '自动检查读 intent 失败：如实退避、释放 lease、不吞为无 intent', async () => {
        const c = ctxFor('auto31');
        const calls = [];
        const fakeRunner = async (task) => {
            calls.push(task.command);
            return { success: true, staged: [], stage: null };
        };

        // 可控时钟：记录 active timers，手动触发当前 setTimeout 回调验证真实调度（退避 60000→120000）。
        const activeTimers = new Map(); // id -> { id, ms, fn }
        let nextId = 0;
        const fakeSetTimeout = (fn, ms) => {
            const t = { id: ++nextId, ms, fn };
            activeTimers.set(t.id, t);
            return t;
        };
        const fakeClearTimeout = (t) => { if (t && activeTimers.has(t.id)) activeTimers.delete(t.id); };

        const svc = c.makeService({ setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, workerRunner: fakeRunner });
        // 初始配置必须先于任何绑定 intent；损坏 intent 不得成为绕过目标保护的理由。
        await configureStubbedSync(svc, c, { autoCheckEnabled: true, autoCheckMinutes: 1 });
        // 用损坏的 intent 文件制造 CORRUPT_STORAGE：直接写非法 JSON 到 intent 路径
        const uDir = await svc._userDir(c.handle);
        const intentPath = path.join(uDir, 'intent.json');
        fs.mkdirSync(uDir, { recursive: true });
        fs.writeFileSync(intentPath, '{bad json', 'utf8');
        assert.strictEqual(activeTimers.size, 1, 'putConfig 后应有 1 个 active timer');

        const beforeCalls = calls.length;
        await svc._autoPull(c.handle);

        // 读 intent 失败：不调 core pull
        assert.strictEqual(calls.length, beforeCalls, '读 intent 失败不应调 core pull（不吞成无 intent 后继续 pull）');
        // 如实记录错误并退避
        const u = await svc._getRuntime(c.handle);
        assert.ok(u.lastError, '应记录读 intent 错误');
        assert.ok(u.lastError.includes('CORRUPT_STORAGE') || u.lastError.includes('非法 JSON'), '错误应含具体原因');
        assert.strictEqual(u.backoffMs, 60000, '首次失败退避=base=60000');
        // lease 已释放（busy=false）
        assert.strictEqual(u.busy, false, 'lease 应已释放');

        // 真实调度验证：_autoPull 后产生新 timer（重排），不是拿 putConfig 的旧 timer 冒充。
        assert.strictEqual(activeTimers.size, 1, '_autoPull 后 active timer 恰 1 个（重排）');
        const timer1 = [...activeTimers.values()][0];
        assert.strictEqual(timer1.ms, 60000, '首次失败重排 60000ms');

        // 模拟触发该 timer → 第二次读 intent 仍失败 → 退避翻倍 120000
        activeTimers.delete(timer1.id);
        timer1.fn();
        await waitUntil(() => {
            const us = [...activeTimers.values()];
            return us.length === 1 && us[0].id !== timer1.id;
        }, '第二次失败后应重排产生新 timer');
        assert.strictEqual(u.backoffMs, 120000, '第二次失败退避翻倍=120000');
        assert.strictEqual(u.busy, false, '第二次失败后 lease 仍释放');
        const timer2 = [...activeTimers.values()][0];
        assert.strictEqual(timer2.ms, 120000, '第二次失败重排 120000ms');
        assert.strictEqual(calls.length, beforeCalls, '两次失败期间均不调 core pull');

        // 修复 intent（清理损坏文件）后下一 tick 恢复 pull
        fs.unlinkSync(intentPath);
        activeTimers.delete(timer2.id);
        timer2.fn();
        await waitUntil(() => calls.length === beforeCalls + 1, '修复后应恢复 pull');
        assert.strictEqual(calls[calls.length - 1], 'pull', '应调用 core pull');
        await waitUntil(() => !u.busy, '等待本次 pull 完成历史记录和退避重置');
        // 成功后 backoff 重置
        assert.strictEqual(u.backoffMs, 0, '成功后 backoff 重置');
        await waitUntil(() => {
            const us = [...activeTimers.values()];
            return us.length === 1 && us[0].id !== timer2.id;
        }, '成功后应重排恢复基础间隔');
        const timer3 = [...activeTimers.values()][0];
        assert.strictEqual(timer3.ms, 60000, '成功后恢复基础间隔 60000ms');

        svc.stopAll();
    });

    runTest(32, '更换凭据严格失效：拒绝非字符串，记录写失败保留原 token 和验证', async () => {
        const c = ctxFor('credentials32');
        const svc = c.makeService({ workerRunner: async () => ({ success: true }) });
        await configureStubbedSync(svc, c);
        const tokenPath = path.join(c.userDirAbs, 'secrets', 'token');
        const historyPath = path.join(c.userDirAbs, 'activity.json');
        const beforeToken = fs.readFileSync(tokenPath);
        const beforeHistory = fs.readFileSync(historyPath);
        await assert.rejects(() => svc.putConfig(c.user, { token: ['synthetic-replacement'] }),
            (e) => e.statusCode === 400, '数组 token 应在触碰磁盘前拒绝');
        assert.ok(fs.readFileSync(tokenPath).equals(beforeToken));
        assert.ok(fs.readFileSync(historyPath).equals(beforeHistory));

        const originalSave = storageMod.saveJson;
        storageMod.saveJson = async (file, value) => {
            if (path.resolve(file) === path.resolve(historyPath)) {
                throw Object.assign(new Error('synthetic history write failure'), { code: 'EIO' });
            }
            return originalSave(file, value);
        };
        try {
            await assert.rejects(() => svc.putConfig(c.user, { token: 'synthetic-replacement' }), /history write failure/);
        } finally { storageMod.saveJson = originalSave; }
        assert.ok(fs.readFileSync(tokenPath).equals(beforeToken), '失效记录不能持久化时不得换 token');
        assert.ok(fs.readFileSync(historyPath).equals(beforeHistory), '原验证记录应完整保留');
    });

    runTest(33, '每次可能发布前重新验证私有仓库，公开或探测失败均不进入核心', async () => {
        const c = ctxFor('private33');
        const calls = [];
        let visibility = 'private';
        let inspections = 0;
        const svc = c.makeService({
            workerRunner: async task => { calls.push(task); return { success: true, published: [], staged: [], conflicts: [] }; },
            repositoryInspector: async args => {
                inspections++;
                await repositoryInspector(args);
                if (visibility === 'unreachable') throw Object.assign(new Error('synthetic metadata unreachable'), { code: 'GITHUB_UNAVAILABLE' });
                return { private: visibility === 'private', fullName: repo };
            },
            setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
        });
        await configureStubbedSync(svc, c, { autoCheckEnabled: true, autoCheckMinutes: 1 });
        calls.length = 0;
        const afterConnect = inspections;
        visibility = 'public';
        await assert.rejects(() => svc.push(c.user, {}), e => e.code === 'PRIVATE_REPOSITORY_REQUIRED');
        await assert.rejects(() => svc.pull(c.user, {}), e => e.code === 'PRIVATE_REPOSITORY_REQUIRED');
        await svc._autoPull(c.handle);
        assert.strictEqual(calls.length, 0, '手动/自动操作都不得把公开仓库交给核心');
        assert.strictEqual(inspections, afterConnect + 3, 'push/pull/auto 各自重新验证');
        visibility = 'unreachable';
        await assert.rejects(() => svc.push(c.user, {}), e => e.code === 'GITHUB_UNAVAILABLE');
        assert.strictEqual(calls.length, 0, '无法核验私有性时关闭发布门禁');
        svc.stopAll();
    });

    runTest(34, '已确认推送后 activity 读写故障不冒报网络失败，状态报告记录错误', async () => {
        const c = ctxFor('history34');
        let corePushes = 0;
        let pushed = false;
        const svc = c.makeService({ workerRunner: async task => {
            if (task.command === 'push') { corePushes++; pushed = true; return { published: ['chats/Actor/a.jsonl'], conflicts: [] }; }
            return { success: true };
        } });
        await configureStubbedSync(svc, c);
        const historyPath = path.join(c.userDirAbs, 'activity.json');
        const originalLoad = storageMod.loadJson;
        storageMod.loadJson = async file => {
            if (pushed && path.resolve(file) === path.resolve(historyPath)) {
                throw Object.assign(new Error('synthetic post-push history read failure'), { code: 'EIO' });
            }
            return originalLoad(file);
        };
        try {
            const result = await svc.push(c.user, {});
            assert.strictEqual(result.success, true, '核心已确认成功必须保留成功结果');
            assert.strictEqual(corePushes, 1, '记录故障不能重试核心推送');
            const runtime = await svc._getRuntime(c.handle);
            assert.strictEqual(runtime.lastError, null, '不伪造推送错误');
            assert.match(runtime.historyError, /post-push history read failure/);
        } finally { storageMod.loadJson = originalLoad; }
    });

    // ---- 汇总 ----
    const report = {
        generator: 'test/integration-server.test.js',
        disclaimer: '真实核心 orchestrator + 本地 bare（url.insteadOf 重写，来自工厂参数而非 HTTP）+ 真实 worker fork；HTTP router 用轻量 stub（非 Express 实测，Codex 后补真实）。未用真实安装/聊天/PAT/互联网 push。',
        createdAt: new Date().toISOString(),
        versions: { node: process.version, git: mustGit(['--version']) },
        coreHashes: shaHashes(),
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

function shaHashes() {
    const fsx = require('fs-extra');
    const crypto = require('crypto');
    const rel = [
        'lib/reliable/orchestrator.js',
        'lib/reliable/state.js',
        'lib/reliable/apply.js',
        'lib/reliable/planner.js',
        'lib/reliable/git-tree.js',
        'lib/reliable/hash-scan.js',
        'lib/integration/service.js',
        'lib/integration/storage.js',
        'lib/integration/worker.js',
        'lib/integration/startup.js',
        'index.js',
    ];
    const out = {};
    for (const r of rel) {
        const p = path.join(__dirname, '..', r);
        try { out[r] = crypto.createHash('sha256').update(fsx.readFileSync(p)).digest('hex'); } catch { out[r] = 'missing'; }
    }
    return out;
}

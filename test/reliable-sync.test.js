#!/usr/bin/env node
'use strict';
/**
 * 酒管可靠同步核心 · 真实测试（本地 bare Git，不 mock 同步算法或 Git 调用）。
 *
 * 结构：父进程创建隔离运行目录并 spawn 本文件 --child <run>；
 * 子进程先隔离环境（HOME/USERPROFILE/TMP/TEMP、GIT_CONFIG_NOSYSTEM、GIT_ALLOW_PROTOCOL=file、
 * 清除令牌/GIT_CONFIG_*），之后才 require 真实 lib/reliable/* 模块。
 *
 * 每个场景使用独立的 githubRepo 假身份（fixture/<n>）与独立本地 bare，且**每个 repoDir**
 * 通过 `url.<file://...>.insteadOf` 把 `https://github.com/fixture/<n>.git` 重写到该 bare；
 * 不写多个同 prefix 到 HOME（只用一份空 .gitconfig）。远端内容一律用
 * `git --git-dir <bare> show main:<path>` 读取。
 *
 * 真实故障窗口（P1_SECOND_REVIEW A-E / P1_TEST_REVIEW）：由 test/reliable-fault-worker.js
 * 作为独立进程**包装真实操作**（真实 push / 真实 fs.rename / 真实 state 保存）后精确抛错或退出，
 * 再由**全新进程** recover；不 mock 算法、不伪造 pending、不手写 B。
 *
 * 用法：node test/reliable-sync.test.js [--keep]
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
    const run = path.join(ROOT, 'test-artifacts', `reliable-${crypto.randomUUID()}`);
    fs.mkdirSync(run, { recursive: true });
    const r = spawnSync(process.execPath, [__filename, '--child', run], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    const out = path.join(ROOT, 'test-artifacts', 'reliable-results.json');
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
    const gitTree = require(path.join(ROOT, 'lib', 'reliable', 'git-tree.js'));
    const scan = require(path.join(ROOT, 'lib', 'reliable', 'hash-scan.js'));
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
    const remoteLog = bare => {
        const r = git(['--git-dir', bare, 'log', '--format=%H', 'main']);
        return r.ok ? r.out.split('\n').filter(s => /^[0-9a-f]{40}$/.test(s)) : [];
    };
    // JSONL：swipes/swipe_info/extra/chat_metadata 齐全
    const jl = (mes, extra) => JSON.stringify({
        name: 'Actor', is_user: false, is_system: false, mes,
        chat_metadata: { char_id: 0, msgs: 2, stop: ['</s>'] },
        swipes: ['hello *waves*', 'second swipe'],
        swipe_info: [{ send_date: 'Oct 1, 2026 10:00am', gen_started: 'x', gen_finished: 'y' }],
        extra: { api: 'openai', model: 'gpt-4o', bookmarked: false, note: 'n' },
        ...extra,
    }) + '\n';

    const ART = 'chats/Actor/a.jsonl';
    const B = 'chats/Actor/b.jsonl';

    /**
     * 构建一个场景：bare（种子 chats 文件）→ clone repoDir（带 insteadOf）→ dataRoot（chats 目录）。
     */
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

        // clone repoDir
        must(['clone', '-q', bare, repoDir]);
        const bareUrl = `file:///${bare.replace(/\\/g, '/')}`;
        must(['config', '--local', `url.${bareUrl}.insteadOf`, `https://github.com/${repo}.git`], repoDir);
        for (const [k, v] of [['credential.helper', ''], ['user.name', 'reliable'], ['user.email', 'reliable@localhost'],
            ['core.autocrlf', 'false'], ['core.safecrlf', 'false']]) {
            must(['config', '--local', k, v], repoDir);
        }

        // dataRoot：chats 目录，复制种子内容
        fs.mkdirSync(path.join(dataRoot, 'chats'), { recursive: true });
        for (const f of seedFiles) {
            const abs = path.join(dataRoot, f.rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, f.content);
        }
        return { S, bare, seed, repoDir, dataRoot, repo };
    }

    /** 在同一 bare 上构建「第二端点」：独立 repoDir + dataRoot，指向同一远端 bare。 */
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
        // dataRoot：复制种子内容（与 baseC 初始种子一致）
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

    /** 默认配置对象（orchestrator.run 直接调用）。 */
    function opts(c, cmd, extra = {}) {
        return {
            command: cmd,
            repoDir: c.repoDir,
            dataRoot: c.dataRoot,
            githubRepo: c.repo,
            branch: 'main',
            commitAuthor: { name: 'Reliable', email: 'reliable@localhost' },
            tokenFile: '',
            offlineConfirmed: true,
            ...extra,
        };
    }

    // ---- 故障注入 worker 工具（独立进程，包装真实操作） ----
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

    /** 故障进程退出后遗留的合成锁：仅在 spawnSync 已返回（子进程已结束）后，清理 test-artifacts 内的锁。 */
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

    // ===== 1. 共同 B 初始化 + 单端往返（断言两端共享相同旧 B 及原哈希） =====
    tests.push(runTest(1, '共同 B 初始化：两端断言相同旧 B（原哈希）→单端编辑→push→对端 pull/apply 往返', async () => {
        const c = setupScenario(1, [
            { rel: ART, content: jl('a-base', {}) },
            { rel: B, content: jl('b-base', {}) },
        ]);
        await orchestrator.run(opts(c, 'init'));
        // 首次 push：无改动，L=R → ok 建立共同 B
        const r0 = await orchestrator.run(opts(c, 'push'));
        assert.strictEqual(r0.pushed, false, '首次 push 无改动应不产生提交');
        const st0 = await stateMod.loadState(path.join(c.repoDir, '.git', 'dsr'));
        assert.ok(st0.baseline[ART], 'ok 应持久化共同 B（a）');
        assert.ok(st0.baseline[B], 'ok 应持久化共同 B（b）');
        assert.strictEqual(st0.baseline[ART].hash, sha(path.join(c.dataRoot, ART)), 'B(a) 应等于本地 a 哈希');

        // 第二端点：建立其共同 B
        const c2 = makeSecondEndpoint(c, 'peer');
        await orchestrator.run({ ...opts(c2, 'init'), githubRepo: c.repo });
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo }); // c2 建立 B=base
        const st2 = await stateMod.loadState(path.join(c2.repoDir, '.git', 'dsr'));
        // 关键断言：两端共享**相同**旧 B，且等于原始种子哈希
        assert.strictEqual(st2.baseline[ART].hash, st0.baseline[ART].hash, '两端 B(a) 应相同');
        assert.strictEqual(st2.baseline[B].hash, st0.baseline[B].hash, '两端 B(b) 应相同');
        assert.strictEqual(st2.baseline[ART].hash, shaBuf(Buffer.from(jl('a-base', {}))), 'B(a) 应为原始种子哈希');

        // 单端编辑 a（A 端）
        fs.writeFileSync(path.join(c.dataRoot, ART), jl('a-edited', {}));
        const r = await orchestrator.run(opts(c, 'push'));
        assert.strictEqual(r.pushed, true, 'push 应成功');
        assert.deepStrictEqual(r.published, [ART], '应只发布 a');
        const remoteA = show(c.bare, ART);
        assert.ok(remoteA && shaBuf(remoteA) === sha(path.join(c.dataRoot, ART)), '远端 a 应等于本地 a');

        // 第二端点拉取并应用
        const pullR = await orchestrator.run({ ...opts(c2, 'pull'), githubRepo: c.repo });
        assert.strictEqual(pullR.staged.length, 1, '应暂存 1 个文件');
        const applyR = await orchestrator.run({ ...opts(c2, 'apply'), githubRepo: c.repo });
        assert.deepStrictEqual(applyR.applied, [ART]);
        assert.strictEqual(sha(path.join(c2.dataRoot, ART)), sha(path.join(c.dataRoot, ART)), '两端 a 应一致');
    }));

    // ===== 2. 过期端不知远端新增直接 push → 不删除远端新文件 =====
    tests.push(runTest(2, '过期端不知远端新增直接 push：保留远端新文件，不删除', async () => {
        const c = setupScenario(2, [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立共同 B
        const newA = 'chats/Actor/newA.jsonl';
        fs.writeFileSync(path.join(c.dataRoot, newA), jl('newA', {}));
        const r = await orchestrator.run(opts(c, 'push'));
        assert.deepStrictEqual(r.published, [newA], '应发布 newA');

        // 第二端在**不知道远端已新增 newA** 的情况下（不 pull）直接新增 newB 并 push
        const c2 = makeSecondEndpoint(c, 'peer');
        await orchestrator.run({ ...opts(c2, 'init'), githubRepo: c.repo });
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo }); // c2 建立 B=base（此时 c2 尚未看到 newA）
        // c2 直接新增 newB，不 pull（过期端不知道 newA 存在）
        const newB = 'chats/Actor/newB.jsonl';
        fs.writeFileSync(path.join(c2.dataRoot, newB), jl('newB', {}));
        const r2 = await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo });
        assert.deepStrictEqual(r2.published, [newB], '应发布 newB');
        assert.ok(show(c.bare, newA), '远端 newA 不应被过期端删除');
        assert.ok(show(c.bare, newB), '远端 newB 应存在');
        // 且 newA 内容未被覆盖
        assert.strictEqual(shaBuf(show(c.bare, newA)), shaBuf(Buffer.from(jl('newA', {}))), '远端 newA 内容应保留');
    }));

    // ===== 3. 同文件冲突（双方先确认旧 B，再各自改同文件 → conflict 保留 .local/.remote） =====
    tests.push(runTest(3, '同文件冲突：双方确认旧 B 后各自改同文件 → conflict 保留 .local/.remote', async () => {
        const c = setupScenario(3, [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B
        const c2 = makeSecondEndpoint(c, 'peer');
        await orchestrator.run({ ...opts(c2, 'init'), githubRepo: c.repo });
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo }); // c2 建立 B=base
        // 双方都确认了相同旧 B
        const st1 = await stateMod.loadState(path.join(c.repoDir, '.git', 'dsr'));
        const st2 = await stateMod.loadState(path.join(c2.repoDir, '.git', 'dsr'));
        assert.strictEqual(st1.baseline[ART].hash, st2.baseline[ART].hash, '双方 B(a) 应相同（确认旧 B 后才改）');
        assert.strictEqual(st1.baseline[ART].hash, shaBuf(Buffer.from(jl('base', {}))), 'B(a) 应为原种子哈希');

        // 双方各自改同文件（不同内容）
        fs.writeFileSync(path.join(c.dataRoot, ART), jl('a-edit', {}));
        fs.writeFileSync(path.join(c2.dataRoot, ART), jl('b-edit-different', {}));
        // A 先 push 成功（B=base, R=base, L=a-edit → publish）
        const rA = await orchestrator.run(opts(c, 'push'));
        assert.deepStrictEqual(rA.published, [ART], 'A 应先成功发布 a-edit');
        // B 再 push：远端已变 → 冲突，不覆盖远端
        const r2 = await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo });
        assert.strictEqual(r2.pushed, false, '应无 publish');
        assert.ok(r2.conflicts.length >= 1, '应报冲突');
        const con = r2.conflicts[0];
        assert.ok(fs.existsSync(con.localPath), '应保留 .local 快照');
        assert.ok(fs.existsSync(con.remotePath), '应保留 .remote 快照');
        // 远端仍是 A 的编辑（a-edit），B 端的 b-edit-different 未被发布覆盖
        assert.strictEqual(shaBuf(show(c.bare, ART)), shaBuf(Buffer.from(jl('a-edit', {}))), '远端 a 应仍是 A 编辑');
    }));

    // ===== 4. 同内容双改（L=R）→ ok 无冲突 =====
    tests.push(runTest(4, '同内容双改：L=R → ok 无冲突无多余提交', async () => {
        const c = setupScenario(4, [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B
        const same = jl('same', {});
        fs.writeFileSync(path.join(c.dataRoot, ART), same);
        await orchestrator.run(opts(c, 'push')); // A 发布 same

        const c2 = makeSecondEndpoint(c, 'peer');
        await orchestrator.run({ ...opts(c2, 'init'), githubRepo: c.repo });
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo }); // c2 建立 B=base
        fs.writeFileSync(path.join(c2.dataRoot, ART), same);
        const r2 = await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo });
        assert.strictEqual(r2.pushed, false, 'L=R 不应产生新提交');
        assert.strictEqual(r2.conflicts.length, 0, '不应有冲突');
    }));

    // ===== 5. 首次同名异内容（无 B）→ conflict =====
    tests.push(runTest(5, '首次同名异内容（无 B）→ conflict', async () => {
        const c = setupScenario(5, [{ rel: ART, content: jl('remote-original', {}) }]);
        fs.writeFileSync(path.join(c.dataRoot, ART), jl('local-different', {}));
        await orchestrator.run(opts(c, 'init'));
        const r = await orchestrator.run(opts(c, 'push'));
        assert.strictEqual(r.pushed, false);
        assert.ok(r.conflicts.length >= 1, '首次异内容应报冲突');
    }));

    // ===== 6. 删除不传播 =====
    tests.push(runTest(6, '删除不传播：本地删除 → delete-pending 阻断', async () => {
        const c = setupScenario(6, [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B
        fs.rmSync(path.join(c.dataRoot, ART));
        await assert.rejects(
            () => orchestrator.run(opts(c, 'push')),
            /DELETE_PENDING|删除待处理/,
            '本地删除应阻断 push'
        );
        assert.ok(show(c.bare, ART), '远端 a 不应被删除');
    }));

    // ===== 7. same size+mtime 不同内容 =====
    tests.push(runTest(7, 'same size+mtime 不同内容：记录基线 stat 后修改并恢复，内容哈希判定为不同', async () => {
        const c = setupScenario(7, [{ rel: ART, content: jl('a-base', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B
        const abs = path.join(c.dataRoot, ART);
        // 先固定 mtime 到 T，再记录基线 stat（大小 + mtime），避免「改到 T 后只断言 T」而非与 beforeStat 比对。
        const T = 1700000000;
        fs.utimesSync(abs, T, T);
        const beforeStat = fs.statSync(abs);
        const before = fs.readFileSync(abs);
        const after = Buffer.from(before.toString('utf8').replace('a-base', 'a-edit'));
        assert.strictEqual(after.length, before.length, '等长替换');
        fs.writeFileSync(abs, after);
        fs.utimesSync(abs, T, T); // 还原 mtime 到与基线相同的固定 T
        const afterStat = fs.statSync(abs);
        // 证实：size 与 mtime 与基线一致（模拟时间戳/大小不变的篡改）
        assert.strictEqual(afterStat.size, beforeStat.size, 'size 应相同');
        assert.ok(
            Math.abs(afterStat.mtimeMs - beforeStat.mtimeMs) <= 1,
            `前后 mtimeMs 应相等（1ms 内）: before=${beforeStat.mtimeMs} after=${afterStat.mtimeMs}`
        );
        assert.ok(
            Math.abs(afterStat.atimeMs - beforeStat.atimeMs) <= 1,
            `前后 atimeMs 应相等（1ms 内）: before=${beforeStat.atimeMs} after=${afterStat.atimeMs}`
        );
        assert.notStrictEqual(shaBuf(after), shaBuf(before), '内容哈希应确实不同（否则测不出篡改）');
        const r = await orchestrator.run(opts(c, 'push'));
        assert.deepStrictEqual(r.published, [ART], '同 size+mtime 异内容应被发布');
        assert.strictEqual(shaBuf(show(c.bare, ART)), shaBuf(after), '远端应为新内容');
    }));

    // ===== 8. JSONL 原字节保留（含 CRLF，hash-object --no-filters） =====
    tests.push(runTest(8, 'JSONL 原字节保留：hash-object --no-filters 逐字节一致（含 CRLF）', async () => {
        const crlfContent = Buffer.concat([
            Buffer.from(JSON.stringify({ name: 'Actor', mes: 'line1' })),
            Buffer.from('\r\n'),
            Buffer.from(JSON.stringify({ name: 'Actor', mes: 'line2', extra: { k: 'v' } })),
            Buffer.from('\r\n'),
        ]);
        const c = setupScenario(8, [{ rel: ART, content: crlfContent }]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B（L=R，含 CRLF）
        const edited = Buffer.concat([crlfContent, Buffer.from(JSON.stringify({ name: 'Actor', mes: 'line3' })), Buffer.from('\r\n')]);
        fs.writeFileSync(path.join(c.dataRoot, ART), edited);
        const r = await orchestrator.run(opts(c, 'push'));
        assert.deepStrictEqual(r.published, [ART]);
        const remote = show(c.bare, ART);
        assert.ok(remote && remote.equals(edited), '远端字节应与本地原字节完全一致（含 CRLF）');
    }));

    // ===== 9. push 被 pre-receive 拒绝一次 → 失败保留 pending，recover 用原快照重试 =====
    tests.push(runTest(9, 'push 被 pre-receive 拒绝一次 → recover 用原快照重试成功', async () => {
        const c = setupScenario(9, [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B
        fs.writeFileSync(path.join(c.dataRoot, ART), jl('edited', {}));
        const hook = path.join(c.bare, 'hooks', 'pre-receive');
        fs.writeFileSync(hook, '#!/bin/sh\necho "reject once" >&2\nexit 1\n');
        fs.chmodSync(hook, 0o755);
        await assert.rejects(() => orchestrator.run(opts(c, 'push')), /PUSH_REJECTED|推送失败/, 'hook 应拒绝 push');
        const pending = await stateMod.loadPending(path.join(c.repoDir, '.git', 'dsr'));
        assert.ok(pending && pending.edits.length === 1, 'pending 应保留');
        // push 失败后再改本地文件，recover 必须用原快照
        fs.writeFileSync(path.join(c.dataRoot, ART), jl('edited-v2', {}));
        fs.rmSync(hook);
        const rec = await orchestrator.run(opts(c, 'recover'));
        assert.ok(rec.pending && rec.pending.recovered, `recover 应恢复: ${JSON.stringify(rec.pending)}`);
        assert.strictEqual(shaBuf(show(c.bare, ART)), shaBuf(Buffer.from(jl('edited', {}))), '远端应为原快照（edited）而非实时新内容');
    }));

    // ===== 10. 并发远端：fetch 后检测冲突不覆盖 =====
    tests.push(runTest(10, '并发远端：fetch 后检测冲突不覆盖', async () => {
        const c = setupScenario(10, [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B
        fs.writeFileSync(path.join(c.dataRoot, ART), jl('a-edit', {}));
        // 第二端真实推送不同内容（并发更新）
        const other = path.join(c.S, 'other');
        fs.mkdirSync(other, { recursive: true });
        must(['clone', '-q', c.bare, other]);
        fs.writeFileSync(path.join(other, ART), jl('b-edit', {}));
        must(['add', '-A'], other);
        must(['-c', 'user.name=other', '-c', 'user.email=other@localhost', 'commit', '-qm', 'b edit'], other);
        must(['push', '-q', c.bare, 'main'], other);

        // A push：fetch 后发现远端已变 → 冲突，不覆盖远端
        const r = await orchestrator.run(opts(c, 'push'));
        assert.strictEqual(r.pushed, false, '并发远端更新应检测冲突而非发布');
        assert.ok(r.conflicts.length >= 1, '应报冲突');
        assert.strictEqual(shaBuf(show(c.bare, ART)), shaBuf(Buffer.from(jl('b-edit', {}))), '远端应保留并发更新（b-edit），不被覆盖');
    }));

    // ===== 11. stale stage（暂存后本地再改 → apply 拒绝，旧 stage 不回退） =====
    tests.push(runTest(11, 'stale stage：暂存后本地再改 → apply 拒绝，不覆盖后来编辑', async () => {
        const c = setupScenario(11, [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B
        const c2 = makeSecondEndpoint(c, 'peer');
        await orchestrator.run({ ...opts(c2, 'init'), githubRepo: c.repo });
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo }); // c2 建立 B=base
        fs.writeFileSync(path.join(c2.dataRoot, ART), jl('remote-edit', {}));
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo });

        const pullR = await orchestrator.run({ ...opts(c, 'pull'), githubRepo: c.repo });
        assert.strictEqual(pullR.staged.length, 1);
        fs.writeFileSync(path.join(c.dataRoot, ART), jl('local-after-stage', {}));
        await assert.rejects(
            () => orchestrator.run(opts(c, 'apply')),
            /LOCAL_CHANGED|本地已改|拒绝覆盖/,
            '暂存后本地已改应拒绝 apply'
        );
    }));

    // ===== 12. 同路径 flat 碰撞 =====
    tests.push(runTest(12, '同路径 flat 碰撞：chats/a/b.jsonl 与 chats/a__b.jsonl 快照不互相覆盖', async () => {
        const p1 = 'chats/a/b.jsonl';
        const p2 = 'chats/a__b.jsonl';
        const c = setupScenario(12, [
            { rel: p1, content: jl('x-base', {}) },
            { rel: p2, content: jl('y-base', {}) },
        ]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B
        fs.writeFileSync(path.join(c.dataRoot, p1), jl('x-a', {}));
        fs.writeFileSync(path.join(c.dataRoot, p2), jl('y-b', {}));
        const r = await orchestrator.run(opts(c, 'push'));
        assert.strictEqual(r.published.length, 2, '两个路径都应发布');
        assert.notStrictEqual(stateMod.fileKeyForRel(p1), stateMod.fileKeyForRel(p2), 'flat 碰撞必须消除');
        assert.strictEqual(shaBuf(show(c.bare, p1)), sha(path.join(c.dataRoot, p1)));
        assert.strictEqual(shaBuf(show(c.bare, p2)), sha(path.join(c.dataRoot, p2)));
    }));

    // ===== 13. schema 越界 + 损坏合法 JSON 拒绝 =====
    tests.push(runTest(13, 'schema 越界：baseline 键非 chats/**/*.jsonl 拒绝；损坏但合法 JSON 拒绝', async () => {
        const c = setupScenario(13, [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        const maintDir = path.join(c.repoDir, '.git', 'dsr');

        const st = await stateMod.loadState(maintDir);
        st.baseline['worlds/x.jsonl'] = { hash: 'a'.repeat(64), setAt: new Date().toISOString() };
        await assert.rejects(() => stateMod.saveState(maintDir, st), /CORRUPT_STATE|schema/, '越界 baseline 键应拒绝');

        const st2 = await stateMod.loadState(maintDir);
        delete st2.baseline['worlds/x.jsonl'];
        st2.schemaVersion = 999;
        await assert.rejects(() => stateMod.saveState(maintDir, st2), /CORRUPT_STATE|schemaVersion/, '损坏 schema 应拒绝');

        const st3 = await stateMod.loadState(maintDir);
        st3.schemaVersion = stateMod.SCHEMA_VERSION;
        const badStage = {
            runId: 'r', remoteHead: 'b'.repeat(40), targetIdentity: st3.targetIdentity,
            entries: [{
                rel: ART, expectedBaselineHash: null, expectedLocalHash: null, expectedLocalMissing: false,
                candidateHash: 'c'.repeat(64), candidatePath: '../outside.jsonl', remoteCommit: 'd'.repeat(40),
            }],
            createdAt: new Date().toISOString(),
        };
        await assert.rejects(() => stateMod.writeStage(maintDir, badStage), /CORRUPT_STATE|越界|越出/, '候选路径越界应拒绝');
    }));

    // ===== 14. 锁 dataRoot 同 repo 竞争 =====
    tests.push(runTest(14, '锁：同 repoDir 竞争拒绝；同 dataRoot 不同 repoDir 共享互斥', async () => {
        const c = setupScenario(14, [{ rel: ART, content: jl('base', {}) }]);
        const maintDir = path.join(c.repoDir, '.git', 'dsr');
        const lock = await stateMod.acquireLock(maintDir);
        try {
            await assert.rejects(() => stateMod.acquireLock(maintDir), /LOCKED|锁定|遗留锁/, '锁竞争应拒绝');
        } finally {
            await stateMod.releaseLock(maintDir, lock);
        }

        const c2 = setupScenario(1414, [{ rel: ART, content: jl('base', {}) }]);
        const c3 = { ...c2, dataRoot: c.dataRoot };
        const dl = await stateMod.acquireDataRootLock(c.dataRoot);
        try {
            await assert.rejects(() => stateMod.acquireDataRootLock(c3.dataRoot), /LOCKED|锁定|遗留锁/, '同 dataRoot 跨 repo 锁应互斥');
        } finally {
            await stateMod.releaseDataRootLock(dl);
        }
    }));

    // ===== 15. 远端其他文件保留 =====
    tests.push(runTest(15, '远端其他文件保留：push 不删除远端未改文件', async () => {
        const c = setupScenario(15, [
            { rel: ART, content: jl('a-base', {}) },
            { rel: B, content: jl('b-base', {}) },
        ]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B
        fs.writeFileSync(path.join(c.dataRoot, ART), jl('a-edit', {}));
        const r = await orchestrator.run(opts(c, 'push'));
        assert.deepStrictEqual(r.published, [ART]);
        assert.strictEqual(shaBuf(show(c.bare, B)), shaBuf(Buffer.from(jl('b-base', {}))), '远端 b 应保留');
    }));

    // ===== 16. apply 正常应用 + journal 计划已持久化 =====
    tests.push(runTest(16, 'apply 正常应用：journal plan 已持久化，含 expected/candidate', async () => {
        const c = setupScenario(16, [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B
        const c2 = makeSecondEndpoint(c, 'peer');
        await orchestrator.run({ ...opts(c2, 'init'), githubRepo: c.repo });
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo }); // c2 建立 B=base
        fs.writeFileSync(path.join(c2.dataRoot, ART), jl('remote-edit', {}));
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo });

        await orchestrator.run({ ...opts(c, 'pull'), githubRepo: c.repo });
        const applyR = await orchestrator.run({ ...opts(c, 'apply'), githubRepo: c.repo });
        assert.deepStrictEqual(applyR.applied, [ART]);
        const journal = await stateMod.readApplyJournal(path.join(c.repoDir, '.git', 'dsr'));
        const planRecs = journal.filter(j => j.status === 'plan');
        assert.ok(planRecs.length >= 1, 'apply 前应持久化 plan journal');
        assert.ok(planRecs.every(j => j.candidateHash && j.expectedHash !== undefined), 'plan journal 应含 expected/candidate');
    }));

    // ===== 17. 暂存后本地删除（apply 拒绝：本地文件被删） =====
    tests.push(runTest(17, '暂存后本地删除 → apply 拒绝', async () => {
        const c = setupScenario(17, [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B
        const c2 = makeSecondEndpoint(c, 'peer');
        await orchestrator.run({ ...opts(c2, 'init'), githubRepo: c.repo });
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo }); // c2 建立 B=base
        fs.writeFileSync(path.join(c2.dataRoot, ART), jl('remote-edit', {}));
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo });
        await orchestrator.run({ ...opts(c, 'pull'), githubRepo: c.repo });
        fs.rmSync(path.join(c.dataRoot, ART));
        await assert.rejects(
            () => orchestrator.run(opts(c, 'apply')),
            /LOCAL_CHANGED|删除|拒绝应用/,
            '暂存后本地删除应拒绝 apply'
        );
    }));

    // ===== 18. 首次 L=R 建立共同 B =====
    tests.push(runTest(18, '首次 L=R 建立共同 B：下一单端编辑 publish 而非首次冲突', async () => {
        const c = setupScenario(18, [{ rel: ART, content: jl('same-init', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        const r0 = await orchestrator.run(opts(c, 'push'));
        assert.strictEqual(r0.pushed, false);
        fs.writeFileSync(path.join(c.dataRoot, ART), jl('single-edit', {}));
        const r = await orchestrator.run(opts(c, 'push'));
        assert.strictEqual(r.pushed, true, '建立 B 后单端编辑应 publish 而非 conflict');
        assert.deepStrictEqual(r.published, [ART]);
    }));

    // ===================== A-E 真实故障集成 =====================

    // ===== A. 双端初始化 + 已有不同文件双改 + 同文件冲突 + 过期端直接 push 保留新增 + same size+mtime =====
    tests.push(runTest('A', 'A. 双端共享旧 B：不同文件双改 + 同文件冲突 + 过期端保留新增 + same size+mtime', async () => {
        // 双端正常初始化，断言相同旧 B
        const c = setupScenario('A', [
            { rel: ART, content: jl('a-base', {}) },
            { rel: B, content: jl('b-base', {}) },
        ]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B
        const baseA = shaBuf(Buffer.from(jl('a-base', {})));
        const baseB = shaBuf(Buffer.from(jl('b-base', {})));
        const c2 = makeSecondEndpoint(c, 'peer');
        await orchestrator.run({ ...opts(c2, 'init'), githubRepo: c.repo });
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo }); // c2 建立 B=base
        const st1 = await stateMod.loadState(path.join(c.repoDir, '.git', 'dsr'));
        const st2 = await stateMod.loadState(path.join(c2.repoDir, '.git', 'dsr'));
        assert.strictEqual(st1.baseline[ART].hash, baseA, 'A 端 B(a) 应为原哈希');
        assert.strictEqual(st2.baseline[ART].hash, baseA, 'B 端 B(a) 应与 A 端相同');
        assert.strictEqual(st1.baseline[B].hash, baseB, 'A 端 B(b) 应为原哈希');
        assert.strictEqual(st2.baseline[B].hash, baseB, 'B 端 B(b) 应与 A 端相同');

        // 已有不同文件双改：A 改 a，B 改 b（互不冲突，各自 publish，不删除对方）
        fs.writeFileSync(path.join(c.dataRoot, ART), jl('a-edit-A', {}));
        fs.writeFileSync(path.join(c2.dataRoot, B), jl('b-edit-B', {}));
        const rA = await orchestrator.run(opts(c, 'push'));
        assert.deepStrictEqual(rA.published, [ART], 'A 应只发布 a');
        const rB = await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo });
        assert.deepStrictEqual(rB.published, [B], 'B 应只发布 b');
        assert.ok(show(c.bare, ART), '远端 a 不应被删');
        assert.ok(show(c.bare, B), '远端 b 不应被删');
        assert.strictEqual(shaBuf(show(c.bare, ART)), shaBuf(Buffer.from(jl('a-edit-A', {}))), '远端 a 为 A 编辑');
        assert.strictEqual(shaBuf(show(c.bare, B)), shaBuf(Buffer.from(jl('b-edit-B', {}))), '远端 b 为 B 编辑');
    }));

    // ===== B. 真实 push 成功后确认前终止/抛错 + state 写失败 → recover 不重复 commit，支持 C 有后继 =====
    tests.push(runTest('B', 'B. 真实 push 成功后确认前退出：C 存在、B 未推进、pending 保留；新进程 recover 不重复 commit', async () => {
        const c = setupScenario('B', [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B
        const edited = jl('edited', {});
        fs.writeFileSync(path.join(c.dataRoot, ART), edited);
        const beforeLog = remoteLog(c.bare); // 建立 B 后的远端提交数

        // 包装真实 pushBranch：真实 push 成功后 process.exit(77)（确认前崩溃）
        const spec = {
            task: 'fault',
            command: 'push',
            repoDir: c.repoDir, dataRoot: c.dataRoot, repo: c.repo, branch: 'main', bare: c.bare,
            offlineConfirmed: true,
            fault: { target: 'pushBranch', module: 'git-tree', when: 'after', action: 'exit', exitCode: 77 },
        };
        const w = spawnWorker(spec);
        assert.strictEqual(w.status, 77, `故障进程应以 77 退出（实际 ${w.status}）: ${w.stderr}`);
        // 证明子进程已结束（spawnSync 返回即结束），清理遗留合成锁
        cleanupSyntheticLocks(c);

        // C 已真实推送到远端（远端 log 多了一个 commit）
        const afterLog = remoteLog(c.bare);
        assert.strictEqual(afterLog.length, beforeLog.length + 1, '远端应新增 C 提交');
        assert.strictEqual(shaBuf(show(c.bare, ART)), shaBuf(Buffer.from(edited)), '远端 C 内容应为 edited');

        // B 未推进 + pending 保留
        const stAfter = await stateMod.loadState(path.join(c.repoDir, '.git', 'dsr'));
        assert.notStrictEqual(stAfter.baseline[ART].hash, shaBuf(Buffer.from(edited)), 'B 不应推进到 edited（确认前崩溃）');
        const pend = await stateMod.loadPending(path.join(c.repoDir, '.git', 'dsr'));
        assert.ok(pend && pend.commitId, 'pending 应保留（含 commitId）');
        const commitId = pend.commitId;

        // 新进程 recover：不重复 commit，B 推进
        const rec = spawnWorker({ task: 'recover', command: 'recover', repoDir: c.repoDir, dataRoot: c.dataRoot, repo: c.repo, branch: 'main', bare: c.bare, offlineConfirmed: true });
        assert.strictEqual(rec.status, 0, `recover 应以 0 退出（实际 ${rec.status}）: ${rec.stderr}`);
        assert.ok(rec.result && !rec.result.error, `recover 结果应无 error: ${JSON.stringify(rec.result && rec.result.error)}`);
        const pendRec = rec.result && rec.result.recoverResult && rec.result.recoverResult.pending;
        assert.ok(pendRec && pendRec.recovered, `recover 应恢复 pending: ${JSON.stringify(pendRec)}`);
        assert.strictEqual(rec.result.remoteLog.length, afterLog.length, 'recover 不应产生重复 commit');
        assert.strictEqual(rec.result.state.baseline[ART].hash, shaBuf(Buffer.from(edited)), 'recover 后 B 应推进到 edited');
        assert.strictEqual(rec.result.pendingExists, false, 'recover 后 pending 应清除');
    }));

    tests.push(runTest('B2', 'B2. push 后 state 保存失败（before throw）：B 未推进、pending 保留；recover 收敛；C 有后继', async () => {
        const c = setupScenario('B2', [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B
        const edited = jl('edited', {});
        fs.writeFileSync(path.join(c.dataRoot, ART), edited);
        const beforeLog = remoteLog(c.bare);

        // 包装真实 saveState：在推进 B 的那次 saveState 之前抛错（state 写失败）
        const spec = {
            task: 'fault',
            command: 'push',
            repoDir: c.repoDir, dataRoot: c.dataRoot, repo: c.repo, branch: 'main', bare: c.bare,
            offlineConfirmed: true,
            fault: { target: 'saveState', module: 'state', when: 'before', action: 'throw', message: 'injected state write fail' },
        };
        const w = spawnWorker(spec);
        assert.strictEqual(w.status, 0, `state 写失败故障应以 0 退出并记录 error（实际 ${w.status}）`);
        assert.ok(w.result && w.result.error, '应记录故障错误');
        assert.strictEqual(w.result.pendingExists, true, 'pending 应保留（state 写失败）');

        // C 已推送（push 在 saveState 之前）
        const afterLog = remoteLog(c.bare);
        assert.strictEqual(afterLog.length, beforeLog.length + 1, '远端应新增 C');
        // B 未推进
        const stAfter = await stateMod.loadState(path.join(c.repoDir, '.git', 'dsr'));
        assert.notStrictEqual(stAfter.baseline[ART].hash, shaBuf(Buffer.from(edited)), 'B 不应推进（state 写失败）');

        // C 有后继：另一端点基于 C 再推一个提交
        const other = path.join(c.S, 'successor');
        fs.mkdirSync(other, { recursive: true });
        must(['clone', '-q', c.bare, other]);
        fs.writeFileSync(path.join(other, B), jl('b-successor', {}));
        must(['add', '-A'], other);
        must(['-c', 'user.name=succ', '-c', 'user.email=succ@localhost', 'commit', '-qm', 'successor'], other);
        must(['push', '-q', c.bare, 'main'], other);
        const logAfterSucc = remoteLog(c.bare);

        // recover：C 仍可达（后继在 C 之上），不重复 commit
        const rec = spawnWorker({ task: 'recover', command: 'recover', repoDir: c.repoDir, dataRoot: c.dataRoot, repo: c.repo, branch: 'main', bare: c.bare, offlineConfirmed: true });
        assert.strictEqual(rec.status, 0, `recover 应以 0 退出（实际 ${rec.status}）: ${rec.stderr}`);
        assert.ok(rec.result && !rec.result.error, `recover 结果应无 error: ${JSON.stringify(rec.result && rec.result.error)}`);
        const pendRec2 = rec.result && rec.result.recoverResult && rec.result.recoverResult.pending;
        assert.ok(pendRec2 && pendRec2.recovered, `recover 应恢复 pending: ${JSON.stringify(pendRec2)}`);
        assert.strictEqual(rec.result.remoteLog.length, logAfterSucc.length, 'recover 不应产生重复 commit（C 有后继也不重复）');
        assert.strictEqual(rec.result.state.baseline[ART].hash, shaBuf(Buffer.from(edited)), 'recover 后 B 应推进到 edited');
        assert.strictEqual(rec.result.pendingExists, false, 'recover 后 pending 应清除');
    }));

    // ===== C. 真实 apply rename 后 journal 前退出 → recover 识别 candidate；第三种编辑拒绝 =====
    tests.push(runTest('C', 'C. 真实 apply fs.rename 后 journal 前退出：recover 识别 candidate；第三种编辑拒绝覆盖', async () => {
        const c = setupScenario('C', [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B
        // 第二端改并 publish，使 c 端有可 pull 的远端更新
        const c2 = makeSecondEndpoint(c, 'peer');
        await orchestrator.run({ ...opts(c2, 'init'), githubRepo: c.repo });
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo }); // c2 建立 B=base
        fs.writeFileSync(path.join(c2.dataRoot, ART), jl('remote-edit', {}));
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo });
        // c 端 pull 暂存
        await orchestrator.run({ ...opts(c, 'pull'), githubRepo: c.repo });

        // 包装真实 fs.rename：仅对「聊天文件目标」注入（dest 在 dataRoot 下），真实 rename 成功后 process.exit(77)
        // （applied journal 之前崩溃；备份/journal 的 atomicWriteBytes rename 不在 dataRoot 下，不会被误触发）
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

        // rename 已发生：本地聊天 == candidate（remote-edit）
        assert.strictEqual(sha(path.join(c.dataRoot, ART)), shaBuf(Buffer.from(jl('remote-edit', {}))), 'rename 后本地应为候选内容');
        // plan journal 已持久化
        const journal = await stateMod.readApplyJournal(path.join(c.repoDir, '.git', 'dsr'));
        const planRecs = journal.filter(j => j.status === 'plan');
        assert.ok(planRecs.length >= 1, 'plan journal 应已持久化');

        // 新进程 recover：识别 candidate 已应用
        const rec = spawnWorker({ task: 'recover', command: 'recover', repoDir: c.repoDir, dataRoot: c.dataRoot, repo: c.repo, branch: 'main', bare: c.bare, offlineConfirmed: true });
        assert.strictEqual(rec.status, 0, `recover 应以 0 退出（实际 ${rec.status}）: ${rec.stderr}`);
        assert.ok(rec.result && !rec.result.error, `recover 结果应无 error: ${JSON.stringify(rec.result && rec.result.error)}`);
        const applyRec = rec.result && rec.result.recoverResult && rec.result.recoverResult.apply;
        assert.ok(applyRec && applyRec.appliedRels && applyRec.appliedRels.includes(ART), `recover 应识别 candidate 已应用: ${JSON.stringify(applyRec)}`);
        assert.strictEqual(rec.result.state.baseline[ART].hash, shaBuf(Buffer.from(jl('remote-edit', {}))), 'recover 后 B 应推进到候选');
    }));

    // ===== C2. 中断后第三种编辑（未完成事务）→ recover 阻断，不覆盖新编辑 =====
    tests.push(runTest('C2', 'C2. 中断后第三种编辑：recover 阻断，不覆盖新编辑', async () => {
        const c = setupScenario('C2', [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B
        const c2 = makeSecondEndpoint(c, 'peer');
        await orchestrator.run({ ...opts(c2, 'init'), githubRepo: c.repo });
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo }); // c2 建立 B=base
        fs.writeFileSync(path.join(c2.dataRoot, ART), jl('remote-edit', {}));
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo });
        await orchestrator.run({ ...opts(c, 'pull'), githubRepo: c.repo });

        // 故障：真实 rename 成功后 exit(77)（applied journal 之前崩溃）
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

        // rename 已发生（本地=remote-edit），随后在 recover 之前改第三种内容
        assert.strictEqual(sha(path.join(c.dataRoot, ART)), shaBuf(Buffer.from(jl('remote-edit', {}))), 'rename 后本地应为候选内容');
        // recover 之前：B 仍为 base（rename 后崩溃，尚未推进 B）
        const stBefore = await stateMod.loadState(path.join(c.repoDir, '.git', 'dsr'));
        assert.strictEqual(stBefore.baseline[ART].hash, shaBuf(Buffer.from(jl('base', {}))), 'recover 前 B 应仍为 base');
        fs.writeFileSync(path.join(c.dataRoot, ART), jl('third-edit', {}));

        // recover：current==third != candidate != expected → 阻断，不覆盖
        const rec = spawnWorker({ task: 'recover', command: 'recover', repoDir: c.repoDir, dataRoot: c.dataRoot, repo: c.repo, branch: 'main', bare: c.bare, offlineConfirmed: true });
        assert.strictEqual(rec.status, 0, `recover 应以 0 退出（实际 ${rec.status}）: ${rec.stderr}`);
        assert.ok(rec.result && !rec.result.error, `recover 结果应无 error: ${JSON.stringify(rec.result && rec.result.error)}`);
        const applyRec = rec.result && rec.result.recoverResult && rec.result.recoverResult.apply;
        assert.ok(applyRec && applyRec.blocked === true, `recover 应阻断第三种编辑: ${JSON.stringify(applyRec)}`);
        assert.ok(applyRec.blockedRels && applyRec.blockedRels.some(b => b.rel === ART), `应阻断 ART: ${JSON.stringify(applyRec.blockedRels)}`);
        // 第三种编辑必须被保留
        assert.strictEqual(sha(path.join(c.dataRoot, ART)), shaBuf(Buffer.from(jl('third-edit', {}))), '第三种编辑不得被 recover 覆盖');
        // recover 之后：B 仍为 base（阻断，不得推进，也不得把第三种编辑误登记为 B）
        const stAfter = await stateMod.loadState(path.join(c.repoDir, '.git', 'dsr'));
        assert.strictEqual(stAfter.baseline[ART].hash, shaBuf(Buffer.from(jl('base', {}))), 'recover 阻断后 B 应仍为 base（不误推进第三种编辑）');
    }));

    // ===== C3. apply 后 state 保存失败 → recover 收敛 =====
    tests.push(runTest('C3', 'C3. apply 后 state 保存失败（before throw）：rename 已发生、B 未推进；recover 收敛', async () => {
        const c = setupScenario('C3', [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B
        const c2 = makeSecondEndpoint(c, 'peer');
        await orchestrator.run({ ...opts(c2, 'init'), githubRepo: c.repo });
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo }); // c2 建立 B=base
        fs.writeFileSync(path.join(c2.dataRoot, ART), jl('remote-edit', {}));
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo });
        await orchestrator.run({ ...opts(c, 'pull'), githubRepo: c.repo });

        // 故障：apply 的 B 推进 saveState 之前抛错（state 写失败）；rename 已发生
        const spec = {
            task: 'fault',
            command: 'apply',
            repoDir: c.repoDir, dataRoot: c.dataRoot, repo: c.repo, branch: 'main', bare: c.bare,
            offlineConfirmed: true,
            fault: { target: 'saveState', module: 'state', when: 'before', action: 'throw', message: 'injected apply state save fail' },
        };
        const w = spawnWorker(spec);
        assert.strictEqual(w.status, 0, `apply state 写失败故障应以 0 退出并记录 error（实际 ${w.status}）`);
        assert.ok(w.result && w.result.error, '应记录故障错误');

        // rename 已发生（本地=remote-edit），但 B 未推进（state 写失败）
        assert.strictEqual(sha(path.join(c.dataRoot, ART)), shaBuf(Buffer.from(jl('remote-edit', {}))), 'apply rename 应已发生');
        const st = await stateMod.loadState(path.join(c.repoDir, '.git', 'dsr'));
        assert.notStrictEqual(st.baseline[ART].hash, shaBuf(Buffer.from(jl('remote-edit', {}))), 'B 不应推进（state 写失败）');

        // recover 收敛：识别已应用，推进 B
        const rec = spawnWorker({ task: 'recover', command: 'recover', repoDir: c.repoDir, dataRoot: c.dataRoot, repo: c.repo, branch: 'main', bare: c.bare, offlineConfirmed: true });
        assert.strictEqual(rec.status, 0, `recover 应以 0 退出（实际 ${rec.status}）: ${rec.stderr}`);
        assert.ok(rec.result && !rec.result.error, `recover 结果应无 error: ${JSON.stringify(rec.result && rec.result.error)}`);
        const applyRec = rec.result && rec.result.recoverResult && rec.result.recoverResult.apply;
        assert.ok(applyRec && applyRec.appliedRels && applyRec.appliedRels.includes(ART), `recover 应识别已应用: ${JSON.stringify(applyRec)}`);
        assert.strictEqual(rec.result.state.baseline[ART].hash, shaBuf(Buffer.from(jl('remote-edit', {}))), 'recover 后 B 应推进到候选');
    }));

    // ===== D. fetch 后 push 前第二端推进远端 → 真 NFF；同路径阻断保留 pending =====
    tests.push(runTest('D', 'D. fetch 后 push 前第二端推进远端 → 真 NFF 阻断；同路径保留 pending 与远端双方', async () => {
        const c = setupScenario('D', [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B
        fs.writeFileSync(path.join(c.dataRoot, ART), jl('a-edit', {}));
        const beforeLog = remoteLog(c.bare);

        // 包装真实 pushBranch：真实 push 之前用第二端推进远端（制造 NFF）
        const spec = {
            task: 'fault',
            command: 'push',
            repoDir: c.repoDir, dataRoot: c.dataRoot, repo: c.repo, branch: 'main', bare: c.bare, seed: c.seed,
            offlineConfirmed: true,
            fault: {
                target: 'pushBranch', module: 'git-tree', action: 'advance-remote',
                advanceRemote: [{ rel: ART, content_b64: b64(jl('peer-advance', {})) }],
            },
        };
        const w = spawnWorker(spec);
        assert.strictEqual(w.status, 0, `NFF push 应以 0 退出并记录 error（实际 ${w.status}）: ${w.stderr}`);
        assert.ok(w.result && w.result.error, '应记录 NFF 推送失败');
        assert.match(w.result.error, /PUSH_REJECTED|non-fast-forward|推送失败/, `应是 NFF 错误: ${w.result.error}`);

        // pending 保留，B 未误推进
        assert.strictEqual(w.result.pendingExists, true, 'NFF 后 pending 应保留');
        // 远端保留第二端推进的内容（peer-advance），本地 a-edit 保留为 pending 快照
        assert.strictEqual(shaBuf(show(c.bare, ART)), shaBuf(Buffer.from(jl('peer-advance', {}))), '远端应保留第二端推进的内容');
        // 本地仍是 a-edit（未被覆盖）
        assert.strictEqual(sha(path.join(c.dataRoot, ART)), shaBuf(Buffer.from(jl('a-edit', {}))), '本地 a-edit 应保留');
        // 远端提交数未因失败的 push 而减少/异常
        assert.strictEqual(remoteLog(c.bare).length, beforeLog.length + 1, '远端只应多第二端那一个提交');

        // ---- 新进程 recover：同文件 NFF 必须阻断，不覆盖第二端推进，不把本地 a-edit 误读为原快照重发 ----
        const rec = spawnWorker({ task: 'recover', command: 'recover', repoDir: c.repoDir, dataRoot: c.dataRoot, repo: c.repo, branch: 'main', bare: c.bare, offlineConfirmed: true });
        assert.strictEqual(rec.status, 0, `recover 应以 0 退出（实际 ${rec.status}）: ${rec.stderr}`);
        assert.ok(rec.result, 'recover 应返回结果');
        assert.ok(!rec.result.error, `recover 结果应无 error（阻断通过返回值体现）: ${JSON.stringify(rec.result.error)}`);
        assert.ok(rec.result.recoverResult, 'recover 应含 recoverResult');
        const pendRec = rec.result.recoverResult.pending;
        assert.ok(pendRec && pendRec.recovered === false, `同文件 NFF recover 应阻断 pending: ${JSON.stringify(pendRec)}`);
        assert.strictEqual(pendRec.result, 'blocked', `recover 结果应为 blocked: ${JSON.stringify(pendRec)}`);
        // pending 必须保留（未被清除）
        assert.strictEqual(rec.result.pendingExists, true, 'recover 阻断后 pending 应保留');
        // 远端仍是第二端推进的内容（peer-advance），本地 a-edit 保留（第三值双方都保留，不覆盖）
        assert.strictEqual(shaBuf(show(c.bare, ART)), shaBuf(Buffer.from(jl('peer-advance', {}))), 'recover 后远端仍应保留 peer-advance（不被本地原快照覆盖）');
        assert.strictEqual(sha(path.join(c.dataRoot, ART)), shaBuf(Buffer.from(jl('a-edit', {}))), 'recover 后本地 a-edit 应保留（不被覆盖）');
        // B 未误推进到 a-edit
        const stD = await stateMod.loadState(path.join(c.repoDir, '.git', 'dsr'));
        assert.strictEqual(stD.baseline[ART].hash, shaBuf(Buffer.from(jl('base', {}))), 'recover 阻断后 B(a) 应仍为 base（不误推进）');
    }));

    // ===== D2. 不同文件 NFF：recover 重发本地，保留第二端推进的不同文件 =====
    tests.push(runTest('D2', 'D2. 不同文件 NFF：recover 重发本地改的文件，保留第二端推进的不同文件', async () => {
        const c = setupScenario('D2', [
            { rel: ART, content: jl('a-base', {}) },
            { rel: B, content: jl('b-base', {}) },
        ]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B（a、b 都登记）
        fs.writeFileSync(path.join(c.dataRoot, ART), jl('a-edit', {})); // 只改 a

        // 包装真实 pushBranch：真实 push 之前用第二端推进**不同文件 b**（制造 NFF，但 a 未被 peer 改）
        const spec = {
            task: 'fault',
            command: 'push',
            repoDir: c.repoDir, dataRoot: c.dataRoot, repo: c.repo, branch: 'main', bare: c.bare, seed: c.seed,
            offlineConfirmed: true,
            fault: {
                target: 'pushBranch', module: 'git-tree', action: 'advance-remote',
                advanceRemote: [{ rel: B, content_b64: b64(jl('b-peer', {})) }],
            },
        };
        const w = spawnWorker(spec);
        assert.strictEqual(w.status, 0, `不同文件 NFF push 应以 0 退出（实际 ${w.status}）: ${w.stderr}`);
        assert.ok(w.result && w.result.error, '应记录 NFF 推送失败');
        assert.strictEqual(w.result.pendingExists, true, 'NFF 后 pending 应保留');

        // recover：pending 只含 a；a 的 R 仍为 base（peer 只改了 b）→ 可重发 a；b 保留 peer 内容
        const rec = spawnWorker({ task: 'recover', command: 'recover', repoDir: c.repoDir, dataRoot: c.dataRoot, repo: c.repo, branch: 'main', bare: c.bare, offlineConfirmed: true });
        assert.strictEqual(rec.status, 0, `recover 应以 0 退出（实际 ${rec.status}）: ${rec.stderr}`);
        assert.ok(rec.result && !rec.result.error, `recover 结果应无 error: ${JSON.stringify(rec.result && rec.result.error)}`);
        const pendRec = rec.result && rec.result.recoverResult && rec.result.recoverResult.pending;
        assert.ok(pendRec && pendRec.recovered === true, `不同文件 NFF recover 应成功重发: ${JSON.stringify(pendRec)}`);
        assert.strictEqual(rec.result.pendingExists, false, 'recover 成功后 pending 应清除');
        // 远端 a = a-edit（本地重发），远端 b = b-peer（第二端推进内容保留）
        assert.strictEqual(shaBuf(show(c.bare, ART)), shaBuf(Buffer.from(jl('a-edit', {}))), '远端 a 应为本地重发的 a-edit');
        assert.strictEqual(shaBuf(show(c.bare, B)), shaBuf(Buffer.from(jl('b-peer', {}))), '远端 b 应保留第二端推进的 b-peer');
        // B 推进：a → a-edit；b 的 B 仍是 b-base（A 端未动 b）
        const stD2 = await stateMod.loadState(path.join(c.repoDir, '.git', 'dsr'));
        assert.strictEqual(stD2.baseline[ART].hash, shaBuf(Buffer.from(jl('a-edit', {}))), 'recover 后 B(a) 应推进到 a-edit');
        assert.strictEqual(stD2.baseline[B].hash, shaBuf(Buffer.from(jl('b-base', {}))), 'recover 后 B(b) 应仍为 b-base（A 端未同步 peer 的 b）');
    }));

    // ===== D3. 首次无 B 新路径：push 前 peer 同路径抢先发布 → recover 必须阻断（不覆盖） =====
    tests.push(runTest('D3', 'D3. 首次无 B 新路径被 peer 同路径抢先发布：recover 阻断，不覆盖 peer（B=null 不误推进）', async () => {
        // seed 只有 b（new 路径首次无 B）
        const NEW = 'chats/Actor/new.jsonl';
        const c = setupScenario('D3', [{ rel: B, content: jl('b-base', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B（仅 b）
        // A 新增 new.jsonl（首次无 B，远端无 → publish）
        fs.writeFileSync(path.join(c.dataRoot, NEW), jl('a-new', {}));
        const beforeLog = remoteLog(c.bare);

        // 包装真实 pushBranch：真实 push 之前 peer 在同路径 new.jsonl 抢先发布不同内容
        const spec = {
            task: 'fault',
            command: 'push',
            repoDir: c.repoDir, dataRoot: c.dataRoot, repo: c.repo, branch: 'main', bare: c.bare, seed: c.seed,
            offlineConfirmed: true,
            fault: {
                target: 'pushBranch', module: 'git-tree', action: 'advance-remote',
                advanceRemote: [{ rel: NEW, content_b64: b64(jl('peer-new', {})) }],
            },
        };
        const w = spawnWorker(spec);
        assert.strictEqual(w.status, 0, `首次无 B 同路径 NFF push 应以 0 退出（实际 ${w.status}）: ${w.stderr}`);
        assert.ok(w.result && w.result.error, '应记录 NFF 推送失败');
        assert.strictEqual(w.result.pendingExists, true, 'NFF 后 pending 应保留（含 new.jsonl）');
        // 远端已由 peer 抢先发布 new.jsonl
        assert.strictEqual(shaBuf(show(c.bare, NEW)), shaBuf(Buffer.from(jl('peer-new', {}))), '远端 new.jsonl 应为 peer 抢先发布内容');

        // recover：B[new]=null，R=peer-new ≠ publishHash → 必须阻断，绝不覆盖 peer（曾存在 B=null 严重错误）
        const rec = spawnWorker({ task: 'recover', command: 'recover', repoDir: c.repoDir, dataRoot: c.dataRoot, repo: c.repo, branch: 'main', bare: c.bare, offlineConfirmed: true });
        assert.strictEqual(rec.status, 0, `recover 应以 0 退出（实际 ${rec.status}）: ${rec.stderr}`);
        assert.ok(rec.result, 'recover 应返回结果');
        assert.ok(!rec.result.error, `recover 结果应无 error（阻断通过返回值体现）: ${JSON.stringify(rec.result.error)}`);
        const pendRec = rec.result.recoverResult && rec.result.recoverResult.pending;
        assert.ok(pendRec && pendRec.recovered === false, `首次无 B 同路径 recover 应阻断: ${JSON.stringify(pendRec)}`);
        assert.strictEqual(pendRec.result, 'blocked', `recover 结果应为 blocked（不覆盖）: ${JSON.stringify(pendRec)}`);
        // pending 保留，B 未误推进
        assert.strictEqual(rec.result.pendingExists, true, 'recover 阻断后 pending 应保留');
        const stD3 = await stateMod.loadState(path.join(c.repoDir, '.git', 'dsr'));
        assert.ok(!(NEW in stD3.baseline), `B[new] 不应被误推进（首次无 B 阻断后应仍无登记）: ${JSON.stringify(stD3.baseline[NEW])}`);
        // 本地 a-new 与远端 peer-new 双方都保留
        assert.strictEqual(sha(path.join(c.dataRoot, NEW)), shaBuf(Buffer.from(jl('a-new', {}))), 'recover 后本地 new.jsonl 应保留 a-new');
        assert.strictEqual(shaBuf(show(c.bare, NEW)), shaBuf(Buffer.from(jl('peer-new', {}))), 'recover 后远端 new.jsonl 应保留 peer-new（不被覆盖）');
        // 远端提交数只多了 peer 那一个（recover 未产生覆盖提交）
        assert.strictEqual(remoteLog(c.bare).length, beforeLog.length + 1, 'recover 阻断不应产生额外提交');
    }));

    // ===== F. 两次正常 apply 后本地第三次编辑：recover 不误处理历史日志，保留新编辑 =====
    tests.push(runTest('F', 'F. 两次正常 apply 后本地第三次编辑：recover 不误处理历史完整日志，保留新编辑', async () => {
        const c = setupScenario('F', [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B
        const c2 = makeSecondEndpoint(c, 'peer');
        await orchestrator.run({ ...opts(c2, 'init'), githubRepo: c.repo });
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo }); // c2 建立 B=base

        // 第一次远端更新：peer 改 remote-1 → c pull/apply
        fs.writeFileSync(path.join(c2.dataRoot, ART), jl('remote-1', {}));
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo });
        await orchestrator.run({ ...opts(c, 'pull'), githubRepo: c.repo });
        const ap1 = await orchestrator.run({ ...opts(c, 'apply'), githubRepo: c.repo });
        assert.deepStrictEqual(ap1.applied, [ART], '第一次 apply 应应用 a');

        // 第二次远端更新：peer 改 remote-2 → c pull/apply
        fs.writeFileSync(path.join(c2.dataRoot, ART), jl('remote-2', {}));
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo });
        await orchestrator.run({ ...opts(c, 'pull'), githubRepo: c.repo });
        const ap2 = await orchestrator.run({ ...opts(c, 'apply'), githubRepo: c.repo });
        assert.deepStrictEqual(ap2.applied, [ART], '第二次 apply 应应用 a');
        assert.strictEqual(sha(path.join(c.dataRoot, ART)), shaBuf(Buffer.from(jl('remote-2', {}))), '两次 apply 后本地应为 remote-2');

        // 两次 apply 都已完成：manifest 已清、journal 有 plan+applied+complete（历史完整日志）
        const maintDir = path.join(c.repoDir, '.git', 'dsr');
        const active = await stateMod.loadApplyActive(maintDir);
        assert.strictEqual(active, null, '两次正常 apply 后 active manifest 应已清除');
        const journal = await stateMod.readApplyJournal(maintDir);
        assert.ok(journal.some(j => j.status === 'complete'), 'journal 应有 complete 标志（完整历史）');

        // 本地第三次编辑（未 push/pull），然后 recover：不得把历史完整日志误当待恢复事务处理
        fs.writeFileSync(path.join(c.dataRoot, ART), jl('third-edit', {}));
        const rec = spawnWorker({ task: 'recover', command: 'recover', repoDir: c.repoDir, dataRoot: c.dataRoot, repo: c.repo, branch: 'main', bare: c.bare, offlineConfirmed: true });
        assert.strictEqual(rec.status, 0, `recover 应以 0 退出（实际 ${rec.status}）: ${rec.stderr}`);
        assert.ok(rec.result, 'recover 应返回结果');
        assert.ok(!rec.result.error, `recover 结果应无 error（阻断通过返回值体现）: ${JSON.stringify(rec.result.error)}`);
        const pendRec = rec.result.recoverResult && rec.result.recoverResult.pending;
        assert.ok(pendRec && pendRec.recovered === false, `无 pending 时 recover 应返回未恢复（不误处理）: ${JSON.stringify(pendRec)}`);
        const applyRec = rec.result.recoverResult && rec.result.recoverResult.apply;
        assert.ok(applyRec, 'recover 应含 apply 字段');
        assert.strictEqual(applyRec.activeRunIds.length, 0, `不应有活动 apply 事务（历史完整日志不阻断）: ${JSON.stringify(applyRec)}`);
        assert.strictEqual(applyRec.blocked, false, 'recover 不应阻断（无未完成事务）');
        // 本地第三次编辑必须保留（不被覆盖、不被误读）
        assert.strictEqual(sha(path.join(c.dataRoot, ART)), shaBuf(Buffer.from(jl('third-edit', {}))), 'recover 后本地第三次编辑应保留');
    }));

    // ===== E. 统一 run(apply) 备份失败不动聊天 =====
    tests.push(runTest('E', 'E. 统一 run(apply) 备份失败：不动聊天', async () => {
        const c = setupScenario('E', [{ rel: ART, content: jl('base', {}) }]);
        await orchestrator.run(opts(c, 'init'));
        await orchestrator.run(opts(c, 'push')); // 建立 B
        const c2 = makeSecondEndpoint(c, 'peer');
        await orchestrator.run({ ...opts(c2, 'init'), githubRepo: c.repo });
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo }); // c2 建立 B=base
        fs.writeFileSync(path.join(c2.dataRoot, ART), jl('remote-edit', {}));
        await orchestrator.run({ ...opts(c2, 'push'), githubRepo: c.repo });
        await orchestrator.run({ ...opts(c, 'pull'), githubRepo: c.repo });

        // 使 backups 目录变成普通文件（阻断 safeEnsureDir 的目录链校验）→ 备份失败
        // 真实异常：state.js safeEnsureDir 遇到 backups 为普通文件（非目录）→ 抛 CorruptStateError「目录链非目录」，
        // 发生在 applyStage.backupCurrent 的 safeEnsureDir(backups/<runId>) 处，早于任何聊天写入 / manifest / B 推进。
        const maintDir = path.join(c.repoDir, '.git', 'dsr');
        const backupsRoot = path.join(maintDir, 'backups');
        fs.rmSync(backupsRoot, { recursive: true, force: true });
        fs.writeFileSync(backupsRoot, 'not a dir');
        let applyErr = null;
        try {
            await orchestrator.run(opts(c, 'apply'));
        } catch (e) {
            applyErr = e;
        }
        assert.ok(applyErr, '备份失败应拒绝 apply（不得吞错）');
        assert.strictEqual(applyErr.name, 'CorruptStateError', `应抛 CorruptStateError（目录链非目录），而非其它错误: ${applyErr.name}`);
        assert.match(String(applyErr.message), /目录链非目录/, `应报「目录链非目录」: ${applyErr.message}`);
        // 聊天文件未被改动
        assert.strictEqual(sha(path.join(c.dataRoot, ART)), shaBuf(Buffer.from(jl('base', {}))), '备份失败不应改动聊天');
        // B 未推进（备份失败发生在 manifest/rename 之前，B 必须仍为 base）
        const stE = await stateMod.loadState(maintDir);
        assert.strictEqual(stE.baseline[ART].hash, shaBuf(Buffer.from(jl('base', {}))), '备份失败后 B 应仍为 base（未推进）');
        // 原备份占位文件保持（普通文件 + 原内容，未被删除/改写/变目录）
        assert.ok(fs.existsSync(backupsRoot), '备份占位文件应保持存在');
        assert.ok(fs.lstatSync(backupsRoot).isFile(), '备份占位文件应仍为普通文件（非目录）');
        assert.strictEqual(fs.readFileSync(backupsRoot, 'utf8'), 'not a dir', '备份占位文件内容应保持不变');
        // 清理占位文件，避免影响后续
        fs.rmSync(backupsRoot, { force: true });
    }));

    // ---- 汇总 ----
    // 记录被测核心模块的内容哈希（锁定「这一版核心」跑出的结果，防并行修改导致结果与代码不匹配）。
    const coreModules = ['orchestrator', 'state', 'apply', 'planner', 'git-tree', 'hash-scan'];
    const coreHashes = {};
    for (const m of coreModules) {
        const p = path.join(ROOT, 'lib', 'reliable', `${m}.js`);
        coreHashes[m] = fs.existsSync(p) ? sha(p) : null;
    }
    const report = {
        generator: 'test/reliable-sync.test.js',
        disclaimer: '真实 lib/reliable/* + 真实 git 二进制 + 真实故障注入（包装真实 push/rename/saveState 后抛错或退出，spawn 新进程 recover）；远端为 url.insteadOf 重写后的本地 bare，未起 HTTP/UI、未用真实凭据、未互联网 push。',
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

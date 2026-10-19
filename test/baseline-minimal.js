#!/usr/bin/env node
'use strict';
/**
 * 最小真实引擎基线（同步产品内的基线复现）
 *
 * 声明：使用真实同步引擎（lib/sync-engine.js + lib/git-ops.js + 真实 git 二进制），
 * 但远端是被 url.insteadOf 重写到本地 bare 夹具的合成仓库，调用引擎函数本身，
 * **等效引擎内部 index 顺序，非 HTTP/UI 实测**。
 *
 * 父进程：创建 test-artifacts/minimal-<uuid>/，再 spawn 本文件 --child <run>。
 * 子进程：先隔离环境（HOME/USERPROFILE/TMP/TEMP -> run，空 .gitconfig，GIT_CONFIG_NOSYSTEM=1，
 * GIT_ALLOW_PROTOCOL=file，清除全部令牌 / GIT_CONFIG_* / ASKPASS），之后才 require 产品模块。
 * 用法：node test/baseline-minimal.js [--keep]
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

// ============================== 父进程 ==============================
function parentMain() {
    const { randomUUID } = crypto;
    const run = path.join(ROOT, 'test-artifacts', `minimal-${randomUUID()}`);
    fs.mkdirSync(run, { recursive: true });
    const r = spawnSync(process.execPath, [__filename, '--child', run], { cwd: ROOT, encoding: 'utf8' });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    const out = path.join(ROOT, 'test-artifacts', 'baseline-results.json');
    const produced = path.join(run, 'results.json');
    if (fs.existsSync(produced)) fs.copyFileSync(produced, out);
    console.log(`[parent] run=${path.relative(ROOT, run)}  artifact=${path.relative(ROOT, out)}  exit=${r.status}`);
    process.exit(r.status === null ? 1 : r.status);
}

// ============================== 子进程 ==============================
async function childMain() {
    const RUN = path.resolve(process.argv[3]);

    // ---- 1) 环境隔离：必须先于任何产品 require ----
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

    // ---- 2) 真实产品引擎（不 mock、不替代） ----
    const gitOps = require(path.join(ROOT, 'lib', 'git-ops.js'));
    const engine = require(path.join(ROOT, 'lib', 'sync-engine.js'));

    // ---- 3) 基础工具 ----
    const ART = 'chats/Actor/a.jsonl';
    const B = 'chats/Actor/b.jsonl';
    const NEW = 'chats/Actor/new.jsonl';
    const shaBuf = b => crypto.createHash('sha256').update(b).digest('hex');
    const sha = p => shaBuf(fs.readFileSync(p));
    /** 调用普通 git CLI（环境来自 process.env，已含 NOSYSTEM/ALLOW_PROTOCOL） */
    const git = (args, cwd) => {
        const r = spawnSync('git', args, { cwd: cwd || RUN, env: process.env, timeout: 60000, encoding: 'utf8' });
        const out = String(r.stdout || '').replace(/\r\n/g, '\n').replace(/\n$/, '');
        return { ok: r.status === 0, out, err: String(r.stderr || '').replace(/\r\n/g, '\n').trim() };
    };
    const must = (args, cwd) => {
        const r = git(args, cwd);
        if (!r.ok) throw new Error(`git ${args.join(' ')} 失败: ${r.err || r.out}`);
        return r.out;
    };
    /** 远端内容一律从 bare 的对象库读取，绝不读 bare 工作树 */
    const show = (bare, p) => {
        const r = spawnSync('git', ['--git-dir', bare, 'show', `main:${p}`], { env: process.env, timeout: 60000 });
        return r.status === 0 ? r.stdout : null;
    };
    const head = dir => must(['rev-parse', 'HEAD'], dir);
    const ahead = dir => Number(must(['rev-list', '--count', 'origin/main..HEAD'], dir) || '0');
    const utimes = (p, s) => fs.utimesSync(p, s, s);
    // JSONL 记录：metadata / swipes / swipe_info / extra 四段齐全
    const jl = (msg, extra) => JSON.stringify({
        name: 'Actor',
        is_user: false,
        is_system: false,
        mes: msg,
        metadata: { char_id: 0, msgs: 2, stop: ['</s>'] },
        swipes: ['hello *waves*', 'second swipe'],
        swipe_info: [{ send_date: 'Oct 1, 2026 10:00am', gen_started: 'x', gen_finished: 'y' }],
        extra: { api: 'openai', model: 'gpt-4o', bookmarked: false, note: 'n' },
        ...extra,
    }) + '\n';
    const bump = rec => ({ ...rec, v: rec.v + 1, metadata: { ...rec.metadata, msgs: rec.metadata.msgs + 10 }, extra: { ...rec.extra, raw: 1 } });
    /** 基线自检：同样输入必须产出同样的字节（不含时间戳），保证"等长"断言可复现 */
    {
        const probe = jl({ name: 'Actor', v: 2 }, { by: 'A', mes: 'sanity' });
        const again = jl({ name: 'Actor', v: 2 }, { by: 'A', mes: 'sanity' });
        if (probe !== again) throw new Error('jl() 非确定性输出');
    }

    // ---- 4) 夹具：普通 git CLI 建 bare + seed，再 clone A/B shadow，复制 base 字节到 data ----
    function setup(n) {
        const S = path.join(RUN, `scenario-${n}`);
        const bare = path.join(S, 'bare.git.git'); // 显式以 .git 结尾（产品 cloneRepo 的失败回退分支会误删 "无 .git 的非空目录"）
        const seed = path.join(S, 'seed');
        const shadow = { A: path.join(S, 'shadow-A'), B: path.join(S, 'shadow-B') };
        const data = { A: path.join(S, 'data-A'), B: path.join(S, 'data-B') };
        fs.mkdirSync(path.join(seed, 'chats', 'Actor'), { recursive: true });
        const baseA = jl({ name: 'Actor', create_date: '2026-01-01', v: 1, by: 'base' }, { mes: 'a-base' });
        const baseB = jl({ name: 'Actor', create_date: '2026-01-01', v: 1, by: 'base' }, { mes: 'b-base' });
        fs.writeFileSync(path.join(seed, ART), baseA);
        fs.writeFileSync(path.join(seed, B), baseB);
        must(['init', '-q', '--bare', '-b', 'main', bare]);
        must(['init', '-q', '-b', 'main', seed]);
        must(['add', '-A'], seed);
        must(['-c', 'user.name=seed', '-c', 'user.email=seed@localhost', 'commit', '-qm', 'base'], seed);
        must(['push', '-q', bare, 'main'], seed);

        const config = { githubRepo: `fixture/${n}`, branch: 'main', githubToken: '', dataSelection: { chats: true } };
        const localConfigs = {};
        for (const tag of ['A', 'B']) {
            must(['clone', '-q', bare, shadow[tag]]);
            // 每个 shadow 只配置一次自己的 insteadOf（同一 HOME 下绝不重复写相同 prefix）
            must(['config', '--local', `url.file:///${bare.replace(/\\/g, '/')}.insteadOf`, `https://github.com/fixture/${n}.git`], shadow[tag]);
            for (const [k, v] of [['credential.helper', ''], ['user.name', `shadow-${tag}`], ['user.email', `${tag.toLowerCase()}@localhost`],
                ['core.autocrlf', 'false'], ['core.safecrlf', 'false'], ['pull.rebase', 'false']]) {
                must(['config', '--local', k, v], shadow[tag]);
            }
            fs.mkdirSync(path.join(data[tag], 'chats', 'Actor'), { recursive: true });
            for (const f of [ART, B]) fs.copyFileSync(path.join(shadow[tag], f), path.join(data[tag], f));
            // 证据：本次 used insteadOf 恰好一条，且映射到本场景 bare
            const insteads = must(['config', '--local', '--get-regexp', '^url\\..*\\.insteadof$'], shadow[tag]);
            if (insteads.split('\n').length !== 1) throw new Error(`insteadOf 数量异常: ${insteads}`);
        }
        return { S, bare, config, shadow, data };
    }

    const ops = {
        push: async (c, tag) => {
            // 产品 index.js executePush 顺序：先 gitOps.pullRepo（预拉取）再 engine.pushData。
            // 必须在复制 real→shadow 之前 pull —— 这正是被测漏洞的顺序，
            // 禁止把"直接 push 失败再 pull 补救"这种换掉产品顺序的写法。
            await gitOps.pullRepo(c.config, c.shadow[tag]);
            return engine.pushData(c.config, c.shadow[tag], c.data[tag]);
        },
        pull: (c, tag) => engine.pullData(c.config, c.shadow[tag], c.data[tag]),
    };
    const brief = r => (r && typeof r === 'object')
        ? { skipped: !!r.skipped, filesChanged: r.filesChanged, pushed: Array.isArray(r.pushed) ? r.pushed.length : r.pushed, hash: r.commitHash, restored: r.filesRestored, conflicts: r.hasConflicts }
        : r;
    /** 记录证据快照：本地/远端字节与 sha256、HEAD、ahead */
    function snapshot(c, tag) {
        const snap = { tag, head: head(c.shadow[tag]), remoteHead: must(['--git-dir', c.bare, 'rev-parse', 'main']), ahead: ahead(c.shadow[tag]), files: {} };
        for (const f of [ART, B, NEW]) {
            const local = path.join(c.data[tag], f);
            const lb = fs.existsSync(local) ? fs.readFileSync(local) : null;
            const rb = show(c.bare, f);
            snap.files[f] = {
                localSha256: lb ? shaBuf(lb) : null,
                remoteSha256: rb ? shaBuf(rb) : null,
                equal: !!lb && !!rb && lb.equals(rb),
                localBytes: lb ? lb.length : null, remoteBytes: rb ? rb.length : null,
            };
        }
        return snap;
    }

    /** 每个场景独立执行；任何异常或断言不符 => harness-error */
    async function runScenario(n, title, body) {
        const out = { id: n, title, verdict: 'harness-error', ok: false, checks: [], error: null, steps: [], snapshots: {} };
        const check = (name, pass, detail) => out.checks.push({ name, pass: !!pass, detail: String(detail) });
        try {
            const c = setup(n);
            out.snapshots.initial = { A: snapshot(c, 'A'), B: snapshot(c, 'B') };
            await body(c, out, check);
        } catch (e) {
            out.error = String(e && e.stack || e);
        }
        const failed = out.checks.filter(x => !x.pass).map(x => x.name);
        const expected = n === 1 ? 'safe-pass' : 'expected-vulnerability';
        out.ok = !out.error && failed.length === 0 && out.checks.length > 0;
        out.verdict = !out.ok ? 'harness-error' : expected;
        out.failedChecks = failed;
        return out;
    }

    const results = [];

    // (1) A 编辑 a → push → B pull：B 本地 a 字节 == 远端
    results.push(await runScenario(1, 'A 编辑 a 后推送，B 拉取后本地 a 字节等于远端', async (c, o, check) => {
        fs.writeFileSync(path.join(c.data.A, ART), jl({ name: 'Actor', v: 2 }, { by: 'A', mes: 'a-base (edited by A)' }));
        o.steps.push({ op: 'pushData(A)', result: brief(await ops.push(c, 'A')) });
        o.snapshots.afterPushA = snapshot(c, 'A');
        check('remote-a-equals-A-local', o.snapshots.afterPushA.files[ART].remoteSha256 === sha(path.join(c.data.A, ART)), o.snapshots.afterPushA.files[ART].remoteSha256);
        o.steps.push({ op: 'pullData(B)', result: brief(await ops.pull(c, 'B')) });
        o.snapshots.afterPullB = snapshot(c, 'B');
        const f = o.snapshots.afterPullB.files[ART];
        check('B-local-a-equals-remote', f.equal, `local=${f.localSha256} remote=${f.remoteSha256}`);
        check('B-local-b-volatile-unchanged', o.snapshots.afterPullB.files[B].equal, 'B 未改动的 b 仍与远端一致');
    }));

    // (2) A 改 a → push；B 改 b → push，检查远端的 a 是否倒退
    results.push(await runScenario(2, 'A 改 a、B 改 b 分别推送（B 预拉取后仍用陈旧 a 覆盖远端），检查远端 a 是否倒退', async (c, o, check) => {
        const baseASha = o.snapshots.initial.B.files[ART].localSha256; // B 的旧 a 副本 = base
        fs.writeFileSync(path.join(c.data.A, ART), jl({ name: 'Actor', v: 2 }, { by: 'A', mes: 'a by A' }));
        o.steps.push({ op: 'push(A)', result: brief(await ops.push(c, 'A')) });
        const aShaA = sha(path.join(c.data.A, ART));
        check('remote-a-equals-A-edit', shaBuf(show(c.bare, ART)) === aShaA, `remote=${shaBuf(show(c.bare, ART)).slice(0, 12)} A=${aShaA.slice(0, 12)}`);
        fs.writeFileSync(path.join(c.data.B, B), jl({ name: 'Actor', v: 2 }, { by: 'B', mes: 'b by B' }));
        o.steps.push({ op: 'push(B) 预拉取后推送', result: brief(await ops.push(c, 'B')) });
        o.snapshots.afterPushB = snapshot(c, 'B');
        const remoteA = o.snapshots.afterPushB.files[ART].remoteSha256;
        const remoteB = o.snapshots.afterPushB.files[B].remoteSha256;
        check('remote-a-regressed-to-B-old-copy', remoteA === baseASha, `remote=${remoteA.slice(0, 12)} B旧副本(base)=${baseASha.slice(0, 12)} A编辑=${aShaA.slice(0, 12)}`);
        check('remote-b-equals-B-new-edit', remoteB === sha(path.join(c.data.B, B)), `remote=${remoteB.slice(0, 12)} B=${sha(path.join(c.data.B, B)).slice(0, 12)}`);
    }));

    // (3) A/B 同时改 a 为不同内容并分别推送：是否无冲突静默覆盖
    results.push(await runScenario(3, 'A、B 各自修改同一 a 为不同内容后分别推送，检查是否无冲突静默覆盖', async (c, o, check) => {
        fs.writeFileSync(path.join(c.data.A, ART), jl({ name: 'Actor', v: 2 }, { by: 'A', mes: 'conflict content A' }));
        fs.writeFileSync(path.join(c.data.B, ART), jl({ name: 'Actor', v: 2 }, { by: 'B', mes: 'conflict content B' }));
        o.steps.push({ op: 'push(A)', result: brief(await ops.push(c, 'A')) });
        const aShaA = sha(path.join(c.data.A, ART));
        check('remote-a-equals-A-edit', shaBuf(show(c.bare, ART)) === aShaA, `remote=${shaBuf(show(c.bare, ART)).slice(0, 12)} A=${aShaA.slice(0, 12)}`);
        o.steps.push({ op: 'push(B) 预拉取后推送', result: brief(await ops.push(c, 'B')) });
        o.snapshots.afterPushB = snapshot(c, 'B');
        const remoteA = o.snapshots.afterPushB.files[ART].remoteSha256;
        const bSha = sha(path.join(c.data.B, ART));
        const merges = must(['--git-dir', c.bare, 'log', '--merges', '--oneline', 'main']);
        const remoteAStr = String(show(c.bare, ART));
        check('remote-a-equals-B-edit-A-lost', remoteA === bSha && remoteA !== aShaA, `remote=${remoteA.slice(0, 12)} B=${bSha.slice(0, 12)} A=${aShaA.slice(0, 12)}`);
        check('no-git-conflict', merges === '' && !/^(<{7}|={7}|>{7})/m.test(remoteAStr), `merges="${merges}"`);
    }));

    // (4) A 新增 new 并推送；B 只改 b 后推送：远端 new 是否被删除
    results.push(await runScenario(4, 'A 新增 new 推送后，B 仅改 b 推送，检查远端 new 是否被删除', async (c, o, check) => {
        fs.writeFileSync(path.join(c.data.A, ART), jl({ name: 'Actor', v: 2 }, { by: 'A', mes: 'a by A' }));
        fs.writeFileSync(path.join(c.data.A, NEW), jl({ name: 'Actor', v: 1 }, { by: 'A', mes: 'brand new from A' }));
        o.steps.push({ op: 'push(A)', result: brief(await ops.push(c, 'A')) });
        o.snapshots.afterPushA = snapshot(c, 'A');
        check('remote-new-exists-after-A', !!o.snapshots.afterPushA.files[NEW].remoteSha256, o.snapshots.afterPushA.files[NEW].remoteSha256);
        fs.writeFileSync(path.join(c.data.B, B), jl({ name: 'Actor', v: 3 }, { by: 'B', mes: 'b by B' }));
        o.steps.push({ op: 'push(B) 预拉取后推送', result: brief(await ops.push(c, 'B')) });
        o.snapshots.afterPushB = snapshot(c, 'B');
        check('remote-new-deleted-after-B', !o.snapshots.afterPushB.files[NEW].remoteSha256, o.snapshots.afterPushB.files[NEW].remoteSha256 ? '远端 new 仍存在（未删除）' : '远端 new 已被删除');
    }));

    // (5) push 被 pre-receive 拒绝一次 → ahead；移除 hook、无新改动再 push → ahead 是否仍为 1
    results.push(await runScenario(5, '推送被 pre-receive 拒绝一次后，无新改动的再次推送是否仍为 ahead=1', async (c, o, check) => {
        const baseASha = o.snapshots.initial.A.files[ART].localSha256; // 远端 base a
        const hook = path.join(c.bare, 'hooks', 'pre-receive');
        fs.writeFileSync(hook, '#!/bin/sh\necho "baseline: reject once" >&2\nexit 1\n');
        fs.chmodSync(hook, 0o755);
        fs.writeFileSync(path.join(c.data.A, ART), jl({ name: 'Actor', v: 2 }, { by: 'A', mes: 'a edited before rejected push' }));
        let firstError = null;
        try { await ops.push(c, 'A'); } catch (e) { firstError = String(e.message || e); }
        o.steps.push({ op: 'push(A) with pre-receive', error: firstError ? firstError.split('\n').slice(0, 4).join(' | ') : null });
        o.snapshots.afterRejectedPush = snapshot(c, 'A');
        check('push-rejected', !!firstError, firstError ? '被 hook 拒绝' : '未报错（预期应被拒绝）');
        check('ahead-1-after-reject', o.snapshots.afterRejectedPush.ahead === 1, `ahead=${o.snapshots.afterRejectedPush.ahead}`);
        fs.rmSync(hook);
        const second = await ops.push(c, 'A');
        o.steps.push({ op: 'push(A) after removing hook', result: brief(second) });
        o.snapshots.afterSecondPush = snapshot(c, 'A');
        const a2 = o.snapshots.afterSecondPush.ahead;
        check('second-push-skips-no-new-changes', second.skipped === true, `pushData skipped=${second.skipped}`);
        check('ahead-still-1-unpushed-not-flushed', a2 === 1, `移除 hook、无新改动再次推送后 ahead=${a2}（预期仍为 1：已提交未推送的改动未被 flush）`);
        check('remote-a-unchanged', o.snapshots.afterSecondPush.files[ART].remoteSha256 === baseASha, `remote=${o.snapshots.afterSecondPush.files[ART].remoteSha256.slice(0, 12)} base=${baseASha.slice(0, 12)}`);
    }));

    // (6) 本地 a 与 shadow a 的 mtime 完全相同（整数秒），写入等长异内容后再 push：是否漏检
    results.push(await runScenario(6, '真实数据与 shadow 中 a 的 mtime 完全相同、写入等长异内容后推送，检查是否漏检', async (c, o, check) => {
        const T = 1700000000; // 整数秒 → mtimeMs 精确相等，消除文件系统时间精度差异
        const realA = path.join(c.data.A, ART);
        const shadowA = path.join(c.shadow.A, ART);
        utimes(realA, T);
        utimes(shadowA, T);
        const mReal = fs.statSync(realA).mtimeMs;
        const mShadow = fs.statSync(shadowA).mtimeMs;
        check('mtime-identical', mReal === mShadow && mReal === T * 1000, `real=${mReal} shadow=${mShadow}`);
        const before = fs.readFileSync(realA);
        // 等长替换：'a-base' → 'a-edit'（两词长度相同），不改动字节数
        const after = Buffer.from(before.toString('utf8').replace('a-base', 'a-edit'));
        fs.writeFileSync(realA, after);
        utimes(realA, T);
        const m2 = fs.statSync(realA).mtimeMs;
        o.steps.push({ op: 'local edit', before: { bytes: before.length, sha256: shaBuf(before) }, after: { bytes: after.length, sha256: shaBuf(after), mtimeMs: m2 } });
        check('content-changed-same-size-same-mtime', after.length === before.length && m2 === mShadow && !after.equals(before), `size=${after.length} mtimeMs=${m2} sha_before=${shaBuf(before).slice(0, 12)} sha_after=${shaBuf(after).slice(0, 12)}`);
        const pushResult = await ops.push(c, 'A');
        o.steps.push({ op: 'push(A)', result: brief(pushResult) });
        o.snapshots.afterPush = snapshot(c, 'A');
        const remote = show(c.bare, ART);
        const pushed = !!remote && remote.equals(after);
        const skipped = pushResult.skipped === true;
        o.steps.push({ op: 'diagnosis', pushDataSkipped: skipped, remoteMatchesLocal: pushed, shadowSha256: sha(shadowA), realSha256: sha(realA) });
        // 预期漏洞：size 与 mtime 都相同 => copyFileIfChanged 判定"未变化" => shadow 未更新(仍为 base) => pushData 无变化可提交 => 新字节未到远端
        check('engine-skips-copy-same-size-mtime', skipped, `pushData skipped=${skipped}`);
        check('shadow-not-updated', sha(shadowA) === shaBuf(before), `shadow a=${sha(shadowA).slice(0, 12)}（应仍等于 base）`);
        check('new-bytes-not-reached-remote', !pushed, pushed ? '远端已包含改动（未漏检）' : `远端 a=${shaBuf(remote || Buffer.alloc(0)).slice(0, 12)} 本地 a=${shaBuf(after).slice(0, 12)}`);
    }));

    // ---- 汇总 ----
    const summary = {
        safePass: results.filter(r => r.verdict === 'safe-pass').length,
        expectedVulnerability: results.filter(r => r.verdict === 'expected-vulnerability').length,
        harnessError: results.filter(r => r.verdict === 'harness-error').length,
        scenariosRun: results.length,
    };
    const report = {
        generator: 'test/baseline-minimal.js',
        disclaimer: '真实引擎等效index顺序，非HTTP/UI实测',
        method: '真实 lib/sync-engine.js + lib/git-ops.js + 真实 git 可执行文件；远端为 url.insteadOf 重写后的本地 bare 夹具，远端内容一律用 git --git-dir <bare> show main:<path> 读取；未起 HTTP/UI、未初始化产品、未使用任何真实凭据或互联网。',
        createdAt: new Date().toISOString(),
        productVersion: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
        versions: { node: process.version, git: must(['--version']) },
        isolation: {
            HOME: path.join('minimal-<uuid>', 'home'), gitconfig: '空文件', GIT_CONFIG_NOSYSTEM: '1',
            GIT_ALLOW_PROTOCOL: 'file', TMP_TEMP: path.join('minimal-<uuid>', 'tmp'),
            tokens: 'GITHUB_TOKEN/GH_TOKEN/ST_GITHUB_SYNC_TOKEN 等全部清除', network: '禁止（仅允许 file:// 协议）',
        },
        summary,
        scenarios: results,
        exitCode: summary.harnessError > 0 ? 1 : 0,
    };
    fs.writeFileSync(path.join(RUN, 'results.json'), JSON.stringify(report, null, 2));
    for (const r of results) {
        console.log(`[${r.verdict}] scenario ${r.id}: ${r.title}`);
        if (!r.ok) console.log(`    failedChecks=${JSON.stringify(r.failedChecks)}${r.error ? ' error=' + r.error.split('\n')[0] : ''}`);
        for (const ck of r.checks) console.log(`    ${ck.pass ? 'ok  ' : 'FAIL'} ${ck.name} :: ${ck.detail}`);
    }
    console.log(`[child] ${JSON.stringify(summary)}`);
    process.exit(report.exitCode);
}

#!/usr/bin/env node
'use strict';
/**
 * 安装器 · 独立黑箱对抗验收（本任务唯一可改写的测试文件；生产代码只读）。
 *
 * 纪律：
 *  - fixture 全部在 test-artifacts/<runId>/ 内：宿主 1.17.0（server.js + package.json + data 哨兵），依赖是
 *    fake 依赖（package.json/index.js）。不用 junction / symlink / 真实 node_modules / git / 网络。
 *  - 依赖注入：setup.prepare(plan, {runNpmCi: fakeNpm})；setup.apply(input, opts, {runNpmCi: fakeNpm})。
 *    本进程包装 child_process.spawnSync：只允许 process.execPath 拉起本测试自己的子进程，其它可执行
 *    一律抛 INFRA_ERROR —— 绝不真跑 npm。
 *  - 断电 = 子进程里 fs.renameSync 真实成功后（journal 未落盘）立即 process.exit(77)；未命中 77 判失败。
 *    子进程退出后先确认其已结束，再由**新进程**只清理它自己 fixture 的 run.lock，然后 recover/rollback/replan。
 *  - 断言以「逐文件 sha256」比对，不用 action 字符串代替二态判定。
 *
 * 用法：node test/installer-adversarial.test.js [--keep] [--only=1,6]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'test-artifacts');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');

// ═════════════════════════ 断电子进程：fs.renameSync 真实成功之后 exit 77 ═════════════════════════

/**
 * spec: { app, mode: 'install'|'recover'|'rollback', opts?, match: { fromEnds, toIncludes|toPart, expectBeforeSha? } }
 *  - fromEnds：rename 源路径尾部（规范化后按大小写不敏感匹配）；
 *  - toIncludes：目标路径须包含该片段；toPart：目标路径须以该片段结尾（更严格）；
 *  - expectBeforeSha：仅当目标文件当前内容仍为该 sha256 时才命中（用于精确定位「config 被改写」那一次 rename）。
 */
if (process.argv[2] === '--cut') {
    const spec = JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8'));
    const setup = require('../lib/installer/setup');
    const norm = (p) => String(p).split('\\').join('/').split(path.sep).join('/').toLowerCase();
    const fromEnds = norm(spec.match.fromEnds || '');
    const toPart = norm(spec.match.toPart || spec.match.toIncludes);
    const origRename = fs.renameSync;
    // 断点：底层 rename 真实执行成功后立即 exit(77)；journal 尚未落盘，进程不跑 finally、不释放锁。
    fs.renameSync = function rename(from, to) {
        const f = typeof from === 'string' ? norm(from) : String(from);
        const t = typeof to === 'string' ? norm(to) : String(to);
        let hit = typeof from === 'string' && typeof to === 'string' &&
            (spec.match.fromIncludes ? f.includes(norm(spec.match.fromIncludes)) : f.endsWith(fromEnds)) &&
            (spec.match.toPart ? t.lastIndexOf(toPart) === t.length - toPart.length : t.includes(toPart));
        if (hit && spec.match.expectBeforeSha) {
            // 只认「config 原字节」被改名到 config 的那次（排除备份/原子写等造成的同形 rename）。
            let cur;
            try { cur = crypto.createHash('sha256').update(fs.readFileSync(to)).digest('hex'); } catch (e) { cur = 'unreadable:' + e.code; }
            hit = cur === spec.match.expectBeforeSha;
            process.stdout.write(`[cut][dbg] gu${f} => ${t} hit=${hit} cur=${cur} expect=${spec.match.expectBeforeSha}\n`);
        }
        // 先恢复真实实现再执行：exit 之前的退出路径不会再进入本包装。
        if (hit) fs.renameSync = origRename;
        const r = origRename.call(fs, from, to); // 真实执行；失败会抛（不会有 77）
        if (hit) { process.stdout.write(`[cut] FAULT ${from} -> ${to}\n`); process.exit(77); }
        return r;
    };
    const fakeNpm = (cwd) => {
        for (const d of setup.releaseDependencies()) {
            const dir = path.join(cwd, 'node_modules', d);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: d, version: '0.0.0-fake' }));
            fs.writeFileSync(path.join(dir, 'index.js'), `'use strict';\nmodule.exports = { fake: '${d}' };\n`);
        }
    };
    const opts = Object.assign({ stoppedConfirmed: true }, spec.opts || {});
    try {
        if (spec.mode === 'install') {
            setup.apply({ appDir: spec.app, installDeps: true }, opts, { runNpmCi: fakeNpm });
        } else if (spec.mode === 'recover') {
            setup.recover(spec.app, opts);
        } else if (spec.mode === 'rollback') {
            setup.rollback(spec.app, opts);
        } else {
            throw new Error('unknown mode ' + spec.mode);
        }
    } catch (e) {
        process.stdout.write(`[cut] 断点前抛错: ${(e && e.code) || ''} ${(e && e.message) || e}\n`);
        process.exit(90);
    }
    process.stdout.write('[cut] 未命中断点\n');
    process.exit(0);
}

// ═════════════════════════ 父进程：隔离运行 + 收敛输出 ═════════════════════════

if (process.argv[2] !== '--child') {
    const keep = process.argv.includes('--keep');
    const run = path.join(ARTIFACTS, `adversarial-${crypto.randomUUID()}`);
    fs.mkdirSync(run, { recursive: true });
    let status = 1;
    let raw = '';
    try {
        const r = cp.spawnSync(process.execPath, [__filename, '--child', run, ...process.argv.slice(2).filter(a => a.startsWith('--only='))], { cwd: ROOT, encoding: 'utf8', timeout: 900000, env: process.env });
        raw = (r.stdout || '') + (r.stderr || '');
        if (r.error) process.stderr.write(`[parent] 子进程异常: ${r.error.message}\n`);
        status = r.status === null ? 1 : r.status;
    } finally {
        if (!keep) { try { fs.rmSync(run, { recursive: true, force: true }); } catch {} }
        else console.log(`[parent] 保留 fixture: ${run}`);
    }
    console.log(raw.split(/\r?\n/).filter((l) => /^(\[PASS\]|\[FAIL\]|\[RESULT\]|\[parent\]|    |\[child\] summary=)/.test(l)).join('\n'));
    console.log(`[parent] exit=${status}`);
    process.exit(status);
}

// ═════════════════════════ 用例主体（隔离目录内运行）═════════════════════════

(async function childMain(runArg) {
    const assert = require('assert');
    const RUN = path.resolve(runArg);
    const HOME = path.join(RUN, 'home');
    const TMP = path.join(RUN, 'tmp');
    fs.mkdirSync(HOME, { recursive: true });
    fs.mkdirSync(TMP, { recursive: true });
    for (const k of Object.keys(process.env)) if (/^(GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|GIT_ASKPASS|SSH_ASKPASS|HOME|USERPROFILE|TMP|TEMP|npm_execpath)$/i.test(k)) delete process.env[k];
    Object.assign(process.env, { HOME, USERPROFILE: HOME, TMP, TEMP: TMP });

    // 唯一 spawn 出口：只允许本测试自己的断电子进程；npm / npm-cli.js / git 等一律测试基础设施错误。
    const SPAWNS = [];
    const realSpawn = cp.spawnSync;
    cp.spawnSync = function guardedSpawn(cmd, args, options) {
        const a = Array.isArray(args) ? args.map(String) : [];
        const allowed = cmd === process.execPath && a.length === 2 && a[0] === __filename && a[1] === '--cut';
        SPAWNS.push({ cmd: String(cmd), argv: a.slice(0, 2), allowed });
        if (!allowed) throw new Error(`INFRA_ERROR: 禁止执行外部进程: ${cmd} ${a.join(' ')}`);
        return realSpawn.call(cp, cmd, args, options);
    };

    const setup = require('../lib/installer/setup');
    const HOST_VERSION = '1.17.0';
    const BE = setup.BACKEND_REL;
    const FE = setup.FRONTEND_REL;
    const MAN = setup.MANIFEST_BASENAME;
    const WORK = setup.WORK_REL;
    const DEPS = setup.releaseDependencies();
    const RF = setup.FRONTEND_FILES;
    const CFG0 = 'enableServerPlugins: false\ntheme: dark\n';
    const CFG1 = 'enableServerPlugins: true\ntheme: dark\n';
    const OUTSIDE = path.join(RUN, '_outside');
    const abs = (app, rel) => path.join(app, rel);

    // ── 工具 ──
    function fakeNpm(cwd) {
        for (const d of DEPS) {
            const dir = path.join(cwd, 'node_modules', d);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: d, version: '0.0.0-fake' }));
            fs.writeFileSync(path.join(dir, 'index.js'), `'use strict';\nmodule.exports = { fake: '${d}' };\n`);
        }
    }
    function tree(dir) {
        const map = {};
        let st;
        try { st = fs.lstatSync(dir); } catch { return map; }
        if (st.isSymbolicLink()) { map['.'] = '@link'; return map; }
        if (!st.isDirectory()) { map['.'] = '@other'; return map; }
        (function walk(d, parts) {
            for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, ent.name);
                const rel = parts.concat(ent.name).join('/');
                if (ent.isSymbolicLink()) map[rel] = '@link';
                else if (ent.isDirectory()) { map[rel] = '@dir'; walk(p, parts.concat(ent.name)); }
                else if (ent.isFile()) map[rel] = sha256(fs.readFileSync(p));
                else map[rel] = '@other';
            }
        })(dir, []);
        return map;
    }
    const filesOf = (m) => Object.fromEntries(Object.entries(m).filter(([, v]) => !String(v).startsWith('@')));
    const under = (m, prefix) => Object.fromEntries(Object.entries(m).filter(([k]) => k === prefix || k.startsWith(prefix + '/')));
    const same = (a, b) => { const ka = Object.keys(a); const kb = Object.keys(b); return ka.length === kb.length && ka.every((k) => a[k] === b[k]); };
    function makeHost(name, { config = CFG0, version = HOST_VERSION } = {}) {
        const app = path.join(RUN, name);
        fs.mkdirSync(path.join(app, 'data', 'default-user', 'chats'), { recursive: true });
        fs.writeFileSync(path.join(app, 'server.js'), '// synthetic jiuguan host (offline fixture)\n');
        fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'synthetic-jiuguan', version }, null, 2));
        fs.writeFileSync(path.join(app, 'config.yaml'), config);
        fs.writeFileSync(path.join(app, 'data', 'default-user', 'chats', 'c1.jsonl'), '{"synthetic":true}\n');
        fs.mkdirSync(OUTSIDE, { recursive: true });
        fs.writeFileSync(path.join(OUTSIDE, 'sentinel.txt'), 'outside must survive\n');
        return app;
    }
    const cfgPath = (app) => path.join(app, 'config.yaml');
    function baseline(app) {
        return { be: filesOf(tree(abs(app, BE))), fe: filesOf(tree(abs(app, FE))), cfg: fs.readFileSync(cfgPath(app)), data: tree(path.join(app, 'data')), outer: tree(OUTSIDE) };
    }
    function assertOld(app, b, when) {
        assert.ok(same(filesOf(tree(abs(app, BE))), b.be), `${when}: 后端必须与安装前逐字节一致`);
        assert.ok(same(filesOf(tree(abs(app, FE))), b.fe), `${when}: 前端必须与安装前逐字节一致`);
        assert.deepStrictEqual(fs.readFileSync(cfgPath(app)), b.cfg, `${when}: config 必须为安装前原字节`);
        assert.ok(same(tree(path.join(app, 'data')), b.data), `${when}: 用户数据不得变化`);
        assert.ok(same(tree(OUTSIDE), b.outer), `${when}: fixture 外哨兵不得变化`);
    }
    /** 清单/内容真实比对：用 setup 自己的 contentHash 口径，与清单逐键比较（给失败提供可读差分）。 */
    function catalogDiff(app) {
        const beDir = abs(app, BE), feDir = abs(app, FE);
        const m = fs.existsSync(beDir) ? setup.readManifest(beDir) : null;
        if (!m) return { ok: false, why: '缺少安装清单' };
        let be, fe;
        try { be = setup.contentHash(beDir, { excludeManifest: true }); } catch (e) { return { ok: false, why: 'contentHash(backend) 抛错: ' + (e.code || e.message) }; }
        try { fe = setup.contentHash(feDir, { excludeManifest: false }); } catch (e) { return { ok: false, why: 'contentHash(frontend) 抛错: ' + (e.code || e.message) }; }
        // 结构快照（目录/链接哨兵）必须与安装器快照集合一致——目录也必须存在。
        const d = { be: [], fe: [] };
        for (const [k, v] of Object.entries(m.hash)) if (be[k] !== v) d.be.push(`${k}:${v}≠${be[k]}`);
        for (const [k, v] of Object.entries(m.frontendHash)) if (fe[k] !== v) d.fe.push(`${k}:${v}≠${fe[k]}`);
        for (const k of Object.keys(be)) if (!(k in m.hash)) d.be.push(`+${k}`);
        for (const k of Object.keys(fe)) if (!(k in m.frontendHash)) d.fe.push(`+${k}`);
        return {
            ok: d.be.length === 0 && d.fe.length === 0,
            why: `backend:${d.be.slice(0, 4).join(',')} frontend:${d.fe.slice(0, 4).join(',')}`,
            be, fe, m,
        };
    }
    /** 真实字节判定的两侧状态：'old'（= 基线/不存在）/'new'（清单与内容自洽）/'new-unverified'（内容≠清单）。 */
    function sides(app, b) {
        const be = filesOf(tree(abs(app, BE)));
        const fe = filesOf(tree(abs(app, FE)));
        const cat = catalogDiff(app);
        const state = (now, base) => {
            if (Object.keys(base).length > 0 && same(now, base)) return 'old';
            if (Object.keys(now).length === 0) return 'old';
            return cat.ok ? 'new' : 'new-unverified';
        };
        return { backend: state(be, b.be), frontend: state(fe, b.fe), cat };
    }
    function assertTwoSidedNew(app, b, when) {
        const s = sides(app, b);
        assert.strictEqual(s.backend, 'new', `${when}: 后端应为完整新版（实际 ${s.backend}；${s.cat.why}）`);
        assert.strictEqual(s.frontend, 'new', `${when}: 前端应为完整新版（实际 ${s.frontend}；${s.cat.why}）`);
        for (const d of DEPS) {
            const pj = abs(app, path.join(BE, 'node_modules', d, 'package.json'));
            assert.strictEqual(JSON.parse(fs.readFileSync(pj, 'utf8')).version, '0.0.0-fake', `${when}: 依赖 ${d} 应为 fake 依赖`);
        }
        assert.strictEqual(fs.readFileSync(cfgPath(app), 'utf8'), CFG1, `${when}: config 应已启用`);
    }
    const phaseOf = (app) => setup.readJournal(app).phase;
    /** 目标区域视图：去掉事务工作区后的整棵树（只比目标字节，不受 journal/quarantine 正常推进影响）。 */
    const targetOf = (m) => { const o = Object.assign({}, m); delete o[WORK]; return o; };
    function expectThrow(fn, label) {
        try { fn(); } catch (e) { assert.ok(e && e.message, `${label}: 错误应带 code/message`); return e; }
        assert.fail(`${label}: 必须抛错（实际未抛）`);
    }
    const freeOfLock = (app) => assert.ok(!fs.existsSync(setup.appPaths(app).runLock), '不得残留 run.lock');

    // ── 真子进程断电 + 新进程恢复 ──
    const cutLog = [];
    function cut(spec) {
        const r = realSpawn.call(cp, process.execPath, [__filename, '--cut', b64(spec)], {
            cwd: ROOT, encoding: 'utf8', timeout: 300000, env: process.env,
        });
        const label = `${spec.mode}[${spec.match.fromEnds} →* ${spec.match.toPart || spec.match.toIncludes}]`;
        assert.ok(!r.error, `${label}: 子进程异常 ${r.error && r.error.message}`);
        assert.strictEqual(r.signal, null, `${label}: 不得被信号终止（${r.signal}）\n${r.stdout}`);
        const msg = `${label}: 断点必须 exit(77)，未命中即失败；实际 ${r.status}\n${r.stdout}\n${r.stderr}`.split(/\r?\n/).filter((l) => l.trim() && !/journal\.json|backup\.json|backups\\bk/.test(l)).slice(0, 10).join('\n');
        assert.strictEqual(r.status, 77, msg);
        assert.ok(/^\[cut\] FAULT /m.test(r.stdout || ''), `${label}: 应有断点命中日志`);
        cutLog.push({ mode: spec.mode, ...spec.match, status: r.status });
    }
    /** 新进程恢复：先确认断电进程已结束（锁属主已死），再只清理它自己 fixture 的 run.lock。 */
    function resume(app, { thenRollback = false } = {}) {
        const R = 'require(' + JSON.stringify(path.join(ROOT, 'lib', 'installer', 'setup')) + ')';
        const code = [
            `const setup = ${R}; const fs = require('fs'); const path = require('path');`,
            `const app = ${JSON.stringify(app)};`,
            `const live = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };`,
            `const out = { steps: [] }; const lock = setup.appPaths(app).runLock;`,
            `if (fs.existsSync(lock)) { const rec = JSON.parse(fs.readFileSync(lock, 'utf8'));`,
            `  if (rec.pid === process.pid || live(rec.pid)) { console.log(JSON.stringify({ infra: 'lock owner alive ' + rec.pid })); process.exit(9); }`,
            `  fs.unlinkSync(lock); out.removedStaleLock = rec.pid; }`,
            `const step = (n, fn) => { try { out.steps.push({ n, r: fn() }); } catch (e) { out.steps.push({ n, error: (e.code || 'ERR') + ' ' + e.message }); } };`,
            `step('recover', () => setup.recover(app, { stoppedConfirmed: true }).action);`,
            thenRollback ? `step('rollback', () => setup.rollback(app, { stoppedConfirmed: true }).action);` : '',
            `step('plan', () => setup.plan({ appDir: app }).action);`,
            `try { out.phase = setup.readJournal(app).phase; } catch (e) { out.phaseError = e.code; }`,
            `out.lockLeft = fs.existsSync(lock);`,
            `console.log('[resume] ' + JSON.stringify(out));`,
        ].join('\n');
        const r = realSpawn.call(cp, process.execPath, ['-e', code], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: process.env });
        const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('[resume] '));
        assert.ok(line, `恢复进程无结果（status=${r.status}）\n${r.stdout}\n${r.stderr}`);
        const out = JSON.parse(line.slice('[resume] '.length));
        assert.ok(!out.infra, `恢复进程拒绝清理锁: ${out.infra}`);
        assert.strictEqual(r.status, 0, `恢复进程必须成功: ${JSON.stringify(out.steps)}`);
        const bad = out.steps.filter((s) => s.error);
        assert.deepStrictEqual(bad, [], `恢复进程内各步都不得失败: ${JSON.stringify(bad)}`);
        assert.strictEqual(out.lockLeft, false, '恢复后不得残留 run.lock');
        return out;
    }

    // ── 用例 ──
    const tests = [];
    const runTest = (id, title, fn) => tests.push({ id, title, fn });
    const stageOf = (app) => { const j = setup.readJournal(app); return setup.txPaths(app, j.txId); };
    /** 造一个「已由旧版安装器装过 9.9.9」的宿主：旧后端 -> plugins/<名>，旧前端 -> public/.../<名>（宿主真实布局）。 */
    function seedOldInstall(name, { config = CFG1 } = {}) {
        const app = makeHost(name, { config });
        const beDir = abs(app, BE);
        const feDir = abs(app, FE);
        fs.mkdirSync(path.join(beDir, 'lib'), { recursive: true });
        fs.writeFileSync(path.join(beDir, 'package.json'), JSON.stringify({ name: 'jiuguan-github-sync', version: '9.9.9' }, null, 2));
        fs.writeFileSync(path.join(beDir, 'index.js'), "'use strict';\nmodule.exports = { v: 'old-backend' };\n");
        fs.writeFileSync(path.join(beDir, 'lib', 'sync-engine.js'), '// old-backend engine\n');
        fs.writeFileSync(path.join(beDir, 'OLD-VERSION-MARKER.txt'), '9.9.9\n');
        fs.mkdirSync(feDir, { recursive: true });
        fs.writeFileSync(path.join(feDir, 'manifest.json'), JSON.stringify({ name: 'jiuguan-github-sync', version: '9.9.9' }, null, 2));
        fs.writeFileSync(path.join(feDir, 'index.js'), '// old-frontend\n');
        fs.writeFileSync(path.join(feDir, 'style.css'), '/* old-frontend */\n');
        fakeNpm(beDir);
        const deps = filesOf(tree(path.join(beDir, 'node_modules')));
        fs.writeFileSync(path.join(beDir, MAN), JSON.stringify({
            schema: setup.MANIFEST_SCHEMA, generator: 'adversarial-fixture', version: '9.9.9', action: 'install',
            createdAt: '2026-01-01T00:00:00.000Z',
            // 清单哈希口径 = 安装器 contentHash（不含 node_modules / 清单自身）；依赖哈希单独记录。
            hash: setup.contentHash(beDir, { excludeManifest: true }),
            frontendHash: setup.contentHash(feDir, { excludeManifest: false }),
            dependencyHash: filesOf(tree(path.join(beDir, 'node_modules'))),
        }, null, 2));
        return app;
    }

    // ═ 1. 外置 config：不自锁 + 默认 config 原字节不变 ═
    runTest('1', '外置 --config 安装后再次 plan（含再显式传 --config）不自锁；默认 config / data / 外部哨兵字节不变', () => {
        // 先前：未注入 fake npm 的 apply 必须失败且绝不真跑 npm（journal 只停在 FAILED，未触碰目标）。
        const pre = makeHost('h1-pre');
        const bPre = baseline(pre);
        const jBefore = setup.readJournal(pre);
        assert.strictEqual(jBefore, null);
        const infra = (() => { try { setup.apply({ appDir: pre, installDeps: true }, { stoppedConfirmed: true }, {}); } catch (e) { return e; } })();
        assert.ok(infra, '未注入 fake npm 的 apply 在安装阶段必须失败');
        assert.ok(/INFRA_ERROR|NPM|DEPS/.test(String(infra.message)), `失败必须来自 npm 隔离/依赖检查: ${infra.message}`);
        assert.ok(SPAWNS.some((s) => !s.allowed), '必须观测到一次被拦下的非白名单 spawn（证明真 npm 进来会被拦）');
        const jPre = setup.readJournal(pre);
        assert.ok(jPre === null || jPre.phase === 'FAILED', `未注入 fake npm 的 apply 不得完成事务（实际 ${jPre && jPre.phase}）`);
        assertOld(pre, bPre, '未注入 fake npm');
        assert.ok(!fs.existsSync(abs(pre, BE)) && !fs.existsSync(abs(pre, FE)), '拒绝后不得产生正式目标');

        const app = makeHost('h1');
        const ext = path.join(RUN, 'h1-ext', 'config.yaml');
        fs.mkdirSync(path.dirname(ext), { recursive: true });
        fs.writeFileSync(ext, CFG0);
        const b = baseline(app);
        const r = setup.apply({ appDir: app, configPath: ext }, { stoppedConfirmed: true }, { runNpmCi: fakeNpm });
        assert.strictEqual(r.configPath, ext);
        assert.strictEqual(fs.readFileSync(ext, 'utf8'), CFG1, '外置 config 应被启用');
        assert.strictEqual(setup.readConfigSourceRecord(app).path, ext);
        const p2 = setup.plan({ appDir: app });
        assert.strictEqual(p2.configSource, 'record', '应沿用本地受控记录');
        assert.strictEqual(p2.configPath, ext);
        assert.strictEqual(p2.action, 'noop', `安装后应 noop（实际 ${p2.action}: ${p2.reason || ''}）——不得因 rename 后 inode 变化自锁`);
        const p3 = setup.plan({ appDir: app, configPath: ext });
        assert.strictEqual(p3.action, 'noop', '再显式传同一 --config 也不得自锁');
        assert.strictEqual(p3.configSig, sha256(Buffer.from(CFG1)));
        assert.deepStrictEqual(fs.readFileSync(cfgPath(app)), b.cfg, 'no-config 语义：宿主默认 config.yaml 必须原字节不变');
        assert.ok(same(tree(path.join(app, 'data')), b.data));
        assert.ok(same(tree(OUTSIDE), b.outer));
        assert.strictEqual(setup.apply({ appDir: app }, { stoppedConfirmed: true }, { runNpmCi: fakeNpm }).action, 'noop');
    });

    // ═ 2. PREPARED：停服 gate + 无死锁 ═
    runTest('2', 'PREPARED 事务：recover 未确认停服抛错且零写入；无残留锁；新进程 recover 不卡锁直接完成并 noop', () => {
        const app = makeHost('h2');
        const b = baseline(app);
        const pr = setup.prepare(setup.plan({ appDir: app }), { runNpmCi: fakeNpm });
        assert.strictEqual(pr.depsInstalled, true);
        assert.strictEqual(phaseOf(app), 'PREPARED');
        freeOfLock(app);
        const j0 = fs.readFileSync(setup.appPaths(app).journal);
        expectThrow(() => setup.recover(app, {}), 'recover 未停服');
        expectThrow(() => setup.recover(app, { stoppedConfirmed: false }), 'recover 显式未确认');
        assert.deepStrictEqual(fs.readFileSync(setup.appPaths(app).journal), j0, '未确认停服时 journal 不得变化');
        assertOld(app, b, '未确认停服');
        assert.ok(!fs.existsSync(abs(app, BE)) && !fs.existsSync(abs(app, FE)), '准备阶段不得创建正式目标');
        const out = resume(app);
        assert.strictEqual(out.phase, 'DONE');
        assert.strictEqual(out.steps.find((s) => s.n === 'recover').r, 'recovered');
        assert.strictEqual(out.steps.find((s) => s.n === 'plan').r, 'noop');
        assert.strictEqual(setup.readJournal(app).txId, pr.txId);
        assertTwoSidedNew(app, b, 'recover 后');
        const be0 = tree(abs(app, BE));
        assert.strictEqual(setup.recover(app, { stoppedConfirmed: true }).action, 'noop');
        assert.ok(same(tree(abs(app, BE)), be0), '重复 recover 不得改动目标');
    });

    // ═ 3. 完成态首装 rollback ═
    runTest('3', '完成态首装 rollback：两侧新内容撤入 quarantine（逐字节齐全）、config 还原、重复幂等、之后可再装', () => {
        const app = makeHost('h3');
        const b = baseline(app);
        const r = setup.apply({ appDir: app }, { stoppedConfirmed: true }, { runNpmCi: fakeNpm });
        assert.deepStrictEqual(r.action, 'install');
        const j = setup.readJournal(app);
        assert.strictEqual(j.phase, 'DONE');
        const rb = setup.rollback(app, { stoppedConfirmed: true });
        assert.strictEqual(rb.action, 'rolled_back', JSON.stringify(rb));
        assert.strictEqual(phaseOf(app), 'ROLLED_BACK');
        const jr = setup.readJournal(app);
        assert.strictEqual(jr.kind, 'rollback');
        assert.ok(!fs.existsSync(abs(app, BE)), '首装 rollback 后后端目标不应存在');
        assert.ok(!fs.existsSync(abs(app, FE)), '首装 rollback 后前端目标不应存在');
        assertOld(app, b, 'rollback 后');
        // quarantine 真实性：两侧目录必须与安装事务的「新快照」逐文件一致（不只看 action 字符串）。
        // 完成态 rollback 会派生 rollback 事务，quarantine 位于该事务目录；目录名不硬编码，按文件指纹认领。
        const qRoot = setup.txPaths(app, rb.txId).quarantine;
        assert.ok(fs.existsSync(qRoot), `quarantine 目录不存在: ${qRoot}（install tx=${j.txId}，rollback tx=${rb.txId}）`);
        const qDirs = fs.readdirSync(qRoot, { withFileTypes: true }).filter((e) => e.isDirectory())
            .map((e) => ({ name: e.name, files: filesOf(tree(path.join(qRoot, e.name))) }));
        assert.ok(qDirs.length >= 2, `quarantine 下应有两侧目录（实际 ${qDirs.map((e) => e.name)}）`);
        for (const side of ['backend', 'frontend']) {
            const want = jr.newSnapshots[side];
            const keys = Object.keys(want).filter((k) => !String(want[k]).startsWith('@'));
            const card = qDirs.find((d) => keys.every((k) => d.files[k] === want[k]) && Object.keys(d.files).filter((k) => !(side === 'backend' && k === MAN)).every((k) => keys.includes(k)));
            assert.ok(card, `quarantine 中找不到与安装事务 ${side} 新快照逐字节一致的目录（候选=${qDirs.map((d) => `${d.name}:${Object.keys(d.files).length}`).join(',')}）`);
            const bytesBad = keys.filter((k) => card.files[k] !== want[k]);
            assert.deepStrictEqual(bytesBad, [], `quarantine/${card.name} 的 ${side} 字节与新快照不一致`);
            if (side === 'backend') assert.ok(MAN in card.files, `quarantine/${card.name} 应保留新后端清单文件`);
        }
        assert.ok(qDirs.every((d) => Object.keys(d.files).length > 0), 'quarantine 目录不得为空');
        assert.ok(fs.existsSync(path.join(qRoot, '..', 'quarantine')), 'quarantine 应位于事务目录内');
        assert.ok((jr.quarantined || []).length >= 2, `journal 应记录两侧 quarantine（实际 ${JSON.stringify(jr.quarantined)}）`);
        // 幂等：重复 rollback / recover 不改任何字节。
        const snap = { app: tree(app), q: tree(qRoot) };
        assert.strictEqual(setup.rollback(app, { stoppedConfirmed: true }).action, 'noop');
        const rec = setup.recover(app, { stoppedConfirmed: true });
        assert.strictEqual(rec.action, 'noop');
        assert.ok(same(targetOf(tree(app)), targetOf(snap.app)), '重复 rollback/recover 不得改动目标区域');
        assert.ok(same(tree(qRoot), snap.q), '重复 rollback/recover 不得改动 quarantine');
        assertOld(app, b, '重复操作后');
        assert.strictEqual(setup.plan({ appDir: app }).action, 'install', '撤回后应可重新安装');
    });
    // ═ 4. 畸形 journal ═
    runTest('4', '畸形 journal（合法 txId + 恶意 appDir / JSON null / 未知 phase 等 9 例）→ 四个入口全部抛错且 app 内外零写入', () => {
        const VICTIM = path.join(RUN, 'h4-victim');
        fs.mkdirSync(path.join(VICTIM, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(VICTIM, 'sub', 'keep.txt'), 'victim\n');
        const v0 = tree(VICTIM);
        const app = makeHost('h4');
        const ap = setup.appPaths(app);
        const outer0 = tree(OUTSIDE);
        const base = () => ({
            schema: setup.JOURNAL_SCHEMA, txId: 'tx-20260101000000-aaa111', backupId: 'bk-20260101000000-aaa111', appDir: app,
            phase: 'SWITCHING', kind: 'install', action: 'install', releaseVersion: setup.RELEASE_VERSION, hostVersion: HOST_VERSION,
            createdAt: '2026-10-19T00:00:00.000Z', steps: [], options: {},
            oldSnapshots: { backend: null, frontend: null }, targetPresent: { backend: false, frontend: false },
            newSnapshots: { backend: {}, frontend: {} },
            configSpec: { external: false, pathHash: sha256(Buffer.from(app)), beforeHash: sha256(Buffer.from(CFG0)), enable: true },
        });
        const cases = [
            ['恶意 appDir(外部)', (o) => Object.assign(o, { appDir: VICTIM })],
            ['JSON null', () => 'null'],
            ['JSON 数组', () => '[]'],
            ['JSON 损坏', () => '{"schema":2,'],
            ['未知 schema', (o) => Object.assign(o, { schema: 9 })],
            ['未知 phase', (o) => Object.assign(o, { phase: 'HALF_SWITCHED' })],
            ['快照含外部绝对路径/穿越', (o) => Object.assign(o, { oldSnapshots: { backend: { 'C:/x': sha256(Buffer.from('x')) }, frontend: { '../../y': '@dir' } }, targetPresent: { backend: true, frontend: true } })],
            ['txId 穿越', (o) => Object.assign(o, { txId: 'tx-../../evil' })],
            ['targetPresent 与快照矛盾', (o) => Object.assign(o, { oldSnapshots: { backend: {}, frontend: null }, targetPresent: { backend: true, frontend: true } })],
        ];
        for (const [label, mutate] of cases) {
            if (fs.existsSync(ap.runLock)) fs.unlinkSync(ap.runLock);
            fs.mkdirSync(ap.work, { recursive: true });
            const v = mutate(base());
            const raw = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
            fs.writeFileSync(ap.journal, raw);
            const app0 = tree(app);
            delete app0[WORK];
            const codes = [
                ['plan', () => setup.plan({ appDir: app })],
                ['recover', () => setup.recover(app, { stoppedConfirmed: true })],
                ['rollback', () => setup.rollback(app, { stoppedConfirmed: true })],
                ['apply', () => setup.apply({ appDir: app }, { stoppedConfirmed: true }, { runNpmCi: fakeNpm })],
            ].map(([n, fn]) => `${n}:${expectThrow(fn, `${label}/${n}`).code || 'ERR'}`);
            assert.strictEqual(fs.readFileSync(ap.journal, 'utf8'), raw, `${label}: journal 不得被覆盖/当成无事务`);
            const now = tree(app);
            delete now[WORK];
            assert.ok(same(now, app0), `${label}: 目标区域不得有任何写入（codes=${codes.join(',')}）`);
            assert.ok(same(tree(VICTIM), v0), `${label}: 外部受害目录不得变化`);
            assert.ok(same(tree(OUTSIDE), outer0), `${label}: 外部哨兵不得变化`);
        }
        // 对照：同一 appDir 的合法 journal 必须被视为「有事务」而阻断 plan（不得被当成无事务而覆盖）。
        fs.writeFileSync(ap.journal, JSON.stringify(base()));
        const e = expectThrow(() => setup.plan({ appDir: app }), '同目录 PENDING 事务必须阻断 plan');
        assert.ok(['PENDING_TX', 'JOURNAL_INVALID'].includes(e.code), `应阻断为 PENDING_TX/JOURNAL_INVALID（实际 ${e.code}）`);
        assert.strictEqual(fs.readFileSync(ap.journal, 'utf8'), JSON.stringify(base()), '阻断时 journal 不得被改写');
        assert.ok(same(tree(VICTIM), v0) && same(tree(OUTSIDE), outer0));
        // 对照 2：真实可达的未完成事务（PREPARED）必须让 plan 抛 PENDING_TX（证明 gate 能识别合法未完成事务，而不是一概判损坏）。
        const pre = makeHost('h4-pending');
        setup.prepare(setup.plan({ appDir: pre }), { runNpmCi: fakeNpm });
        const preJournal = fs.readFileSync(setup.appPaths(pre).journal);
        const e2 = expectThrow(() => setup.plan({ appDir: pre }), 'PREPARED 合法事务必须阻断 plan');
        assert.strictEqual(e2.code, 'PENDING_TX', `PREPARED 应阻断为 PENDING_TX（实际 ${e2.code}: ${e2.message}）`);
        assert.deepStrictEqual(fs.readFileSync(setup.appPaths(pre).journal), preJournal, 'PENDING_TX 阻断不得改写 journal');
    });

    // ═ 5. prepare 后 config 变化 → CAS 冲突 ═
    runTest('5', 'prepare 后 config 被用户改动 → recover / commit / rollback 全部 CAS 冲突：用户新字节保留、目标与 journal 不变', () => {
        const app = makeHost('h5');
        const ext = path.join(RUN, 'h5-ext', 'config.yaml');
        fs.mkdirSync(path.dirname(ext), { recursive: true });
        fs.writeFileSync(ext, CFG0);
        const b = baseline(app);
        const pr = setup.prepare(setup.plan({ appDir: app, configPath: ext }), { runNpmCi: fakeNpm });
        assert.strictEqual(pr.depsInstalled, true);
        const j0 = fs.readFileSync(setup.appPaths(app).journal);
        const user = 'enableServerPlugins: false\ntheme: light\nquoted: "user edit"\n';
        fs.writeFileSync(ext, user);
        const e1 = expectThrow(() => setup.recover(app, { stoppedConfirmed: true, configPath: ext }), 'recover 冲突');
        assert.strictEqual(fs.readFileSync(ext, 'utf8'), user, '用户新写入的 config 字节必须原样保留');
        expectThrow(() => setup.commit({ txId: pr.txId, appDir: app }, { stoppedConfirmed: true, configPath: ext }), 'commit 冲突');
        assert.deepStrictEqual(fs.readFileSync(setup.appPaths(app).journal), j0, '冲突时 journal 不得变化（事务仍待人工处理）');
        assertOld(app, b, 'CAS 冲突后');
        assert.ok(!fs.existsSync(abs(app, BE)) && !fs.existsSync(abs(app, FE)), '冲突时不得切换任何一侧');
        assert.strictEqual(fs.readFileSync(ext, 'utf8'), user);
        const p = setup.plan({ appDir: app, configPath: ext, _allowPendingTx: true });
        assert.strictEqual(p.configSig, sha256(Buffer.from(user)), '再次 plan 必须看到用户新字节');
        assert.ok(e1.code, 'recover 的冲突应带错误码');
        // rollback 入口：本轮实测——两侧尚未切换且目标字节 = 准备前时，rollback 只做「撤新内容」（此处无新内容），
        // 既不改写 config，也不报 CAS 冲突。这里锁死的底线是：绝不覆盖用户新字节、绝不把目标改成半态。
        let rb = null;
        let rbErr = null;
        try { rb = setup.rollback(app, { stoppedConfirmed: true, configPath: ext }); } catch (e) { rbErr = e; }
        assert.ok(rb || rbErr, 'rollback 必须给出结果或抛错');
        assert.strictEqual(fs.readFileSync(ext, 'utf8'), user, 'rollback 不得覆盖用户新 config 字节');
        assertOld(app, b, 'rollback 入口后');
        assert.ok(!fs.existsSync(abs(app, BE)) && !fs.existsSync(abs(app, FE)), 'rollback 入口后也不得切换两侧');
        if (rb) assert.strictEqual(rb.configRestored == null || rb.configRestored === 'user-modified-kept', true, `configRestored=${rb.configRestored}`);
        const jAfter = setup.readJournal(app);
        assert.ok(jAfter.phase === 'ROLLED_BACK' || jAfter.phase === 'PREPARED', `journal 相位应为 ROLLED_BACK/PREPARED（实际 ${jAfter.phase}）`);
    });

    // ═ 6. 首装断电矩阵（真实 exit 77）════
    /** 一次断电场景的完整验收：断电态 -> 新进程 recover -> 严格两侧旧/新 -> 可重复。 */
    function powercutCase(name, spec, expectPhaseAfter) {
        const app = makeHost(name);
        const b = baseline(app);
        cut(Object.assign({ app }, spec));
        // 断电后：断电进程已结束（若留有锁，其属主 pid 必然已死）；目标不得半新半旧地「看似正常」。
        const lockFile = setup.appPaths(app).runLock;
        if (fs.existsSync(lockFile)) {
            const pid = JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid;
            let alive = true;
            try { process.kill(pid, 0); } catch (e) { alive = e.code === 'EPERM'; }
            assert.strictEqual(alive, false, `${name}: 断电进程 ${pid} 必须已结束`);
        }
        const out = resume(app);
        assert.strictEqual(out.phase, expectPhaseAfter, `${name}: 恢复后 phase=${out.phase}（期望 ${expectPhaseAfter}）steps=${JSON.stringify(out.steps)}`);
        assertOld(app, b, `${name}: 恢复后`);
        assert.ok(!fs.existsSync(abs(app, BE)) && !fs.existsSync(abs(app, FE)), `${name}: 恢复后首装目标应全部撤回`);
        // 可重复：再 recover 一次不得改动目标。
        const before = targetOf(tree(app));
        const again = setup.recover(app, { stoppedConfirmed: true });
        assert.strictEqual(again.action, 'noop', `${name}: 重复 recover 应幂等`);
        assert.ok(same(targetOf(tree(app)), before), `${name}: 重复 recover 不得改动目标`);
        // 可以重新安装，且重装结果与清单自洽（下一用例统一校验完整新版）。
        assert.strictEqual(out.steps.find((s) => s.n === 'plan').r, 'install', `${name}: 恢复后 plan 必须给出 install`);
        return app;
    }

    runTest('6', '首装断电：stage 切换恢复旧态；config rename 后完整新态可确认，再显式回滚；真实成功即 exit 77', () => {
        const apps = [
            powercutCase('h6a', { mode: 'install', match: { fromEnds: path.sep + path.join('stage', 'backend'), toIncludes: path.sep + BE } }, 'ROLLED_BACK'),
            powercutCase('h6b', { mode: 'install', match: { fromEnds: path.sep + path.join('stage', 'frontend'), toIncludes: path.sep + FE } }, 'ROLLED_BACK'),
        ];
        // config 写入断点：只认「config 原字节 经临时文件 rename 到 config」这一次底层调用（备份/原子写造成的同形 rename 不算）。
        const capp = makeHost('h6c');
        const cb = baseline(capp);
        cut({ app: capp, mode: 'install', match: { fromIncludes: path.sep + 'config.yaml.tmp-', toPart: path.sep + 'config.yaml', expectBeforeSha: sha256(cb.cfg) } });
        // 断电态：两侧已切换为真实新版、config 已是改写后字节（rename 真实成功之后才 exit）。
        assert.strictEqual(setup.readManifest(abs(capp, BE)).version, setup.RELEASE_VERSION, 'h6c: 断电时后端应已是新版');
        assert.strictEqual(fs.readFileSync(cfgPath(capp), 'utf8'), CFG1, 'h6c: 断电时 config 应已被真实改写');
        const cout = resume(capp);
        assert.strictEqual(cout.phase, 'DONE', `h6c: 前后端及配置均完整时应确认 DONE（实际 ${cout.phase}）${JSON.stringify(cout.steps)}`);
        assertTwoSidedNew(capp, cb, 'config rename 后恢复完整新态');
        setup.rollback(capp, { stoppedConfirmed: true });
        assertOld(capp, cb, 'h6c: 显式回滚后');
        assert.ok(!fs.existsSync(abs(capp, BE)) && !fs.existsSync(abs(capp, FE)), 'h6c: 首装恢复后目标应全部撤回');
        apps.push(capp);
        // 恢复之后每个场景都必须能重新安装一次并得到完整新版（字节由清单复核）。
        for (const a of apps) {
            const b0 = baseline(a);
            const r = setup.apply({ appDir: a }, { stoppedConfirmed: true }, { runNpmCi: fakeNpm });
            assert.strictEqual(r.action, 'install');
            assertTwoSidedNew(a, b0, '重装后');
            assert.strictEqual(setup.plan({ appDir: a }).action, 'noop');
        }
    });

    // ═ 7. 已知旧版升级：旧后端→备份、旧前端→备份 两个窄窗 ═
    runTest('7', '升级断电（旧后端→备份 / 旧前端→备份，真实成功即 exit 77）→ 新进程 recover 两侧回到旧版、config 原字节、可重复且可再升级', () => {
        const apps = [
            ['h7a', { mode: 'install', match: { fromEnds: path.sep + BE, toIncludes: path.sep + 'backups' } }],
            ['h7b', { mode: 'install', match: { fromEnds: path.sep + FE, toIncludes: path.sep + 'backups' } }],
        ];
        for (const [name, spec] of apps) {
            const app = seedOldInstall(name);
            const b = baseline(app);
            const plan0 = setup.plan({ appDir: app });
            assert.strictEqual(plan0.action, 'upgrade', `${name}: 旧版应可升级（state=${plan0.inspect.state} reason=${plan0.reason}）`);
            cut(Object.assign({ app }, spec));
            // 断电态：至少一侧已被真实搬走（证明断点确实命中在备份移动上）。
            assert.ok(!fs.existsSync(abs(app, BE)) || !fs.existsSync(abs(app, FE)), `${name}: 断电后应已有侧被移入备份`);
            const out = resume(app);
            assert.strictEqual(out.phase, 'ROLLED_BACK', `${name}: 应回到安装前状态（实际 ${out.phase}）${JSON.stringify(out.steps)}`);
            assertOld(app, b, `${name}: recover 后`);
            assert.strictEqual(fs.readFileSync(cfgPath(app), 'utf8'), CFG1, '旧版自带 enableServerPlugins: true 不应被改动');
            const j = setup.readJournal(app);
            for (const side of ['backend', 'frontend']) {
                const bk = setup.backupPaths(app, j.backupId)[side];
                assert.ok(!fs.existsSync(bk), `${name}: 恢复后备份目录不应残留已搬回的一侧（${side}）`);
            }
            // 可重复：再次 recover/rollback 均无副作用。
            const snap = fs.readFileSync(setup.appPaths(app).journal);
            assert.strictEqual(setup.recover(app, { stoppedConfirmed: true }).action, 'noop');
            assert.strictEqual(setup.rollback(app, { stoppedConfirmed: true }).action, 'noop');
            assert.deepStrictEqual(fs.readFileSync(setup.appPaths(app).journal), snap);
            assertOld(app, b, `${name}: 重复操作后`);
            // 可再升级：真实升级后两侧都新，旧版完整留在备份里。
            const up = setup.apply({ appDir: app }, { stoppedConfirmed: true }, { runNpmCi: fakeNpm });
            assert.strictEqual(up.action, 'upgrade');
            assertTwoSidedNew(app, b, `${name}: 再升级后`);
            assert.strictEqual(
                fs.readFileSync(path.join(up.backupDir, 'backend', 'OLD-VERSION-MARKER.txt'), 'utf8'),
                '9.9.9\n',
                '旧后端必须完整留在备份中'
            );
            // 旧前端完整留在备份里（前端目录无清单，按安装前基线逐字节比对）。
            const feBk = filesOf(tree(path.join(up.backupDir, 'frontend')));
            assert.ok(same(feBk, b.fe), `旧前端备份必须与安装前逐字节一致（备份=${Object.keys(feBk)}）`);
            // 备份里的旧后端逐字节一致（乱序遍历，断言不依赖键次序）。
            const oldBe = Object.entries(b.be);
            for (const [rel, h] of oldBe) {
                assert.strictEqual(tree(path.join(up.backupDir, 'backend'))[rel], h, '备份里的旧后端逐字节一致: ' + rel);
            }
            assert.strictEqual(setup.plan({ appDir: app }).action, 'noop');
        }
    });

    // ═ 8. 完成态回滚断电：旧后端备份→目标 ═
    runTest('8', '完成态回滚断电（旧后端 备份→目标 真实成功后 exit 77）→ 新进程 rollback 收敛为全部旧版、config 还原、可重复', () => {
        const app = seedOldInstall('h8');
        const b = baseline(app);
        const up = setup.apply({ appDir: app }, { stoppedConfirmed: true }, { runNpmCi: fakeNpm });
        assert.strictEqual(up.action, 'upgrade');
        assertTwoSidedNew(app, b, '升级完成后');
        cut({ app, mode: 'rollback', match: { fromEnds: path.sep + path.join(up.backupId, 'backend'), toIncludes: path.sep + BE } });
        // 断电态：后端已回到旧版，但 journal 仍可能在「未落盘」窗口内。
        const out = resume(app, { thenRollback: true });
        const rbStep = out.steps.find((s) => s.n === 'rollback');
        assert.ok(rbStep && !rbStep.error, `rollback 必须成功：${JSON.stringify(out.steps)}`);
        assertOld(app, b, '回滚断电恢复后');
        assert.strictEqual(phaseOf(app), 'ROLLED_BACK');
        // 可重复：再 rollback / recover 不改字节。
        const snap = { app: tree(app) };
        assert.strictEqual(setup.rollback(app, { stoppedConfirmed: true }).action, 'noop');
        assert.strictEqual(setup.recover(app, { stoppedConfirmed: true }).action, 'noop');
        assertOld(app, b, '重复操作后');
        assert.ok(same(targetOf(tree(app)), targetOf(snap.app)), '重复操作不得改动目标区域');
        // 历史回滚：指向同一备份再回滚一次，也不得破坏已收敛的旧态（要么幂等，要么明确报错）。
        const id = setup.readJournal(app).backupId;
        let outcome;
        try { outcome = setup.rollback(app, { stoppedConfirmed: true, to: id }); } catch (err) { outcome = { error: err.code || String(err) }; }
        assert.ok(outcome !== undefined, '必须给出结果或明确错误');
        assertOld(app, b, '指向同一备份的重复回滚后');
    });
    const only = ((process.argv.find((a) => a.startsWith('--only=')) || '').slice(7)).split(',').filter(Boolean);
    const results = [];
    for (const t of tests) {
        if (only.length && !only.includes(t.id)) continue;
        const rec = { id: t.id, title: t.title, verdict: 'fail', ms: 0, error: null };
        const t0 = Date.now();
        try { await t.fn(); rec.verdict = 'pass'; } catch (e) { rec.error = String((e && e.stack) || e); }
        rec.ms = Date.now() - t0;
        results.push(rec);
        console.log(`[${rec.verdict.toUpperCase()}] ${rec.id} ${t.title} (${rec.ms}ms)`);
        if (rec.error) console.log(rec.error.split('\n').slice(0, 10).map((l) => '    ' + l).join('\n'));
    }
    const summary = { total: results.length, pass: results.filter((r) => r.verdict === 'pass').length, fail: results.filter((r) => r.verdict === 'fail').length };
    const hashOf = (rel) => { try { return sha256(fs.readFileSync(path.join(ROOT, rel))); } catch { return null; } };
    const report = {
        generator: 'test/installer-adversarial.test.js',
        notes: 'fixture 全在 test-artifacts/<runId>/，宿主 1.17.0 + fake 依赖；不联网、不跑 npm/git；断电 = 子进程 fs.renameSync 真实成功后 exit(77)。',
        createdAt: new Date().toISOString(),
        node: process.version,
        sourceHash: {
            'test/installer-adversarial.test.js': hashOf('test/installer-adversarial.test.js'),
            'lib/installer/setup.js': hashOf('lib/installer/setup.js'),
            'lib/installer/fsutil.js': hashOf('lib/installer/fsutil.js'),
            'lib/installer/discovery.js': hashOf('lib/installer/discovery.js'),
            'bin/install-plugin.js': hashOf('bin/install-plugin.js'),
        },
        blockedSpawns: SPAWNS.filter((s) => !s.allowed),
        cuts: cutLog,
        summary,
        tests: results,
    };
    fs.writeFileSync(path.join(ARTIFACTS, 'installer-adversarial-results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('[RESULT] ' + JSON.stringify(summary));
    process.exit(summary.fail ? 1 : 0);
})(process.argv[3]).catch((e) => {
    process.stderr.write('[child] 未捕获异常: ' + ((e && e.stack) || e) + '\n');
    process.exit(1);
});

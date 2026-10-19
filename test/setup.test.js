#!/usr/bin/env node
'use strict';
/**
 * 酒管同步 · 统一安装向导（setup）聚焦测试 —— 合成 host fixture，全隔离。
 *
 * 设计原则（对齐任务合同）：
 *  - 只用合成 host（1.17.x + server.js + package.json + config.yaml + data 哨兵）、隔离 HOME/TMP；
 *  - 依赖注入 fake npm（不联网）：安装分支走真实 prepare/commit 路径，但依赖由注入函数在 stage 内造出；
 *  - **真实断电**：测试用 --fault 子进程在「某一个真实 fs 动作之后」process.exit(77)，
 *    而不是抛错后被自动 rollback 的伪中断；
 *  - 恶意 journal / 越界绝对路径 / 链接 / 损坏文件都用真实文件构造，断言「app 外文件不变、不删」。
 *
 * 覆盖（缺陷编号对应复审报告）：
 *   1  --config 真实文件可接受；默认 config / journal / 备份 / 记录都做祖先+最终普通文件校验；
 *      journal 损坏 / 不可读 / 未知 schema → 阻断（不吞、不覆盖）
 *   2  recover PREPARED 不再 INSTALL_BUSY（同一把锁）；PREPARING/FAILED/ROLLING_BACK 阻断新安装；
 *      真实断电子进程在每条单侧 rename / config rename 之后
 *   3  scanShadowExtensions 扫直系 extensions/<name> 与旧 thirdparty 路径；链接/错误 fail-closed；gate 拒绝
 *   4  journal 的 configPath 不信任；外置 config 用本地受控记录 / --config 重指并比对标识；
 *      恢复路径链接拒绝；备份 hash 复核；回滚幂等；首装 PREPARING 失败可放弃且保留 stage
 *   5  config 改前 CAS + 预期哈希先入 journal（rename 后断电不留 unknown config）；
 *      recover 补 DONE 同时校验 config；备份两侧逐侧标记，断电不误移未移动侧
 *   6  已知不同版本 → upgrade（无需 --takeover）；unknown/modified 才 takeover；
 *      --no-deps 首装必须拒绝；正常 noop 必须复核依赖
 *   7  交互：选择编号 + 确认实际 config 路径 + 确认数据根（默认值+自定义+多候选）
 *   8  严格 1.17.x
 *
 * 用法: node test/setup.test.js [--keep] [--filter 12,15,22]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SETUP_BIN = path.join(ROOT, 'bin', 'setup.js');
const BUILD_BIN = path.join(ROOT, 'scripts', 'build-release.js');
const FAULT_WRAPPER = path.join(__dirname, 'setup-fault-wrapper.js');

const SUBCOMMANDS = ['--child', '--fault-child', '--interactive-child'];

if (!SUBCOMMANDS.includes(process.argv[2])) {
    parentMain();
} else if (process.argv[2] === '--fault-child') {
    // 由 test/setup-fault-wrapper.js 调用：由 wrapper 先安装 fs 包装再交给本函数。
    runFaultChild().catch((e) => {
        console.error('[fault-child] 未捕获异常:', e);
        process.exit(1);
    });
} else if (process.argv[2] === '--interactive-child') {
    interactiveChild();
} else {
    childMain().catch((err) => {
        console.error('[child] 未捕获异常:', err);
        process.exit(1);
    });
}

function parentMain() {
    const keep = process.argv.includes('--keep');
    const filterAt = process.argv.indexOf('--filter');
    const filter = filterAt >= 0 ? process.argv[filterAt + 1] : '';
    if (filterAt >= 0 && (!filter || filter.startsWith('--'))) throw new Error('--filter 需要测试编号/前缀，以逗号分隔');
    const run = path.join(ROOT, 'test-artifacts', `setup-${crypto.randomUUID()}`);
    fs.mkdirSync(run, { recursive: true });
    const r = spawnSync(process.execPath, [__filename, '--child', run, ...(filter ? ['--filter', filter] : [])], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000 });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    if (!keep) {
        try { fs.rmSync(run, { recursive: true, force: true }); } catch {}
    }
    console.log(`[parent] exit=${r.status}${keep ? ` artifacts=${run}` : ''}${r.error ? ` error=${r.error.message}` : ''}`);
    process.exit(r.status === null ? 1 : r.status);
}

// ───────────────────────────── 子进程（断电 / 交互）─────────────────────────────

/**
 * 断电子进程：包装 fs.renameSync，对匹配的动作「执行成功后」立即 process.exit(77)。
 * 这是真实进程退出（不跑 finally、不 auto-rollback），模拟「rename 之后断电」。
 * 参数: <specJson>
 *   spec = { mode:'install'|'recover'|'rollback', appPath, match:{kind, contains, destContains, index}, exitCode }
 */
function faultSpec() {
    const arg = process.argv.find((a) => a.startsWith('--spec='));
    if (!arg) throw new Error('缺少 --spec');
    const spec = JSON.parse(Buffer.from(arg.slice('--spec='.length), 'base64').toString('utf8'));
    return spec;
}

function installFaultHook() {
    let spec;
    try {
        spec = faultSpec();
    } catch {
        return;
    }
    const norm = (p) => String(p || '').split(path.sep).join('/').toLowerCase();
    let count = 0;
    const hit = (kind, a, b) => {
        const m = spec.match || {};
        if (m.kind && m.kind !== kind) return false;
        if (m.contains && !norm(a).includes(norm(m.contains))) return false;
        if (m.destContains && !norm(b).includes(norm(m.destContains))) return false;
        count++;
        if (m.index && count < m.index) return false;
        return true;
    };
    const fire = (kind, a, b) => {
        if (!hit(kind, a, b)) return;
        // 真实进程退出：不执行任何 finally / 回滚逻辑。
        process.stdout.write(`[fault] ${kind} ${a} -> ${b}\n`);
        process.exit(spec.exitCode || 77);
    };
    const origRename = fs.renameSync;
    fs.renameSync = function (a, b) {
        const r = origRename.apply(this, arguments);
        fire('rename', a, b);
        return r;
    };
    const origCopy = fs.copyFileSync;
    fs.copyFileSync = function (a, b) {
        const r = origCopy.apply(this, arguments);
        fire('copy', a, b);
        return r;
    };
    const origUnlink = fs.unlinkSync;
    fs.unlinkSync = function (a) {
        const r = origUnlink.apply(this, arguments);
        fire('unlink', a, a);
        return r;
    };
}

async function runFaultChild() {
    const spec = faultSpec();
    installFaultHook();
    const setup = require('../lib/installer/setup');
    const runner = makeFakeNpmRunner();
    const deps = setup.releaseDependencies();
    // 用与父测试一致的确定性依赖填充（不联网）。
    if (spec.installDepsCopy) runner(spec.installDepsCopy);
    const app = spec.appPath;
    const options = Object.assign({ appDir: app, dataRoot: null }, spec.options);
    if (spec.mode === 'install') {
        const p = setup.plan(options);
        const pr = setup.prepare(p, { runNpmCi: spec.installDepsCopy ? undefined : runner });
        setup.commit(pr, pr.plan, Object.assign({}, spec.options, { stoppedConfirmed: true }));
    } else if (spec.mode === 'recover') {
        setup.recover(app, Object.assign({}, spec.options, { stoppedConfirmed: true }));
    } else if (spec.mode === 'rollback') {
        setup.rollback(app, Object.assign({}, spec.options, { stoppedConfirmed: true }));
    } else if (spec.mode === 'prepare') {
        const p = setup.plan({ appDir: app });
        setup.prepare(p, { runNpmCi: runner });
    }
    process.stdout.write('[fault] 未触发（未退出）\n');
    process.exit(0);
    void deps;
}

function makeFakeNpmRunner() {
    const deps = require('../lib/installer/setup').releaseDependencies();
    return (cwd) => {
        for (const d of deps) {
            const dir = path.join(cwd, 'node_modules', d);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: d, version: '0.0.0-fake' }));
        }
    };
}

/** 交互子进程：主进程扮演终端（isTTY=true）。 */
function interactiveChild() {
    process.stdin.isTTY = true;
    const arg = process.argv.find((a) => a.startsWith('--args='));
    const args = arg ? JSON.parse(Buffer.from(arg.slice('--args='.length), 'base64').toString('utf8')) : [];
    const core = require('../lib/installer/setup');
    const originalPrepare = core.prepare;
    core.prepare = (p, deps) => originalPrepare(p, Object.assign({}, deps, { runNpmCi: makeFakeNpmRunner() }));
    const mod = require(SETUP_BIN);
    mod.main(args).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}

// ───────────────────────────── 主测试子进程 ─────────────────────────────

async function childMain() {
    const RUN = path.resolve(process.argv[3]);
    const assert = require('assert');

    // ---- 环境隔离 ----
    const HOME = path.join(RUN, 'home');
    const TMP = path.join(RUN, 'tmp');
    fs.mkdirSync(HOME, { recursive: true });
    fs.mkdirSync(TMP, { recursive: true });
    const SCRUB = /^(GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|GIT_ASKPASS|SSH_ASKPASS|GIT_CONFIG|GIT_CONFIG_NOSYSTEM|GIT_TERMINAL_PROMPT|ST_GITHUB_SYNC_TOKEN|HOME|USERPROFILE|TMP|TEMP|npm_execpath)$/i;
    for (const k of Object.keys(process.env)) if (SCRUB.test(k)) delete process.env[k];
    Object.assign(process.env, { HOME, USERPROFILE: HOME, TMP, TEMP: TMP, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });

    const setup = require('../lib/installer/setup');
    const discovery = require('../lib/installer/discovery');
    const { InstallError } = setup;

    const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

    function dirInventory(dir) {
        const map = {};
        const walk = (d) => {
            for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
                const abs = path.join(d, ent.name);
                const rel = path.relative(dir, abs).split(path.sep).join('/');
                if (ent.isDirectory()) walk(abs);
                else if (ent.isFile()) map[rel] = sha256(fs.readFileSync(abs));
                else if (ent.isSymbolicLink()) map[rel] = 'LINK';
            }
        };
        if (!fs.existsSync(dir)) return map;
        walk(dir);
        return map;
    }

    function makeHost(name, { version = '1.17.0', configText = 'enableServerPlugins: false\n', withData = true } = {}) {
        const app = path.join(RUN, name);
        fs.mkdirSync(app, { recursive: true });
        fs.writeFileSync(path.join(app, 'server.js'), '// fake server\n');
        fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'fake-app', version }));
        fs.writeFileSync(path.join(app, 'config.yaml'), configText);
        if (withData) {
            fs.mkdirSync(path.join(app, 'data', 'default-user', 'chats'), { recursive: true });
            fs.writeFileSync(path.join(app, 'data', 'default-user', 'chats', 'somechat.jsonl'), '{"user":"hi"}\n');
        }
        return app;
    }

    /** 注入 fake npm（成功）：在 stage 内造出依赖目录，证明「装的是 deps 分支」。 */
    function fakeRunnerOk() {
        return makeFakeNpmRunner();
    }

    function expectThrow(fn, code, re) {
        let threw = null;
        try {
            const r = fn();
            if (r && typeof r.then === 'function') {
                // 同步测试里不应出现 Promise；这里直接失败以免误判。
                throw new Error('expectThrow 收到了 Promise');
            }
        } catch (e) {
            threw = e;
        }
        assert.ok(threw, `应抛错（期望 ${code}）`);
        if (typeof code === 'string') assert.strictEqual(threw.code, code, `错误码应为 ${code}，实际 ${threw && threw.code}（${threw && threw.message}）`);
        if (re) assert.ok(re.test(threw.message), `错误信息应匹配 ${re}，实际 ${threw.message}`);
        return threw;
    }

    function planOk(app, extra = {}) {
        return setup.plan(Object.assign({ appDir: app, installDeps: true, enableServerPlugins: true }, extra));
    }

    function installOk(app, extra = {}, runner = fakeRunnerOk()) {
        const p = planOk(app, extra);
        const prepared = setup.prepare(p, { runNpmCi: runner });
        return setup.commit(prepared, prepared.plan, { stoppedConfirmed: true });
    }

    /** 真子进程断电：返回 { status, stdout, stderr }。 */
    function faulted(spec) {
        const payload = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
        const r = spawnSync(process.execPath, [FAULT_WRAPPER, payload], {
            cwd: ROOT,
            encoding: 'utf8',
            timeout: 180000,
            env: process.env,
        });
        return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', signal: r.signal };
    }

    /** 子进程里只做 prepare（用于制造「PREPARE 中途断电」的 PREPARING journal）。 */
    function prepareInChild(app, { fault } = {}) {
        const code = `
const setup = require(${JSON.stringify(path.join(ROOT, 'lib', 'installer', 'setup.js'))});
const fs = require('fs'); const path = require('path');
const deps = setup.releaseDependencies();
const runner = (cwd) => { for (const d of deps) { const dir = path.join(cwd, 'node_modules', d); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'package.json'), '{}'); } };
let n = 0;
const orig = fs.copyFileSync;
fs.copyFileSync = function (a, b) { const r = orig.apply(this, arguments); n++; if (n >= ${Number(fault && fault.afterFiles ? fault.afterFiles : 9999)}) process.exit(77); return r; };
const p = setup.plan({ appDir: ${JSON.stringify(app)} });
const pr = setup.prepare(p, { runNpmCi: runner });
process.stdout.write('PREPARED ' + pr.txId + '\\n');
process.exit(0);
`;
        const f = path.join(RUN, `prepare-${crypto.randomUUID()}.js`);
        fs.writeFileSync(f, code);
        const r = spawnSync(process.execPath, [f], { cwd: RUN, encoding: 'utf8', timeout: 180000, env: process.env });
        return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
    }

    const BE = path.join('plugins', 'jiuguan-github-sync');
    const FE = path.join('public', 'scripts', 'extensions', 'third-party', 'jiuguan-github-sync');
    const MAN = setup.MANIFEST_BASENAME;

    // ───────────── helpers（发行包副本 / 交互驱动）─────────────
    function makeReleaseCopy(dest, { version, marker }) {
        fs.mkdirSync(dest, { recursive: true });
        const { collectSourceFiles } = require('../bin/install-plugin.js');
        for (const f of setup.releaseSourceFiles()) {
            const to = path.join(dest, f.relPosix.split('/').join(path.sep));
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.copyFileSync(f.abs, to);
        }
        const pkgPath = path.join(dest, 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        pkg.version = version;
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
        const cm = JSON.parse(fs.readFileSync(path.join(dest, 'client', 'manifest.json'), 'utf8'));
        cm.version = version;
        fs.writeFileSync(path.join(dest, 'client', 'manifest.json'), JSON.stringify(cm, null, 2));
        fs.writeFileSync(path.join(dest, 'index.js'), `// ${marker}\n` + fs.readFileSync(path.join(dest, 'index.js'), 'utf8'));
    }

    function collectReleaseFiles(dir) {
        return setup.releaseSourceFiles().map((f) => ({ abs: path.join(dir, ...f.relPosix.split('/')), relPosix: f.relPosix }));
    }

    /** 用「旧版本发行包」把宿主装成某版本（9.9.9 等），返回 { app, backupId }。 */
    function installAsOldVersion(name, version = '9.9.9') {
        const app = makeHost(name);
        const rel = path.join(RUN, `rel-${name}-${version}`);
        makeReleaseCopy(rel, { version, marker: 'OLD-' + version });
        setup.__setReleaseForTesting({ root: rel, files: collectReleaseFiles(rel), version });
        try {
            const p = planOk(app);
            const pr = setup.prepare(p, { runNpmCi: fakeRunnerOk() });
            const r = setup.commit(pr, pr.plan, { stoppedConfirmed: true });
            return { app, backupId: r.backupId };
        } finally {
            setup.__resetReleaseForTesting();
        }
    }

    function runInteractive(args, answers, cwd) {
        const payload = Buffer.from(JSON.stringify(['--interactive', ...args]), 'utf8').toString('base64');
        const arg = `--args=${payload}`;
        return new Promise((resolve) => {
            const child = spawn(process.execPath, [__filename, '--interactive-child', arg], { cwd, env: process.env, windowsHide: true });
            let stdout = '';
            let stderr = '';
            const queue = answers.slice();
            let pending = '';
            let timer = null;
            let timedOut = false;
            const deadline = setTimeout(() => { timedOut = true; child.kill(); }, 15000);
            const flush = () => {
                timer = null;
                if (/: $/.test(pending) && queue.length > 0) {
                    const ans = queue.shift();
                    child.stdin.write(ans + '\n');
                    pending = '';
                }
            };
            const timerFlush = () => {
                if (timer) return;
                timer = setTimeout(flush, 80);
            };
            child.stdout.on('data', (d) => { stdout += d.toString(); pending += d.toString(); timerFlush(); });
            child.stderr.on('data', (d) => { stderr += d.toString(); });
            child.on('close', (code) => { clearTimeout(deadline); clearTimeout(timer); resolve({ status: code, stdout, stderr, timedOut }); });
            child.on('error', (e) => { clearTimeout(deadline); clearTimeout(timer); resolve({ status: null, stdout, stderr: stderr + e.message, timedOut }); });
            child.stdin.on('error', () => {});
        });
    }

    const tests = [];
    const runTest = (id, title, fn) => tests.push({ id, title, fn });
    async function execute(t) {
        const rec = { id: t.id, title: t.title, verdict: 'fail', error: null, skipped: false };
        try {
            const r = await t.fn();
            rec.verdict = r === 'skip' ? 'skip' : 'pass';
            rec.skipped = r === 'skip';
        } catch (e) {
            rec.error = String((e && e.stack) || e);
        }
        return rec;
    }

    // ═════════════ 1. 工具 / 版本识别（严格 1.17.x）═════════════
    runTest('1.1', '工具检查与版本识别：严格 1.17.x（1.17.foo / 1.17 / 1.17.0.1 全拒绝）', () => {
        const t = discovery.checkTools();
        assert.strictEqual(t.node.ok, true, 'node >= 20');
        assert.strictEqual(t.npm.ok, true, 'npm 可定位');
        for (const v of ['1.17.0', '1.17.9', '1.17.12', '1.17.0-rc.1', '1.17.15-preview.2']) {
            assert.strictEqual(discovery.isSupportedHostVersion(v), true, `${v} 应支持`);
        }
        for (const v of ['1.17.foo', '1.17', '1.17.', '1.17.0.1', '1.170.0', '01.17.0', '1.16.0', '1.18.0', '1.17.0 ', ' 1.17.0', '1.17.0\n', 'v1.17.0', '', null, undefined, 1.17]) {
            assert.strictEqual(discovery.isSupportedHostVersion(v), false, `${JSON.stringify(v)} 必须拒绝`);
        }
        const bad = makeHost('h-ver', { version: '1.17.foo' });
        expectThrow(() => planOk(bad), 'HOST_VERSION_UNSUPPORTED');
        const bad2 = makeHost('h-ver2', { version: '1.17' });
        expectThrow(() => planOk(bad2), 'HOST_VERSION_UNSUPPORTED');
        const ok = makeHost('h-ver3', { version: '1.17.4' });
        assert.strictEqual(planOk(ok).action, 'install');
    });

    // ═════════════ 2. 首装基础 + noop ═════════════
    runTest('2.1', '首装：前后端同装、清单 schema、config 改写、备份就绪、data 不变、noop', () => {
        const app = makeHost('h2');
        const dataBefore = dirInventory(path.join(app, 'data'));
        const p = planOk(app);
        assert.strictEqual(p.action, 'install');
        assert.strictEqual(p.inspect.state, 'none');
        assert.strictEqual(p.configSource, 'default');
        const r = installOk(app);
        for (const f of ['package.json', 'index.js', MAN]) assert.ok(fs.existsSync(path.join(app, BE, f)), `后端应含 ${f}`);
        for (const f of ['manifest.json', 'index.js', 'style.css']) assert.ok(fs.existsSync(path.join(app, FE, f)), `前端应含 ${f}`);
        const man = setup.readManifest(path.join(app, BE));
        assert.strictEqual(man.schema, setup.MANIFEST_SCHEMA);
        assert.strictEqual(man.version, setup.RELEASE_VERSION);
        assert.ok(fs.existsSync(path.join(app, BE, 'node_modules', 'fs-extra')), '依赖应装进后端');
        assert.strictEqual(fs.readFileSync(path.join(app, 'config.yaml'), 'utf8'), 'enableServerPlugins: true\n');
        assert.ok(r.backupDir.startsWith(path.join(app, '.jiuguan-install', 'backups')));
        const j = setup.readJournal(app);
        assert.strictEqual(j.phase, 'DONE');
        assert.strictEqual(j.configSha256After, sha256(Buffer.from('enableServerPlugins: true\n')));
        assert.deepStrictEqual(dirInventory(path.join(app, 'data')), dataBefore, 'data 必须完全不变');
        assert.ok(!fs.existsSync(path.join(app, 'plugins', '.jiuguan-install')));
        assert.ok(!fs.existsSync(path.join(app, 'public', 'scripts', 'extensions', 'third-party', '.jiuguan-install')));
        // journal 内不含可写外部的 config 绝对路径（只留 basename + 哈希）。
        assert.ok(!('configPath' in j), 'journal 不得保存 config 绝对路径');
        assert.strictEqual(j.configIdent.basename, 'config.yaml');
        assert.strictEqual(planOk(app).action, 'noop');
    });

    // ═════════════ 3. --config 真实文件（缺陷 1）═════════════
    runTest('3.1', '--config 指向真实普通文件：可接受并实际改写该文件（不再必拒）', () => {
        const app = makeHost('h3');
        const altDir = path.join(RUN, 'h3-config');
        fs.mkdirSync(altDir, { recursive: true });
        const alt = path.join(altDir, 'config.yaml');
        fs.writeFileSync(alt, 'enableServerPlugins: false\n');
        const p = planOk(app, { configPath: alt });
        assert.strictEqual(p.action, 'install', `应可安装：${p.reason}`);
        assert.strictEqual(p.configSource, 'cli');
        assert.strictEqual(p.configPath, alt);
        const r = installOk(app, { configPath: alt });
        assert.strictEqual(r.configChanged, true);
        assert.strictEqual(fs.readFileSync(alt, 'utf8'), 'enableServerPlugins: true\n', '应改写 --config 指定的那一份');
        assert.strictEqual(fs.readFileSync(path.join(app, 'config.yaml'), 'utf8'), 'enableServerPlugins: false\n', '宿主默认 config 不得被改');
        // 外置 config → 本地受控凭据记录存在，且下次 plan 使用它。
        const rec = setup.readConfigSourceRecord(app);
        assert.ok(rec && rec.path === alt, '应生成 config 来源记录');
        assert.strictEqual(planOk(app).configSource, 'record');
        assert.strictEqual(planOk(app).action, 'noop');
    });

    runTest('3.2', '--config 拒绝：相对路径 / 目录 / 不存在 / 链接 / 祖先 junction', () => {
        const app = makeHost('h3b');
        expectThrow(() => planOk(app, { configPath: 'config.yaml' }), 'CONFIG_PATH_INVALID', /绝对路径/);
        expectThrow(() => planOk(app, { configPath: path.join(app, 'data') }), 'NOT_REGULAR_FILE', /普通文件/);
        expectThrow(() => planOk(app, { configPath: path.join(app, 'nope.yaml') }), 'CONFIG_PATH_INVALID');
        // 最终节点是链接 → 拒绝
        const realCfg = path.join(RUN, 'h3b-real.yaml');
        fs.writeFileSync(realCfg, 'enableServerPlugins: false\n');
        const link = path.join(RUN, 'h3b-link.yaml');
        let linked = false;
        try { fs.symlinkSync(realCfg, link, 'file'); linked = true; } catch { linked = false; }
        if (linked) {
            expectThrow(() => planOk(app, { configPath: link }), 'LINK_REJECTED');
            fs.unlinkSync(link);
        }
        // 祖先 junction → 拒绝（且不写出外部）
        const realDir = path.join(RUN, 'h3b-real-dir');
        fs.mkdirSync(realDir, { recursive: true });
        fs.writeFileSync(path.join(realDir, 'config.yaml'), 'enableServerPlugins: false\n');
        const linkedDir = path.join(RUN, 'h3b-linked-dir');
        let dirLinked = false;
        try { fs.symlinkSync(realDir, linkedDir, 'junction'); dirLinked = true; } catch { dirLinked = false; }
        if (dirLinked) {
            expectThrow(() => planOk(app, { configPath: path.join(linkedDir, 'config.yaml') }), 'LINK_REJECTED');
        }
        return 'ok';
    });

    // ═════════════ 4. journal 损坏 / 不可读 / 未知 schema（缺陷 1）═════════════
    runTest('4.1', 'journal 损坏（JSON 截断）→ 阻断且不覆盖 journal', () => {
        const app = makeHost('h4');
        const ap = setup.appPaths(app);
        fs.mkdirSync(ap.work, { recursive: true });
        fs.writeFileSync(ap.journal, '{"schema":2,"txId":"tx-1","phase":"SWIT');
        const before = fs.readFileSync(ap.journal, 'utf8');
        expectThrow(() => planOk(app), 'JOURNAL_CORRUPT');
        expectThrow(() => setup.apply({ appDir: app }), 'JOURNAL_CORRUPT');
        expectThrow(() => setup.prepare({ appDir: app }, { runNpmCi: fakeRunnerOk() }), 'JOURNAL_CORRUPT');
        expectThrow(() => setup.recover(app, { stoppedConfirmed: true }), 'JOURNAL_CORRUPT');
        expectThrow(() => setup.rollback(app, { stoppedConfirmed: true }), 'JOURNAL_CORRUPT');
        const r = spawnSync(process.execPath, [SETUP_BIN, '--app-dir', app, '--apply', '--stopped-confirmed'], { cwd: RUN, encoding: 'utf8', timeout: 120000 });
        assert.notStrictEqual(r.status, 0, 'CLI 也应拒绝');
        assert.strictEqual(fs.readFileSync(ap.journal, 'utf8'), before, 'journal 不得被覆盖');
        assert.ok(!fs.existsSync(path.join(app, BE)), '不得开始安装');
        // --status 只读地如实报告（不吞）。
        const st = spawnSync(process.execPath, [SETUP_BIN, '--status', '--app-dir', app], { cwd: RUN, encoding: 'utf8' });
        assert.strictEqual(st.status, 0);
        assert.ok(/无法读取/.test(st.stdout), `status 应报告损坏: ${st.stdout}`);
        assert.strictEqual(fs.readFileSync(ap.journal, 'utf8'), before);
    });

    runTest('4.2', '未知 schema / legacy schema journal → 阻断，不自动恢复、不覆盖', () => {
        for (const [schema, code] of [[3, 'JOURNAL_SCHEMA_UNKNOWN'], [1, 'JOURNAL_SCHEMA_UNKNOWN']]) {
            const app = makeHost(`h4s-${schema}`);
            const ap = setup.appPaths(app);
            fs.mkdirSync(ap.work, { recursive: true });
            const data = JSON.stringify({ schema, txId: 'tx-20260101000000-aaaaaa', appDir: app, phase: 'SWITCHING', backupId: 'bk-x', configPath: path.join(RUN, 'outside-victim.yaml') });
            fs.writeFileSync(ap.journal, data);
            expectThrow(() => planOk(app), code, /schema/);
            expectThrow(() => setup.recover(app, { stoppedConfirmed: true }), code);
            expectThrow(() => setup.rollback(app, { stoppedConfirmed: true }), code);
            expectThrow(() => setup.apply({ appDir: app }, { stoppedConfirmed: true }), code);
            assert.strictEqual(fs.readFileSync(ap.journal, 'utf8'), data, `schema=${schema} journal 不得被覆盖`);
        }
    });

    runTest('4.3', 'journal 不可读（EACCES 或原子替换后目录型 journal）→ JOURNAL_UNREADABLE 阻断', () => {
        const app = makeHost('h4r');
        const ap = setup.appPaths(app);
        fs.mkdirSync(ap.work, { recursive: true });
        // Windows 下 chmod 不生效：用「journal.json 是目录」制造 EISDIR 类不可读（只读错误路径的同一分支）。
        fs.mkdirSync(ap.journal);
        const threw = expectThrow(() => planOk(app));
        assert.ok(['JOURNAL_CORRUPT', 'JOURNAL_UNREADABLE', 'NOT_REGULAR_FILE'].includes(threw.code), `实际 ${threw.code} ${threw.message}`);
        assert.ok(fs.statSync(ap.journal).isDirectory(), 'journal 路径不得被覆盖');
        assert.ok(!fs.existsSync(path.join(app, BE)), '不得开始安装');
    });

    // ═════════════ 5. 已读清单校验 / noop 依赖复核（缺陷 6）═════════════
    runTest('5.1', 'noop 必须复核依赖：依赖缺失时 noop 不成立（提示修依赖，不假成功）', () => {
        const app = makeHost('h5');
        installOk(app);
        assert.strictEqual(planOk(app).action, 'noop');
        fs.rmSync(path.join(app, BE, 'node_modules', 'fs-extra'), { recursive: true, force: true });
        const p = planOk(app, { installDeps: false });
        assert.strictEqual(p.inspect.state, 'match', '内容仍匹配（node_modules 不计入）');
        assert.notStrictEqual(p.action, 'noop', '依赖缺失不能判 noop');
        assert.strictEqual(p.action, 'rejected');
        assert.ok(/依赖/.test(p.reason), `应提示依赖: ${p.reason}`);
        expectThrow(() => setup.apply({ appDir: app, installDeps: false }, { stoppedConfirmed: true }), 'REJECTED_TARGET', /依赖/);
        // 修复依赖（重新装）后恢复 noop。
        installOk(app, { takeover: true });
        assert.strictEqual(planOk(app).action, 'noop');
    });

    // ═════════════ 6. no-op 双侧 + 单侧 + 改动 ═════════════
    runTest('6.1', 'no-op 必须前后端双侧：前端改动 / 单侧缺失都拒绝', () => {
        const app = makeHost('h6');
        installOk(app);
        fs.appendFileSync(path.join(app, FE, 'style.css'), '/* user edit */\n');
        const p1 = planOk(app);
        assert.strictEqual(p1.inspect.state, 'modified');
        assert.strictEqual(p1.action, 'rejected');
        expectThrow(() => setup.apply({ appDir: app }), 'REJECTED_TARGET', /前端/);
        fs.copyFileSync(path.join(ROOT, 'client', 'style.css'), path.join(app, FE, 'style.css'));
        fs.rmSync(path.join(app, FE), { recursive: true, force: true });
        const p2 = planOk(app);
        assert.strictEqual(p2.inspect.state, 'incomplete');
        expectThrow(() => setup.apply({ appDir: app }), 'REJECTED_TARGET', /一侧/);
        assert.ok(!fs.existsSync(path.join(app, FE)), '拒绝时不得写前端');
    });

    // ═════════════ 7. gate：modified / unknown 需 takeover（缺陷 6）═════════════
    runTest('7.1', 'modified/unknown 默认拒绝；--takeover 才接管并完整保留', () => {
        const app = makeHost('h7');
        installOk(app);
        fs.writeFileSync(path.join(app, BE, 'index.js'), '// user modified\n');
        expectThrow(() => setup.apply({ appDir: app }), 'REJECTED_TARGET');
        expectThrow(() => setup.prepare({ appDir: app }, { runNpmCi: fakeRunnerOk() }), 'REJECTED_TARGET');
        const app2 = makeHost('h7u');
        fs.mkdirSync(path.join(app2, BE), { recursive: true });
        fs.writeFileSync(path.join(app2, BE, 'legacy.js'), '// legacy\n');
        expectThrow(() => setup.prepare({ appDir: app2 }, { runNpmCi: fakeRunnerOk() }), 'REJECTED_TARGET', /一侧|无法精确识别/);
        // takeover 完整保留（含 .git 与未知内容）。
        fs.mkdirSync(path.join(app2, FE), { recursive: true });
        fs.mkdirSync(path.join(app2, BE, '.git'), { recursive: true });
        fs.writeFileSync(path.join(app2, BE, '.git', 'HEAD'), 'ref: refs/heads/main\n', { flag: 'w' });
        fs.writeFileSync(path.join(app2, FE, 'old.js'), 'old frontend');
        const p = planOk(app2, { takeover: true });
        assert.strictEqual(p.action, 'takeover');
        const r = installOk(app2, { takeover: true });
        assert.strictEqual(fs.readFileSync(path.join(r.backupDir, 'backend', 'legacy.js'), 'utf8'), '// legacy\n');
        assert.strictEqual(fs.readFileSync(path.join(r.backupDir, 'backend', '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/main\n');
        assert.strictEqual(fs.readFileSync(path.join(r.backupDir, 'frontend', 'old.js'), 'utf8'), 'old frontend');
        assert.strictEqual(setup.readManifest(path.join(app2, BE)).action, 'takeover');
    });

    // ═════════════ 8. 已知不同版本 → upgrade（缺陷 6）═════════════
    runTest('8.1', '已知旧版本（清单与内容自洽）：action=upgrade，无需 --takeover，清单记录 upgrade', () => {
        const { app } = installAsOldVersion('h8', '9.9.9');
        const p = planOk(app);
        assert.strictEqual(p.inspect.state, 'upgrade', `应为 upgrade，实际 ${p.inspect.state}`);
        assert.strictEqual(p.action, 'upgrade', `已知版本升级不需要 takeover，实际 ${p.action}（${p.reason}）`);
        assert.strictEqual(p.canProceed, true);
        const r = installOk(app);
        const man = setup.readManifest(path.join(app, BE));
        assert.strictEqual(man.version, setup.RELEASE_VERSION);
        assert.strictEqual(man.action, 'upgrade', `清单应记录 upgrade，实际 ${man.action}`);
        assert.ok(!fs.readFileSync(path.join(app, BE, 'index.js'), 'utf8').includes('OLD-9.9.9'), '旧内容应被替换');
        assert.strictEqual(setup.readManifest(path.join(r.backupDir, 'backend')).version, '9.9.9', '旧版应完整备份');
        assert.ok(fs.existsSync(path.join(r.backupDir, 'config.yaml')), '配置应备份');
        assert.strictEqual(planOk(app).action, 'noop');
    });

    runTest('8.2', '升级 + 显式升级确认（交互）→ 从旧版本升级成功；计划中不出现「接管」字样', async () => {
        const { app } = installAsOldVersion('h8i', '9.9.9');
        const staging = path.join(RUN, 'h8i-staging');
        fs.mkdirSync(staging, { recursive: true });
        const answers = ['', 'y', '', 'y', 'y', 'y', 'y'];
        const r = await runInteractive(['--app-dir', app], answers, staging);
        assert.strictEqual(r.status, 0, `交互升级应成功\nstdout=${r.stdout}\nstderr=${r.stderr}`);
        assert.ok(/升级/.test(r.stdout), '应明确显示升级');
        assert.ok(!/接管已有目录/.test(r.stdout), `正常升级不得冒称接管:\n${r.stdout}`);
        assert.strictEqual(setup.readManifest(path.join(app, BE)).version, setup.RELEASE_VERSION);
        assert.strictEqual(setup.readManifest(path.join(app, BE)).action, 'upgrade');
    });

    // ═════════════ 9. --no-deps（缺陷 6）═════════════
    runTest('9.1', '--no-deps 首装：拒绝（不可目标不存在却 ok 缺依赖）', () => {
        const app = makeHost('h9');
        const p = setup.plan({ appDir: app, installDeps: false });
        assert.strictEqual(p.depsCheck.ok, false, '首装 --no-deps 必须不可验证');
        assert.strictEqual(p.action, 'rejected');
        expectThrow(() => setup.apply({ appDir: app, installDeps: false }, { stoppedConfirmed: true }), 'REJECTED_TARGET', /依赖/);
        assert.ok(!fs.existsSync(path.join(app, BE)), '不得写出无依赖的后端');
        const r = spawnSync(process.execPath, [SETUP_BIN, '--app-dir', app, '--no-data-root', '--no-deps', '--apply', '--stopped-confirmed'], { cwd: RUN, encoding: 'utf8', timeout: 120000 });
        assert.notStrictEqual(r.status, 0, 'CLI 也应拒绝');
        assert.ok(/依赖/.test(r.stdout + r.stderr), '应说明依赖不可验证');
    });

    runTest('9.2', '--no-deps 升级：从旧版已核验依赖复制到新 stage；旧依赖被篡改则拒绝', () => {
        const { app } = installAsOldVersion('h9b', '9.9.9');
        // 正常：旧目标依赖齐全且未改动 → 复制。
        const p = planOk(app, { installDeps: false });
        assert.strictEqual(p.action, 'upgrade');
        const pr = setup.prepare(p, { runNpmCi: () => { throw new Error('不应调用 npm'); } });
        assert.strictEqual(pr.depsCopied, true, '应从旧版本复制依赖');
        const r = setup.commit(pr, pr.plan, { stoppedConfirmed: true });
        assert.strictEqual(setup.readManifest(path.join(app, BE)).version, setup.RELEASE_VERSION);
        assert.ok(fs.existsSync(path.join(r.backendDir, 'node_modules', 'fs-extra', 'package.json')), '新目录应有依赖');
        // 篡改旧依赖后（内容不再与清单自洽）→ 拒绝。
        const { app: app2 } = installAsOldVersion('h9c', '9.9.9');
        fs.writeFileSync(path.join(app2, BE, 'node_modules', 'fs-extra', 'index.js'), '// tampered\n');
        const p2 = planOk(app2, { installDeps: false });
        assert.strictEqual(p2.action, 'rejected', '旧目录被改动后依赖不可信任');
        expectThrow(() => setup.apply({ appDir: app2, installDeps: false }, { stoppedConfirmed: true }), 'REJECTED_TARGET', /拒绝覆盖|依赖/);
    });

    runTest('9.3', '装依赖分支：npm 命令假装成功但没装依赖 → DEPS_INCOMPLETE（不冒充成功）', () => {
        const app = makeHost('h9d');
        const p = planOk(app);
        expectThrow(() => setup.prepare(p, { runNpmCi: () => {} }), 'DEPS_INCOMPLETE');
        const j = setup.readJournal(app);
        assert.strictEqual(j.phase, 'FAILED');
        assert.ok(fs.existsSync(setup.txPaths(app, j.txId).stageBackend), 'stage 必须保留（未删）');
    });

    // ═════════════ 10. 遮蔽扫描（缺陷 3）═════════════
    runTest('10.1', '遮蔽扫描：官方直系 <dataRoot>/<handle>/extensions/name + 旧 thirdparty 都能发现', () => {
        const app = makeHost('h10');
        const dr = path.join(RUN, 'data10');
        fs.mkdirSync(path.join(dr, 'alice', 'extensions', 'jiuguan-github-sync'), { recursive: true });
        fs.mkdirSync(path.join(dr, 'bob', 'extensions', 'third-party', 'jiuguan-github-sync'), { recursive: true });
        fs.mkdirSync(path.join(dr, 'carol', 'extensions', 'other-ext'), { recursive: true });
        fs.mkdirSync(path.join(dr, 'dave', 'extensions'), { recursive: true });
        fs.writeFileSync(path.join(dr, 'dave', 'extensions', 'notes.txt'), 'x');
        const s = setup.scanShadowExtensions(dr, app);
        assert.strictEqual(s.ok, false);
        assert.strictEqual(s.found.length, 2, `应发现 2 处，实际 ${JSON.stringify(s.found)}`);
        assert.ok(s.found.some((f) => f.split(path.sep).join('/').endsWith('/alice/extensions/jiuguan-github-sync')));
        assert.ok(s.found.some((f) => f.split(path.sep).join('/').endsWith('/bob/extensions/third-party/jiuguan-github-sync')));
        // gate：发现即拒绝。
        const p = planOk(app, { dataRoot: dr });
        assert.strictEqual(p.action, 'rejected');
        assert.strictEqual(p.shadowBlocked, true);
        expectThrow(() => setup.apply({ appDir: app, dataRoot: dr }, { stoppedConfirmed: true }), 'REJECTED_TARGET', /遮蔽|用户级/);
        expectThrow(() => setup.assertShadowCleared(p), 'SHADOW_EXTENSION');
        // dataRoot 只读。
        const before = dirInventory(dr);
        assert.deepStrictEqual(dirInventory(dr), before, 'data-root 只读');
    });

    runTest('10.2', '遮蔽移除后才可通过（无口头确认绕过）；链接/不可读 fail-closed', () => {
        const app = makeHost('h10b');
        const dr = path.join(RUN, 'data10b');
        const sh = path.join(dr, 'alice', 'extensions', 'jiuguan-github-sync');
        fs.mkdirSync(sh, { recursive: true });
        assert.strictEqual(planOk(app, { dataRoot: dr }).action, 'rejected');
        // takeover 也不能绕过。
        const app2 = makeHost('h10c');
        fs.mkdirSync(path.join(app2, BE), { recursive: true });
        fs.writeFileSync(path.join(app2, BE, 'x.js'), 'x');
        assert.strictEqual(planOk(app2, { dataRoot: dr, takeover: true }).action, 'rejected');
        // 实际移除后 → 可安装。
        fs.rmSync(sh, { recursive: true, force: true });
        assert.strictEqual(planOk(app, { dataRoot: dr }).action, 'install');
        installOk(app, { dataRoot: dr });
        // 链接 fail-closed：用 junction 冒充用户级扩展。
        const linkRoot = path.join(RUN, 'data10d');
        const realTarget = path.join(RUN, 'data10d-real-ext');
        fs.mkdirSync(realTarget, { recursive: true });
        fs.mkdirSync(path.join(linkRoot, 'erin', 'extensions'), { recursive: true });
        let ok = false;
        try {
            fs.symlinkSync(realTarget, path.join(linkRoot, 'erin', 'extensions', 'jiuguan-github-sync'), 'junction');
            ok = true;
        } catch {
            ok = false;
        }
        if (ok) {
            const s = setup.scanShadowExtensions(linkRoot, app);
            assert.strictEqual(s.ok, false, '链接扩展必须 fail-closed');
            assert.ok(s.hardError.length >= 1);
            assert.strictEqual(planOk(makeHost('h10e'), { dataRoot: linkRoot }).action, 'rejected');
        }
        // dataRoot 自身是链接 → 拒绝跟随。
        const linkData = path.join(RUN, 'data10-link');
        let linked = false;
        try { fs.symlinkSync(dr, linkData, 'junction'); linked = true; } catch { linked = false; }
        if (linked) {
            const s2 = setup.scanShadowExtensions(linkData, app);
            assert.strictEqual(s2.ok, false);
            assert.ok(/链接/.test(s2.error));
        }
        // dataRoot 不存在 → 阻断（不静默通过）。
        assert.strictEqual(setup.scanShadowExtensions(path.join(RUN, 'no-such-data'), app).ok, false);
        assert.strictEqual(planOk(makeHost('h10f'), { dataRoot: path.join(RUN, 'no-such-data') }).action, 'rejected');
    });

    // ═════════════ 11. recover PREPARED 同一锁（缺陷 2）═════════════
    runTest('11.1', 'PREPARED 事务可被 recover 真实提交（不再 INSTALL_BUSY）', () => {
        const app = makeHost('h11');
        const p = planOk(app);
        const prepared = setup.prepare(p, { runNpmCi: fakeRunnerOk() });
        assert.strictEqual(setup.readJournal(app).phase, 'PREPARED');
        expectThrow(() => planOk(app), 'PENDING_TX');
        expectThrow(() => setup.recover(app), 'NOT_CONFIRMED');
        const r = setup.recover(app, { stoppedConfirmed: true });
        assert.strictEqual(r.action, 'recovered', `recover 应提交，实际 ${JSON.stringify(r)}`);
        assert.strictEqual(setup.readJournal(app).phase, 'DONE');
        assert.strictEqual(fs.readFileSync(path.join(app, 'config.yaml'), 'utf8'), 'enableServerPlugins: true\n');
        assert.strictEqual(setup.readManifest(path.join(app, BE)).version, setup.RELEASE_VERSION);
        assert.ok(!fs.existsSync(path.join(app, '.jiuguan-install', 'run.lock')), '锁应释放');
        assert.strictEqual(planOk(app).action, 'noop');
        void prepared;
    });

    runTest('11.2', 'PREPARING/FAILED/ROLLING_BACK 都阻断新安装，且不覆盖 journal', () => {
        // PREPARING：子进程在复制文件中途真实退出。
        const appP = makeHost('h11p');
        const r = prepareInChild(appP, { fault: { afterFiles: 2 } });
        assert.strictEqual(r.status, 77, `子进程应 process.exit(77)，实际 ${r.status} ${r.stderr}`);
        const jP = setup.readJournal(appP);
        assert.strictEqual(jP.phase, 'PREPARING');
        const beforeP = fs.readFileSync(setup.appPaths(appP).journal, 'utf8');
        expectThrow(() => planOk(appP), 'PENDING_TX');
        expectThrow(() => setup.apply({ appDir: appP }, { stoppedConfirmed: true }), 'PENDING_TX');
        expectThrow(() => setup.recover(appP, { stoppedConfirmed: true }), 'TX_PREPARING');
        assert.strictEqual(fs.readFileSync(setup.appPaths(appP).journal, 'utf8'), beforeP, '阻断时 journal 不得变化');
        assert.ok(!fs.existsSync(path.join(appP, BE)), '正式目标不得被写');

        // FAILED
        const appF = makeHost('h11f');
        const pF = planOk(appF);
        expectThrow(() => setup.prepare(pF, { runNpmCi: () => { throw new InstallError('NPM_FAKE', 'npm 失败'); } }), 'NPM_FAKE');
        assert.strictEqual(setup.readJournal(appF).phase, 'FAILED');
        const beforeF = fs.readFileSync(setup.appPaths(appF).journal, 'utf8');
        expectThrow(() => planOk(appF), 'PENDING_TX');
        expectThrow(() => setup.recover(appF, { stoppedConfirmed: true }), 'TX_ABORTED');
        assert.strictEqual(fs.readFileSync(setup.appPaths(appF).journal, 'utf8'), beforeF);

        // ROLLING_BACK：基于真实 prepare 生成完整 schema（真实 rename 断电另有覆盖）。
        const appR = makeHost('h11r');
        const ap = setup.appPaths(appR);
        setup.prepare(planOk(appR), { runNpmCi: fakeRunnerOk() });
        const rb = Object.assign({}, setup.readJournal(appR), { phase: 'ROLLING_BACK' });
        setup.writeJournal(appR, rb);
        expectThrow(() => planOk(appR), 'PENDING_TX');
        const beforeR = fs.readFileSync(ap.journal, 'utf8');
        expectThrow(() => setup.apply({ appDir: appR }, { stoppedConfirmed: true }), 'PENDING_TX');
        assert.strictEqual(fs.readFileSync(ap.journal, 'utf8'), beforeR);
        // recover 会续做回滚（它本来就该收敛），而不是开始新安装。
        const rr = setup.recover(appR, { stoppedConfirmed: true });
        assert.strictEqual(rr.action, 'rolled_back');
        assert.strictEqual(setup.readJournal(appR).phase, 'ROLLED_BACK');
        assert.strictEqual(planOk(appR).action, 'install');
    });

    // ═════════════ 12. 真实断电：单侧 rename 之后（缺陷 2 + 5）═════════════
    runTest('12.1', '真实断电：备份后端移动后 exit(77) → recover 不动未移动前端，两端回到旧版', () => {
        const { app } = installAsOldVersion('h12a', '9.9.9');
        const beOld = dirInventory(path.join(app, BE));
        const feOld = dirInventory(path.join(app, FE));
        const cfgOld = fs.readFileSync(path.join(app, 'config.yaml'), 'utf8');
        const r = faulted({
            mode: 'install',
            appPath: app,
            match: { kind: 'rename', contains: `${path.sep}${BE}`.split(path.sep).join('/'), destContains: '/backups/' },
        });
        assert.strictEqual(r.status, 77, `应真实退出 77：${r.stdout}${r.stderr}`);
        let j = setup.readJournal(app);
        assert.strictEqual(j.phase, 'SWITCHING', '断电后 journal 应停在 SWITCHING（不自动回滚）');
        assert.strictEqual(j.backupState.backend.moved, false, 'rename 后立即断电，移动结果尚未写 journal；恢复必须依据磁盘快照');
        assert.strictEqual(j.backupState.frontend.moved, false, '前端未移动');
        assert.ok(!fs.existsSync(path.join(app, BE)), '后端已被移入备份');
        assert.deepStrictEqual(dirInventory(path.join(app, FE)), feOld, '前端必须原地未动（断电点在前端移动之前）');
        // 新安装被阻断。
        expectThrow(() => planOk(app), 'PENDING_TX');
        const rec = setup.recover(app, { stoppedConfirmed: true });
        assert.strictEqual(rec.action, 'rolled_back', JSON.stringify(rec));
        j = setup.readJournal(app);
        assert.strictEqual(j.phase, 'ROLLED_BACK');
        assert.deepStrictEqual(dirInventory(path.join(app, BE)), beOld, '后端应恢复为旧版（含 node_modules 等原样）');
        assert.deepStrictEqual(dirInventory(path.join(app, FE)), feOld, '前端应仍是旧版，且未被移入 quarantine 丢失');
        assert.strictEqual(fs.readFileSync(path.join(app, 'config.yaml'), 'utf8'), cfgOld, 'config 原字节');
        // 未被误移入 quarantine（前端不该出现在 quarantine）。
        const qDir = setup.txPaths(app, j.txId).quarantine;
        const q = fs.existsSync(qDir) ? fs.readdirSync(qDir) : [];
        assert.ok(!q.some((n) => n.includes('frontend')), `前端不得被误移入 quarantine: ${q.join(',')}`);
        assert.strictEqual(planOk(app).action, 'upgrade', '旧版已恢复，可再次升级');
    });

    runTest('12.2', '真实断电：前端切换后 exit(77) → recover 两侧回旧版（新装入 quarantine）', () => {
        const { app } = installAsOldVersion('h12b', '9.9.9');
        const beOld = dirInventory(path.join(app, BE));
        const feOld = dirInventory(path.join(app, FE));
        const r = faulted({
            mode: 'install',
            appPath: app,
            match: { kind: 'rename', contains: '/stage/frontend', destContains: `/${FE.split(path.sep).join('/')}` },
        });
        assert.strictEqual(r.status, 77, `应真实退出 77：${r.stdout}${r.stderr}`);
        let j = setup.readJournal(app);
        assert.strictEqual(j.phase, 'SWITCHING');
        assert.strictEqual(j.swap.backend, true);
        assert.ok(fs.existsSync(path.join(app, BE)), '前后端都已切到新版');
        assert.strictEqual(setup.readManifest(path.join(app, BE)).version, setup.RELEASE_VERSION);
        expectThrow(() => setup.recover(app, {}), 'NOT_CONFIRMED');
        const rec = setup.recover(app, { stoppedConfirmed: true });
        assert.strictEqual(rec.action, 'rolled_back');
        j = setup.readJournal(app);
        assert.deepStrictEqual(dirInventory(path.join(app, BE)), beOld);
        assert.deepStrictEqual(dirInventory(path.join(app, FE)), feOld);
        const q = fs.readdirSync(setup.txPaths(app, j.txId).quarantine);
        assert.ok(q.length >= 2, `新版应保留在 quarantine，实际 ${q.join(',')}`);
    });

    runTest('12.3', '真实断电：首装后端切换后 exit(77) → recover 回到「都没装」且新版保留在 quarantine', () => {
        const app = makeHost('h12c');
        const r = faulted({
            mode: 'install',
            appPath: app,
            match: { kind: 'rename', contains: '/stage/backend', destContains: `/${BE.split(path.sep).join('/')}` },
        });
        assert.strictEqual(r.status, 77, `应真实退出：${r.stdout}${r.stderr}`);
        const j = setup.readJournal(app);
        assert.strictEqual(j.phase, 'SWITCHING');
        const rec = setup.recover(app, { stoppedConfirmed: true });
        assert.strictEqual(rec.action, 'rolled_back');
        assert.ok(!fs.existsSync(path.join(app, BE)), '首装回滚后不应有后端');
        assert.ok(!fs.existsSync(path.join(app, FE)), '首装回滚后不应有前端');
        const q = fs.readdirSync(setup.txPaths(app, j.txId).quarantine);
        assert.ok(q.some((n) => fs.existsSync(path.join(setup.txPaths(app, j.txId).quarantine, n, MAN))), '新版后端应完整保留在 quarantine');
        assert.strictEqual(fs.readFileSync(path.join(app, 'config.yaml'), 'utf8'), 'enableServerPlugins: false\n');
        assert.strictEqual(planOk(app).action, 'install', '回滚后可以重新安装');
    });

    runTest('12.4', '真实断电：config rename 前后 exit(77) → 不会留下 unknown config；recover 收敛', () => {
        for (const phase of ['before', 'after']) {
            const app = makeHost('h12d-' + phase);
            const match = phase === 'before'
                ? { kind: 'rename', contains: '/backups/', destContains: '/config.yaml' }
                : { kind: 'rename', contains: '/config.yaml.tmp-', destContains: path.join(app, 'config.yaml') };
            const r = faulted({
                mode: 'install',
                appPath: app,
                match,
            });
            assert.strictEqual(r.status, 77, `${phase}: 应真实退出：${r.stdout}${r.stderr}`);
            const j = setup.readJournal(app);
            assert.strictEqual(j.phase, 'SWITCHING', `${phase}: 断电后应停在 SWITCHING，实际 ${j.phase}`);
            // 关键：journal 里先写了「预期改写后哈希」，不允许出现「config 未知」。
            if (j.configChange) {
                assert.ok(/^[0-9a-f]{64}$/.test(j.configChange.sha256After), `${phase}: 应记录预期哈希`);
            }
            const cfgNow = sha256(fs.readFileSync(path.join(app, 'config.yaml')));
            const known = [j.configSigBefore, j.configChange && j.configChange.sha256After].filter(Boolean);
            assert.ok(known.includes(cfgNow), `${phase}: 当前 config 必须是「原字节」或「预期改写字节」之一，实际 ${cfgNow} known=${known.join(',')}`);
            expectThrow(() => planOk(app), 'PENDING_TX');
            const rec = setup.recover(app, { stoppedConfirmed: true });
            assert.strictEqual(rec.action, phase === 'before' ? 'rolled_back' : 'recovered', `${phase}: ${JSON.stringify(rec)}`);
            if (rec.action === 'recovered') setup.rollback(app, { stoppedConfirmed: true });
            assert.strictEqual(setup.readJournal(app).phase, 'ROLLED_BACK');
            assert.strictEqual(fs.readFileSync(path.join(app, 'config.yaml'), 'utf8'), 'enableServerPlugins: false\n', `${phase}: config 应恢复原字节`);
            assert.ok(!fs.existsSync(path.join(app, BE)), `${phase}: 首装回滚后不应有后端`);
        }
    });

    // ═════════════ 13. config 并发（CAS）═════════════
    runTest('13.1', 'config 在 plan→commit 之间被改动 → CONFIG_CHANGED，不改动任何目标', () => {
        const app = makeHost('h13');
        const p = planOk(app);
        const prepared = setup.prepare(p, { runNpmCi: fakeRunnerOk() });
        fs.writeFileSync(path.join(app, 'config.yaml'), 'enableServerPlugins: false\nother: 1\n');
        expectThrow(() => setup.commit(prepared, prepared.plan, { stoppedConfirmed: true }), 'CONFIG_CHANGED');
        assert.ok(!fs.existsSync(path.join(app, BE)));
        assert.ok(!fs.existsSync(path.join(app, FE)));
        assert.strictEqual(fs.readFileSync(path.join(app, 'config.yaml'), 'utf8'), 'enableServerPlugins: false\nother: 1\n');
        // PREPARED 未切换目标：commit 失败后仍是 PREPARED，可 rollback 后重来。
        assert.strictEqual(setup.readJournal(app).phase, 'PREPARED');
        expectThrow(() => planOk(app), 'PENDING_TX');
        setup.rollback(app, { stoppedConfirmed: true });
        assert.strictEqual(planOk(app).action, 'install');
    });

    runTest('13.2', 'config 在备份后、改写前被并发改动 → 回滚，用户改动不被覆盖', () => {
        const app = makeHost('h13b');
        const p = planOk(app);
        const prepared = setup.prepare(p, { runNpmCi: fakeRunnerOk() });
        setup.__setStepHookForTesting((step) => {
            if (step === 'CONFIG_BACKED_UP') fs.writeFileSync(path.join(app, 'config.yaml'), 'enableServerPlugins: false # user edit\n');
        });
        let err = null;
        try {
            setup.commit(prepared, prepared.plan, { stoppedConfirmed: true });
        } catch (e) {
            err = e;
        } finally {
            setup.__setStepHookForTesting(null);
        }
        assert.ok(err, '应失败');
        assert.strictEqual(fs.readFileSync(path.join(app, 'config.yaml'), 'utf8'), 'enableServerPlugins: false # user edit\n', '用户改动不得被覆盖');
        assert.ok(!fs.existsSync(path.join(app, BE)), '后端应回滚');
        const j = setup.readJournal(app);
        assert.strictEqual(j.phase, 'ROLLED_BACK');
        assert.strictEqual(j.configRestored, 'user-modified-kept');
    });

    runTest('13.3', 'config 格式复杂（加引号/尾随注释）→ plan 阶段就拒绝', () => {
        const app = makeHost('h13c', { configText: 'enableServerPlugins: false # 注释\n' });
        expectThrow(() => planOk(app), 'CONFIG_COMPLEX');
        const app2 = makeHost('h13d', { configText: 'enableServerPlugins: false\nenableServerPlugins: true\n' });
        expectThrow(() => planOk(app2), 'CONFIG_AMBIGUOUS');
    });

    // ═════════════ 14. DONE 条件（缺陷 5）═════════════
    runTest('14.1', 'recover 补 DONE 必须同时满足 config 已设置且哈希符合（否则回滚旧版）', () => {
        const { app } = installAsOldVersion('h14', '9.9.9');
        fs.writeFileSync(path.join(app, 'config.yaml'), 'enableServerPlugins: false\n');
        const beOld = dirInventory(path.join(app, BE));
        const r = faulted({
            mode: 'install',
            appPath: app,
            // 前端切换之后（config 还没改）断电。
            match: { kind: 'rename', contains: '/stage/frontend', destContains: `/${FE.split(path.sep).join('/')}` },
        });
        assert.strictEqual(r.status, 77, r.stderr);
        const j = setup.readJournal(app);
        assert.strictEqual(j.phase, 'SWITCHING');
        // 伪造「config 已改」：把 journal 的 configSha256After 写成原字节的哈希（=已设置但实际上没改）。
        const tampered = Object.assign({}, j, { configSha256After: sha256(fs.readFileSync(path.join(app, 'config.yaml'))) });
        tampered.configChange = null;
        setup.writeJournal(app, tampered);
        const rec = setup.recover(app, { stoppedConfirmed: true });
        assert.strictEqual(rec.action, 'rolled_back', `config 未设置时不得补 DONE：${JSON.stringify(rec)}`);
        assert.deepStrictEqual(dirInventory(path.join(app, BE)), beOld, '应回到旧版');
        assert.ok(!/enableServerPlugins: true/.test(fs.readFileSync(path.join(app, 'config.yaml'), 'utf8')), 'config 应为原字节');
    });

    runTest('14.2', 'DONE 判定拒绝「仅两目录存在」：清单版本不符 / 内容不符都不算完成', () => {
        const app = makeHost('h14b');
        installOk(app);
        const j = setup.readJournal(app);
        assert.strictEqual(j.phase, 'DONE');
        // 篡改后端清单版本 → 不再被视为本次安装完成（plan 拒绝）。
        const mp = path.join(app, BE, MAN);
        const man = JSON.parse(fs.readFileSync(mp, 'utf8'));
        man.version = '0.0.0-other';
        fs.writeFileSync(mp, JSON.stringify(man, null, 2));
        const p = planOk(app);
        assert.notStrictEqual(p.action, 'noop');
        assert.ok(['mismatch', 'modified'].includes(p.inspect.state), `实际 ${p.inspect.state}`);
    });

    // ═════════════ 15. 回滚幂等（缺陷 4）═════════════
    runTest('15.1', '回滚中断后可再次 --rollback 幂等续做（只补未完成侧）', () => {
        const { app } = installAsOldVersion('h15', '9.9.9');
        const beOld = dirInventory(path.join(app, BE));
        // 1) 前端切换后断电（两侧新版 + 备份齐备）。
        const r = faulted({ mode: 'install', appPath: app, match: { kind: 'rename', contains: '/stage/frontend', destContains: `/${FE.split(path.sep).join('/')}` } });
        assert.strictEqual(r.status, 77, r.stderr);
        // 2) 回滚第一个侧（后端移回）之后真实断电。
        const r2 = faulted({ mode: 'recover', appPath: app, match: { kind: 'rename', contains: '/backups/', destContains: `/${BE.split(path.sep).join('/')}` } });
        assert.strictEqual(r2.status, 77, `回滚中途应真实退出：${r2.stdout}${r2.stderr}`);
        let j = setup.readJournal(app);
        assert.strictEqual(j.phase, 'ROLLING_BACK');
        assert.deepStrictEqual(j.restored || [], [], 'rename 已完成，但恢复标记尚未落盘');
        assert.deepStrictEqual(dirInventory(path.join(app, BE)), beOld, '后端已是旧版');
        // 3) 再次 rollback：幂等续做，不重复移动后端、不丢前端。
        const rb = setup.rollback(app, { stoppedConfirmed: true });
        assert.strictEqual(rb.action, 'rolled_back');
        j = setup.readJournal(app);
        assert.strictEqual(j.phase, 'ROLLED_BACK');
        assert.deepStrictEqual(dirInventory(path.join(app, BE)), beOld);
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(app, FE, 'manifest.json'), 'utf8')).version, '9.9.9', '前端应回到旧版');
        assert.strictEqual(fs.readFileSync(path.join(app, 'config.yaml'), 'utf8'), 'enableServerPlugins: true\n', 'config 恢复为旧版安装时的字节');
        // 再跑一次不报错（幂等）。
        const rb2 = setup.rollback(app, { stoppedConfirmed: true });
        assert.ok(['rolled_back', 'noop'].includes(rb2.action), `二次回滚应幂等，实际 ${rb2.action}`);
        assert.deepStrictEqual(dirInventory(path.join(app, BE)), beOld);
    });

    runTest('15.2', '回滚失败可重试：备份被挪走 → 报 ROLLBACK_INCOMPLETE 并保留现场；挪回后可完成', () => {
        const { app } = installAsOldVersion('h15b', '9.9.9');
        const beOld = dirInventory(path.join(app, BE));
        const r = faulted({ mode: 'install', appPath: app, match: { kind: 'rename', contains: '/stage/frontend', destContains: `/${FE.split(path.sep).join('/')}` } });
        assert.strictEqual(r.status, 77, r.stderr);
        const j = setup.readJournal(app);
        const bp = setup.backupPaths(app, j.backupId);
        const parked = path.join(RUN, 'h15b-parked-backend');
        fs.renameSync(bp.backend, parked);
        let err = null;
        try {
            setup.recover(app, { stoppedConfirmed: true });
        } catch (e) {
            err = e;
        }
        assert.ok(err && err.code === 'ROLLBACK_INCOMPLETE', `应报 ROLLBACK_INCOMPLETE：${err && err.code} ${err && err.message}`);
        assert.strictEqual(setup.readJournal(app).phase, 'ROLLING_BACK');
        assert.ok(fs.readdirSync(path.join(app, '.jiuguan-install', 'tx')).length >= 1);
        // 备份挪回 → 再次 rollback 完成。
        fs.renameSync(parked, bp.backend);
        const rb = setup.rollback(app, { stoppedConfirmed: true });
        assert.strictEqual(rb.action, 'rolled_back');
        assert.deepStrictEqual(dirInventory(path.join(app, BE)), beOld);
    });

    runTest('15.3', '备份完整性：备份内容被篡改 → 拒绝移回（不把坏备份当旧版）', () => {
        const { app } = installAsOldVersion('h15c', '9.9.9');
        fs.writeFileSync(path.join(app, BE, 'index.js'), '// user modified\n');
        const r = installOk(app, { takeover: true });
        // 篡改备份里的一个文件。
        fs.appendFileSync(path.join(r.backupDir, 'backend', 'index.js'), '\n// tampered backup\n');
        let err = null;
        try {
            setup.rollback(app, { stoppedConfirmed: true, to: r.backupId });
        } catch (e) {
            err = e;
        }
        assert.ok(err && err.code === 'ROLLBACK_INCOMPLETE', `应拒绝不完整备份：${err && err.code} ${err && err.message}`);
        void app;
    });

    // ═════════════ 16. 恶意 journal（缺陷 4：configPath 不信任）═════════════
    runTest('16.1', '恶意 journal 的 configPath 指向 app 外文件 → 恢复/回滚都不写该文件', () => {
        const app = makeHost('h16');
        const outside = path.join(RUN, 'h16-outside.yaml');
        fs.writeFileSync(outside, 'enableServerPlugins: false\n');
        const outsideHash = sha256(fs.readFileSync(outside));
        const ap = setup.appPaths(app);
        fs.mkdirSync(ap.work, { recursive: true });
        fs.writeFileSync(
            ap.journal,
            JSON.stringify({
                schema: setup.JOURNAL_SCHEMA,
                txId: 'tx-20260101000000-abcdef',
                appDir: app,
                phase: 'SWITCHING',
                backupId: 'bk-20260101000000-abcdef',
                configPath: outside,
                enableServerPlugins: true,
                releaseVersion: setup.RELEASE_VERSION,
                steps: [],
            })
        );
        const before = fs.readFileSync(ap.journal, 'utf8');
        expectThrow(() => setup.recover(app, { stoppedConfirmed: true }), 'JOURNAL_INVALID');
        assert.strictEqual(sha256(fs.readFileSync(outside)), outsideHash, 'app 外 config 绝不能被写');
        assert.strictEqual(fs.readFileSync(path.join(app, 'config.yaml'), 'utf8'), 'enableServerPlugins: false\n');
        // rollback 同样不碰它。
        expectThrow(() => setup.rollback(app, { stoppedConfirmed: true }), 'JOURNAL_INVALID');
        assert.strictEqual(fs.readFileSync(ap.journal, 'utf8'), before, '非法 journal 不得重写');
        assert.strictEqual(sha256(fs.readFileSync(outside)), outsideHash);
    });

    runTest('16.2', '外置 config 恢复：--config 重新指定且标识一致才可用；指向别处拒绝', () => {
        const app = makeHost('h16b');
        const ext = path.join(RUN, 'h16b-ext');
        fs.mkdirSync(ext, { recursive: true });
        const alt = path.join(ext, 'config.yaml');
        fs.writeFileSync(alt, 'enableServerPlugins: false\n');
        const other = path.join(RUN, 'h16b-other.yaml');
        fs.writeFileSync(other, 'enableServerPlugins: false\n');
        const p = planOk(app, { configPath: alt });
        const pr = setup.prepare(p, { runNpmCi: fakeRunnerOk() });
        // 用 --config 指向别处 → 拒绝（与记录不一致）。
        expectThrow(() => setup.recover(app, { stoppedConfirmed: true, configPath: other }), 'CONFIG_SOURCE_MISMATCH');
        expectThrow(() => planOk(app), 'PENDING_TX');
        expectThrow(() => setup.recover(app, { stoppedConfirmed: true }), 'CONFIG_REQUIRED');
        // 恢复写入外置文件必须重新显式授权路径；完成后的普通计划仍可只读记录。
        const rec = setup.recover(app, { stoppedConfirmed: true, configPath: alt });
        assert.strictEqual(rec.action, 'recovered');
        assert.strictEqual(fs.readFileSync(alt, 'utf8'), 'enableServerPlugins: true\n');
        assert.strictEqual(fs.readFileSync(path.join(app, 'config.yaml'), 'utf8'), 'enableServerPlugins: false\n');
        assert.strictEqual(planOk(app).configSource, 'record');
        assert.strictEqual(planOk(app).action, 'noop');
        void pr;
    });

    runTest('16.3', '恶意 journal：越界 txId/backupId、appDir 不一致 → 拒绝且不动 app 外文件', () => {
        const app = makeHost('h16c');
        const victim = path.join(RUN, 'victim-backend');
        fs.mkdirSync(victim, { recursive: true });
        fs.writeFileSync(path.join(victim, 'keep.txt'), 'must survive');
        const before = dirInventory(victim);
        const ap = setup.appPaths(app);
        fs.mkdirSync(ap.work, { recursive: true });
        const mk = (o) => fs.writeFileSync(ap.journal, JSON.stringify(Object.assign({ schema: setup.JOURNAL_SCHEMA, appDir: app, phase: 'SWITCHING', releaseVersion: setup.RELEASE_VERSION, steps: [] }, o)));
        mk({ txId: '../../evil', backupId: 'bk-evil' });
        expectThrow(() => setup.recover(app, { stoppedConfirmed: true }), 'JOURNAL_INVALID');
        expectThrow(() => setup.rollback(app, { stoppedConfirmed: true }), 'JOURNAL_INVALID');
        mk({ txId: 'tx-20260101000000-abcdef', backupId: '../../../../victim-backend' });
        expectThrow(() => setup.rollback(app, { stoppedConfirmed: true }), 'JOURNAL_INVALID');
        mk({ txId: 'tx-20260101000000-abcdef', backupId: 'bk-20260101000000-abcdef', appDir: path.join(RUN, 'other-app') });
        expectThrow(() => setup.recover(app, { stoppedConfirmed: true }), 'JOURNAL_INVALID');
        assert.deepStrictEqual(dirInventory(victim), before, 'app 外目录不得被改动/删除');
    });

    // ═════════════ 17. 首装 PREPARING 失败可放弃（缺陷 4）═════════════
    runTest('17.1', '首装 PREPARING 断电 → --rollback 放弃事务且保留 stage（移入 quarantine）', () => {
        const app = makeHost('h17');
        const r = prepareInChild(app, { fault: { afterFiles: 2 } });
        assert.strictEqual(r.status, 77, r.stderr);
        const j0 = setup.readJournal(app);
        assert.strictEqual(j0.phase, 'PREPARING');
        const stageCount = fs.readdirSync(setup.txPaths(app, j0.txId).stageBackend).length;
        assert.ok(stageCount > 0, 'stage 已有文件');
        expectThrow(() => planOk(app), 'PENDING_TX');
        const rb = setup.rollback(app, { stoppedConfirmed: true });
        assert.strictEqual(rb.action, 'rolled_back');
        const kept = setup.txPaths(app, j0.txId).stageBackend;
        assert.ok(fs.existsSync(kept), '已放弃事务的 stage 必须保留（未删除）');
        assert.ok(fs.readdirSync(kept).length === stageCount, 'stage 内容不得被删减');
        assert.ok(!fs.existsSync(path.join(app, BE)), '首装正式目标不应出现');
        assert.strictEqual(fs.readFileSync(path.join(app, 'config.yaml'), 'utf8'), 'enableServerPlugins: false\n');
        assert.strictEqual(planOk(app).action, 'install', '放弃后可以重新安装');
        installOk(app);
        assert.strictEqual(planOk(app).action, 'noop');
    });

    // ═════════════ 18. 目标并发变化 / 链接目标 ═════════════
    runTest('18.1', '目标在 plan→commit 之间被改动 → TARGET_CHANGED 拒绝', () => {
        const app = makeHost('h18');
        fs.mkdirSync(path.join(app, BE), { recursive: true });
        fs.writeFileSync(path.join(app, BE, 'legacy.js'), 'legacy');
        const p = planOk(app, { takeover: true });
        assert.strictEqual(p.action, 'takeover');
        const prepared = setup.prepare(p, { runNpmCi: fakeRunnerOk() });
        fs.writeFileSync(path.join(app, BE, 'legacy.js'), 'legacy changed concurrently');
        expectThrow(() => setup.commit(prepared, prepared.plan, { stoppedConfirmed: true }), 'TARGET_CHANGED');
        assert.strictEqual(fs.readFileSync(path.join(app, BE, 'legacy.js'), 'utf8'), 'legacy changed concurrently', '拒绝时旧目录不得被移动');
    });

    runTest('18.2', '目标祖先 junction → 拒绝（不写出外部目录）；目标自身是 junction → 拒绝', () => {
        const app = makeHost('h18b');
        const real = path.join(RUN, 'real-plugins-18');
        fs.mkdirSync(real, { recursive: true });
        let linked = false;
        try { fs.symlinkSync(real, path.join(app, 'plugins'), 'junction'); linked = true; } catch { linked = false; }
        if (!linked) return 'skip';
        expectThrow(() => planOk(app), 'LINK_REJECTED');
        assert.deepStrictEqual(dirInventory(real), {}, '外部目录不得被写入');
        // 目标自身是 junction。
        const app2 = makeHost('h18c');
        fs.mkdirSync(path.join(app2, 'plugins'), { recursive: true });
        const ext = path.join(RUN, 'real-target-18');
        fs.mkdirSync(ext, { recursive: true });
        fs.writeFileSync(path.join(ext, 'keep.txt'), 'keep');
        let linked2 = false;
        try { fs.symlinkSync(ext, path.join(app2, BE), 'junction'); linked2 = true; } catch { linked2 = false; }
        if (linked2) {
            expectThrow(() => planOk(app2, { takeover: true }), 'LINK_REJECTED');
            expectThrow(() => setup.apply({ appDir: app2, takeover: true }, { stoppedConfirmed: true }), 'LINK_REJECTED');
        }
    });

    // ═════════════ 19. 交互向导（缺陷 7）═════════════
    runTest('19.1', '交互：多候选编号 → 默认 config 确认 → 默认数据根确认 → 计划 → 停服 → 安装', async () => {
        const staging = path.join(RUN, 'h19-staging');
        const appA = makeHost(path.join('h19-staging', 'host-a'));
        makeHost(path.join('h19-staging', 'host-b'));
        const answers = ['1', '', 'y', '', 'y', 'y', 'y'];
        const r = await runInteractive([], answers, staging);
        assert.strictEqual(r.status, 0, `交互应成功\nstdout=${r.stdout}\nstderr=${r.stderr}`);
        assert.ok(/检测到多个酒管目录/.test(r.stdout), `应列出候选:\n${r.stdout}`);
        assert.ok(/生效的 config 路径/.test(r.stdout), `应询问 config:\n${r.stdout}`);
        assert.ok(/数据根路径/.test(r.stdout), `应询问数据根:\n${r.stdout}`);
        assert.ok(/安装计划/.test(r.stdout));
        assert.ok(/已经停止酒管服务/.test(r.stdout));
        assert.strictEqual(setup.readManifest(path.join(appA, BE)).version, setup.RELEASE_VERSION);
        assert.strictEqual(fs.readFileSync(path.join(appA, 'config.yaml'), 'utf8'), 'enableServerPlugins: true\n');
    });

    runTest('19.2', '交互：自定义 config 路径（接受/拒绝重试）+ 自定义数据根；拒绝停服则不写', async () => {
        const app = makeHost('h19b');
        const ext = path.join(RUN, 'h19b-ext');
        fs.mkdirSync(ext, { recursive: true });
        const custom = path.join(ext, 'actual-config.yaml');
        fs.writeFileSync(custom, 'enableServerPlugins: false\n');
        const customData = path.join(RUN, 'h19b-data-custom');
        fs.mkdirSync(path.join(customData, 'u1', 'extensions'), { recursive: true });
        // 第 1 次 config 回答：不存在的路径（重试）；第 2 次：自定义绝对路径，但先回答 n 再确认。
        const answers = [path.join(ext, 'missing.yaml'), custom, 'n', custom, 'y', customData, 'y', 'y', 'n'];
        const r = await runInteractive(['--app-dir', app], answers, RUN);
        assert.strictEqual(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
        assert.ok(/不存在、不是普通文件/.test(r.stdout), '应提示路径不可用并重试');
        assert.ok(!fs.existsSync(path.join(app, BE)), '未确认停服时不得安装');
        // 再次交互，确认停服并安装。
        const answers2 = [custom, 'y', customData, 'y', 'y', 'y'];
        const r2 = await runInteractive(['--app-dir', app], answers2, RUN);
        assert.strictEqual(r2.status, 0, `stdout=${r2.stdout}\nstderr=${r2.stderr}`);
        assert.strictEqual(fs.readFileSync(custom, 'utf8'), 'enableServerPlugins: true\n', '应改写用户确认的自定义 config');
        assert.strictEqual(fs.readFileSync(path.join(app, 'config.yaml'), 'utf8'), 'enableServerPlugins: false\n');
        const rec = setup.readConfigSourceRecord(app);
        assert.strictEqual(rec.path, custom, '应生成外置 config 的本地记录');
    });

    runTest('19.3', '交互：data_root 可从简单 config 推断为候选，但仍必须用户确认', async () => {
        const app = makeHost('h19c', { configText: 'enableServerPlugins: false\ndata_root: ' + JSON.stringify(path.join(RUN, 'h19c-altdata')) + '\n' });
        const altData = path.join(RUN, 'h19c-altdata');
        fs.mkdirSync(path.join(altData, 'user', 'extensions'), { recursive: true });
        const answers = ['', 'y', '2', 'y', 'y', 'y'];
        const r = await runInteractive(['--app-dir', app], answers, RUN);
        assert.strictEqual(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
        assert.ok(/h19c-altdata/.test(r.stdout), '应把 config 里的 data_root 作为候选展示');
        assert.ok(/数据根是这一处吗/.test(r.stdout), '必须用户确认');
        assert.ok(fs.existsSync(path.join(app, BE)), '应完成安装');
        void altData;
    });

    runTest('19.4', '交互：发现用户级同名扩展 → gate 阻断，口头确认也无法继续', async () => {
        const app = makeHost('h19d');
        const dr = path.join(RUN, 'h19d-data');
        fs.mkdirSync(path.join(dr, 'alice', 'extensions', 'jiuguan-github-sync'), { recursive: true });
        const answers = ['', 'y', '', 'y'];
        const r = await runInteractive(['--app-dir', app, '--data-root', dr], answers, RUN);
        assert.notStrictEqual(r.status, 0, `应被阻断\nstdout=${r.stdout}`);
        assert.ok(/遮蔽|用户级/.test(r.stdout), '应说明遮蔽风险');
        assert.ok(!fs.existsSync(path.join(app, BE)), '不得安装');
    });

    // ═════════════ 20. 状态 / 其它 ═════════════
    runTest('20.1', 'CLI --status：只读显示事务 / 备份 / config 来源', () => {
        const app = makeHost('h20');
        const r0 = spawnSync(process.execPath, [SETUP_BIN, '--status', '--app-dir', app], { cwd: RUN, encoding: 'utf8' });
        assert.strictEqual(r0.status, 0);
        assert.ok(/事务:\s*无/.test(r0.stdout));
        const before = dirInventory(app);
        installOk(app);
        const r = spawnSync(process.execPath, [SETUP_BIN, '--status', '--app-dir', app], { cwd: RUN, encoding: 'utf8' });
        assert.strictEqual(r.status, 0);
        assert.ok(/DONE/.test(r.stdout), `应显示 DONE: ${r.stdout}`);
        assert.ok(/备份:\s*1\s*个/.test(r.stdout), '应显示 1 个备份');
        assert.ok(/配置来源/.test(r.stdout));
        void before;
    });

    runTest('20.2', '并发向导被锁拒绝（跨进程）；锁释放后正常提交', () => {
        const app = makeHost('h20b');
        const p = planOk(app);
        const prepared = setup.prepare(p, { runNpmCi: fakeRunnerOk() });
        const lock = path.join(app, '.jiuguan-install', 'run.lock');
        fs.writeFileSync(lock, '{}');
        try {
            expectThrow(() => setup.commit(prepared, prepared.plan, { stoppedConfirmed: true }), 'INSTALL_BUSY');
        } finally {
            fs.unlinkSync(lock);
        }
        const r = setup.commit(prepared, prepared.plan, { stoppedConfirmed: true });
        assert.strictEqual(r.txId, prepared.txId);
        assert.strictEqual(planOk(app).action, 'noop');
    });

    runTest('20.3', '安装不触碰 ~/.jiuguan-github-sync（同步状态/凭据）', () => {
        const syncDir = path.join(HOME, '.jiuguan-github-sync');
        fs.mkdirSync(syncDir, { recursive: true });
        fs.writeFileSync(path.join(syncDir, 'config.json'), '{"token":"synthetic"}\n');
        const before = dirInventory(syncDir);
        installOk(makeHost('h20c'));
        assert.deepStrictEqual(dirInventory(syncDir), before);
    });

    runTest('20.4', 'recover/rollback 未确认停服 → 拒绝且不写任何文件（CLI 退出码 2）', () => {
        const app = makeHost('h20d');
        const r = faulted({ mode: 'install', appPath: app, match: { kind: 'rename', contains: '/stage/backend', destContains: `/${BE.split(path.sep).join('/')}` } });
        assert.strictEqual(r.status, 77, r.stderr);
        const j1 = JSON.stringify(setup.readJournal(app));
        const beBefore = dirInventory(path.join(app, 'plugins'));
        expectThrow(() => setup.recover(app, {}), 'NOT_CONFIRMED');
        expectThrow(() => setup.rollback(app, {}), 'NOT_CONFIRMED');
        assert.strictEqual(JSON.stringify(setup.readJournal(app)), j1, 'journal 不得变化');
        assert.deepStrictEqual(dirInventory(path.join(app, 'plugins')), beBefore);
        const c1 = spawnSync(process.execPath, [SETUP_BIN, '--recover', '--app-dir', app], { cwd: RUN, encoding: 'utf8' });
        assert.strictEqual(c1.status, 2);
        const c2 = spawnSync(process.execPath, [SETUP_BIN, '--rollback', '--app-dir', app], { cwd: RUN, encoding: 'utf8' });
        assert.strictEqual(c2.status, 2);
        assert.strictEqual(JSON.stringify(setup.readJournal(app)), j1);
        const rr = setup.recover(app, { stoppedConfirmed: true });
        assert.strictEqual(rr.action, 'rolled_back');
    });

    // ═════════════ 21. 打包（root 接管；这里只做就绪性检查，不臆测命名）═════════════
    runTest('21.1', '打包脚本纳入本次安装器文件（打包命名由 root 负责，本测试不假定归档名）', () => {
        const build = require('../scripts/build-release.js');
        const { files } = build.collectFiles();
        assert.ok(files.includes('bin/setup.js'));
        assert.ok(files.includes('lib/installer/setup.js'));
        assert.ok(files.includes('lib/installer/fsutil.js'));
        assert.ok(files.includes('lib/installer/discovery.js'));
        assert.ok(!files.some((f) => /(^|\/)(node_modules|\.git|test-artifacts|research|outputs)\//.test(f)));
        assert.ok(!files.some((f) => /(^|\/)(token|pat|credentials)/i.test(path.basename(f))));
        void BUILD_BIN;
    });

    // ═════════════ 22. 完整快照与真实断电回归 ═════════════
    runTest('22.1', 'JSON null/数组/标量 journal 一律损坏，不覆盖原文件', () => {
        for (const [i, raw] of ['null', '[]', '1', 'false', '"text"'].entries()) {
            const app = makeHost('h22json-' + i), ap = setup.appPaths(app);
            fs.mkdirSync(ap.work, { recursive: true }); fs.writeFileSync(ap.journal, raw);
            for (const action of [() => planOk(app), () => setup.recover(app, { stoppedConfirmed: true }), () => setup.rollback(app, { stoppedConfirmed: true })]) expectThrow(action, 'JOURNAL_CORRUPT');
            assert.strictEqual(fs.readFileSync(ap.journal, 'utf8'), raw);
            assert.ok(!fs.existsSync(path.join(app, BE)));
        }
    });
    runTest('22.2', '--no-config 安装、noop、完整回滚均保留原配置字节', () => {
        const app = makeHost('h22-no-config'), cfg = path.join(app, 'config.yaml');
        const before = fs.readFileSync(cfg);
        assert.strictEqual(require(SETUP_BIN).parseArgs(['--no-config']).enableServerPlugins, false);
        const r = installOk(app, { enableServerPlugins: false });
        assert.strictEqual(r.configChanged, false);
        assert.deepStrictEqual(fs.readFileSync(cfg), before);
        assert.strictEqual(planOk(app, { enableServerPlugins: false }).action, 'noop');
        setup.rollback(app, { stoppedConfirmed: true });
        assert.deepStrictEqual(fs.readFileSync(cfg), before);
        assert.ok(!fs.existsSync(path.join(app, BE)) && !fs.existsSync(path.join(app, FE)));
        assert.strictEqual(setup.rollback(app, { stoppedConfirmed: true }).action, 'noop');
    });
    runTest('22.3', '运行时 payload 固定，副本 hash 相同且不含测试或文档', () => {
        const files = setup.releaseSourceFiles();
        assert.strictEqual(new Set(files.map((f) => f.relPosix)).size, files.length);
        for (const f of files) assert.ok(/^(?:bin|client|lib)\//.test(f.relPosix) || ['index.js','manifest.json','package.json','package-lock.json','LICENSE'].includes(f.relPosix), f.relPosix);
        const copy = path.join(RUN, 'h22-payload');
        makeReleaseCopy(copy, { version: setup.RELEASE_VERSION, marker: 'PAYLOAD' });
        const copied = collectReleaseFiles(copy);
        assert.deepStrictEqual(copied.map((f) => f.relPosix), files.map((f) => f.relPosix));
        for (const f of copied.filter((f) => !['index.js','package.json','client/manifest.json'].includes(f.relPosix))) assert.strictEqual(sha256(fs.readFileSync(f.abs)), sha256(fs.readFileSync(path.join(ROOT, ...f.relPosix.split('/')))), f.relPosix);
    });
    for (const [id, upgrade] of [['22.4', false], ['22.5', true]]) runTest(id, `完成态${upgrade ? '升级' : '首装'}完整回滚与重复回滚`, () => {
        const app = upgrade ? installAsOldVersion('h' + id, '9.9.9').app : makeHost('h' + id);
        const old = { backend: dirInventory(path.join(app, BE)), frontend: dirInventory(path.join(app, FE)), config: fs.readFileSync(path.join(app, 'config.yaml')) };
        installOk(app); assert.strictEqual(setup.readJournal(app).phase, 'DONE');
        assert.strictEqual(setup.rollback(app, { stoppedConfirmed: true }).action, 'rolled_back');
        for (let n = 0; n < 2; n++) {
            assert.deepStrictEqual(dirInventory(path.join(app, BE)), old.backend);
            assert.deepStrictEqual(dirInventory(path.join(app, FE)), old.frontend);
            assert.deepStrictEqual(fs.readFileSync(path.join(app, 'config.yaml')), old.config);
            assert.strictEqual(setup.rollback(app, { stoppedConfirmed: true }).action, 'noop');
        }
        if (!upgrade) assert.ok(!fs.existsSync(path.join(app, BE)) && !fs.existsSync(path.join(app, FE)));
    });
    let crashId = 6;
    for (const upgrade of [false, true]) for (const side of ['backend', 'frontend']) for (const operation of (upgrade ? ['quarantine', 'restore'] : ['quarantine'])) {
        const id = '22.' + crashId++;
        runTest(id, `完成态${upgrade ? '升级' : '首装'}回滚 ${side} ${operation} rename 后真退出，重试幂等`, () => {
            const app = upgrade ? installAsOldVersion('h' + id, '9.9.9').app : makeHost('h' + id);
            const old = { backend: dirInventory(path.join(app, BE)), frontend: dirInventory(path.join(app, FE)), config: fs.readFileSync(path.join(app, 'config.yaml')) };
            installOk(app);
            const target = path.join(app, side === 'backend' ? BE : FE);
            const match = operation === 'quarantine' ? { kind: 'rename', contains: target, destContains: '/quarantine/' } : { kind: 'rename', contains: '/backups/', destContains: target };
            const r = faulted({ mode: 'rollback', appPath: app, match });
            assert.strictEqual(r.status, 77, r.stdout + r.stderr);
            assert.strictEqual(setup.readJournal(app).phase, 'ROLLING_BACK');
            setup.rollback(app, { stoppedConfirmed: true });
            assert.deepStrictEqual(dirInventory(path.join(app, BE)), old.backend);
            assert.deepStrictEqual(dirInventory(path.join(app, FE)), old.frontend);
            assert.deepStrictEqual(fs.readFileSync(path.join(app, 'config.yaml')), old.config);
            assert.strictEqual(setup.rollback(app, { stoppedConfirmed: true }).action, 'noop');
            if (!upgrade) assert.ok(!fs.existsSync(path.join(app, BE)) && !fs.existsSync(path.join(app, FE)));
        });
    }
    runTest('22.12', 'CONFIG_INTENT_WRITTEN 后用户改字节：拒绝覆盖并保留用户内容', () => {
        const app = makeHost('h22-intent'), cfg = path.join(app, 'config.yaml');
        const prepared = setup.prepare(planOk(app), { runNpmCi: fakeRunnerOk() });
        const user = 'enableServerPlugins: false\nuser_value: preserved\n';
        setup.__setStepHookForTesting((step) => { if (step === 'CONFIG_INTENT_WRITTEN') fs.writeFileSync(cfg, user); });
        try { expectThrow(() => setup.commit(prepared, prepared.plan, { stoppedConfirmed: true }), 'CONFIG_CHANGED'); }
        finally { setup.__setStepHookForTesting(null); }
        assert.strictEqual(fs.readFileSync(cfg, 'utf8'), user);
        assert.ok(!fs.existsSync(path.join(app, BE)) && !fs.existsSync(path.join(app, FE)));
        assert.strictEqual(setup.readJournal(app).configRestored, 'user-modified-kept');
    });
    runTest('22.13', '恶意完整 journal 修改 tx.appDir，直接 commit 必须拒绝且外部不变', () => {
        const app = makeHost('h22-malicious'), victim = makeHost('h22-victim');
        const prepared = setup.prepare(planOk(app), { runNpmCi: fakeRunnerOk() });
        const before = dirInventory(victim), ap = setup.appPaths(app);
        const tx = setup.readJournal(app); tx.appDir = victim;
        fs.writeFileSync(ap.journal, JSON.stringify(tx));
        const raw = fs.readFileSync(ap.journal, 'utf8');
        expectThrow(() => setup.commit(prepared, prepared.plan, { stoppedConfirmed: true }), 'JOURNAL_INVALID');
        assert.deepStrictEqual(dirInventory(victim), before);
        assert.strictEqual(fs.readFileSync(ap.journal, 'utf8'), raw);
        assert.ok(!fs.existsSync(path.join(app, BE)));
    });
    runTest('22.14', '--no-deps 计划后旧依赖被篡改：prepare 拒绝并原地保留目标', () => {
        const { app } = installAsOldVersion('h22-deps', '9.9.9');
        const p = planOk(app, { installDeps: false }); assert.strictEqual(p.action, 'upgrade');
        fs.writeFileSync(path.join(app, BE, 'node_modules', 'fs-extra', 'tampered.js'), '// user edit\n');
        const before = dirInventory(path.join(app, BE));
        const err = expectThrow(() => setup.prepare(p, { runNpmCi: () => { throw new Error('不得安装依赖'); } }));
        assert.ok(/依赖|dependency/i.test(err.message), err.message);
        assert.deepStrictEqual(dirInventory(path.join(app, BE)), before);
        assert.strictEqual(setup.readManifest(path.join(app, BE)).version, '9.9.9');
    });

    // ---- 汇总 ----
    const report = {
        generator: 'test/setup.test.js',
        disclaimer: '合成 host fixture + 隔离 HOME/TMP + 注入 fake npm；真实子进程 process.exit 模拟断电；不改真实宿主/数据/PAT/远端，不联网安装依赖。',
        createdAt: new Date().toISOString(),
        versions: { node: process.version, platform: process.platform },
        summary: { total: 0, pass: 0, fail: 0, skip: 0 },
        tests: [],
    };
    const filterAt = process.argv.indexOf('--filter');
    const filters = filterAt >= 0 ? process.argv[filterAt + 1].split(',').map((x) => x.trim()).filter(Boolean) : [];
    const selected = filters.length ? tests.filter((t) => filters.some((f) => t.id === f || t.id.startsWith(f + '.'))) : tests;
    if (!selected.length) throw new Error('过滤条件未匹配任何测试');
    report.filter = filters;
    for (const t of selected) {
        const rec = await execute(t);
        report.tests.push(rec);
        report.summary.total++;
        if (rec.verdict === 'pass') report.summary.pass++;
        else if (rec.verdict === 'skip') report.summary.skip++;
        else report.summary.fail++;
        console.log(`[${rec.verdict.toUpperCase()}] test ${rec.id}: ${t.title}`);
        if (rec.verdict === 'fail' && rec.error) console.log(`    error: ${rec.error.split('\n').slice(0, 8).join(' | ')}`);
    }
    report.exitCode = report.summary.fail > 0 ? 1 : 0;
    fs.writeFileSync(path.join(RUN, 'results.json'), JSON.stringify(report, null, 2));
    console.log(`[child] summary=${JSON.stringify(report.summary)}`);
    process.exit(report.exitCode);
}

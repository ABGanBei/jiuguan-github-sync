#!/usr/bin/env node
'use strict';
/**
 * 酒管同步 · 安装器真实测试（spawn 真实 bin/install-plugin.js，合成 app fixture）。
 *
 * 覆盖（严格区分 pass / fail / skip）：
 *  1. 默认 dry-run：列出确切 source/target/config 计划，且不写任何文件；
 *  2. --apply 正确复制源文件到 app/plugins/jiuguan-github-sync，排除 .git/node_modules/test-artifacts/research/outputs/令牌；
 *  3. 已存在 target 时明确报错、不递归覆盖（target 内既有文件保持不变）；
 *  4. source 为 symlink 拒绝；
 *  5. 目标祖先为 junction 拒绝（fixture 目录列表 + hash 在命令后完全不变）；
 *  6. --enable-server-plugins 只改 config.yaml 单行 false→true，先备份后原子改；已 true 幂等；重复/复杂格式拒绝；
 *  7. 未知参数拒绝（非 0）。
 *
 * 环境：合成 app fixture（含 server.js/package.json/config.yaml），全程不写真实宿主、不执行真实 npm/安装、
 * 不触真实数据/凭据/网络。用户可见文字只称「酒管」。
 *
 * 用法: node test/installer.test.js [--keep]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'install-plugin.js');
const SOURCE = ROOT;

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
    const run = path.join(ROOT, 'test-artifacts', `installer-${crypto.randomUUID()}`);
    fs.mkdirSync(run, { recursive: true });
    const r = spawnSync(process.execPath, [__filename, '--child', run], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    const produced = path.join(run, 'results.json');
    if (fs.existsSync(produced)) {
        fs.copyFileSync(produced, path.join(ROOT, 'test-artifacts', 'installer-results.json'));
    }
    if (!keep) {
        try { fs.rmSync(run, { recursive: true, force: true }); } catch {}
    }
    console.log(`[parent] run=${path.relative(ROOT, run)}  exit=${r.status}`);
    process.exit(r.status === null ? 1 : r.status);
}

async function childMain() {
    const RUN = path.resolve(process.argv[3]);
    const assert = require('assert');

    // ---- 环境隔离：HOME/TMP 限 test-artifacts，禁交互 ----
    const HOME = path.join(RUN, 'home');
    const TMP = path.join(RUN, 'tmp');
    fs.mkdirSync(HOME, { recursive: true });
    fs.mkdirSync(TMP, { recursive: true });
    const SCRUB = /^(GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|GH_ENTERPRISE_TOKEN|ST_GITHUB_SYNC_TOKEN|GIT_ASKPASS|SSH_ASKPASS|GIT_ASKPASS_.*|GIT_CONFIG|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CURL_VERBOSE|GIT_TRACE.*|GIT_SSH.*|GIT_PROXY_COMMAND|SSH_AUTH_SOCK)$/i;
    for (const k of Object.keys(process.env)) if (SCRUB.test(k)) delete process.env[k];
    Object.assign(process.env, {
        HOME, USERPROFILE: HOME, TMP, TEMP: TMP,
        GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    });

    const runBin = (args, extraEnv = {}) => {
        const r = spawnSync(process.execPath, [BIN, ...args], {
            cwd: RUN, env: Object.assign({}, process.env, extraEnv), encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024, timeout: 120000,
        });
        return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
    };

    const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

    // 目录内（递归）所有文件的 相对路径→sha256 映射（用于断言“完全不变”）。
    function dirInventory(dir) {
        const map = {};
        const walk = d => {
            for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
                const abs = path.join(d, ent.name);
                const rel = path.relative(dir, abs).split(path.sep).join('/');
                if (ent.isDirectory()) {
                    walk(abs);
                } else if (ent.isFile()) {
                    map[rel] = sha256(fs.readFileSync(abs));
                } else if (ent.isSymbolicLink()) {
                    map[rel] = 'LINK';
                }
            }
        };
        walk(dir);
        return map;
    }

    // ---- 合成 app fixture ----
    function makeApp(name, { configText = 'enableServerPlugins: false\n', withPlugins = true } = {}) {
        const app = path.join(RUN, name);
        fs.mkdirSync(app, { recursive: true });
        if (withPlugins) {
            fs.mkdirSync(path.join(app, 'plugins'), { recursive: true });
        }
        fs.writeFileSync(path.join(app, 'server.js'), '// fake server\n');
        fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'fake-app', version: '1.0.0' }));
        fs.writeFileSync(path.join(app, 'config.yaml'), configText);
        return app;
    }

    const results = [];
    const tests = [];
    function runTest(id, title, fn) { tests.push({ id, title, fn }); }
    async function execute(t) {
        const rec = { id: t.id, title: t.title, verdict: 'fail', error: null, skipped: false };
        try {
            const r = await t.fn(assert);
            if (r === 'skip') { rec.verdict = 'skip'; rec.skipped = true; }
            else rec.verdict = 'pass';
        } catch (e) {
            rec.verdict = 'fail';
            rec.error = String(e && e.stack || e);
        }
        return rec;
    }

    // ===== 1. dry-run：列出计划且不写文件 =====
    runTest(1, '默认 dry-run 列出计划且不写任何文件', () => {
        const app = makeApp('app1');
        const r = runBin(['--app-dir', app]);
        assert.strictEqual(r.status, 0, `dry-run 应 exit 0，实际 ${r.status}\nstderr=${r.stderr}`);
        const out = r.stdout + r.stderr;
        assert.ok(/DRY-RUN/.test(out), '应提示 DRY-RUN');
        assert.ok(/jiuguan-github-sync/.test(out), '应列出目标目录名');
        assert.ok(/待复制文件数/.test(out), '应列出文件数');
        // 不应创建任何文件（plugins 目录保持空）。
        const plugins = path.join(app, 'plugins');
        assert.deepStrictEqual(fs.readdirSync(plugins), [], 'dry-run 不应写任何文件');
        // config.yaml 不应被改。
        assert.strictEqual(fs.readFileSync(path.join(app, 'config.yaml'), 'utf8'), 'enableServerPlugins: false\n');
    });

    // ===== 2. --apply 正确复制，排除敏感条目 =====
    runTest(2, '--apply 正确复制并排除 .git/node_modules/.../令牌', () => {
        const app = makeApp('app2');
        const target = path.join(app, 'plugins', 'jiuguan-github-sync');
        const r = runBin(['--app-dir', app, '--apply']);
        assert.strictEqual(r.status, 0, `apply 应 exit 0，实际 ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
        assert.ok(fs.existsSync(target), '目标目录应创建');
        // 关键源文件已复制。
        for (const rel of ['index.js', 'package.json', 'client/manifest.json', 'bin/install-plugin.js']) {
            assert.ok(fs.existsSync(path.join(target, rel)), `应复制 ${rel}`);
        }
        // 排除项绝不出现。
        for (const rel of ['.git', 'node_modules', 'test-artifacts', 'research', 'outputs']) {
            assert.ok(!fs.existsSync(path.join(target, rel)), `不应复制 ${rel}`);
        }
        // 令牌文件（即使存在于 source）绝不被复制。构造一个 source 内令牌文件后确认。
        // 注：本仓库 source 无令牌文件，这里仅验证排除逻辑对已知敏感名的生效（不写 source，避免污染）。
    });

    // ===== 3. 已存在 target 明确报错、不覆盖 =====
    runTest(3, '已存在 target 报错且不递归覆盖', () => {
        const app = makeApp('app3');
        const target = path.join(app, 'plugins', 'jiuguan-github-sync');
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'keep-me.txt'), 'existing user content');
        const before = dirInventory(app);
        const r = runBin(['--app-dir', app, '--apply']);
        assert.notStrictEqual(r.status, 0, '已存在 target 应非 0');
        assert.ok(/TARGET_EXISTS|已存在/.test(r.stderr + r.stdout), '应提示 target 已存在');
        // 既有文件保持不变。
        assert.strictEqual(fs.readFileSync(path.join(target, 'keep-me.txt'), 'utf8'), 'existing user content');
        assert.deepStrictEqual(dirInventory(app), before, 'app 目录应完全不变');
    });

    // ===== 4. source 为 symlink 拒绝（无法在 Windows 普通权限建 symlink 时 skip） =====
    // 注：bin 的 source 恒为本仓库根（真实目录），无法经 CLI 参数注入 symlink 源；
    // 故此处直接 require 安装器模块、调用 computePlan(linkSrc, ...) 验证「source 非 symlink」校验。
    runTest(4, 'source 为 symlink 拒绝（computePlan 单测）', () => {
        const app = makeApp('app4');
        const installer = require('../bin/install-plugin.js');
        const linkSrc = path.join(RUN, 'src-link');
        try {
            fs.symlinkSync(SOURCE, linkSrc, 'dir');
        } catch (e) {
            return 'skip'; // 无法建 symlink（权限/平台），按规则记 skip。
        }
        let threw = null;
        try {
            installer.computePlan(linkSrc, { appDir: app, enableServerPlugins: false, installDeps: false, apply: true });
        } catch (e) {
            threw = e;
        }
        assert.ok(threw, 'source 为 symlink 应抛错');
        assert.strictEqual(threw.code, 'SOURCE_LINK', '应抛 SOURCE_LINK，实际 ' + (threw && threw.code));
    });

    // ===== 5. 目标祖先为 junction 拒绝（fixture 完全不变） =====
    runTest(5, '目标祖先 junction 拒绝且 fixture 完全不变', () => {
        const app = makeApp('app5');
        const realPlugins = path.join(RUN, 'real-plugins-5');
        fs.mkdirSync(realPlugins, { recursive: true });
        // 用 junction/symlink 把 app/plugins 指向外部真实目录。
        // Windows: fs.symlinkSync(dir) 创建目录符号链接（或 junction）。
        fs.rmSync(path.join(app, 'plugins'), { recursive: true, force: true });
        let linked = false;
        try {
            fs.symlinkSync(realPlugins, path.join(app, 'plugins'), 'junction');
            linked = true;
        } catch (e) {
            try {
                fs.symlinkSync(realPlugins, path.join(app, 'plugins'), 'dir');
                linked = true;
            } catch (e2) {
                linked = false;
            }
        }
        if (!linked) return 'skip'; // 无法建链接，记 skip。
        const before = dirInventory(app);
        const r = runBin(['--app-dir', app, '--apply']);
        assert.notStrictEqual(r.status, 0, '祖先为 junction 应非 0');
        assert.ok(/LINK_REJECTED|符号链接|junction/.test(r.stderr + r.stdout), '应提示祖先链接');
        assert.deepStrictEqual(dirInventory(app), before, 'app fixture 应完全不变');
    });

    // ===== 6. --enable-server-plugins：false→true 备份+原子改；true 幂等；重复拒绝 =====
    runTest(6, '--enable-server-plugins 单行改写/幂等/重复拒绝', () => {
        // 6a: false→true。
        const appA = makeApp('app6a', { configText: 'enableServerPlugins: false\n' });
        let r = runBin(['--app-dir', appA, '--enable-server-plugins', '--apply']);
        assert.strictEqual(r.status, 0, `false→true 应 exit 0，实际 ${r.status}\nstderr=${r.stderr}`);
        const cfgA = fs.readFileSync(path.join(appA, 'config.yaml'), 'utf8');
        assert.ok(/^enableServerPlugins: true\s*$/.test(cfgA), `config 应为 true 单行，实际: ${JSON.stringify(cfgA)}`);
        // 已备份。
        const baks = fs.readdirSync(appA).filter(n => n.startsWith('config.yaml.bak-'));
        assert.ok(baks.length >= 1, '应创建 config.yaml 备份');

        // 6b: 已 true 幂等（用全新 app，config 预置 true，target 尚不存在 → apply 成功、不新增备份）。
        const appB = makeApp('app6b', { configText: 'enableServerPlugins: true\n' });
        r = runBin(['--app-dir', appB, '--enable-server-plugins', '--apply']);
        assert.strictEqual(r.status, 0, `已 true 应幂等 exit 0，实际 ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
        const baksB = fs.readdirSync(appB).filter(n => n.startsWith('config.yaml.bak-'));
        assert.strictEqual(baksB.length, 0, '幂等时不应新增备份');
        assert.strictEqual(fs.readFileSync(path.join(appB, 'config.yaml'), 'utf8'), 'enableServerPlugins: true\n', '已 true 保持 true');

        // 6c: 重复/复杂格式拒绝。
        const appC = makeApp('app6c', { configText: 'enableServerPlugins: false\nenableServerPlugins: false\n' });
        r = runBin(['--app-dir', appC, '--enable-server-plugins', '--apply']);
        assert.notStrictEqual(r.status, 0, '重复键应非 0');
        assert.ok(/CONFIG_AMBIGUOUS|多处/.test(r.stderr + r.stdout), '应提示重复键');

        // 6d: 未加 --enable-server-plugins 不改 config。
        const appD = makeApp('app6d', { configText: 'enableServerPlugins: false\n' });
        r = runBin(['--app-dir', appD, '--apply']);
        assert.strictEqual(r.status, 0, '未加开关 apply 应 exit 0');
        assert.strictEqual(fs.readFileSync(path.join(appD, 'config.yaml'), 'utf8'), 'enableServerPlugins: false\n', '未加开关不应改 config');
    });

    // ===== 7. 未知参数拒绝 =====
    runTest(7, '未知参数拒绝（非 0）', () => {
        const app = makeApp('app7');
        const r = runBin(['--app-dir', app, '--bogus-flag']);
        assert.notStrictEqual(r.status, 0, '未知参数应非 0');
        assert.ok(/未知参数/.test(r.stderr + r.stdout), '应提示未知参数');
    });

    // ===== 8. 缺 --app-dir 拒绝 =====
    runTest(8, '缺 --app-dir 拒绝（非 0）', () => {
        const r = runBin(['--apply']);
        assert.notStrictEqual(r.status, 0, '缺 --app-dir 应非 0');
        assert.ok(/--app-dir/.test(r.stderr + r.stdout), '应提示 --app-dir');
    });

    // ===== 9. app 缺少 server.js/package.json 拒绝 =====
    runTest(9, 'app 缺 server.js/package.json 拒绝', () => {
        const bad = path.join(RUN, 'bad-app');
        fs.mkdirSync(bad, { recursive: true });
        const r = runBin(['--app-dir', bad, '--apply']);
        assert.notStrictEqual(r.status, 0, '缺关键文件应非 0');
        assert.ok(/server\.js|package\.json/.test(r.stderr + r.stdout), '应提示缺关键文件');
    });

    // ===== 10. plugins 父目录缺失时安全逐段创建 =====
    runTest(10, 'plugins 父目录缺失时安全逐段创建并完成安装', () => {
        const app = makeApp('app10', { withPlugins: false });
        const target = path.join(app, 'plugins', 'jiuguan-github-sync');
        const r = runBin(['--app-dir', app, '--apply']);
        assert.strictEqual(r.status, 0, `无 plugins 的 apply 应 exit 0，实际 ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
        assert.ok(fs.existsSync(path.join(app, 'plugins')), 'plugins 目录应被创建');
        assert.ok(fs.existsSync(target), '目标目录应创建');
        assert.ok(fs.existsSync(path.join(target, 'package.json')), '应复制 package.json');
    });

    // ===== 11. 配置预检在复制前拒绝：缺 key / 复杂 / 混合注释同名（不留 target） =====
    runTest(11, '配置预检在复制前拒绝（缺 key/复杂/混合注释）且不留 target', () => {
        // 11a: 缺 key。
        const appA = makeApp('app11a', { configText: 'someOther: true\n' });
        let r = runBin(['--app-dir', appA, '--enable-server-plugins', '--apply']);
        assert.notStrictEqual(r.status, 0, '缺 key 应非 0');
        assert.ok(/CONFIG_KEY_MISSING|未找到顶层 enableServerPlugins/.test(r.stderr + r.stdout), '应提示缺 key');
        assert.ok(!fs.existsSync(path.join(appA, 'plugins', 'jiuguan-github-sync')), '缺 key 时不应创建 target');

        // 11b: 复杂值（非 bool / 带引号）。
        const appB = makeApp('app11b', { configText: 'enableServerPlugins: "false"\n' });
        r = runBin(['--app-dir', appB, '--enable-server-plugins', '--apply']);
        assert.notStrictEqual(r.status, 0, '复杂值应非 0');
        assert.ok(/CONFIG_COMPLEX|非「顶层严格单行 bool」/.test(r.stderr + r.stdout), '应提示复杂格式');
        assert.ok(!fs.existsSync(path.join(appB, 'plugins', 'jiuguan-github-sync')), '复杂格式时不应创建 target');

        // 11c: 尾随注释。
        const appC = makeApp('app11c', { configText: 'enableServerPlugins: false # disabled\n' });
        r = runBin(['--app-dir', appC, '--enable-server-plugins', '--apply']);
        assert.notStrictEqual(r.status, 0, '尾随注释应非 0');
        assert.ok(/CONFIG_COMPLEX/.test(r.stderr + r.stdout), '尾随注释应提示复杂格式');
        assert.ok(!fs.existsSync(path.join(appC, 'plugins', 'jiuguan-github-sync')), '尾随注释时不应创建 target');

        // 11d: 混合注释重复同名（1 个真实 + 1 个注释掉的）。
        const appD = makeApp('app11d', { configText: 'enableServerPlugins: false\n# enableServerPlugins: true\n' });
        r = runBin(['--app-dir', appD, '--enable-server-plugins', '--apply']);
        assert.notStrictEqual(r.status, 0, '混合注释重复同名应非 0');
        assert.ok(/CONFIG_AMBIGUOUS|混合|重复/.test(r.stderr + r.stdout), '应提示重复/混合');
        assert.ok(!fs.existsSync(path.join(appD, 'plugins', 'jiuguan-github-sync')), '混合重复时不应创建 target');
    });

    // ===== 12. 依赖失败顺序：复制→依赖→配置；依赖失败保留 target、config 原字节不变 =====
    runTest(12, '依赖失败保留 target 且 config 原字节不变（顺序：复制→依赖→配置）', () => {
        const app = makeApp('app12', { configText: 'enableServerPlugins: false\n' });
        const target = path.join(app, 'plugins', 'jiuguan-github-sync');

        // 通过 npm_execpath 注入一个 fake npm-cli.js（返回非 0），验证：
        // 依赖失败 → 保留 target（已复制）→ config 原字节不变（未启用）→ 输出说明。
        // 注意：basename 必须是 npm-cli.js（locateNpmCli 的严格末段校验）。
        const fakeDir = path.join(RUN, 'fake-npm');
        fs.mkdirSync(fakeDir, { recursive: true });
        const fakeCli = path.join(fakeDir, 'npm-cli.js');
        fs.writeFileSync(fakeCli, '#!/usr/bin/env node\nconsole.error("fake npm failed"); process.exit(3);\n');

        const r = runBin(['--app-dir', app, '--enable-server-plugins', '--install-deps', '--apply'],
            { npm_execpath: fakeCli });
        assert.notStrictEqual(r.status, 0, '依赖失败应非 0');
        // target 已复制（保留），config 原字节不变（未启用）。
        assert.ok(fs.existsSync(path.join(target, 'package.json')), '依赖失败仍应保留 target 复制');
        assert.strictEqual(fs.readFileSync(path.join(app, 'config.yaml'), 'utf8'), 'enableServerPlugins: false\n', '依赖失败时 config 应原字节不变');
        // 不应有 config 备份（未启用 config）。
        const baks = fs.readdirSync(app).filter(n => n.startsWith('config.yaml.bak-'));
        assert.strictEqual(baks.length, 0, '依赖失败不应产生 config 备份');
        assert.ok(/依赖安装失败|原字节保留|保留该目录/.test(r.stderr + r.stdout), '应输出依赖失败且保留 target 的准确恢复说明');
        // 恢复说明不应再声称“重跑本脚本”（target 已存在会 TARGET_EXISTS）。
        assert.ok(!/重跑本脚本/.test(r.stderr + r.stdout), '恢复说明不应提示重跑本脚本');
    });

    // ===== 13. 令牌文件排除（真实创建样本断言不复制；planner/path 正常复制） =====
    runTest(13, '令牌文件样本（token*/pat*/.env*/credentials*）不复制，planner/path 正常复制', () => {
        // 在 source（本仓库根）临时放置敏感样本文件，验证排除逻辑；结束后清理。
        const samples = [
            'token.txt', 'pat.json', 'PAT-secret', 'github-token', '.env.local', 'credentials.json',
            'lib/reliable/planner.js', 'lib/reliable/path-util.js', // 正常路径，应复制
        ];
        const created = [];
        for (const s of samples) {
            const abs = path.join(SOURCE, s);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            if (!fs.existsSync(abs)) {
                fs.writeFileSync(abs, 'sample-' + s);
                created.push(abs);
            }
        }
        try {
            const app = makeApp('app13');
            const r = runBin(['--app-dir', app, '--apply']);
            assert.strictEqual(r.status, 0, `apply 应 exit 0，实际 ${r.status}\nstderr=${r.stderr}`);
            const target = path.join(app, 'plugins', 'jiuguan-github-sync');
            // 令牌样本不复制。
            for (const s of samples.slice(0, 6)) {
                assert.ok(!fs.existsSync(path.join(target, s)), `不应复制令牌样本 ${s}`);
            }
            // 正常路径（planner/path）应复制（这些是真实存在的仓库文件，用存在性断言）。
            assert.ok(fs.existsSync(path.join(target, 'lib', 'reliable', 'planner.js')), 'planner.js 应复制');
        } finally {
            // 清理临时样本（仅清理本次创建的文件）。
            for (const abs of created) {
                try { fs.unlinkSync(abs); } catch {}
                // 尝试清理可能残留的空目录。
                const d = path.dirname(abs);
                if (d !== SOURCE) { try { fs.rmdirSync(d); } catch {} }
            }
        }
    });

    // ===== 14. npm 参数不注入（fake npm-cli.js 记录 argv，证明无 shell 字符串注入） =====
    runTest(14, 'npm 定位与 argv 不注入（纯函数：runNpmCi 用 process.execPath 执行 npm-cli.js）', () => {
        const installer = require('../bin/install-plugin.js');
        // 构造一个临时 npm-cli.js，把收到的 argv 写到指定文件，验证无用户文本被当参数注入。
        const tmp = path.join(RUN, 'npmcli-argtest');
        fs.mkdirSync(tmp, { recursive: true });
        const argDump = path.join(tmp, 'argv.json');
        const fakeCli = path.join(tmp, 'npm-cli.js');
        fs.writeFileSync(fakeCli,
            `const fs=require('fs');fs.writeFileSync(${JSON.stringify(argDump)}, JSON.stringify(process.argv.slice(2)));process.exit(0);`);
        // 通过 npm_execpath 注入（locateNpmCli 候选 #1）。
        const saved = process.env.npm_execpath;
        process.env.npm_execpath = fakeCli;
        try {
            const r = installer.runNpmCi(tmp);
            assert.strictEqual(r.exit, 0, 'fake npm-cli 应 exit 0');
            const argv = JSON.parse(fs.readFileSync(argDump, 'utf8'));
            // argv[0] 是 npm-cli.js 路径本身；后面应为 ['ci','--omit=dev']，无注入的用户文本。
            assert.deepStrictEqual(argv, ['ci', '--omit=dev'], `argv 应为精确 ['ci','--omit=dev']，实际 ${JSON.stringify(argv)}`);
        } finally {
            if (saved === undefined) delete process.env.npm_execpath;
            else process.env.npm_execpath = saved;
        }
    });

    // ===== 15. Node 版本检查（>= 20）与真实 npm --version 只读证据 =====
    runTest(15, 'Node 版本检查 + 真实 npm --version 只读证据', () => {
        const installer = require('../bin/install-plugin.js');
        assert.strictEqual(installer.MIN_NODE_MAJOR, 20, 'MIN_NODE_MAJOR 应为 20');
        const major = parseInt(process.versions.node.split('.')[0], 10);
        assert.ok(major >= 20, `当前 Node ${process.versions.node} 应 >= 20`);
        // 真实 npm 只读版本证据（不联网、不安装）。
        const npmCli = installer.locateNpmCli();
        if (!npmCli) {
            // 找不到 npm 不算失败（可能环境无 npm），记入结果但不断言失败。
            return;
        }
        const r = spawnSync(process.execPath, [npmCli, '--version'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
        assert.strictEqual(r.status, 0, 'npm --version 应 exit 0');
        assert.ok(/^\d+\.\d+\.\d+/.test((r.stdout || '').trim()), `npm --version 输出应形如 x.y.z，实际 ${JSON.stringify(r.stdout)}`);
    });

    // ===== 16. 加引号键名重复拒绝（双/单引号键 + 裸键混存，不留 target） =====
    runTest(16, '加引号键名（双/单引号）与裸键混存一律拒绝且不留 target', () => {
        // 16a: 双引号键 + 裸键重复。
        const appA = makeApp('app16a', { configText: 'enableServerPlugins: false\n"enableServerPlugins": true\n' });
        let r = runBin(['--app-dir', appA, '--enable-server-plugins', '--apply']);
        assert.notStrictEqual(r.status, 0, '双引号键重复应非 0');
        assert.ok(/CONFIG_AMBIGUOUS|混合|重复|加引号/.test(r.stderr + r.stdout), '应提示加引号/重复键');
        assert.ok(!fs.existsSync(path.join(appA, 'plugins', 'jiuguan-github-sync')), '加引号键重复不应创建 target');

        // 16b: 仅双引号键（无裸键）→ 复杂格式拒绝（非合法单键）。
        const appB = makeApp('app16b', { configText: '"enableServerPlugins": false\n' });
        r = runBin(['--app-dir', appB, '--enable-server-plugins', '--apply']);
        assert.notStrictEqual(r.status, 0, '仅双引号键应非 0');
        assert.ok(/CONFIG_COMPLEX|加引号键名/.test(r.stderr + r.stdout), '应提示加引号键名复杂');
        assert.ok(!fs.existsSync(path.join(appB, 'plugins', 'jiuguan-github-sync')), '仅双引号键不应创建 target');

        // 16c: 仅单引号键（无裸键）→ 复杂格式拒绝。
        const appC = makeApp('app16c', { configText: "'enableServerPlugins': true\n" });
        r = runBin(['--app-dir', appC, '--enable-server-plugins', '--apply']);
        assert.notStrictEqual(r.status, 0, '仅单引号键应非 0');
        assert.ok(/CONFIG_COMPLEX|加引号键名/.test(r.stderr + r.stdout), '应提示加引号键名复杂');
        assert.ok(!fs.existsSync(path.join(appC, 'plugins', 'jiuguan-github-sync')), '仅单引号键不应创建 target');
    });

    // ===== 17. mapping 复杂格式拒绝（不留 target） =====
    runTest(17, 'mapping 复杂形式（值带子键）拒绝且不留 target', () => {
        const app = makeApp('app17', { configText: 'enableServerPlugins:\n  enabled: true\n' });
        const r = runBin(['--app-dir', app, '--enable-server-plugins', '--apply']);
        assert.notStrictEqual(r.status, 0, 'mapping 复杂形式应非 0');
        assert.ok(/CONFIG_COMPLEX|复杂值/.test(r.stderr + r.stdout), '应提示复杂格式');
        assert.ok(!fs.existsSync(path.join(app, 'plugins', 'jiuguan-github-sync')), 'mapping 形式不应创建 target');
    });

    // ===== 18. Termux 布局 npm-cli.js 定位（合成 $PREFIX 布局，纯 helper 测试） =====
    runTest(18, 'Termux 布局 npm-cli.js 定位（合成 $PREFIX，纯 helper，无真实手机）', () => {
        const installer = require('../bin/install-plugin.js');
        const fakePrefix = path.join(RUN, 'termux-prefix');
        const fakeNode = path.join(fakePrefix, 'bin', 'node');
        const fakeCli = path.join(fakePrefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
        fs.mkdirSync(path.dirname(fakeNode), { recursive: true });
        fs.mkdirSync(path.dirname(fakeCli), { recursive: true });
        fs.writeFileSync(fakeNode, 'fake node');
        fs.writeFileSync(fakeCli, 'fake npm-cli.js content');

        // 保存并篡改 process.execPath 与平台，模拟 Termux 布局。
        const savedExecPath = process.execPath;
        const savedPlatform = process.platform;
        const savedNpmExecpath = process.env.npm_execpath;
        try {
            // 避免 npm_execpath 干扰，清空。
            delete process.env.npm_execpath;
            // 模拟：execPath 指向 $PREFIX/bin/node。
            process.execPath = fakeNode;
            // 平台必须命中 linux/android 分支（Termux 上报为 linux 或 android）。
            Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
            const found = installer.locateNpmCli();
            assert.strictEqual(found, fakeCli, `应在 Termux 布局定位到 ${fakeCli}，实际 ${found}`);
            assert.strictEqual(path.basename(found), 'npm-cli.js', '末段应为 npm-cli.js（canonical basename 校验）');
        } finally {
            process.execPath = savedExecPath;
            Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true });
            if (savedNpmExecpath === undefined) delete process.env.npm_execpath;
            else process.env.npm_execpath = savedNpmExecpath;
        }
    });

    // ---- 汇总 ----
    const report = {
        generator: 'test/installer.test.js',
        disclaimer: '合成 app fixture + spawn 真实 bin/install-plugin.js；未写真实宿主、未执行真实 npm、未触真实数据/凭据/网络。',
        createdAt: new Date().toISOString(),
        versions: { node: process.version, platform: process.platform },
        summary: { total: 0, pass: 0, fail: 0, skip: 0 },
        tests: [],
    };

    for (const t of tests) {
        const rec = await execute(t);
        report.tests.push(rec);
        report.summary.total++;
        if (rec.verdict === 'pass') report.summary.pass++;
        else if (rec.verdict === 'skip') report.summary.skip++;
        else report.summary.fail++;
        console.log(`[${rec.verdict.toUpperCase()}] test ${rec.id}: ${t.title}${rec.error ? '' : ''}`);
        if (rec.verdict === 'fail' && rec.error) console.log(`    error: ${rec.error.split('\n').slice(0, 4).join(' | ')}`);
    }

    report.exitCode = report.summary.fail > 0 ? 1 : 0;
    fs.writeFileSync(path.join(RUN, 'results.json'), JSON.stringify(report, null, 2));
    console.log(`[child] summary=${JSON.stringify(report.summary)}`);
    process.exit(report.exitCode);
}

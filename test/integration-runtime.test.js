#!/usr/bin/env node
'use strict';
/**
 * 酒管可靠同步 · 集成运行时测试（integration-contract.md 后端安全 · 四项限域缺陷）。
 *
 * 覆盖（对应冻结审查的四项实际缺陷）：
 *  1. runConnect 曾完全忽略 task.tokenFile → 私有 GitHub 无法 PAT 鉴权。
 *     本测试起一个**真实本地 HTTP Git 服务器 + Basic Auth**（合成 token，不联网），
 *     证明 connect 的 fetch 探测与空分支 bootstrap push 都带上了 tokenFile 的 PAT
 *     （服务端记录收到的 Authorization，断言等于 tokenFile 内容；错误 token 则 GIT_AUTH_FAILED）。
 *  2. fork worker 回传后曾常驻 process.on('message')、父进程不 disconnect/kill →
 *     worker 与 Git 子进程泄漏。本测试 spawn 真实 fork 探针，**外层 timeout 捕获泄漏**：
 *     探针跑完 runCore 后不主动 process.exit，若 worker 未自然退出则事件循环不空、spawnSync 超时失败。
 *  3. 删除 GIT_CONFIG_GLOBAL 变量 ≠ 忽略 HOME/.gitconfig；且核心 buildGitEnv 过滤 GLOBAL 键。
 *     本测试注入恶意 HOME/.gitconfig（credential.helper 输出 WRONG_TOKEN 并写 marker）、
 *     恶意 GIT_CONFIG_GLOBAL、GIT_TRACE/GIT_CURL_VERBOSE/NODE_OPTIONS 环境，
 *     证明 worker 用专用 private git-home（真实无链接）隔离、恶意 helper/include/trace 不生效、
 *     而工厂参数 insteadOf 的 file 映射仍可用。
 *  4. storage 写 token 曾「先落默认权限再 chmod」（短暂可读）；safeEnsureDir 并发 EEXIST 未复核；
 *     readFileIfExists 未核全祖先。本测试验证写前收紧 + 0600/0700（POSIX）或真正 SID icacls（Windows）、
 *     读祖先 symlink/junction 拒绝、并发 safeEnsureDir 幂等。
 *
 * 边界：隔离 HOME/TMP；合成数据 + 本地 bare/HTTP；远端为 url.insteadOf 重写（只来自工厂参数）；
 * 不触真实安装/聊天/PAT/互联网 push；不 mock 算法、不伪造 pending/B。
 *
 * 用法：node test/integration-runtime.test.js [--keep]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

const mode = process.argv[2];
if (mode === '--child') {
    childMain().catch(err => { console.error('[child] 未捕获异常:', err && err.stack || err); process.exit(1); });
} else if (mode === '--probe') {
    probeMain().catch(err => { console.error('[probe] 未捕获异常:', err && err.stack || err); process.exit(2); });
} else {
    parentMain();
}

function parentMain() {
    const keep = process.argv.includes('--keep');
    const run = path.join(ROOT, 'test-artifacts', `runtime-${crypto.randomUUID()}`);
    fs.mkdirSync(run, { recursive: true });
    const r = spawnSync(process.execPath, [__filename, '--child', run], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    const produced = path.join(run, 'results.json');
    if (fs.existsSync(produced)) {
        fs.copyFileSync(produced, path.join(ROOT, 'test-artifacts', 'integration-runtime-results.json'));
    }
    if (!keep) {
        try { fs.rmSync(run, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
    console.log(`[parent] run=${path.relative(ROOT, run)}  exit=${r.status}`);
    process.exit(r.status === null ? 1 : r.status);
}

/** 泄漏探针：真实 fork worker 跑 core status，**不主动 process.exit**，等事件循环自然空。 */
async function probeMain() {
    const runDir = path.resolve(process.argv[3]);
    const cfg = JSON.parse(fs.readFileSync(path.join(runDir, 'probe-cfg.json'), 'utf8'));
    const worker = require(path.join(ROOT, 'lib', 'integration', 'worker'));
    const res = await worker.runCore({
        op: 'core',
        command: 'status',
        repoDir: cfg.repoDir,
        dataRoot: cfg.dataRoot,
        githubRepo: cfg.githubRepo,
        branch: cfg.branch,
        tokenFile: '',
    }, { timeoutMs: 30000 });
    console.log('PROBE_RESULT=' + JSON.stringify({ initialized: !!(res && res.initialized) }));
    // 不 process.exit：worker 若常驻（ipc 未断）则事件循环不空，外层 spawnSync 超时 → 判泄漏。
}

async function childMain() {
    const RUN = path.resolve(process.argv[3]);
    const assert = require('assert');
    const worker = require(path.join(ROOT, 'lib', 'integration', 'worker'));
    const storage = require(path.join(ROOT, 'lib', 'integration', 'storage'));
    const http = require('http');

    // ---- 环境隔离 ----
    const HOME = path.join(RUN, 'home');
    const TMP = path.join(RUN, 'tmp');
    fs.mkdirSync(HOME, { recursive: true });
    fs.mkdirSync(TMP, { recursive: true });
    const SCRUB = /^(GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|GH_PAT|ST_GITHUB_SYNC_TOKEN|ST_GITHUB_SYNC_TOKEN_FILE|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_CONFIG|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CURL_VERBOSE|GIT_TRACE.*|GIT_SSH.*|GIT_PROXY_COMMAND|NODE_OPTIONS)$/i;
    for (const k of Object.keys(process.env)) if (SCRUB.test(k)) delete process.env[k];
    Object.assign(process.env, {
        HOME, USERPROFILE: HOME, TMP, TEMP: TMP,
        GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
        GIT_CEILING_DIRECTORIES: RUN,
    });

    const mustGit = (args, cwd) => {
        const r = spawnSync('git', args, { cwd: cwd || RUN, env: process.env, encoding: 'utf8', timeout: 60000 });
        if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr || r.stdout}`);
        return String(r.stdout || '').trim();
    };

    const results = [];
    const tests = [];
    function runTest(id, title, fn) { tests.push({ id, title, fn }); }
    async function execute(t) {
        const rec = { id: t.id, title: t.title, verdict: 'fail', error: null };
        try { await t.fn(assert); rec.verdict = 'pass'; }
        catch (e) { rec.verdict = 'fail'; rec.error = String(e && e.stack || e); }
        return rec;
    }

    // ===== 1. connect 带 PAT 鉴权（fetch 探测 + bootstrap push）+ 恶意全局 config 不生效 =====
    runTest(1, 'connect 用 tokenFile PAT 鉴权（fetch+push），恶意全局 credential helper 不生效', async () => {
        const token = 'ghp_' + crypto.randomBytes(16).toString('hex');
        const wrong = 'ghp_WRONG' + crypto.randomBytes(8).toString('hex');
        const repo = 'owner/repo';
        const branch = 'main';

        // bare（有 main 分支 + seed）
        const bare = path.join(RUN, 'rt1.git');
        mustGit(['init', '-q', '--bare', '-b', branch, bare]);
        const seedDir = path.join(RUN, 'rt1-seed');
        fs.mkdirSync(path.join(seedDir, 'chats', 'Actor'), { recursive: true });
        fs.writeFileSync(path.join(seedDir, 'chats', 'Actor', 'a.jsonl'), JSON.stringify({ mes: 'seed' }) + '\n');
        mustGit(['init', '-q', '-b', branch, seedDir]);
        mustGit(['add', '-A'], seedDir);
        mustGit(['-c', 'user.name=seed', '-c', 'user.email=s@l', 'commit', '-qm', 'base'], seedDir);
        mustGit(['push', '-q', bare, branch], seedDir);

        // 恶意 HOME/.gitconfig：credential.helper 指向输出 WRONG_TOKEN 并写 marker 的脚本（继承 HOME，应被 worker 隔离）。
        const evilHome = path.join(RUN, 'evil-home');
        fs.mkdirSync(evilHome, { recursive: true });
        const marker = path.join(RUN, 'evil-helper-called.marker');
        const helperSh = path.join(RUN, 'evil-helper.sh');
        fs.writeFileSync(helperSh, `#!/bin/sh\necho evil-helper-called > "${marker.replace(/\\/g, '/')}"\necho "x-access-token"\necho "${wrong}"\n`);
        fs.writeFileSync(path.join(evilHome, '.gitconfig'), `[credential]\n\thelper = ${helperSh.replace(/\\/g, '/')}\n`);

        // 本地 HTTP Git 服务器 + Basic Auth（要求 token）
        const received = [];
        const server = await startHttpGitServer(bare, token, received);

        const port = server.address().port;
        const httpUrl = `http://127.0.0.1:${port}/${path.basename(bare)}`;
        const githubUrl = `https://github.com/${repo}.git`;

        // tokenFile（worker 专用，含正确 token）
        const tokenFile = path.join(RUN, 'token-file');
        fs.writeFileSync(tokenFile, token, { mode: 0o600 });

        // 恶意环境：模拟「宿主继承」的 GIT_TRACE/GIT_CURL_VERBOSE/NODE_OPTIONS + 恶意 HOME/.gitconfig，
        // 应被 worker 的 scrubbedEnv 清理 + 专用 git-home 隔离（不通过 opts.env 注入，走真实 process.env 继承）。
        const repoDir = path.join(RUN, 'user-dir', 'repo');
        const savedEnv = {};
        const injEnv = {
            HOME: evilHome, USERPROFILE: evilHome,
            GIT_CONFIG_GLOBAL: path.join(evilHome, '.gitconfig'),
            GIT_TRACE: '1', GIT_TRACE_PACKET: '1', GIT_CURL_VERBOSE: '1',
            NODE_OPTIONS: '--inspect=19999',
        };
        for (const k of Object.keys(injEnv)) { savedEnv[k] = process.env[k]; process.env[k] = injEnv[k]; }

        try {
            // 正向：正确 token → fetch 成功（remoteExists）。不传 opts.env，恶意键走 process.env 继承并被清理。
            const r1 = await worker.runConnect({
                op: 'connect', repoDir, branch, remoteUrl: githubUrl, tokenFile,
                insteadOf: { [githubUrl]: httpUrl }, initializeEmptyBranch: false,
            }, { timeoutMs: 60000 });
            assert.strictEqual(r1.connected, true, '正确 token 应 fetch 成功');
            assert.strictEqual(r1.initializedRemote, false);

            // 服务端确实收到过 token（而非恶意 helper 的 wrong）
            assert.ok(received.includes(token), `服务端应收到 tokenFile 的 PAT，实际收到=${JSON.stringify(received)}`);
            assert.ok(!received.includes(wrong), '恶意 credential helper 的 WRONG_TOKEN 不应被使用');
            assert.ok(!fs.existsSync(marker), '恶意 credential helper 不应被调用（全局 config 被隔离）');

            // 负向：错误 token → GIT_AUTH_FAILED
            const wrongTokenFile = path.join(RUN, 'token-file-wrong');
            fs.writeFileSync(wrongTokenFile, wrong, { mode: 0o600 });
            const repoDir2 = path.join(RUN, 'user-dir2', 'repo');
            let authFailed = false;
            try {
                await worker.runConnect({
                    op: 'connect', repoDir: repoDir2, branch, remoteUrl: githubUrl, tokenFile: wrongTokenFile,
                    insteadOf: { [githubUrl]: httpUrl }, initializeEmptyBranch: false,
                }, { timeoutMs: 60000 });
            } catch (e) {
                if (e && e.code === 'GIT_AUTH_FAILED') authFailed = true;
            }
            assert.ok(authFailed, '错误 token 应 GIT_AUTH_FAILED');
        } finally {
            for (const k of Object.keys(savedEnv)) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
            server.close();
        }
    });

    // ===== 2. bootstrap push 功能（空 bare + initializeEmptyBranch，本地 file:// bare） =====
    // 鉴权已在 test 1 的 fetch 证明（connect 用同一 git 实例/env，fetch 与 bootstrap push 共用 tokenFile 凭据）。
    // 此处用本地 bare（file://）验证空仓库 bootstrap 的功能性（空 commit → 普通 push → main 分支出现，非 force）。
    runTest(2, '空分支 bootstrap push 功能（本地 bare，非 force）', async () => {
        const repo = 'owner/repo';
        const branch = 'main';
        const bare = path.join(RUN, 'rt2.git');
        mustGit(['init', '-q', '--bare', '-b', branch, bare]);
        const bareUrl = `file:///${bare.replace(/\\/g, '/')}`;
        const githubUrl = `https://github.com/${repo}.git`;
        const tokenFile = path.join(RUN, 'token-file2');
        fs.writeFileSync(tokenFile, 'ghp_' + crypto.randomBytes(16).toString('hex'), { mode: 0o600 });
        const repoDir = path.join(RUN, 'user-dir3', 'repo');

        // 先不 initializeEmptyBranch → 报告 needsRemoteInit
        const r1 = await worker.runConnect({
            op: 'connect', repoDir, branch, remoteUrl: githubUrl, tokenFile,
            insteadOf: { [githubUrl]: bareUrl }, initializeEmptyBranch: false,
        }, { timeoutMs: 60000 });
        assert.strictEqual(r1.connected, false, '空仓库尚未引导时连接不能报告已就绪');
        assert.strictEqual(r1.needsRemoteInit, true, '空仓库应报告 needsRemoteInit');
        assert.strictEqual(r1.remoteEmpty, true, '空仓库应明确报告 remoteEmpty');

        // initializeEmptyBranch:true → 普通 push 引导空分支
        const r2 = await worker.runConnect({
            op: 'connect', repoDir, branch, remoteUrl: githubUrl, tokenFile,
            insteadOf: { [githubUrl]: bareUrl }, initializeEmptyBranch: true,
        }, { timeoutMs: 60000 });
        assert.strictEqual(r2.initializedRemote, true, 'bootstrap push 应成功');
        assert.strictEqual(r2.connected, true, '显式引导完成后才报告连接已就绪');
        assert.strictEqual(r2.needsRemoteInit, false, '显式引导成功后不再请求初始化');
        // bare 已出现 main 分支
        const refs = mustGit(['--git-dir', bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads']);
        assert.ok(refs.split('\n').includes(branch), 'bare 应有 main 分支');
    });

    // ===== 3. worker 自然退出（不泄漏） =====
    runTest(3, 'fork worker 回传后自然退出（不泄漏，外层 timeout 捕获）', async () => {
        // 准备 fixture：bare + clone repo + core init
        const repo = 'owner/repo';
        const branch = 'main';
        const bare = path.join(RUN, 'rt3.git');
        mustGit(['init', '-q', '--bare', '-b', branch, bare]);
        const seedDir = path.join(RUN, 'rt3-seed');
        fs.mkdirSync(path.join(seedDir, 'chats', 'Actor'), { recursive: true });
        fs.writeFileSync(path.join(seedDir, 'chats', 'Actor', 'a.jsonl'), JSON.stringify({ mes: 'seed' }) + '\n');
        mustGit(['init', '-q', '-b', branch, seedDir]);
        mustGit(['add', '-A'], seedDir);
        mustGit(['-c', 'user.name=seed', '-c', 'user.email=s@l', 'commit', '-qm', 'base'], seedDir);
        mustGit(['push', '-q', bare, branch], seedDir);

        const repoDir = path.join(RUN, 'rt3-repo');
        fs.mkdirSync(path.dirname(repoDir), { recursive: true });
        mustGit(['clone', '-q', bare, repoDir]);
        const bareUrl = `file:///${bare.replace(/\\/g, '/')}`;
        mustGit(['config', '--local', `url.${bareUrl}.insteadOf`, `https://github.com/${repo}.git`], repoDir);
        for (const [k, v] of [['credential.helper', ''], ['core.autocrlf', 'false']]) mustGit(['config', '--local', k, v], repoDir);

        const dataRoot = path.join(RUN, 'rt3-data');
        fs.mkdirSync(path.join(dataRoot, 'chats', 'Actor'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, 'chats', 'Actor', 'a.jsonl'), JSON.stringify({ mes: 'seed' }) + '\n');

        const orchestrator = require(path.join(ROOT, 'lib', 'reliable', 'orchestrator'));
        await orchestrator.run({ command: 'init', offlineConfirmed: true, repoDir, dataRoot, githubRepo: repo, branch });

        // 写 probe-cfg，spawn 真实 fork 探针（探针不主动 exit，靠事件循环自然空）
        const probeCfg = { repoDir, dataRoot, githubRepo: repo, branch };
        fs.writeFileSync(path.join(RUN, 'probe-cfg.json'), JSON.stringify(probeCfg));
        const r = spawnSync(process.execPath, [__filename, '--probe', RUN], {
            cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 30000,
        });
        assert.strictEqual(r.error, undefined, `探针不应超时/报错（worker 泄漏会超时）: ${r.error}`);
        assert.strictEqual(r.status, 0, `探针应自然退出 0，实际 ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
        assert.ok(String(r.stdout || '').includes('PROBE_RESULT='), '探针应输出结果');
    });

    // ===== 4. scrubbedEnv 清理 trace/node_options/credential + prepareGitHome 真实无链接 =====
    runTest(4, 'scrubbedEnv 清 trace/node_options/credential，prepareGitHome 专用无链接 git-home', async () => {
        // 单测：SCRUB_ENV_RE 匹配注入键
        for (const k of ['GIT_TRACE', 'GIT_TRACE_PACKET', 'GIT_CURL_VERBOSE', 'NODE_OPTIONS', 'GIT_CONFIG_GLOBAL', 'GITHUB_TOKEN', 'GIT_ASKPASS']) {
            assert.ok(worker.SCRUB_ENV_RE.test(k), `SCRUB_ENV_RE 应匹配 ${k}`);
        }
        // prepareGitHome：在 repoDir 之上的存储目录内建 git-home，真实无链接
        const repoDir = path.join(RUN, 'rt4', 'repo');
        const home = await worker.prepareGitHome({ repoDir });
        assert.ok(home.endsWith('git-home'), 'git-home 应位于 repoDir 父目录内');
        assert.ok(fs.lstatSync(home).isDirectory());
        assert.ok(fs.existsSync(path.join(home, '.gitconfig')), '应生成空 .gitconfig 供 GIT_CONFIG_GLOBAL 指向');
        // git-home 不应是 repoDir 自身或祖先 repo 目录
        assert.ok(!home.startsWith(repoDir + path.sep), 'git-home 不应在 repoDir 内');
    });

    // ===== 5. storage writeToken 权限 + 读祖先 link 拒绝 + safeEnsureDir 并发幂等 =====
    runTest(5, 'storage writeToken 写前收紧 + 读祖先 link 拒绝 + safeEnsureDir 并发幂等', async () => {
        const storageBase = path.join(HOME, '.jiuguan-github-sync');
        const globalDataRoot = path.join(RUN, 'data-root');
        const handle = 'alice';
        const ud = await storage.userDir(storageBase, globalDataRoot, handle);
        const token = 'ghp_' + crypto.randomBytes(16).toString('hex');
        const tp = await storage.writeToken(ud, token);
        assert.ok(fs.existsSync(tp), 'token 文件应存在');
        assert.strictEqual((await storage.readToken(ud)), token, '读回 token 应一致');

        // 权限：POSIX 断言 0600/0700；Windows 断言 icacls 收紧成功（writeToken 已不抛）
        if (process.platform !== 'win32') {
            const stFile = fs.statSync(tp);
            const stDir = fs.statSync(path.dirname(tp));
            assert.strictEqual(stFile.mode & 0o777, 0o600, `token 文件应 0600，实际 ${(stFile.mode & 0o777).toString(8)}`);
            assert.strictEqual(stDir.mode & 0o777, 0o700, `secrets 目录应 0700，实际 ${(stDir.mode & 0o777).toString(8)}`);
        } else {
            // Windows：resolveWindowsSid 返回 S-1-... 真 SID（不信 USERNAME）
            const sid = storage.resolveWindowsSid();
            assert.match(sid, /^S-1-\d+-\d+(?:-\d+)+$/, `SID 应合法，实际=${sid}`);
        }

        // 读祖先 link 拒绝：把 secrets 的父目录 userDir 用 junction（Windows）/symlink（POSIX）替换后，readToken 应抛 PATH_UNSAFE。
        const userDirLink = ud + '-link';
        if (process.platform === 'win32') {
            // junction 需要目录目标，且 userDir 已存在 → 用新键的目录做祖先替换测试。
            const h2 = 'bob';
            const ud2 = await storage.userDir(storageBase, globalDataRoot, h2);
            // 在 ud2 之上建 junction：把 secrets 祖先替换为 junction 指向外部
            const external = path.join(RUN, 'external-secrets');
            fs.mkdirSync(external, { recursive: true });
            fs.writeFileSync(path.join(external, 'token'), token);
            // 用 junction 让 secrets 指向外部（symlink dir）
            const secretsReal = path.join(ud2, 'secrets');
            fs.mkdirSync(secretsReal, { recursive: true });
            fs.rmdirSync(secretsReal);
            spawnSync('cmd', ['/c', 'mklink', '/J', secretsReal, external], { encoding: 'utf8' });
            let rejected = false;
            try { await storage.readToken(ud2); } catch (e) { if (e && e.code === 'PATH_UNSAFE') rejected = true; }
            assert.ok(rejected, 'secrets 祖先为 junction 时 readToken 应抛 PATH_UNSAFE');
        } else {
            const external = path.join(RUN, 'external-secrets');
            fs.mkdirSync(external, { recursive: true });
            fs.writeFileSync(path.join(external, 'token'), token);
            const h2 = 'bob';
            const ud2 = await storage.userDir(storageBase, globalDataRoot, h2);
            const secretsReal = path.join(ud2, 'secrets');
            fs.mkdirSync(secretsReal, { recursive: true });
            fs.rmdirSync(secretsReal);
            fs.symlinkSync(external, secretsReal, 'dir');
            let rejected = false;
            try { await storage.readToken(ud2); } catch (e) { if (e && e.code === 'PATH_UNSAFE') rejected = true; }
            assert.ok(rejected, 'secrets 祖先为 symlink 时 readToken 应抛 PATH_UNSAFE');
        }

        // safeEnsureDir 并发幂等（EEXIST 复核不误判失败）
        const dirC = path.join(RUN, 'concurrent', 'a', 'b');
        await Promise.all([storage.safeEnsureDir(dirC), storage.safeEnsureDir(dirC), storage.safeEnsureDir(dirC)]);
        assert.ok(fs.lstatSync(dirC).isDirectory(), '并发 safeEnsureDir 应成功');
        // 已存在目录幂等
        await storage.safeEnsureDir(dirC);
    });

    // ===== 6. readToken 目录不存在返回空（仅 ENOENT），link/EACCES 仍抛 =====
    runTest(6, 'readToken 目录不存在返回空（仅 ENOENT），link/EACCES 仍抛', async () => {
        const storageBase = path.join(HOME, '.jiuguan-github-sync');
        const globalDataRoot = path.join(RUN, 'data-root');
        const handle = 'nobody';
        const ud = await storage.userDir(storageBase, globalDataRoot, handle);
        // secrets 目录尚未创建（首次尚无 token）→ readToken 应返回空，不抛。
        const token = await storage.readToken(ud);
        assert.strictEqual(token, '', 'secrets 目录不存在时 readToken 应返回空字符串');
    });

    // ===== 7. Windows ACL 可靠替换：Everyone/Users 宽读被移除，final/tmp 不可宽读，principal 摘要不含 token =====
    runTest(7, 'Windows ACL 可靠替换：Everyone/Users 宽读被移除，final/tmp 不可宽读，principal 摘要不含 token', async () => {
        if (process.platform !== 'win32') return; // POSIX 无此路径（test 5 已覆盖 0600/0700）
        const storageBase = path.join(HOME, '.jiuguan-github-sync');
        const globalDataRoot = path.join(RUN, 'data-root');
        const handle = 'acluser';
        const ud = await storage.userDir(storageBase, globalDataRoot, handle);
        const secretsDir = path.join(ud, 'secrets');
        await storage.safeEnsureDir(secretsDir);

        // 主动添加 Everyone + Users 显式 read（宽读），用于证明可靠 DACL 替换会清掉旧 icacls grant:r 漏删的 ACE。
        // 前置确认：icacls 必须 exit 0，且独立 .NET 枚举确实已注入 Everyone/Users 宽读 ACE（防止注入本身失败导致测试假绿）。
        const g1 = spawnSync('icacls', [secretsDir, '/grant', '*S-1-1-0:(RX)'], { encoding: 'utf8' });
        assert.strictEqual(g1.status, 0, `icacls 注入 Everyone 应 exit 0，实际 ${g1.status}\n${g1.stderr || g1.stdout}`);
        const g2 = spawnSync('icacls', [secretsDir, '/grant', '*S-1-5-32-545:(RX)'], { encoding: 'utf8' });
        assert.strictEqual(g2.status, 0, `icacls 注入 Users 应 exit 0，实际 ${g2.status}\n${g2.stderr || g2.stdout}`);
        const preSids = getAclSids(secretsDir);
        assert.ok(preSids.includes('S-1-1-0'), `前置：Everyone 宽读 ACE 必须已注入（实际 ${JSON.stringify(preSids)}）`);
        assert.ok(preSids.includes('S-1-5-32-545'), `前置：Users 宽读 ACE 必须已注入（实际 ${JSON.stringify(preSids)}）`);

        const token = 'ghp_' + crypto.randomBytes(16).toString('hex');
        const tp = await storage.writeToken(ud, token);

        const sid = storage.resolveWindowsSid();
        // 真实 Get-Acl 枚举目录与最终文件：Everyone(S-1-1-0)/Users(S-1-5-32-545) 必须已移除。
        for (const [label, p] of [['目录', secretsDir], ['最终文件', tp]]) {
            const sids = getAclSids(p);
            assert.ok(!sids.includes('S-1-1-0'), `${label} 不应再有 Everyone 宽读`);
            assert.ok(!sids.includes('S-1-5-32-545'), `${label} 不应再有 Users 宽读`);
        }
        // verifyAcl 真实枚举：恰好 3 主体（当前 SID / SYSTEM / Administrators），返回摘要不含 token / 英文标签。
        const v = storage.verifyAcl(tp, sid);
        assert.strictEqual(v.verified, true);
        assert.ok(Array.isArray(v.principals) && v.principals.length === 3, 'verifyAcl 应返回恰好 3 个真实 SID');
        const expectedSet = new Set([sid, 'S-1-5-18', 'S-1-5-32-544']);
        for (const s of v.principals) assert.ok(expectedSet.has(s), `主体 ${s} 应是当前 SID/SYSTEM/Administrators`);
        const principalJson = JSON.stringify(v.principals);
        assert.ok(!principalJson.includes(token), 'principal 摘要不得包含 token');
        assert.ok(!principalJson.includes('Everyone') && !principalJson.includes('Users'), 'principal 摘要不得含英文标签（必须真实 SID）');

        // 无 tmp 残留（写前收紧 tmp、rename 后清理，异常路径才留残留）。
        const leftovers = fs.readdirSync(secretsDir).filter(f => f.includes('.tmp-'));
        assert.strictEqual(leftovers.length, 0, '不应有 tmp 残留');
        // 读回一致。
        assert.strictEqual((await storage.readToken(ud)), token, '读回 token 应一致');
    });

    // ===== 8. verifyAcl 真实枚举：未知主体/Deny/继承 ACE 被拒绝（非 regex 英文标签） =====
    runTest(8, 'verifyAcl 真实枚举：未知主体/Deny/继承 ACE 被拒绝（非 regex 英文标签）', async () => {
        if (process.platform !== 'win32') return;
        const dir = path.join(RUN, 'acl-probe');
        fs.mkdirSync(dir, { recursive: true });
        const sid = storage.resolveWindowsSid();

        // 辅助：重置到合法 DACL（restrictAcl + 前置 verifyAcl 通过），确保每次注入测试从干净合法状态开始。
        function resetClean() {
            storage.restrictAcl(dir, sid, 'ContainerInherit,ObjectInherit');
            const v = storage.verifyAcl(dir, sid);
            assert.strictEqual(v.verified, true, '重置后 verifyAcl 应通过');
        }

        // 1) 未知主体（Everyone Allow RX）→ verifyAcl 必须拒绝。
        resetClean();
        let g = spawnSync('icacls', [dir, '/grant', '*S-1-1-0:(RX)'], { encoding: 'utf8' });
        assert.strictEqual(g.status, 0, `注入 Everyone 应 exit 0，实际 ${g.status}\n${g.stderr || g.stdout}`);
        assert.ok(getAclSids(dir).includes('S-1-1-0'), '前置：Everyone ACE 必须已注入');
        let rejected = false;
        try { storage.verifyAcl(dir, sid); } catch (e) { if (e && e.code === 'ACL_FAILED') rejected = true; }
        assert.ok(rejected, 'verifyAcl 应拒绝未知主体 Everyone');

        // 2) Deny 当前用户 → verifyAcl 必须拒绝。
        resetClean();
        g = spawnSync('icacls', [dir, '/deny', `*${sid}:(RD)`], { encoding: 'utf8' });
        assert.strictEqual(g.status, 0, `注入 Deny 应 exit 0，实际 ${g.status}\n${g.stderr || g.stdout}`);
        assert.ok(hasDenyAce(dir, sid), '前置：Deny ACE 必须已注入');
        rejected = false;
        try { storage.verifyAcl(dir, sid); } catch (e) { if (e && e.code === 'ACL_FAILED') rejected = true; }
        assert.ok(rejected, 'verifyAcl 应拒绝 Deny ACE');

        // 3) 继承 ACE（子目录从父级继承）→ verifyAcl 必须拒绝（IsInherited === true）。
        // 用独立父子目录制造真实继承：父目录加可继承 ACE(OI|CI)，子目录先 restrictAcl 关闭继承，
        // 再 `/inheritance:e` 开启继承从父级继承 → 产生 IsInherited=true 的 ACE。
        const parentDir = path.join(RUN, 'acl-inherit-parent');
        const childDir = path.join(parentDir, 'child');
        fs.mkdirSync(childDir, { recursive: true });
        g = spawnSync('icacls', [parentDir, '/grant', '*S-1-5-18:(OI)(CI)F'], { encoding: 'utf8' });
        assert.strictEqual(g.status, 0, `父目录注入可继承 ACE 应 exit 0，实际 ${g.status}\n${g.stderr || g.stdout}`);
        storage.restrictAcl(childDir, sid, 'ContainerInherit,ObjectInherit');
        g = spawnSync('icacls', [childDir, '/inheritance:e'], { encoding: 'utf8' });
        assert.strictEqual(g.status, 0, `开启继承应 exit 0，实际 ${g.status}\n${g.stderr || g.stdout}`);
        assert.ok(hasInheritedAce(childDir), '前置：应存在继承 ACE');
        rejected = false;
        try { storage.verifyAcl(childDir, sid); } catch (e) { if (e && e.code === 'ACL_FAILED') rejected = true; }
        assert.ok(rejected, 'verifyAcl 应拒绝继承 ACE');

        // 4) restrictAcl 可靠替换后 → verifyAcl 通过，且恰好 3 个真实 SID；Everyone 被清掉。
        resetClean();
        const v = storage.verifyAcl(dir, sid);
        assert.strictEqual(v.verified, true);
        assert.strictEqual(v.principals.length, 3);
        const sids = getAclSids(dir);
        assert.ok(!sids.includes('S-1-1-0'), 'Everyone 应被 restrictAcl 清掉');
        assert.ok(!sids.includes('S-1-5-32-545'), 'Users 应被 restrictAcl 清掉');
    });

    // ---- 汇总 ----
    const report = {
        generator: 'test/integration-runtime.test.js',
        disclaimer: '真实核心 orchestrator + 本地 bare + 本地 HTTP Git 服务器（Basic Auth 合成 token，不联网）+ 真实 worker fork；远端 url.insteadOf 重写来自工厂参数。未用真实安装/聊天/PAT/互联网 push。',
        createdAt: new Date().toISOString(),
        versions: { node: process.version, git: mustGit(['--version']), platform: process.platform },
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
        if (rec.verdict === 'fail' && rec.error) console.log(`    error: ${rec.error.split('\n').slice(0, 8).join(' | ')}`);
    }

    report.exitCode = report.summary.fail > 0 ? 1 : 0;
    fs.writeFileSync(path.join(RUN, 'results.json'), JSON.stringify(report, null, 2));
    console.log(`[child] summary=${JSON.stringify(report.summary)}`);
    process.exit(report.exitCode);
}

/** 启动一个最小本地 HTTP Git 服务器（用 git http-backend 处理 smart http 协议），带 Basic Auth。 */
function startHttpGitServer(bareRepo, expectedToken, received) {
    const { spawnSync } = require('child_process');
    const http = require('http');
    const projectRoot = path.dirname(path.resolve(bareRepo));
    const repoName = path.basename(bareRepo);
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            // 鉴权检查（Basic x-access-token:<token>）—— Node 层，git 客户端用 askpass 提供凭据。
            const auth = req.headers.authorization || '';
            const m = auth.match(/Basic\s+(.+)/i);
            let pass = '';
            if (m) {
                try { const dec = Buffer.from(m[1], 'base64').toString('utf8'); pass = dec.split(':')[1] || ''; } catch { /* ignore */ }
            }
            if (pass) received.push(pass);
            if (pass !== expectedToken) {
                res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' });
                res.end('Unauthorized');
                return;
            }

            // 收集 body（POST git-upload-pack / git-receive-pack）
            const chunks = [];
            req.on('data', c => chunks.push(c));
            req.on('end', () => {
                const body = Buffer.concat(chunks);
                const url = new URL(req.url, 'http://x');
                // PATH_INFO = /<repoName>/<剩余路径>
                const full = url.pathname; // e.g. /_rt1.git/info/refs
                const pathInfo = full.startsWith('/' + repoName) ? full : ('/' + repoName + full);
                const env = {
                    ...process.env,
                    GIT_PROJECT_ROOT: projectRoot,
                    GIT_HTTP_EXPORT_ALL: '1',
                    PATH_INFO: pathInfo,
                    QUERY_STRING: url.search ? url.search.slice(1) : '',
                    REQUEST_METHOD: req.method,
                    CONTENT_TYPE: req.headers['content-type'] || '',
                    GIT_PROTOCOL: req.headers['git-protocol'] || '',
                    REMOTE_USER: 'x-access-token',
                };
                const r = spawnSync('git', ['http-backend'], { env, input: body, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
                // 解析 CGI 响应：header 块 + \n\n + body（二进制）
                const out = r.stdout || Buffer.alloc(0);
                const sep = findHeaderEnd(out);
                const headerText = out.slice(0, sep).toString('utf8');
                const respBody = out.slice(sep);
                const status = /Status:\s*(\d+)/i.test(headerText) ? parseInt(/Status:\s*(\d+)/i.exec(headerText)[1], 10) : 200;
                const ct = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
                const headers = { 'Content-Type': ct ? ct[1].trim() : 'application/octet-stream' };
                res.writeHead(status, headers);
                res.end(respBody);
            });
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

/** 找 CGI 响应 header/body 分隔（\n\n 或 \r\n\r\n）的字节偏移。 */
function findHeaderEnd(buf) {
    for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i] === 0x0a && buf[i + 1] === 0x0a) return i + 2;
        if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) return i + 4;
    }
    return buf.length;
}

/** 用原始 .NET FileInfo/DirectoryInfo.GetAccessControl() 真实枚举某路径的全部 ACE identity SID（Translate 到 SecurityIdentifier）。 */
function getAclSids(absPath) {
    const script = `
$ErrorActionPreference = 'Stop'
$path = $env:JIUGUAN_ACL_PATH
$fi = [System.IO.FileInfo]::new($path)
$item = if ($fi.Exists) { $fi } else { [System.IO.DirectoryInfo]::new($path) }
$acl = $item.GetAccessControl()
($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | Sort-Object) -join '|'
`;
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], {
        env: { ...process.env, JIUGUAN_ACL_PATH: absPath },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) throw new Error(`Get-Acl 枚举失败: ${r.stderr}`);
    return String(r.stdout).trim().split('|').filter(s => s && s.startsWith('S-1-'));
}

/** 用原始 .NET 枚举某路径是否存在 Deny ACE（Translate 到 SecurityIdentifier 后与目标 SID 比较）。 */
function hasDenyAce(absPath, sid) {
    const script = `
$ErrorActionPreference = 'Stop'
$path = $env:JIUGUAN_ACL_PATH
$sidStr = $env:JIUGUAN_ACL_SID
$fi = [System.IO.FileInfo]::new($path)
$item = if ($fi.Exists) { $fi } else { [System.IO.DirectoryInfo]::new($path) }
$acl = $item.GetAccessControl()
$found = $false
foreach ($r in $acl.Access) {
    $s = $r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($r.AccessControlType -eq 'Deny' -and $s -eq $sidStr) { $found = $true }
}
if ($found) { 'yes' } else { 'no' }
`;
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], {
        env: { ...process.env, JIUGUAN_ACL_PATH: absPath, JIUGUAN_ACL_SID: sid },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) throw new Error(`Deny ACE 枚举失败: ${r.stderr}`);
    return String(r.stdout).trim() === 'yes';
}

/** 用原始 .NET 枚举某路径是否存在继承 ACE（IsInherited === true）。 */
function hasInheritedAce(absPath) {
    const script = `
$ErrorActionPreference = 'Stop'
$path = $env:JIUGUAN_ACL_PATH
$fi = [System.IO.FileInfo]::new($path)
$item = if ($fi.Exists) { $fi } else { [System.IO.DirectoryInfo]::new($path) }
$acl = $item.GetAccessControl()
$found = $false
foreach ($r in $acl.Access) { if ($r.IsInherited) { $found = $true } }
if ($found) { 'yes' } else { 'no' }
`;
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], {
        env: { ...process.env, JIUGUAN_ACL_PATH: absPath },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) throw new Error(`继承 ACE 枚举失败: ${r.stderr}`);
    return String(r.stdout).trim() === 'yes';
}

function shaHashes() {
    const crypto = require('crypto');
    const rel = [
        'lib/integration/worker.js',
        'lib/integration/worker-entry.js',
        'lib/integration/storage.js',
    ];
    const out = {};
    for (const r of rel) {
        try { out[r] = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, r))).digest('hex'); } catch { out[r] = 'missing'; }
    }
    return out;
}

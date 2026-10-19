#!/usr/bin/env node
'use strict';
/**
 * 酒管可靠同步 · CLI 入口真实测试（spawn 真实 bin/reliable-sync.js，不 require API）。
 *
 * 背景：此前 bin/reliable-sync.js 只 `require('../lib/reliable/cli')`，而 cli 仅在
 * `require.main === module` 时才执行 main，导致 `node bin/reliable-sync.js --help` 静默 exit 0、
 * 所有 bin 命令均无动作。本测试 spawn 真实二进制验证入口确实执行。
 *
 * 覆盖：
 *  1. `--help` 输出命令表且 exit 0；
 *  2. 缺命令 / 非法命令 / 缺 --repo-dir/--data-root → 非 0；
 *  3. 无 --offline-confirmed 的 init/apply/recover → 非 0 拒绝；
 *  4. 真实隔离 Git + 合成数据，用 bin 走完 init → push → pull → apply → status 基本往返（至少 1 个完整往返）。
 *
 * 环境：隔离 HOME/TMP、合成数据、本地 bare Git（GIT_ALLOW_PROTOCOL=file、url.insteadOf 本地映射），
 * 不触真实安装/聊天/凭据/网络 push。只 spawn 真实 bin 与真实 git，不 mock 算法。
 *
 * 用法：node test/reliable-cli.test.js [--keep]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'reliable-sync.js');

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
    const run = path.join(ROOT, 'test-artifacts', `cli-${crypto.randomUUID()}`);
    fs.mkdirSync(run, { recursive: true });
    const r = spawnSync(process.execPath, [__filename, '--child', run], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    const produced = path.join(run, 'results.json');
    if (fs.existsSync(produced)) {
        fs.copyFileSync(produced, path.join(ROOT, 'test-artifacts', 'reliable-cli-results.json'));
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

    // ---- 2) 工具：spawn 真实 bin ----
    // 返回 { status, stdout, stderr }
    const runBin = (args, opts = {}) => {
        const r = spawnSync(process.execPath, [BIN, ...args], {
            cwd: RUN, env: process.env, encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024, timeout: 120000, ...opts,
        });
        return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
    };
    const mustGit = (args, cwd) => {
        const r = spawnSync('git', args, { cwd: cwd || RUN, env: process.env, encoding: 'utf8', timeout: 60000 });
        if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr || r.stdout}`);
        return String(r.stdout || '').trim();
    };

    const shaBuf = b => crypto.createHash('sha256').update(b).digest('hex');

    // ---- 3) 建本地 bare + 指向它的工作 clone（含 insteadOf 重写） ----
    function setupRepo(n, seedRel, seedContent) {
        const S = path.join(RUN, `r${n}`);
        const bare = path.join(S, 'bare.git');
        const seed = path.join(S, 'seed');
        const repoDir = path.join(S, 'repo');
        const dataRoot = path.join(S, 'data');
        fs.mkdirSync(seed, { recursive: true });
        const absSeed = path.join(seed, seedRel);
        fs.mkdirSync(path.dirname(absSeed), { recursive: true });
        fs.writeFileSync(absSeed, seedContent);
        mustGit(['init', '-q', '--bare', '-b', 'main', bare]);
        mustGit(['init', '-q', '-b', 'main', seed]);
        mustGit(['add', '-A'], seed);
        mustGit(['-c', 'user.name=seed', '-c', 'user.email=seed@localhost', 'commit', '-qm', 'base'], seed);
        mustGit(['push', '-q', bare, 'main'], seed);
        mustGit(['clone', '-q', bare, repoDir]);
        const bareUrl = `file:///${bare.replace(/\\/g, '/')}`;
        const repo = `fixture/${n}`;
        mustGit(['config', '--local', `url.${bareUrl}.insteadOf`, `https://github.com/${repo}.git`], repoDir);
        for (const [k, v] of [
            ['credential.helper', ''], ['user.name', 'reliable'], ['user.email', 'reliable@localhost'],
            ['core.autocrlf', 'false'], ['core.safecrlf', 'false'],
        ]) {
            mustGit(['config', '--local', k, v], repoDir);
        }
        // dataRoot：chats/Actor/a.jsonl（与远端种子一致，便于 init 后 status）
        fs.mkdirSync(path.join(dataRoot, 'chats', 'Actor'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, 'chats', 'Actor', 'a.jsonl'), seedContent);
        return { S, bare, repoDir, dataRoot, repo, branch: 'main' };
    }

    // 通用 CLI 参数
    const commonArgs = c => ['--repo-dir', c.repoDir, '--data-root', c.dataRoot, '--github-repo', c.repo, '--branch', c.branch];

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

    // ===== 1. --help 输出命令表且 exit 0 =====
    runTest(1, '--help 输出命令表且 exit 0', () => {
        const r = runBin(['--help']);
        assert.strictEqual(r.status, 0, `--help 应 exit 0，实际 ${r.status}\nstderr=${r.stderr}`);
        const out = r.stdout + r.stderr;
        for (const cmd of ['init', 'status', 'push', 'pull', 'apply', 'recover']) {
            assert.ok(out.includes(cmd), `--help 应包含命令 ${cmd}`);
        }
        // 不应把不存在的 sync 命令列进命令表
        assert.ok(!/\bsync\b/.test(out.split('命令:')[1] || ''), '命令表不应包含不存在的 sync 命令');
    });

    // ===== 2. 缺命令 / 非法命令 / 缺必填 → 非 0 =====
    runTest(2, '缺命令 / 非法命令 / 缺 --repo-dir/--data-root → 非 0', () => {
        // 缺命令
        let r = runBin([]);
        assert.notStrictEqual(r.status, 0, '缺命令应非 0');
        // 非法命令
        r = runBin(['bogus-cmd']);
        assert.notStrictEqual(r.status, 0, '非法命令应非 0');
        assert.ok(/未知命令/.test(r.stderr + r.stdout), '非法命令应提示未知命令');
        // 合法命令但缺 --repo-dir/--data-root
        r = runBin(['status']);
        assert.notStrictEqual(r.status, 0, 'status 缺必填应非 0');
        assert.ok(/--repo-dir 与 --data-root 必填/.test(r.stderr + r.stdout), '应提示缺必填参数');
    });

    // ===== 3. 无 --offline-confirmed 的 init/apply/recover → 非 0 拒绝 =====
    runTest(3, '无 --offline-confirmed 的 init/apply/recover → 非 0', () => {
        const c = setupRepo(3, 'chats/Actor/a.jsonl', Buffer.from(JSON.stringify({ mes: 'seed' }) + '\n'));
        for (const cmd of ['init', 'apply', 'recover']) {
            const r = runBin([cmd, ...commonArgs(c)]);
            assert.notStrictEqual(r.status, 0, `${cmd} 无 --offline-confirmed 应非 0`);
            assert.ok(/--offline-confirmed/.test(r.stderr + r.stdout), `${cmd} 应提示 --offline-confirmed`);
        }
    });

    // ===== 4. 完整往返：init → push(建基线) → 编辑 push → pull → apply → status =====
    runTest(4, 'bin init→push→pull→apply→status 基本往返', () => {
        const seedContent = Buffer.from(JSON.stringify({ mes: 'seed-1' }) + '\n');
        const c = setupRepo(4, 'chats/Actor/a.jsonl', seedContent);

        // 4.1 init
        let r = runBin(['init', ...commonArgs(c), '--offline-confirmed']);
        assert.strictEqual(r.status, 0, `init 应成功，实际 ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
        assert.ok(/initialized|已初始化/.test(r.stdout), 'init 应输出已初始化');

        // 4.2 status（免离线确认）
        r = runBin(['status', ...commonArgs(c)]);
        assert.strictEqual(r.status, 0, `status 应成功，实际 ${r.status}\nstderr=${r.stderr}`);
        assert.ok(/"initialized":\s*true/.test(r.stdout), 'status 应输出 initialized=true');

        // 4.3 首次 push：本地==远端==种子 → L=R → 推进基线 B（pushed=false，但建立共同基线）
        r = runBin(['push', ...commonArgs(c), '--offline-confirmed']);
        assert.strictEqual(r.status, 0, `首次 push（建立基线）应成功，实际 ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);

        // 4.4 本地编辑 → push（此时 B=seed，L=edit，R=seed → 发布）
        const edited = Buffer.from(JSON.stringify({ mes: 'seed-2-edited' }) + '\n');
        fs.writeFileSync(path.join(c.dataRoot, 'chats', 'Actor', 'a.jsonl'), edited);
        r = runBin(['push', ...commonArgs(c), '--offline-confirmed']);
        assert.strictEqual(r.status, 0, `push 应成功，实际 ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
        assert.ok(/"pushed":\s*true/.test(r.stdout), `push 应输出 pushed=true，实际 stdout=${r.stdout}`);

        // 4.5 验证远端已更新（通过 bare 的 main 分支读回）
        const remoteContent = spawnSync('git', ['--git-dir', c.bare, 'show', 'main:chats/Actor/a.jsonl'], { env: process.env, timeout: 60000 });
        assert.strictEqual(remoteContent.status, 0, '读取远端失败');
        assert.ok(Buffer.from(remoteContent.stdout).equals(edited), '远端内容应等于 push 的编辑内容');

        // 4.6 制造远端领先：从 bare 新 clone 一个独立工作树，编辑 + commit + push（模拟另一设备推进）。
        //     注意：CLI 的 push 用 `git push origin <commitId>:refs/heads/<branch>`，只更新 bare 的 main，
        //     不更新 repoDir 的本地 main 分支，故不能直接复用 repoDir 的陈旧 main 继续 commit。
        const otherContent = Buffer.from(JSON.stringify({ mes: 'other-device-edit' }) + '\n');
        const otherWork = path.join(c.S, 'other-work');
        mustGit(['clone', '-q', c.bare, otherWork]);
        mustGit(['config', '--local', 'user.name', 'other'], otherWork);
        mustGit(['config', '--local', 'user.email', 'other@localhost'], otherWork);
        fs.writeFileSync(path.join(otherWork, 'chats', 'Actor', 'a.jsonl'), otherContent);
        mustGit(['add', '-A'], otherWork);
        mustGit(['commit', '-qm', 'other edit'], otherWork);
        mustGit(['push', '-q', c.bare, 'main'], otherWork);

        // 4.7 pull（远端领先 → 暂存）
        r = runBin(['pull', ...commonArgs(c), '--offline-confirmed']);
        assert.strictEqual(r.status, 0, `pull 应成功，实际 ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
        assert.ok(/"staged"|"message"/.test(r.stdout), `pull 应输出 staged/message，实际 stdout=${r.stdout}`);

        // 4.8 apply（把暂存写到本地聊天）
        r = runBin(['apply', ...commonArgs(c), '--offline-confirmed']);
        assert.strictEqual(r.status, 0, `apply 应成功，实际 ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
        assert.ok(/已应用|applied/.test(r.stdout), `apply 应输出 applied，实际 stdout=${r.stdout}`);
        // 本地聊天内容应变为 otherContent
        const localAfter = fs.readFileSync(path.join(c.dataRoot, 'chats', 'Actor', 'a.jsonl'));
        assert.ok(localAfter.equals(otherContent), 'apply 后本地聊天应等于远端领先内容');

        // 4.9 status 再确认
        r = runBin(['status', ...commonArgs(c)]);
        assert.strictEqual(r.status, 0, `apply 后 status 应成功，实际 ${r.status}\nstderr=${r.stderr}`);
    });

    // ---- 汇总 ----
    const report = {
        generator: 'test/reliable-cli.test.js',
        disclaimer: 'spawn 真实 bin/reliable-sync.js + 真实 git 二进制；远端为 url.insteadOf 重写后的本地 bare，未起 HTTP/UI、未用真实凭据、未互联网 push。',
        createdAt: new Date().toISOString(),
        versions: { node: process.version, git: mustGit(['--version']) },
        summary: { total: 0, pass: 0, fail: 0, skip: 0 },
        tests: [],
    };

    for (const t of tests) {
        const rec = await execute(t);
        report.tests.push(rec);
        report.summary.total++;
        if (rec.verdict === 'pass') report.summary.pass++;
        else report.summary.fail++;
        console.log(`[${rec.verdict.toUpperCase()}] test ${rec.id}: ${t.title}${rec.error ? '' : ''}`);
        if (rec.verdict === 'fail' && rec.error) console.log(`    error: ${rec.error.split('\n').slice(0, 4).join(' | ')}`);
    }

    report.exitCode = report.summary.fail > 0 ? 1 : 0;
    fs.writeFileSync(path.join(RUN, 'results.json'), JSON.stringify(report, null, 2));
    console.log(`[child] summary=${JSON.stringify(report.summary)}`);
    process.exit(report.exitCode);
}

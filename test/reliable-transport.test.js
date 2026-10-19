#!/usr/bin/env node
'use strict';
/**
 * 酒管可靠同步核心 · 传输层真实测试（本地 bare Git，不 mock 同步算法或 Git 调用）。
 *
 * 覆盖 P1 第 2/9/11/12 项：中文/空格路径、CRLF+BOM+首尾空白原字节、非法 UTF-8 拒绝、
 * tree mode（symlink/submodule 拒绝）、保留远端未改内容、嵌套双路径（斜杠替换不碰撞）、
 * 本地 symlink 与大小写碰撞阻断、分支名校验、blob 缺失 vs 读取错误区分。
 *
 * 结构：父进程创建隔离运行目录并 spawn 本文件 --child <run>；
 * 子进程先隔离环境（HOME/USERPROFILE/TMP/TEMP、GIT_CONFIG_NOSYSTEM、GIT_ALLOW_PROTOCOL=file、
 * 清除令牌/GIT_CONFIG_*、每 repo url.insteadOf 重写 https://github.com/<repo> 到本地 bare），
 * 之后才 require 真实 lib/reliable/* 模块。远端内容一律用 git --git-dir <bare> show main:<path> 读取。
 *
 * 只读真实模块与真实 git 二进制；不访问真实数据/凭据；不互联网 push。
 *
 * 用法：node test/reliable-transport.test.js [--keep]
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
    const run = path.join(ROOT, 'test-artifacts', `transport-${crypto.randomUUID()}`);
    fs.mkdirSync(run, { recursive: true });
    const r = spawnSync(process.execPath, [__filename, '--child', run], { cwd: ROOT, encoding: 'utf8' });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    const produced = path.join(run, 'results.json');
    if (fs.existsSync(produced)) {
        fs.copyFileSync(produced, path.join(ROOT, 'test-artifacts', 'reliable-transport-results.json'));
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

    // ---- 2) 真实模块（隔离后 require） ----
    const gitTree = require(path.join(ROOT, 'lib', 'reliable', 'git-tree.js'));
    const scan = require(path.join(ROOT, 'lib', 'reliable', 'hash-scan.js'));
    const planner = require(path.join(ROOT, 'lib', 'reliable', 'planner.js'));

    // ---- 3) 工具 ----
    const shaBuf = b => crypto.createHash('sha256').update(b).digest('hex');
    const git = (args, cwd) => {
        const r = spawnSync('git', args, { cwd: cwd || RUN, env: process.env, timeout: 60000, encoding: 'utf8' });
        return { ok: r.status === 0, out: String(r.stdout || '').replace(/\r\n/g, '\n').replace(/\n$/, ''), err: String(r.stderr || '').replace(/\r\n/g, '\n').trim() };
    };
    const must = (args, cwd, stdin) => {
        const r = spawnSync('git', args, { cwd: cwd || RUN, env: process.env, timeout: 60000, encoding: 'utf8', input: stdin });
        if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr || r.stdout}`);
        return String(r.stdout || '').replace(/\r\n/g, '\n').replace(/\n$/, '').trim();
    };
    // 读 bare 里某 blob 的原字节
    const showBuf = (bare, p) => {
        const r = spawnSync('git', ['--git-dir', bare, 'show', `main:${p}`], { env: process.env, timeout: 60000 });
        return r.status === 0 ? r.stdout : null;
    };

    // 建一个带种子内容的本地 bare + 一个指向它的工作 clone（含 insteadOf）
    function setupRepo(n, seedFiles) {
        const S = path.join(RUN, `r${n}`);
        const bare = path.join(S, 'bare.git');
        const seed = path.join(S, 'seed');
        const repoDir = path.join(S, 'repo');
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
        const repo = `fixture/${n}`;
        must(['config', '--local', `url.${bareUrl}.insteadOf`, `https://github.com/${repo}.git`], repoDir);
        for (const [k, v] of [['credential.helper', ''], ['user.name', 'reliable'], ['user.email', 'reliable@localhost'],
            ['core.autocrlf', 'false'], ['core.safecrlf', 'false']]) {
            must(['config', '--local', k, v], repoDir);
        }
        const cfg = {
            githubRepo: repo,
            branch: 'main',
            commitAuthor: { name: 'Reliable', email: 'reliable@localhost' },
            tokenFile: '',
        };
        return { S, bare, repoDir, cfg, head: must(['rev-parse', 'HEAD'], repoDir) };
    }

    // 在 repoDir 上构造一个以 baseHead 为父的提交，把 tree 里的某路径替换为 bytes（保留其他条目），push 到 bare。
    // 用真实 git hash-object --no-filters + 临时 index，模拟 buildTreeFromRemote 的核心（保留未改远端内容）。
    async function commitReplacing(c, baseHead, changes, msg) {
        const tmpIndex = path.join(c.S, `idx-${crypto.randomUUID()}`);
        const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
        const r = (args, stdin) => {
            const rr = spawnSync('git', ['-C', c.repoDir, ...args], { env, timeout: 60000, input: stdin });
            if (rr.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${rr.stderr}`);
            return String(rr.stdout).trim();
        };
        r(['read-tree', baseHead]);
        for (const ch of changes) {
            const blob = r(['hash-object', '--no-filters', '-w', '--stdin'], ch.bytes);
            r(['update-index', '--add', '--cacheinfo', `${ch.mode || '100644'},${blob},${ch.rel}`]);
        }
        const tree = r(['write-tree']);
        const commit = r(['commit-tree', tree, '-p', baseHead, '-m', msg]);
        const push = spawnSync('git', ['-C', c.repoDir, 'push', '-q', c.bare, `${commit}:refs/heads/main`], { env: process.env, timeout: 60000 });
        if (push.status !== 0) throw new Error(`push 失败: ${push.stderr}`);
        return commit;
    }

    // 在 repoDir 上注入一个含指定 mode 条目的提交（read-tree + update-index --cacheinfo + write-tree + commit-tree），
    // 支持嵌套路径与 gitlink(120000) 条目，不写工作树、不 push。
    function injectCommit(c, baseHead, entries, msg) {
        const tmpIndex = path.join(c.S, `inj-${crypto.randomUUID()}`);
        const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
        const r = (args, stdin) => {
            const rr = spawnSync('git', ['-C', c.repoDir, ...args], { env, timeout: 60000, input: stdin });
            if (rr.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${rr.stderr}`);
            return String(rr.stdout).trim();
        };
        r(['read-tree', baseHead]);
        for (const e of entries) {
            r(['update-index', '--add', '--cacheinfo', `${e.mode || '100644'},${e.blobId},${e.rel}`]);
        }
        const tree = r(['write-tree']);
        return r(['commit-tree', tree, '-p', baseHead, '-m', msg]);
    }

    const results = [];
    const tests = [];
    const runTest = (id, title, fn) => tests.push({ id, title, fn });
    // 测试可抛 { skip: '原因' } 表示「环境不支持，跳过」——跳过不计 pass 也不计 fail，单独列 skip。
    function skip(reason) { throw { skip: String(reason || '环境不支持') }; }
    async function execute(t) {
        const rec = { id: t.id, title: t.title, verdict: 'fail', error: null };
        try {
            await t.fn(assert);
            rec.verdict = 'pass';
        } catch (e) {
            if (e && typeof e === 'object' && e.skip) {
                rec.verdict = 'skip';
                rec.error = e.skip;
            } else {
                rec.verdict = 'fail';
                rec.error = String(e && e.stack || e);
            }
        }
        return rec;
    }

    // ===== 1. 中文/空格/安全 Unicode 路径（ls-tree -rz 正确枚举） =====
    runTest(1, '中文/空格路径：ls-tree -rz 正确枚举，远端 blob 原字节一致', async () => {
        const zhContent = Buffer.concat([
            Buffer.from(JSON.stringify({ name: '角色', mes: '你好，酒管' })),
            Buffer.from('\n'),
        ]);
        const c = setupRepo(1, [
            { rel: 'chats/角色 A/你好.jsonl', content: zhContent },
            { rel: 'chats/角色 A/keep.jsonl', content: Buffer.from(JSON.stringify({ mes: 'keep' }) + '\n') },
        ]);
        const map = await gitTree.remoteHashesAt(c.repoDir, c.head, true);
        assert.ok(map.has('chats/角色 A/你好.jsonl'), '应枚举中文路径');
        assert.ok(map.has('chats/角色 A/keep.jsonl'), '应枚举同目录另一文件');
        const e = map.get('chats/角色 A/你好.jsonl');
        assert.strictEqual(e.hash, shaBuf(zhContent), '远端中文文件哈希应一致');
        assert.ok(e.bytes && e.bytes.equals(zhContent), '远端中文文件字节应逐字节一致');
    });

    // ===== 2. CRLF + BOM + 首尾空白原字节保留 =====
    runTest(2, 'CRLF+BOM+首尾空白：blob 原字节保留，不丢 bytes', async () => {
        const raw = Buffer.concat([
            Buffer.from('\uFEFF'),
            Buffer.from(JSON.stringify({ name: 'A', mes: ' line with  spaces ' })),
            Buffer.from('\r\n'),
            Buffer.from('   '), // 首尾空白（trim 后为空行，但字节需保留）
            Buffer.from('\r\n'),
        ]);
        const c = setupRepo(2, [{ rel: 'chats/A/x.jsonl', content: raw }]);
        const map = await gitTree.remoteHashesAt(c.repoDir, c.head, true);
        const e = map.get('chats/A/x.jsonl');
        assert.ok(e, '应有 x.jsonl');
        assert.ok(e.bytes.equals(raw), 'BOM/CRLF/首尾空白应逐字节一致');
        assert.strictEqual(e.hash, shaBuf(raw));
    });

    // ===== 3. 非法 UTF-8 拒绝（不吞成 null，也不误判缺失） =====
    runTest(3, '非法 UTF-8：远端 blob 非法字节 → 抛错（不当 null/缺失）', async () => {
        // 注意：不能通过工作树 add 注入非法字节 —— Windows 上 git add 会把非法 UTF-8 规整为 U+FFFD。
        // 改为用 hash-object --no-filters + update-index --cacheinfo 直接向对象库注入原始非法字节。
        const bad = Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d, 0x0a]); // 非法 UTF-8 序列
        const c = setupRepo(3, [{ rel: 'chats/A/real.jsonl', content: Buffer.from(JSON.stringify({ mes: 'r' }) + '\n') }]);
        const blobId = must(['hash-object', '--no-filters', '-w', '--stdin'], c.repoDir, bad);
        const commitId = injectCommit(c, c.head, [{ rel: 'chats/A/bad.jsonl', blobId }], 'inject bad');
        await assert.rejects(() => gitTree.remoteHashesAt(c.repoDir, commitId), /非法 UTF-8|INVALID_UTF8|JSONL/, '非法 UTF-8 应抛错');
    });

    // ===== 4. tree mode：symlink / submodule(gitlink) 拒绝 =====
    runTest(4, 'tree mode：symlink(gitlink) 条目拒绝，不当作普通 blob', async () => {
        const c = setupRepo(4, [{ rel: 'chats/A/real.jsonl', content: Buffer.from(JSON.stringify({ mes: 'r' }) + '\n') }]);
        // 用 update-index --cacheinfo 注入 mode 120000（symlink）条目，避免依赖平台建 symlink 权限。
        const linkBlob = must(['hash-object', '--no-filters', '-w', '--stdin'], c.repoDir, 'real.jsonl');
        const commitId = injectCommit(c, c.head, [{ rel: 'chats/A/evil.jsonl', blobId: linkBlob, mode: '120000' }], 'add symlink');
        await assert.rejects(
            () => gitTree.remoteHashesAt(c.repoDir, commitId),
            /NON_BLOB_REJECTED|不是普通 blob|mode 非法/,
            'symlink(120000) 条目应拒绝'
        );
    });

    // ===== 5. 保留远端未改内容（buildTreeFromRemote 从 H 读树，只改指定路径） =====
    runTest(5, '保留未改远端内容：buildTreeFromRemote 只改指定路径，其余保留', async () => {
        const aBase = Buffer.from(JSON.stringify({ mes: 'a-base' }) + '\n');
        const bBase = Buffer.from(JSON.stringify({ mes: 'b-base' }) + '\n');
        const c = setupRepo(5, [
            { rel: 'chats/A/a.jsonl', content: aBase },
            { rel: 'chats/A/b.jsonl', content: bBase },
        ]);
        // 本地只改 a，构造 tree 并 commit（保留 b）
        const aEdit = Buffer.from(JSON.stringify({ mes: 'a-edit' }) + '\n');
        const { treeId } = await gitTree.buildTreeFromRemote(c.cfg, c.repoDir, c.head, [
            { rel: 'chats/A/a.jsonl', bytes: aEdit, hash: shaBuf(aEdit) },
        ]);
        const commitId = await gitTree.commitTree(c.cfg, c.repoDir, treeId, c.head, 'test-edit');
        // 校验新 commit 的 tree：a 为新内容，b 仍为 base（直接按 commitId 读对象，不依赖 push）
        const aNew = await gitTree.readRemoteBlob(c.repoDir, commitId, 'chats/A/a.jsonl');
        const bStill = await gitTree.readRemoteBlob(c.repoDir, commitId, 'chats/A/b.jsonl');
        assert.ok(aNew && aNew.equals(aEdit), 'a 应为新内容');
        assert.ok(bStill && bStill.equals(bBase), 'b 应保留未改内容');
        assert.ok(/^[0-9a-f]{40}$/.test(commitId));
    });

    // ===== 6. 嵌套双路径：斜杠替换不碰撞（a/b.jsonl 与 a__b.jsonl） =====
    runTest(6, '嵌套双路径：chats/a/b.jsonl 与 chats/a__b.jsonl 是两个独立文件', async () => {
        const c1 = Buffer.from(JSON.stringify({ mes: 'nested' }) + '\n');
        const c2 = Buffer.from(JSON.stringify({ mes: 'flat' }) + '\n');
        const c = setupRepo(6, [
            { rel: 'chats/a/b.jsonl', content: c1 },
            { rel: 'chats/a__b.jsonl', content: c2 },
        ]);
        const map = await gitTree.remoteHashesAt(c.repoDir, c.head, true);
        assert.strictEqual(map.size, 2, '两个独立文件应分别枚举');
        assert.ok(map.get('chats/a/b.jsonl').bytes.equals(c1), 'a/b.jsonl 内容应独立');
        assert.ok(map.get('chats/a__b.jsonl').bytes.equals(c2), 'a__b.jsonl 内容应独立');
    });

    // ===== 7. 本地 symlink 阻断（scanLocal / listChatJsonl） =====
    runTest(7, '本地 symlink：scanLocal 拒绝（不跳过）', async () => {
        const dataRoot = path.join(RUN, 'd7');
        const chats = path.join(dataRoot, 'chats');
        fs.mkdirSync(path.join(chats, 'A'), { recursive: true });
        fs.writeFileSync(path.join(chats, 'A', 'real.jsonl'), JSON.stringify({ mes: 'r' }) + '\n');
        try {
            fs.symlinkSync(path.join(chats, 'A', 'real.jsonl'), path.join(chats, 'A', 'evil.jsonl'));
        } catch (e) {
            if (e.code === 'EPERM' || e.code === 'EACCES') return skip(`Windows 无权限建 symlink: ${e.code}`);
            throw e;
        }
        await assert.rejects(() => scan.scanLocal(dataRoot), /SYMLINK_REJECTED|符号链接/, '本地 symlink 应阻断');
    });

    // ===== 8. 大小写碰撞阻断（仅大小写敏感文件系统可测） =====
    runTest(8, '大小写碰撞：同目录 A.jsonl 与 a.jsonl 阻断（大小写敏感文件系统）', async () => {
        // 探测文件系统是否大小写敏感：写入 A.jsonl 后读 a.jsonl 是否命中同一文件。
        const probe = path.join(RUN, `caseprobe-${crypto.randomUUID()}`);
        fs.mkdirSync(probe, { recursive: true });
        fs.writeFileSync(path.join(probe, 'A.txt'), 'upper');
        let caseSensitive = true;
        try {
            const back = fs.readFileSync(path.join(probe, 'a.txt'), 'utf8');
            caseSensitive = (back !== 'upper'); // 大小写不敏感则 a.txt 命中 A.txt
        } catch { caseSensitive = true; }
        if (!caseSensitive) {
            // 大小写不敏感文件系统上无法创建同名异大小写两个文件，该断言不适用——记 skip，不计 pass。
            return skip('文件系统大小写不敏感，无法创建 A.jsonl/a.jsonl 碰撞样本');
        }
        const dataRoot = path.join(RUN, 'd8');
        const chats = path.join(dataRoot, 'chats');
        fs.mkdirSync(chats, { recursive: true });
        fs.writeFileSync(path.join(chats, 'A.jsonl'), JSON.stringify({ mes: 'upper' }) + '\n');
        fs.writeFileSync(path.join(chats, 'a.jsonl'), JSON.stringify({ mes: 'lower' }) + '\n');
        await assert.rejects(() => scan.scanLocal(dataRoot), /大小写|碰撞|UNSAFE_PATH/, '大小写碰撞应阻断');
    });

    // ===== 9. blob 缺失 vs 读取错误区分 =====
    runTest(9, 'blob 缺失 vs 读取错误：缺失返回 null，读取错误抛错', async () => {
        const c = setupRepo(9, [{ rel: 'chats/A/real.jsonl', content: Buffer.from(JSON.stringify({ mes: 'r' }) + '\n') }]);
        // 缺失路径 → null
        const missing = await gitTree.readRemoteBlob(c.repoDir, c.head, 'chats/A/nope.jsonl');
        assert.strictEqual(missing, null, 'tree 证实缺失应返回 null');
        // 存在路径 → Buffer
        const real = await gitTree.readRemoteBlob(c.repoDir, c.head, 'chats/A/real.jsonl');
        assert.ok(Buffer.isBuffer(real), '存在路径应返回 Buffer');
        // 不存在的 commit（对象缺失）→ 抛错，不返回 null
        await assert.rejects(
            () => gitTree.readRemoteBlob(c.repoDir, '0'.repeat(40), 'chats/A/real.jsonl'),
            /BLOB_READ_FAILED|失败/,
            '对象缺失应抛错而非 null'
        );
    });

    // ===== 10. 分支名校验（check-ref-format，拒绝 - 开头） =====
    runTest(10, '分支名校验：拒绝以 "-" 开头 / 非法分支名', async () => {
        const c = setupRepo(10, [{ rel: 'chats/A/x.jsonl', content: Buffer.from(JSON.stringify({ mes: 'x' }) + '\n') }]);
        await assert.rejects(
            () => gitTree.checkBranchRef('--upload-pack=evil', c.repoDir),
            /INVALID_BRANCH|非法|check-ref-format/,
            '以 - 开头的分支名应拒绝'
        );
        const ok = await gitTree.checkBranchRef('main', c.repoDir);
        assert.strictEqual(ok, 'main');
    });

    // ===== 11. chats 根 symlink/gitlink 阻断（问题 1：根条目 mode/type 校验） =====
    runTest(11, 'chats 根是 symlink(120000)：remoteHashesAt 阻断，不当「无数据」', async () => {
        const c = setupRepo(11, [{ rel: 'chats/A/x.jsonl', content: Buffer.from(JSON.stringify({ mes: 'x' }) + '\n') }]);
        // 用 mktree 构造顶级 tree：chats 根替换为 symlink(120000)（read-tree 后 update-index 无法覆盖既有目录条目）。
        const linkBlob = must(['hash-object', '--no-filters', '-w', '--stdin'], c.repoDir, 'chats/A/x.jsonl');
        const topEntry = Buffer.concat([Buffer.from(`120000 blob ${linkBlob}\tchats\0`)]);
        const mt = spawnSync('git', ['-C', c.repoDir, 'mktree', '-z'], { env: process.env, timeout: 60000, input: topEntry });
        if (mt.status !== 0) throw new Error(`mktree 失败: ${mt.stderr}`);
        const rootTree = String(mt.stdout).trim();
        const commitId = must(['commit-tree', rootTree, '-p', c.head, '-m', 'chats as symlink'], c.repoDir);
        await assert.rejects(
            () => gitTree.remoteHashesAt(c.repoDir, commitId),
            /NON_BLOB_REJECTED|不是普通 blob|symlink|mode 非法/,
            'chats 根 symlink 应阻断'
        );
    });

    // ===== 12. 非 .jsonl 的 symlink/gitlink 阻断（问题 1：后缀筛选前校验后代 mode/type） =====
    runTest(12, '非 .jsonl 的 symlink/gitlink：remoteHashesAt 阻断，不因后缀筛选漏检', async () => {
        const c = setupRepo(12, [{ rel: 'chats/A/x.jsonl', content: Buffer.from(JSON.stringify({ mes: 'x' }) + '\n') }]);
        // 注入一个非 .jsonl 的 symlink 条目（chats/A/evil.txt mode=120000）
        const linkBlob = must(['hash-object', '--no-filters', '-w', '--stdin'], c.repoDir, 'target');
        const commitId = injectCommit(c, c.head, [{ rel: 'chats/A/evil.txt', blobId: linkBlob, mode: '120000' }], 'non-jsonl symlink');
        await assert.rejects(
            () => gitTree.remoteHashesAt(c.repoDir, commitId),
            /NON_BLOB_REJECTED|不是普通 blob|symlink|mode 非法/,
            '非 .jsonl 的 symlink 应在后缀筛选前阻断'
        );
    });

    // ===== 13. Windows 跨平台安全路径（问题 2） =====
    runTest(13, 'Windows 安全路径：设备名.扩展名/冒号 ADS/尾随空格点 拒绝', async () => {
        const bads = [
            'chats/A/CON.jsonl',      // 设备名.扩展名
            'chats/A/NUL.txt',        // 设备名.扩展名
            'chats/A/COM1.jsonl',     // 设备名.扩展名
            'chats/A/COM9.foo.bar',   // 设备名.多扩展名
            'chats/A/file.jsonl:ads', // 冒号 ADS
            'chats/A/file.jsonl ',    // 尾随空格
            'chats/A/file.jsonl.',    // 尾随点
        ];
        for (const p of bads) {
            assert.throws(() => scan.assertSafeRel(p), /UNSAFE_PATH|保留设备名|冒号|尾随|空格或点/, `应拒绝 ${p}`);
        }
        // 显式验证 isWindowsReservedSegment
        assert.strictEqual(scan.isWindowsReservedSegment('CON'), true);
        assert.strictEqual(scan.isWindowsReservedSegment('CON.jsonl'), true);
        assert.strictEqual(scan.isWindowsReservedSegment('NUL.txt'), true);
        assert.strictEqual(scan.isWindowsReservedSegment('COM1.jsonl'), true);
        assert.strictEqual(scan.isWindowsReservedSegment('conversation'), false);
        assert.strictEqual(scan.isWindowsReservedSegment('console.jsonl'), false);
        // 合法路径仍通过
        assert.strictEqual(scan.assertSafeRel('chats/A/你好.jsonl'), 'chats/A/你好.jsonl');
    });

    // ===== 14. ls-tree 非法 UTF-8 文件名拒绝（问题 3：fatal 解码，不替换/不漏） =====
    runTest(14, 'ls-tree 非法 UTF-8 文件名：fatal 解码拒绝，不替换 U+FFFD', async () => {
        // 通过 git mktree -z 直接构造含非法字节文件名的 tree（argv 无法传非法字节，tree 对象可以）。
        const c = setupRepo(14, [{ rel: 'chats/A/x.jsonl', content: Buffer.from(JSON.stringify({ mes: 'x' }) + '\n') }]);
        const goodBlob = must(['hash-object', '--no-filters', '-w', '--stdin'], c.repoDir, '{"a":1}\n');
        const goodTree = must(['rev-parse', `${c.head}^{tree}`], c.repoDir);
        // 构造一个含 `chats/<非法字节>.jsonl` 的 tree：先取 chats 子树，再插入非法名条目。
        // 简化：直接构造一个顶级含 chats 子树的 tree 文本较复杂；改为单独构造 chats 子树。
        const chatsTree = must(['rev-parse', `${c.head}:chats`], c.repoDir);
        // 用 mktree -z 重建 chats 子树：原条目 + 一个非法字节名条目。
        const evilName = Buffer.concat([Buffer.from('evil'), Buffer.from([0xff, 0xfe]), Buffer.from('.jsonl')]);
        const entryLine = Buffer.concat([
            Buffer.from(`100644 blob ${goodBlob}\t`), evilName, Buffer.from('\0'),
        ]);
        // 用 ls-tree 拿到原 chats 子树的现有条目文本（z 格式），追加非法条目后 mktree。
        const ls = spawnSync('git', ['-C', c.repoDir, 'ls-tree', '-z', chatsTree], { env: process.env, timeout: 60000 });
        if (ls.status !== 0) throw new Error(`ls-tree 失败: ${ls.stderr}`);
        const mktreeInput = Buffer.concat([ls.stdout, entryLine]);
        const mt = spawnSync('git', ['-C', c.repoDir, 'mktree', '-z'], { env: process.env, timeout: 60000, input: mktreeInput });
        if (mt.status !== 0) throw new Error(`mktree 失败: ${mt.stderr}`);
        const newChatsTree = String(mt.stdout).trim();
        // 用新 chats 子树构造完整 tree（顶级 tree 的 chats 条目指向 newChatsTree），再 commit。
        const topEntry = Buffer.concat([
            Buffer.from(`040000 tree ${newChatsTree}\tchats\0`),
        ]);
        const mtTop = spawnSync('git', ['-C', c.repoDir, 'mktree', '-z'], { env: process.env, timeout: 60000, input: topEntry });
        if (mtTop.status !== 0) throw new Error(`mktree 顶级失败: ${mtTop.stderr}`);
        const newRootTree = String(mtTop.stdout).trim();
        const commit = must(['commit-tree', newRootTree, '-p', c.head, '-m', 'illegal utf8 name'], c.repoDir);
        await assert.rejects(
            () => gitTree.remoteHashesAt(c.repoDir, commit),
            /INVALID_UTF8|非法 UTF-8/,
            '非法 UTF-8 文件名应 fatal 解码拒绝'
        );
    });

    // ===== 15. buildTreeFromRemote absSnapshotPath 单次读取 + 实际 blob 验证（问题 4） =====
    runTest(15, 'absSnapshotPath：单次读取构造 blob，读回验证，hash 不符拒绝', async () => {
        const aBase = Buffer.from(JSON.stringify({ mes: 'a-base' }) + '\n');
        const bBase = Buffer.from(JSON.stringify({ mes: 'b-base' }) + '\n');
        const c = setupRepo(15, [
            { rel: 'chats/A/a.jsonl', content: aBase },
            { rel: 'chats/A/b.jsonl', content: bBase },
        ]);
        // 快照文件（含 BOM，验证原字节）
        const aEdit = Buffer.concat([Buffer.from('\uFEFF'), Buffer.from(JSON.stringify({ mes: 'a-edit' }) + '\n')]);
        const snapDir = path.join(c.S, 'snap');
        fs.mkdirSync(snapDir, { recursive: true });
        const snapFile = path.join(snapDir, 'a.jsonl.snapshot');
        fs.writeFileSync(snapFile, aEdit);
        // 正确 hash：成功，且构造的 blob 读回等于快照内容
        const { treeId } = await gitTree.buildTreeFromRemote(c.cfg, c.repoDir, c.head, [
            { rel: 'chats/A/a.jsonl', absSnapshotPath: snapFile, hash: shaBuf(aEdit) },
        ]);
        const commitId = await gitTree.commitTree(c.cfg, c.repoDir, treeId, c.head, 'abs-snapshot-ok');
        const aNew = await gitTree.readRemoteBlob(c.repoDir, commitId, 'chats/A/a.jsonl');
        const bStill = await gitTree.readRemoteBlob(c.repoDir, commitId, 'chats/A/b.jsonl');
        assert.ok(aNew && aNew.equals(aEdit), 'a 应为快照原字节（含 BOM）');
        assert.ok(bStill && bStill.equals(bBase), 'b 应保留');
        // 错误 hash：应抛 HASH_MISMATCH，且不产生任何 commit
        await assert.rejects(
            () => gitTree.buildTreeFromRemote(c.cfg, c.repoDir, c.head, [
                { rel: 'chats/A/a.jsonl', absSnapshotPath: snapFile, hash: '0'.repeat(64) },
            ]),
            /HASH_MISMATCH|哈希不匹配/,
            'absSnapshotPath 提供错误 hash 应拒绝'
        );
    });

    // ===== 16. chats 根是普通 blob（100644）：remoteHashesAt 阻断（根必须是 tree） =====
    runTest(16, 'chats 根是普通 blob(100644)：remoteHashesAt 阻断，不当「无数据」', async () => {
        const c = setupRepo(16, [{ rel: 'chats/A/x.jsonl', content: Buffer.from(JSON.stringify({ mes: 'x' }) + '\n') }]);
        // 用 mktree -z 构造顶级 tree：chats 根替换为普通 blob（100644）。
        const blob = must(['hash-object', '--no-filters', '-w', '--stdin'], c.repoDir, '{"mes":"x"}\n');
        const topEntry = Buffer.concat([Buffer.from(`100644 blob ${blob}\tchats\0`)]);
        const mt = spawnSync('git', ['-C', c.repoDir, 'mktree', '-z'], { env: process.env, timeout: 60000, input: topEntry });
        if (mt.status !== 0) throw new Error(`mktree 失败: ${mt.stderr}`);
        const rootTree = String(mt.stdout).trim();
        const commitId = must(['commit-tree', rootTree, '-p', c.head, '-m', 'chats as blob'], c.repoDir);
        await assert.rejects(
            () => gitTree.remoteHashesAt(c.repoDir, commitId),
            /NON_BLOB_REJECTED|必须是目录|tree/,
            'chats 根是普通 blob 应阻断'
        );
    });

    // ===== 17. 跨路径大小写碰撞：远端 tree 同目录 A.jsonl 与 a.jsonl 阻断 =====
    runTest(17, '跨路径大小写碰撞：远端 tree 同目录 A.jsonl 与 a.jsonl 阻断', async () => {
        const c = setupRepo(17, [{ rel: 'chats/A/x.jsonl', content: Buffer.from(JSON.stringify({ mes: 'x' }) + '\n') }]);
        // 用 mktree -z 构造 chats 子树：加入 A.jsonl 与 a.jsonl 两个条目（仅大小写不同）。
        // Git 对象可容纳这两个名字，无需本机 FS 同时创建（在大小写不敏感 FS 上无法创建）。
        const blobUpper = must(['hash-object', '--no-filters', '-w', '--stdin'], c.repoDir, '{"mes":"upper"}\n');
        const blobLower = must(['hash-object', '--no-filters', '-w', '--stdin'], c.repoDir, '{"mes":"lower"}\n');
        const chatsTree = must(['rev-parse', `${c.head}:chats`], c.repoDir);
        const ls = spawnSync('git', ['-C', c.repoDir, 'ls-tree', '-z', chatsTree], { env: process.env, timeout: 60000 });
        if (ls.status !== 0) throw new Error(`ls-tree 失败: ${ls.stderr}`);
        const upperEntry = Buffer.concat([Buffer.from(`100644 blob ${blobUpper}\tA.jsonl\0`)]);
        const lowerEntry = Buffer.concat([Buffer.from(`100644 blob ${blobLower}\ta.jsonl\0`)]);
        const mktreeInput = Buffer.concat([ls.stdout, upperEntry, lowerEntry]);
        const mt = spawnSync('git', ['-C', c.repoDir, 'mktree', '-z'], { env: process.env, timeout: 60000, input: mktreeInput });
        if (mt.status !== 0) throw new Error(`mktree 失败: ${mt.stderr}`);
        const newChatsTree = String(mt.stdout).trim();
        const topEntry = Buffer.concat([Buffer.from(`040000 tree ${newChatsTree}\tchats\0`)]);
        const mtTop = spawnSync('git', ['-C', c.repoDir, 'mktree', '-z'], { env: process.env, timeout: 60000, input: topEntry });
        if (mtTop.status !== 0) throw new Error(`mktree 顶级失败: ${mtTop.stderr}`);
        const newRootTree = String(mtTop.stdout).trim();
        const commitId = must(['commit-tree', newRootTree, '-p', c.head, '-m', 'casefold collision'], c.repoDir);
        await assert.rejects(
            () => gitTree.remoteHashesAt(c.repoDir, commitId),
            /大小写不敏感碰撞|UNSAFE_PATH/,
            '同目录 A.jsonl 与 a.jsonl 应阻断'
        );
    });

    // ===== 18. 祖先目录别名碰撞：chats/Actor/a.jsonl vs chats/actor/a.jsonl 阻断 =====
    runTest(18, '祖先目录别名碰撞：chats/Actor/a.jsonl vs chats/actor/a.jsonl 阻断', async () => {
        const c = setupRepo(18, [{ rel: 'chats/A/x.jsonl', content: Buffer.from(JSON.stringify({ mes: 'x' }) + '\n') }]);
        const blob = must(['hash-object', '--no-filters', '-w', '--stdin'], c.repoDir, '{"mes":"same"}\n');
        // 用 update-index --cacheinfo 注入两个仅目录名大小写不同的嵌套路径，Git 对象可容纳。
        const commitId = injectCommit(c, c.head, [
            { rel: 'chats/Actor/a.jsonl', blobId: blob },
            { rel: 'chats/actor/a.jsonl', blobId: blob },
        ], 'ancestor casefold alias');
        await assert.rejects(
            () => gitTree.remoteHashesAt(c.repoDir, commitId),
            /大小写不敏感碰撞|UNSAFE_PATH/,
            '祖先目录仅大小写不同应阻断'
        );
    });

    // ===== 19. 非 .jsonl 条目的 casefold 碰撞也阻断（问题：检测覆盖所有后代条目） =====
    runTest(19, '非 .jsonl 条目的 casefold 碰撞：chats/A/note.txt vs chats/A/NOTE.txt 阻断', async () => {
        const c = setupRepo(19, [{ rel: 'chats/A/x.jsonl', content: Buffer.from(JSON.stringify({ mes: 'x' }) + '\n') }]);
        const blob = must(['hash-object', '--no-filters', '-w', '--stdin'], c.repoDir, 'note');
        const commitId = injectCommit(c, c.head, [
            { rel: 'chats/A/note.txt', blobId: blob },
            { rel: 'chats/A/NOTE.txt', blobId: blob },
        ], 'non-jsonl casefold');
        await assert.rejects(
            () => gitTree.remoteHashesAt(c.repoDir, commitId),
            /大小写不敏感碰撞|UNSAFE_PATH/,
            '非 .jsonl 条目的 casefold 碰撞应阻断'
        );
    });

    // ===== 20. planner 对 B/L/R 路径并集做 casefold 碰撞检测（单元负测） =====
    runTest(20, 'planner：B/L/R 并集 casefold 碰撞阻断（本地/远端各一种拼写）', async () => {
        // 本地持 chats/Actor/，远端持 chats/actor/，规划前必须阻断，防止 push 造出不可用 tree。
        const localHashes = new Map([['chats/Actor/a.jsonl', { hash: 'a', size: 1 }]]);
        const remoteHashes = new Map([['chats/actor/a.jsonl', { hash: 'b', size: 1 }]]);
        const state = { baseline: {} };
        assert.throws(
            () => planner.plan({ state, localHashes, remoteHashes, remoteHead: '0'.repeat(40) }),
            /大小写不敏感碰撞|UNSAFE_PATH/,
            'B/L/R 并集 casefold 碰撞应阻断'
        );
        // 无碰撞的正常输入不抛，且返回 actions
        const okLocal = new Map([['chats/A/a.jsonl', { hash: 'a', size: 1 }]]);
        const okRemote = new Map([['chats/A/b.jsonl', { hash: 'b', size: 1 }]]);
        const r = planner.plan({ state: { baseline: {} }, localHashes: okLocal, remoteHashes: okRemote, remoteHead: '0'.repeat(40) });
        assert.ok(Array.isArray(r.actions), '无碰撞时应返回 actions 数组');
    });

    // ===== 21. Windows 非法字符 / 控制字符 / 上标设备名 拒绝 =====
    runTest(21, 'Windows 非法字符<>"|?*、控制字符0x01-0x1F、上标设备名COM¹/²/³ LPT¹/²/³ 拒绝', async () => {
        const bads = [
            'chats/A/a<b.jsonl', 'chats/A/a>b.jsonl', 'chats/A/a"b.jsonl',
            'chats/A/a|b.jsonl', 'chats/A/a?b.jsonl', 'chats/A/a*b.jsonl',
            'chats/A/a\u0001b.jsonl', // 控制字符 0x01
            'chats/A/a\u001fb.jsonl', // 控制字符 0x1F
            'chats/A/COM\u00b9.jsonl', // COM¹
            'chats/A/COM\u00b2.jsonl', // COM²
            'chats/A/COM\u00b3.jsonl', // COM³
            'chats/A/LPT\u00b9.txt', // LPT¹
            'chats/A/LPT\u00b2.txt', // LPT²
            'chats/A/LPT\u00b3.txt', // LPT³
        ];
        for (const p of bads) {
            assert.throws(() => scan.assertSafeRel(p), /UNSAFE_PATH|非法字符|控制字符|保留设备名/, `应拒绝 ${p}`);
        }
        // 上标设备名被 isWindowsReservedSegment 识别
        assert.strictEqual(scan.isWindowsReservedSegment('COM\u00b9'), true, 'COM¹ 应判为保留设备名');
        assert.strictEqual(scan.isWindowsReservedSegment('COM\u00b3'), true, 'COM³ 应判为保留设备名');
        assert.strictEqual(scan.isWindowsReservedSegment('LPT\u00b2.jsonl'), true, 'LPT².jsonl 应判为保留设备名');
        // 合法路径仍通过
        assert.strictEqual(scan.assertSafeRel('chats/A/你好.jsonl'), 'chats/A/你好.jsonl');
    });

    // ---- 汇总 ----
    const report = {
        generator: 'test/reliable-transport.test.js',
        disclaimer: '真实 lib/reliable/git-tree.js + hash-scan.js + 真实 git 二进制；远端为 url.insteadOf 重写后的本地 bare，未起 HTTP/UI、未用真实凭据、未互联网 push。',
        createdAt: new Date().toISOString(),
        versions: { node: process.version, git: must(['--version']) },
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
        console.log(`[${rec.verdict.toUpperCase()}] test ${rec.id}: ${rec.title}${rec.error ? `  (${rec.error})` : ''}`);
        if (rec.verdict === 'fail' && rec.error) console.log(`    error: ${rec.error.split('\n').slice(0, 3).join(' | ')}`);
    }

    report.exitCode = report.summary.fail > 0 ? 1 : 0;
    fs.writeFileSync(path.join(RUN, 'results.json'), JSON.stringify(report, null, 2));
    console.log(`[child] summary=${JSON.stringify(report.summary)}`);
    process.exit(report.exitCode);
}

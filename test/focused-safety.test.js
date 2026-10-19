#!/usr/bin/env node
'use strict';
/**
 * 酒管可靠同步 · 聚焦安全负测（P1 三次复审第 5-20/24 条数据保护边界 + 三复审第 1-5 项）。
 *
 * 覆盖：
 * 1. 维护目录祖先 junction/symlink 拒绝（assertRealWithinMaintDir / assertRepoDirReal）。
 * 2. 聊天目标父段 junction/symlink 拒绝且外部合成哨兵不变（verifyTargetParents）。
 * 3. 读错误不当缺失：lstat 非 ENOENT（含真实 EIO 注入）错误抛 CorruptStateError；目录非普通文件也抛错。
 * 4. 半 journal plan 无 manifest → 明确阻断（recoverApply 抛 APPLY_MANIFEST_MISSING）。
 * 5. 分类单测：current 为第三种值 → blockedRels（不覆盖）。
 * 6. 分类单测：current==candidate 识别为已应用（手造合法 manifest + writeFile，非真 rename/新进程恢复）。
 * 7. 旧完整 apply 历史（complete 标志）不阻断后续编辑。
 * 8. manifest 缺备份（backupPath null 但 expectedLocalMissing false）→ schema 拒绝。
 * 9. 真实统一 run：repo/.git 为 junction → 拒绝，且外部 fixture 目录列表+hash 完全不变（含锁/子目录）。
 * 10. 真实统一 run：repo/.git/dsr 为 junction → 拒绝，fixture 不变。
 * 11. safeEnsureDir(backups/r11) helper 祖先 junction → 拒绝（单元负测，非完整 backupCurrent/stage 集成）。
 * 12. 故障间隙：apply 在真实 clearApplyActive 之前 throw（完成标志已 fsync）→ 全新进程 recover 收敛，
 *     不制造「无 manifest 但未 complete 日志」的阻断态（spawn 自身 worker 载体；本地 bare 真实 Git）。
 *
 * 环境：隔离 HOME/TMP、合成数据、本地 Git（GIT_ALLOW_PROTOCOL=file、url.insteadOf），
 * 不触真实安装/聊天/凭据/网络 push。只测模块真实行为，不 mock 算法；不伪造 pending/手写 B 冒充集成故障。
 *
 * 用法：node test/focused-safety.test.js [--keep]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

if (process.argv[2] === '--gap-apply') {
    gapApplyMain().catch(err => { console.error('[gap-apply] 未捕获异常:', err); process.exit(1); });
} else if (process.argv[2] === '--gap-recover') {
    gapRecoverMain().catch(err => { console.error('[gap-recover] 未捕获异常:', err); process.exit(1); });
} else if (process.argv[2] !== '--child') {
    parentMain();
} else {
    childMain().catch(err => {
        console.error('[child] 未捕获异常:', err);
        process.exit(1);
    });
}

function parentMain() {
    const keep = process.argv.includes('--keep');
    const run = path.join(ROOT, 'test-artifacts', `focused-${crypto.randomUUID()}`);
    fs.mkdirSync(run, { recursive: true });
    const r = spawnSync(process.execPath, [__filename, '--child', run], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    const produced = path.join(run, 'results.json');
    if (fs.existsSync(produced)) {
        fs.copyFileSync(produced, path.join(ROOT, 'test-artifacts', 'focused-safety-results.json'));
    }
    if (!keep) {
        try { fs.rmSync(run, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
    console.log(`[parent] run=${path.relative(ROOT, run)}  exit=${r.status}`);
    process.exit(r.status === null ? 1 : r.status);
}

/** 隔离环境（父/child/gap worker 各自进程都调用一次，隔离后再 require 模块）。 */
function isolateEnv(RUN) {
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
}

async function childMain() {
    const RUN = path.resolve(process.argv[3]);
    const assert = require('assert');

    // ---- 1) 环境隔离 ----
    isolateEnv(RUN);

    // ---- 2) 真实模块 ----
    const stateMod = require(path.join(ROOT, 'lib', 'reliable', 'state.js'));
    const applyMod = require(path.join(ROOT, 'lib', 'reliable', 'apply.js'));
    const orchestrator = require(path.join(ROOT, 'lib', 'reliable', 'orchestrator.js'));
    const scan = require(path.join(ROOT, 'lib', 'reliable', 'hash-scan.js'));
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

    /** 创建 junction（失败回退 dir symlink）；两者都失败抛错（调用方决定 skip）。 */
    function makeJunction(target, linkPath) {
        try { fs.symlinkSync(target, linkPath, 'junction'); return 'junction'; }
        catch (e) { fs.symlinkSync(target, linkPath, 'dir'); return 'dir'; }
    }

    /** 快照目录：排序后的相对路径 + 文件哈希（文件/目录/其它项都记录，含子目录）。 */
    function snapshotTree(dir) {
        const out = [];
        (function walk(d, prefix) {
            const entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
            for (const e of entries) {
                const rel = prefix ? `${prefix}/${e.name}` : e.name;
                const abs = path.join(d, e.name);
                if (e.isDirectory()) { out.push(`D ${rel}`); walk(abs, rel); }
                else if (e.isFile()) { out.push(`F ${rel} ${shaBuf(fs.readFileSync(abs))}`); }
                else if (e.isSymbolicLink()) { out.push(`L ${rel}`); }
                else { out.push(`? ${rel}`); }
            }
        })(dir, '');
        return out;
    }

    const results = [];
    function runTest(id, title, fn) { return { id, title, fn }; }
    function skip(msg) { const e = new Error(msg || 'skipped'); e.skip = true; throw e; }
    async function execute(t) {
        const rec = { id: t.id, title: t.title, verdict: 'fail', error: null };
        try {
            await t.fn(assert);
            rec.verdict = 'pass';
        } catch (e) {
            if (e && e.skip) { rec.verdict = 'skip'; rec.error = String(e.message || 'skipped'); }
            else { rec.verdict = 'fail'; rec.error = String(e && e.stack || e); }
        }
        return rec;
    }

    const tests = [];

    // ===== 1. 维护目录祖先 symlink/junction 拒绝 =====
    tests.push(runTest(1, '维护目录祖先 symlink/junction 拒绝（assertRealWithinMaintDir / assertRepoDirReal）', async () => {
        const base = path.join(RUN, 't1');
        fs.mkdirSync(base, { recursive: true });
        const real = path.join(base, 'real');
        fs.mkdirSync(real, { recursive: true });
        const link = path.join(base, 'link');
        makeJunction(real, link);
        fs.mkdirSync(path.join(real, 'child'), { recursive: true });
        const maintDir = path.join(link, 'child');
        await assert.rejects(
            () => stateMod.assertRepoDirReal(maintDir),
            /符号链接|symlink|junction/,
            'repoDir 祖先 symlink 应拒绝'
        );
        const maintLink = path.join(base, 'maint-link');
        makeJunction(real, maintLink);
        await assert.rejects(
            () => stateMod.assertRealWithinMaintDir(maintLink, 'x.json', 'test'),
            /符号链接|symlink|junction/,
            'maintDir 自身链接应拒绝'
        );
    }));

    // ===== 2. 聊天目标父段 symlink 拒绝 + 外部合成哨兵不变 =====
    tests.push(runTest(2, '聊天目标父段 symlink 拒绝且外部合成哨兵不变', async () => {
        const dataRoot = path.join(RUN, 't2', 'data');
        fs.mkdirSync(path.join(dataRoot, 'chats'), { recursive: true });
        const sentinel = path.join(RUN, 't2', 'sentinel.txt');
        fs.writeFileSync(sentinel, 'SENTINEL');
        const outside = path.join(RUN, 't2', 'outside');
        fs.mkdirSync(outside, { recursive: true });
        const actorDir = path.join(dataRoot, 'chats', 'Actor');
        makeJunction(outside, actorDir);
        await assert.rejects(
            () => applyMod.readCurrentTarget(dataRoot, 'chats/Actor/a.jsonl'),
            /符号链接|symlink|junction/,
            '聊天目标父段 symlink 应拒绝'
        );
        assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'SENTINEL', '外部哨兵不应被改写');
        assert.ok(!fs.existsSync(path.join(outside, 'a.jsonl')), '不应向 symlink 目标写文件');
    }));

    // ===== 3. 读错误不当缺失（lstat 非 ENOENT：目录非普通文件 + 真实 EIO 注入） =====
    tests.push(runTest(3, '读错误不当缺失：目录非普通文件抛错 + lstat EIO 注入不当 null/[]', async () => {
        const base = path.join(RUN, 't3');
        fs.mkdirSync(base, { recursive: true });
        // (a) apply-journal.jsonl 本身是目录：lstat 成功但非普通文件 → 抛「不是普通文件」而非返回空
        const maintDir = path.join(base, 'maint');
        fs.mkdirSync(path.join(maintDir, 'apply-journal.jsonl'), { recursive: true });
        await assert.rejects(
            () => stateMod.readApplyJournal(maintDir),
            /不是普通文件|CorruptState|corrupt/i,
            'journal 为目录应抛错而非返回空'
        );
        // (b) state.json 本身是目录：loadState 经 readJsonOrNull 应抛「不是普通文件」而非返回 null
        const maint2 = path.join(base, 'maint2');
        fs.mkdirSync(path.join(maint2, 'state.json'), { recursive: true });
        await assert.rejects(
            () => stateMod.loadState(maint2),
            /不是普通文件|CorruptState|corrupt/i,
            'state.json 为目录应抛错而非返回 null'
        );

        // (c) 真实 lstat EIO 注入：state/pending/journal 路径 lstat 抛 EIO，不得当作缺失返回 null/[]。
        const maint3 = path.join(base, 'maint3');
        fs.mkdirSync(maint3, { recursive: true }); // 文件不存在：朴素实现会返回 null/[]，注入后必须抛
        const origLstat = fsExtra.lstat;
        fsExtra.lstat = function (p, ...rest) {
            const s = String(p);
            if (s.includes('state.json') || s.includes('pending.json') || s.includes('apply-journal.jsonl')) {
                const err = new Error('simulated EIO');
                err.code = 'EIO';
                return Promise.reject(err);
            }
            return origLstat.apply(this, [p, ...rest]);
        };
        try {
            await assert.rejects(() => stateMod.loadState(maint3), /CorruptState|读取失败|非缺失|EIO/i, 'state EIO 不当缺失');
            await assert.rejects(() => stateMod.loadPending(maint3), /CorruptState|读取失败|非缺失|EIO/i, 'pending EIO 不当缺失');
            await assert.rejects(() => stateMod.readApplyJournal(maint3), /CorruptState|读取失败|非缺失|EIO/i, 'journal EIO 不当缺失');
        } finally {
            fsExtra.lstat = origLstat;
        }
    }));

    // ===== 4. 半 journal plan 无 manifest → 明确阻断 =====
    tests.push(runTest(4, '半 journal plan 无 manifest → 明确阻断（不自动猜测）', async () => {
        const base = path.join(RUN, 't4');
        const maintDir = path.join(base, 'maint');
        fs.mkdirSync(maintDir, { recursive: true });
        const dataRoot = path.join(base, 'data');
        fs.mkdirSync(path.join(dataRoot, 'chats'), { recursive: true });
        await stateMod.appendApplyJournal(maintDir, {
            runId: 'r-old', rel: 'chats/Actor/a.jsonl', status: 'plan',
            expectedHash: 'a'.repeat(64), expectedMissing: false,
            candidateHash: 'b'.repeat(64), candidatePath: 'stage/x/abc.content',
            backupPath: null, backupHash: null, ts: new Date().toISOString(),
        });
        const state = {
            schemaVersion: stateMod.SCHEMA_VERSION,
            targetIdentity: 'c'.repeat(16),
            repo: 'owner/repo', branch: 'main', stDataRoot: dataRoot,
            remoteHead: null, baseline: {},
        };
        await assert.rejects(
            () => applyMod.recoverApply(state, maintDir, dataRoot),
            /MANIFEST_MISSING|manifest|人工检查/,
            '无 manifest 但有半 plan 应明确阻断'
        );
    }));

    // 辅助：写一个候选 + 备份（原内容），返回 {candBuf,candHash,candPath,backupPath,backupHash}
    function writeCandidateAndBackup(maintDir, runId, rel, baseName, candBuf, expectedBuf) {
        const stageDir = path.join(maintDir, 'stage', runId);
        fs.mkdirSync(stageDir, { recursive: true });
        const candPath = `stage/${runId}/${baseName}.content`;
        fs.writeFileSync(path.join(maintDir, candPath), candBuf);
        const backupsDir = path.join(maintDir, 'backups', runId);
        fs.mkdirSync(backupsDir, { recursive: true });
        const backupPath = `backups/${runId}/${baseName}.backup`;
        fs.writeFileSync(path.join(maintDir, backupPath), expectedBuf);
        return {
            candBuf, candHash: shaBuf(candBuf), candPath,
            backupPath, backupHash: shaBuf(expectedBuf),
        };
    }

    // ===== 5. 分类单测：current 第三种值 → blockedRels =====
    tests.push(runTest(5, '分类单测：current 为第三种值 → blockedRels（不覆盖）', async () => {
        const base = path.join(RUN, 't5');
        const maintDir = path.join(base, 'maint');
        fs.mkdirSync(maintDir, { recursive: true });
        const dataRoot = path.join(base, 'data');
        fs.mkdirSync(path.join(dataRoot, 'chats', 'Actor'), { recursive: true });
        const rel = 'chats/Actor/a.jsonl';
        const abs = path.join(dataRoot, rel);

        const candBuf = Buffer.from(jl('candidate'));
        const expectedBuf = Buffer.from(jl('expected'));
        const { candHash, candPath, backupPath, backupHash } = writeCandidateAndBackup(maintDir, 'r1', rel, 'abc', candBuf, expectedBuf);

        // 本地当前为第三种值（既非 expected 也非 candidate）
        fs.writeFileSync(abs, jl('third-value'));

        const identity = 'c'.repeat(16);
        const manifest = {
            schemaVersion: stateMod.MANIFEST_SCHEMA_VERSION,
            runId: 'r1',
            targetIdentity: identity,
            stageId: 'r1',
            remoteHead: 'd'.repeat(40),
            createdAt: new Date().toISOString(),
            entries: [{
                rel,
                expectedBaselineHash: null,
                expectedLocalHash: shaBuf(expectedBuf),
                expectedLocalMissing: false,
                candidateHash: candHash,
                candidatePath: candPath,
                backupPath,
                backupHash,
            }],
        };
        await stateMod.writeApplyActive(maintDir, manifest);

        const state = {
            schemaVersion: stateMod.SCHEMA_VERSION,
            targetIdentity: identity,
            repo: 'owner/repo', branch: 'main', stDataRoot: dataRoot,
            remoteHead: null, baseline: {},
        };
        const rec = await applyMod.recoverApply(state, maintDir, dataRoot);
        assert.strictEqual(rec.blockedRels.length, 1, '第三值应阻断');
        assert.strictEqual(rec.blockedRels[0].rel, rel, '阻断 rel 正确');
        assert.strictEqual(shaBuf(fs.readFileSync(abs)), shaBuf(Buffer.from(jl('third-value'))), '第三值不得被覆盖');
    }));

    // ===== 6. 分类单测：current==candidate 识别为已应用（手造 manifest，非真 rename/新进程） =====
    tests.push(runTest(6, '分类单测：current==candidate 识别为已应用（手造 manifest，非真 rename/新进程恢复）', async () => {
        const base = path.join(RUN, 't6');
        const maintDir = path.join(base, 'maint');
        fs.mkdirSync(maintDir, { recursive: true });
        const dataRoot = path.join(base, 'data');
        fs.mkdirSync(path.join(dataRoot, 'chats', 'Actor'), { recursive: true });
        const rel = 'chats/Actor/a.jsonl';
        const abs = path.join(dataRoot, rel);

        const expectedBuf = Buffer.from(jl('expected'));
        const expectedHash = shaBuf(expectedBuf);
        const candBuf = Buffer.from(jl('candidate'));
        const { candHash, candPath, backupPath, backupHash } = writeCandidateAndBackup(maintDir, 'r2', rel, 'abc', candBuf, expectedBuf);

        const identity = 'c'.repeat(16);
        const manifest = {
            schemaVersion: stateMod.MANIFEST_SCHEMA_VERSION,
            runId: 'r2',
            targetIdentity: identity,
            stageId: 'r2',
            remoteHead: 'd'.repeat(40),
            createdAt: new Date().toISOString(),
            entries: [{
                rel,
                expectedBaselineHash: null,
                expectedLocalHash: expectedHash,
                expectedLocalMissing: false,
                candidateHash: candHash,
                candidatePath: candPath,
                backupPath,
                backupHash,
            }],
        };
        await stateMod.writeApplyActive(maintDir, manifest);

        // 手造：本地 == candidate（等价于 rename 已完成的磁盘结果，仅用于分类单测，不冒充真实 rename）
        fs.writeFileSync(abs, candBuf);

        const state = {
            schemaVersion: stateMod.SCHEMA_VERSION,
            targetIdentity: identity,
            repo: 'owner/repo', branch: 'main', stDataRoot: dataRoot,
            remoteHead: null, baseline: {},
        };
        const rec = await applyMod.recoverApply(state, maintDir, dataRoot);
        assert.deepStrictEqual(rec.appliedRels, [rel], 'current==candidate 应识别为已应用');
        assert.strictEqual(rec.blockedRels.length, 0, '不应阻断');
    }));

    // ===== 7. 旧完整 apply 历史（complete 标志）不阻断后续编辑 =====
    tests.push(runTest(7, '旧完整 apply 历史（complete 标志）不阻断后续编辑', async () => {
        const base = path.join(RUN, 't7');
        const maintDir = path.join(base, 'maint');
        fs.mkdirSync(maintDir, { recursive: true });
        const dataRoot = path.join(base, 'data');
        fs.mkdirSync(path.join(dataRoot, 'chats', 'Actor'), { recursive: true });
        const rel = 'chats/Actor/a.jsonl';
        fs.writeFileSync(path.join(dataRoot, rel), jl('now-edited'));

        await stateMod.appendApplyJournal(maintDir, {
            runId: 'r-done', rel, status: 'plan',
            expectedHash: 'a'.repeat(64), expectedMissing: false,
            candidateHash: 'b'.repeat(64), candidatePath: 'stage/x/abc.content',
            backupPath: null, backupHash: null, ts: new Date().toISOString(),
        });
        await stateMod.appendApplyComplete(maintDir, 'r-done');

        const state = {
            schemaVersion: stateMod.SCHEMA_VERSION,
            targetIdentity: 'c'.repeat(16),
            repo: 'owner/repo', branch: 'main', stDataRoot: dataRoot,
            remoteHead: null, baseline: {},
        };
        const rec = await applyMod.recoverApply(state, maintDir, dataRoot);
        assert.strictEqual(rec.activeRunIds.size, 0, '旧完整历史不应产生活动事务');
        assert.strictEqual(rec.appliedRels.length, 0, '不应误判已应用');
        assert.strictEqual(rec.blockedRels.length, 0, '不应阻断');
    }));

    // ===== 8. manifest 缺备份 → schema 拒绝 =====
    tests.push(runTest(8, 'manifest 缺备份（backupPath null 但 expectedLocalMissing false）→ schema 拒绝', async () => {
        const base = path.join(RUN, 't8');
        const maintDir = path.join(base, 'maint');
        fs.mkdirSync(maintDir, { recursive: true });
        const candPath = 'stage/r8/abc.content';
        fs.mkdirSync(path.join(maintDir, 'stage', 'r8'), { recursive: true });
        fs.writeFileSync(path.join(maintDir, candPath), Buffer.from(jl('candidate')));
        const candHash = shaBuf(Buffer.from(jl('candidate')));

        const manifest = {
            schemaVersion: stateMod.MANIFEST_SCHEMA_VERSION,
            runId: 'r8',
            targetIdentity: 'c'.repeat(16),
            stageId: 'r8',
            remoteHead: 'd'.repeat(40),
            createdAt: new Date().toISOString(),
            entries: [{
                rel: 'chats/Actor/a.jsonl',
                expectedBaselineHash: null,
                expectedLocalHash: shaBuf(Buffer.from(jl('expected'))),
                expectedLocalMissing: false,
                candidateHash: candHash,
                candidatePath: candPath,
                backupPath: null,   // 原文件存在却无备份 → 非法
                backupHash: null,
            }],
        };
        await assert.rejects(
            () => stateMod.writeApplyActive(maintDir, manifest),
            /backupPath|backupHash|备份/i,
            '原文件存在却无备份应 schema 拒绝'
        );
    }));

    // ===== 9. 真实统一 run：repo/.git 为 junction → 拒绝 + fixture 不变 =====
    tests.push(runTest(9, '真实统一 run：repo/.git 为 junction → 拒绝，fixture 列表+hash 不变', async () => {
        const base = path.join(RUN, 't9');
        const repoDir = path.join(base, 'repo');
        fs.mkdirSync(repoDir, { recursive: true });
        // 外部 fixture 目录（junction 目标），含哨兵文件
        const realGit = path.join(base, 'realgit');
        fs.mkdirSync(path.join(realGit, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(realGit, 'sub', 'sentinel.txt'), 'KEEP');
        const before = snapshotTree(realGit);
        try {
            makeJunction(realGit, path.join(repoDir, '.git'));
        } catch (e) { return skip(`无法创建 junction: ${e.message}`); }

        await assert.rejects(
            () => orchestrator.run({
                command: 'init', repoDir,
                dataRoot: path.join(base, 'data'),
                githubRepo: 'owner/repo', branch: 'main', offlineConfirmed: true,
            }),
            /符号链接|symlink|junction|目录链/,
            '.git 为 junction 应拒绝'
        );
        const after = snapshotTree(realGit);
        assert.deepStrictEqual(after, before, 'junction 目标 fixture 应完全不变（含锁/子目录）');
    }));

    // ===== 10. 真实统一 run：repo/.git/dsr 为 junction → 拒绝 + fixture 不变 =====
    tests.push(runTest(10, '真实统一 run：repo/.git/dsr 为 junction → 拒绝，fixture 不变', async () => {
        const base = path.join(RUN, 't10');
        const repoDir = path.join(base, 'repo');
        fs.mkdirSync(repoDir, { recursive: true });
        must(['init', '-q', repoDir]);
        const realDsr = path.join(base, 'realdsr');
        fs.mkdirSync(path.join(realDsr, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(realDsr, 'sub', 'sentinel.txt'), 'KEEP');
        const before = snapshotTree(realDsr);
        try {
            makeJunction(realDsr, path.join(repoDir, '.git', 'dsr'));
        } catch (e) { return skip(`无法创建 junction: ${e.message}`); }

        await assert.rejects(
            () => orchestrator.run({
                command: 'init', repoDir,
                dataRoot: path.join(base, 'data'),
                githubRepo: 'owner/repo', branch: 'main', offlineConfirmed: true,
            }),
            /符号链接|symlink|junction|目录链/,
            'dsr 为 junction 应拒绝'
        );
        const after = snapshotTree(realDsr);
        assert.deepStrictEqual(after, before, 'junction 目标 fixture 应完全不变（含锁/子目录）');
    }));

    // ===== 11. safeEnsureDir(backups/r11) helper 祖先 junction → 拒绝 + fixture 不变 =====
    // 注：本测试只针对 safeEnsureDir helper 对「backups 祖先为 junction」的拒绝，是单元级负测，
    // 不声称覆盖完整 backupCurrent（读回校验）或 stage 集成流程（完整集成由主 suite 覆盖）。
    tests.push(runTest(11, 'safeEnsureDir(backups/r11) helper 祖先 junction → 拒绝，fixture 不变（单元负测，非完整 backupCurrent/stage 集成）', async () => {
        const base = path.join(RUN, 't11');
        const maintDir = path.join(base, 'maint');
        fs.mkdirSync(maintDir, { recursive: true });
        const outside = path.join(base, 'outside');
        fs.mkdirSync(path.join(outside, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(outside, 'sub', 'sentinel.txt'), 'KEEP');
        const before = snapshotTree(outside);
        try {
            makeJunction(outside, path.join(maintDir, 'backups'));
        } catch (e) { return skip(`无法创建 junction: ${e.message}`); }

        // safeEnsureDir 直接拒绝 junction 祖先（backups 是 junction）
        await assert.rejects(
            () => stateMod.safeEnsureDir(path.join(maintDir, 'backups', 'r11')),
            /符号链接|symlink|junction|目录链/,
            'backups 祖先 junction 应拒绝'
        );
        const after = snapshotTree(outside);
        assert.deepStrictEqual(after, before, 'junction 目标 fixture 应完全不变（含锁/子目录）');
    }));

    // ===== 12. 故障间隙：clearApplyActive 前 throw → 新进程 recover 收敛 =====
    tests.push(runTest(12, '故障间隙：apply 于 clearApplyActive 前 throw（完成标志已 fsync）→ 新进程 recover 收敛', async () => {
        // 构造真实 git 场景：bare(种子 A) → clone repoDir(带 insteadOf) → dataRoot(=A)
        const S = path.join(RUN, 't12');
        const bare = path.join(S, 'bare.git');
        const seed = path.join(S, 'seed');
        const repoDir = path.join(S, 'repo');
        const dataRoot = path.join(S, 'data');
        const repo = 'fixture/gap';
        const ART = 'chats/Actor/a.jsonl';
        const contentA = jl('a-base');
        const contentA2 = jl('a-peer');

        fs.mkdirSync(seed, { recursive: true });
        fs.mkdirSync(path.join(seed, 'chats', 'Actor'), { recursive: true });
        fs.writeFileSync(path.join(seed, ART), contentA);
        must(['init', '-q', '--bare', '-b', 'main', bare]);
        must(['init', '-q', '-b', 'main', seed]);
        must(['add', '-A'], seed);
        must(['-c', 'user.name=seed', '-c', 'user.email=seed@localhost', 'commit', '-qm', 'base'], seed);
        must(['push', '-q', bare, 'main'], seed);
        must(['clone', '-q', bare, repoDir]);
        const bareUrl = `file:///${bare.replace(/\\/g, '/')}`;
        must(['config', '--local', `url.${bareUrl}.insteadOf`, `https://github.com/${repo}.git`], repoDir);
        for (const [k, v] of [['credential.helper', ''], ['user.name', 'reliable'], ['user.email', 'reliable@localhost'],
            ['core.autocrlf', 'false'], ['core.safecrlf', 'false']]) {
            must(['config', '--local', k, v], repoDir);
        }
        fs.mkdirSync(path.join(dataRoot, 'chats', 'Actor'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, ART), contentA);

        const runOpts = cmd => ({
            command: cmd, repoDir, dataRoot, githubRepo: repo, branch: 'main',
            commitAuthor: { name: 'Reliable', email: 'reliable@localhost' }, tokenFile: '',
            offlineConfirmed: true,
        });

        // init + push（L=R=A → ok，建立 B=A）
        await orchestrator.run(runOpts('init'));
        await orchestrator.run(runOpts('push'));

        // 第二端推进远端：A → A2
        const advAbs = path.join(S, 'advance');
        must(['clone', '-q', bare, advAbs]);
        fs.writeFileSync(path.join(advAbs, ART), contentA2);
        must(['add', '-A'], advAbs);
        must(['-c', 'user.name=peer', '-c', 'user.email=peer@localhost', 'commit', '-qm', 'peer'], advAbs);
        must(['push', '-q', bare, 'main'], advAbs);

        // pull：L=A,B=A,R=A2 → 暂存 A2
        await orchestrator.run(runOpts('pull'));

        // 写场景描述给 gap worker（apply 故障 + recover 都读它）
        const scenFile = path.join(S, 'scenario.json');
        fs.writeFileSync(scenFile, JSON.stringify({ repoDir, dataRoot, repo, branch: 'main' }));

        // (a) 故障 apply：clearApplyActive 前 throw（完成标志已 appendComplete+fsync）
        const gapApply = spawnSync(process.execPath, [__filename, '--gap-apply', RUN, scenFile], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        assert.strictEqual(gapApply.status, 0, `gap-apply worker 应正常退出（记录故障）: ${gapApply.stderr}`);
        const applyRes = JSON.parse(fs.readFileSync(path.join(S, 'apply-result.json'), 'utf8'));
        assert.strictEqual(applyRes.faultFired, true, 'clearApplyActive 故障应确实触发');

        // (b) 中间态断言：manifest 仍在、B 已推进到 A2、stage 已清、完成标志已写（完成标志先于 clearActive）
        const maintDir = path.join(repoDir, '.git', 'dsr');
        const midState = await stateMod.loadState(maintDir);
        assert.strictEqual(midState.baseline[ART].hash, shaBuf(Buffer.from(contentA2)), '故障后 B 应已推进到 A2');
        const midActive = await stateMod.loadApplyActive(maintDir);
        assert.ok(midActive, '故障后 manifest 应仍存在（clearActive 未执行）');
        const midJournal = await stateMod.readApplyJournal(maintDir);
        assert.ok(midJournal.some(r => r.status === 'complete'), '故障后完成标志应已写入（先于 clearActive）');
        assert.strictEqual(await stateMod.loadStage(maintDir), null, '故障后 stage 应已清');

        // (c) 全新进程 recover：应收敛（清 active，不阻断）
        const gapRecover = spawnSync(process.execPath, [__filename, '--gap-recover', RUN, scenFile], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        assert.strictEqual(gapRecover.status, 0, `gap-recover worker 应正常退出: ${gapRecover.stderr}`);
        const recRes = JSON.parse(fs.readFileSync(path.join(S, 'recover-result.json'), 'utf8'));
        assert.strictEqual(recRes.blocked, false, 'recover 不应阻断（无 manifest-missing 未 complete 态）');

        // (d) 最终态：manifest 已清、B 仍为 A2、本地为 A2
        assert.strictEqual(await stateMod.loadApplyActive(maintDir), null, 'recover 后 manifest 应已清');
        const finState = await stateMod.loadState(maintDir);
        assert.strictEqual(finState.baseline[ART].hash, shaBuf(Buffer.from(contentA2)), 'recover 后 B 仍为 A2');
        assert.strictEqual(shaBuf(fs.readFileSync(path.join(dataRoot, ART))), shaBuf(Buffer.from(contentA2)), '本地应为 A2');
    }));

    // ---- 汇总 ----
    const report = {
        generator: 'test/focused-safety.test.js',
        disclaimer: '合成测试（synthetic）：真实 lib/reliable/*（state/apply/orchestrator/hash-scan）+ 合成数据 + 本地 Git；#12 用本地 bare + spawn 全新进程 recover；url.insteadOf 重写为本地仓库，未起 HTTP/UI；隔离 HOME/TMP；不触真实安装/聊天/凭据/网络 push。',
        createdAt: new Date().toISOString(),
        versions: { node: process.version, git: (git(['--version']).out || '').trim() },
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
        if (rec.error) console.log(`    ${rec.verdict === 'skip' ? 'skip' : 'error'}: ${rec.error.split('\n').slice(0, 4).join(' | ')}`);
    }

    report.exitCode = report.summary.fail > 0 ? 1 : 0;
    fs.writeFileSync(path.join(RUN, 'results.json'), JSON.stringify(report, null, 2));
    console.log(`[child] summary=${JSON.stringify(report.summary)}`);
    process.exit(report.exitCode);
}

// ===== gap-apply worker：真实 apply，clearApplyActive 前 throw =====
async function gapApplyMain() {
    const RUN = path.resolve(process.argv[3]);
    const scenFile = process.argv[4];
    isolateEnv(RUN);
    const stateMod = require(path.join(ROOT, 'lib', 'reliable', 'state.js'));
    const orchestrator = require(path.join(ROOT, 'lib', 'reliable', 'orchestrator.js'));
    const scen = JSON.parse(fs.readFileSync(scenFile, 'utf8'));
    const S = path.dirname(scenFile);
    const resultFile = path.join(S, 'apply-result.json');

    // 包装真实 clearApplyActive：在真实执行前 throw（模拟在完成标志已写、尚未清 active 的临界窗口崩溃）。
    let faultFired = false;
    stateMod.clearApplyActive = async function () {
        faultFired = true;
        const err = new Error('injected: crash before clearApplyActive');
        err.code = 'FAULT_INJECTED';
        throw err;
    };

    try {
        await orchestrator.run({
            command: 'apply', repoDir: scen.repoDir, dataRoot: scen.dataRoot,
            githubRepo: scen.repo, branch: scen.branch,
            commitAuthor: { name: 'Reliable', email: 'reliable@localhost' }, tokenFile: '',
            offlineConfirmed: true,
        });
        fs.writeFileSync(resultFile, JSON.stringify({ faultFired, threw: false }));
    } catch (e) {
        fs.writeFileSync(resultFile, JSON.stringify({ faultFired, threw: true, code: e && e.code, message: String(e && e.message) }));
    }
    process.exit(0);
}

// ===== gap-recover worker：全新进程 recover =====
async function gapRecoverMain() {
    const RUN = path.resolve(process.argv[3]);
    const scenFile = process.argv[4];
    isolateEnv(RUN);
    const orchestrator = require(path.join(ROOT, 'lib', 'reliable', 'orchestrator.js'));
    const scen = JSON.parse(fs.readFileSync(scenFile, 'utf8'));
    const S = path.dirname(scenFile);
    const resultFile = path.join(S, 'recover-result.json');

    try {
        const r = await orchestrator.run({
            command: 'recover', repoDir: scen.repoDir, dataRoot: scen.dataRoot,
            githubRepo: scen.repo, branch: scen.branch,
            commitAuthor: { name: 'Reliable', email: 'reliable@localhost' }, tokenFile: '',
            offlineConfirmed: true,
        });
        const blocked = !!(r && r.apply && r.apply.blocked);
        fs.writeFileSync(resultFile, JSON.stringify({ blocked }));
    } catch (e) {
        fs.writeFileSync(resultFile, JSON.stringify({ blocked: null, error: String(e && e.message), code: e && e.code }));
    }
    process.exit(0);
}

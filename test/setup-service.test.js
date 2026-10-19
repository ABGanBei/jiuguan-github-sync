#!/usr/bin/env node
'use strict';
// Synthetic, sequential checks for the new setup API and read-only stage preview.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectRepository } = require('../lib/integration/github');
const { createService } = require('../lib/integration/service');
const state = require('../lib/reliable/state');
const { preflight } = require('../lib/integration/preflight');

const RUN = path.resolve(__dirname, '..', 'test-artifacts', 'setup-service-' + crypto.randomUUID());
fs.mkdirSync(RUN, { recursive: true });
const results = [];
const repo = 'synthetic/private-chat';
const token = 'synthetic-token-do-not-use';
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const response = data => ({ ok: true, text: async () => JSON.stringify(data) });
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function inspect(fetchImpl, extra = {}) { return inspectRepository({ repo, token, fetchImpl, ...extra }); }

test('GitHub credentials are header-only; redirects are rejected; private identity is checked', async () => {
    const result = await inspect(async (url, options) => {
        assert.equal(url, 'https://api.github.com/repos/' + repo);
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers.Authorization, 'Bearer ' + token);
        assert.equal(url.includes(token), false);
        return response({ full_name: repo, private: true, permissions: { push: true } });
    });
    assert.equal(result.private, true);
    assert.equal(result.writePermissionHint, true); // A hint is not a tested write.
});
for (const status of [401, 403, 404, 429, 500]) {
    test('GitHub ' + status + ' response never echoes its body or credentials', async () => {
        let bodyRead = false;
        await assert.rejects(() => inspect(async () => ({ ok: false, status, text: async () => {
            bodyRead = true; return token;
        } })), e => e.code === 'GITHUB_' + status && !String(e).includes(token));
        assert.equal(bodyRead, false);
    });
}
test('Public, archived, renamed and malformed repository responses are blocked', async () => {
    for (const [data, code] of [
        [{ full_name: repo, private: false }, 'PRIVATE_REPOSITORY_REQUIRED'],
        [{ full_name: repo, private: true, archived: true }, 'REPOSITORY_READ_ONLY'],
        [{ full_name: 'other/repo', private: true }, 'REPOSITORY_MISMATCH'],
    ]) await assert.rejects(() => inspect(async () => response(data)), { code });
    await assert.rejects(() => inspect(async () => ({ ok: true, text: async () => '{' })), { code: 'GITHUB_RESPONSE' });
    await assert.rejects(() => inspect(async () => ({ ok: true, text: async () => 'x'.repeat(262145) })), { code: 'GITHUB_RESPONSE' });
});
test('Timeout and network errors are redacted and fail closed', async () => {
    await assert.rejects(() => inspect(async () => { throw new Error(token); }), e => e.code === 'GITHUB_UNAVAILABLE' && !String(e).includes(token));
    await assert.rejects(() => inspect((url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error(token)), { once: true });
    }), { timeoutMs: 5 }), { code: 'GITHUB_UNAVAILABLE' });
});

let counter = 0;
function fixture(overrides = {}) {
    const base = path.join(RUN, 'case-' + ++counter);
    const globalDataRoot = path.join(base, 'data');
    const dataRoot = path.join(globalDataRoot, 'alice');
    fs.mkdirSync(path.join(dataRoot, 'chats', 'Actor'), { recursive: true });
    const user = { handle: 'alice', dataRoot };
    const calls = [];
    const options = { dataRoot: globalDataRoot, storageBase: path.join(base, 'storage'), hostRoot: base,
        repositoryInspector: async () => ({ private: true, fullName: repo }),
        workerRunner: async task => {
            calls.push(task);
            if (task.op === 'connect') return { connected: true, needsRemoteInit: false };
            if (task.command === 'init') {
                const maint = state.getMaintDir(task.repoDir);
                fs.mkdirSync(maint, { recursive: true });
                await state.saveState(maint, { schemaVersion: 1, targetIdentity: state.bindTargetIdentity({ repo, branch: 'main', stDataRoot: dataRoot }),
                    repo, branch: 'main', stDataRoot: dataRoot, remoteHead: null, baseline: {} });
                return {};
            }
            if (task.command === 'status') return { identity: 'ok', remoteHeadSource: 'cached' };
            if (task.command === 'push') return { published: ['chats/Actor/a.jsonl'], conflicts: [] };
            if (task.command === 'pull') return { staged: [], conflicts: [] };
            if (task.op === 'preflight') return { ready: false, stageId: null, files: [] };
            throw new Error('Unexpected synthetic task');
        }, ...overrides };
    return { base, calls, options, user, service: createService(options) };
}
test('Missing branch requires explicit initialization and does not create local baseline', async () => {
    const f = fixture({ workerRunner: async task => {
        f.calls.push(task);
        assert.equal(task.op, 'connect');
        return { needsRemoteInit: true, remoteEmpty: true };
    } });
    await f.service.putConfig(f.user, { githubRepo: repo, token });
    const r = await f.service.connect(f.user, {});
    assert.equal(r.connected, false);
    assert.equal(r.needsRemoteInit, true);
    assert.equal(r.remoteEmpty, true);
    assert.equal(r.verification.write, 'unverified');
    assert.equal(f.calls.length, 1);
    await assert.rejects(() => f.service.push(f.user, {}), { code: 'SETUP_REQUIRED' });
    f.service.stopAll();
});
test('Read verification differs from actual write; upload and check history survive restart', async () => {
    const f = fixture();
    await f.service.putConfig(f.user, { githubRepo: repo, token });
    const r = await f.service.connect(f.user, {});
    assert.equal(r.verification.read, 'verified');
    assert.equal(r.verification.write, 'unverified');
    await f.service.push(f.user, {});
    await f.service.pull(f.user, {});
    const restarted = createService(f.options);
    const s = (await restarted.status(f.user)).status;
    assert.equal(s.readyForSync, true);
    assert.equal(s.history.verification.write, 'verified');
    assert.equal(s.history.lastUpload.outcome, 'success');
    assert.equal(s.history.lastUpload.count, 1);
    assert.equal(s.history.lastCheck.outcome, 'no-changes');
    assert.ok(Number.isFinite(Date.parse(s.history.lastUpload.at)));
    await assert.rejects(() => restarted.putConfig(f.user, { githubRepo: '' }), { code: 'TARGET_SWITCH_REJECTED' });
    await restarted.putConfig(f.user, { token: 'replacement-synthetic-token' });
    assert.equal((await restarted.status(f.user)).status.readyForSync, false);
    await assert.rejects(() => restarted.push(f.user, {}), { code: 'SETUP_REQUIRED' });
    f.service.stopAll(); restarted.stopAll();
});
test('Public repository blocks setup before the transport is invoked', async () => {
    const f = fixture({ repositoryInspector: async () => ({ private: false }) });
    await f.service.putConfig(f.user, { githubRepo: repo, token });
    await assert.rejects(() => f.service.connect(f.user, { initializeEmptyBranch: true }), { code: 'PRIVATE_REPOSITORY_REQUIRED' });
    assert.equal(f.calls.length, 0);
    f.service.stopAll();
});

async function stageFixture() {
    const base = path.join(RUN, 'preview-' + ++counter);
    const task = { repoDir: path.join(base, 'repo'), dataRoot: path.join(base, 'data'), githubRepo: repo, branch: 'main' };
    const maint = state.getMaintDir(task.repoDir);
    fs.mkdirSync(path.join(maint, 'stage'), { recursive: true });
    fs.mkdirSync(path.join(task.dataRoot, 'chats', 'Actor'), { recursive: true });
    const rel = 'chats/Actor/a.jsonl';
    const current = Buffer.from('{"name":"Actor","mes":"before"}\n');
    const candidate = Buffer.from('{"name":"Actor","mes":"after","swipes":["A","B"],"swipe_id":1}\n');
    const target = path.join(task.dataRoot, rel);
    fs.writeFileSync(target, current);
    fs.writeFileSync(path.join(maint, 'stage', 'candidate.jsonl'), candidate);
    const targetIdentity = state.bindTargetIdentity({ repo, branch: 'main', stDataRoot: task.dataRoot });
    await state.saveState(maint, { schemaVersion: 1, targetIdentity, repo, branch: 'main', stDataRoot: task.dataRoot,
        remoteHead: 'a'.repeat(40), baseline: { [rel]: { hash: hash(current), setAt: new Date().toISOString() } } });
    await state.writeStage(maint, { runId: 'synthetic-stage', remoteHead: 'b'.repeat(40), targetIdentity,
        createdAt: new Date().toISOString(), entries: [{ rel, expectedBaselineHash: hash(current), expectedLocalHash: hash(current),
            expectedLocalMissing: false, candidateHash: hash(candidate), candidatePath: 'stage/candidate.jsonl', remoteCommit: 'b'.repeat(40) }] });
    return { task, target, maint, current };
}
test('Stage preview validates bytes and leaves active chat bytes unchanged', async () => {
    const f = await stageFixture();
    const r = await preflight(f.task);
    assert.equal(r.ready, true);
    assert.equal(r.stageId, 'synthetic-stage');
    assert.deepEqual(r.files, ['chats/Actor/a.jsonl']);
    assert.deepEqual(fs.readFileSync(f.target), f.current);
    assert.equal(fs.existsSync(state.activeManifestPath(f.maint)), false);
    assert.equal(fs.existsSync(path.join(f.maint, 'lock')), false);
});
test('Changed local chat and damaged candidate prevent preview without overwriting data', async () => {
    const f = await stageFixture();
    const changed = Buffer.from('{"mes":"saved later"}\n');
    fs.writeFileSync(f.target, changed);
    await assert.rejects(() => preflight(f.task), { code: 'LOCAL_CHANGED' });
    assert.deepEqual(fs.readFileSync(f.target), changed);
    fs.writeFileSync(f.target, f.current);
    fs.writeFileSync(path.join(f.maint, 'stage', 'candidate.jsonl'), 'damaged');
    await assert.rejects(() => preflight(f.task), { code: 'STAGE_CORRUPT' });
    assert.deepEqual(fs.readFileSync(f.target), f.current);
});
test('Pending transaction and mismatched identity block preview and preserve chat', async () => {
    const f = await stageFixture();
    await assert.rejects(() => preflight({ ...f.task, branch: 'other' }), { code: 'TARGET_MISMATCH' });
    await state.writePending(f.maint, { runId: 'synthetic-pending', remoteHead: null, targetIdentity: state.bindTargetIdentity({ repo,
        branch: 'main', stDataRoot: f.task.dataRoot }), phase: 'built', treeId: null, commitId: null, edits: [], createdAt: new Date().toISOString() });
    await assert.rejects(() => preflight(f.task), { code: 'NEEDS_OFFLINE_RECOVERY' });
    assert.deepEqual(fs.readFileSync(f.target), f.current);
});
test('Incomplete or corrupt apply journal blocks preview just as startup does', async () => {
    const f = await stageFixture();
    await state.appendApplyJournal(f.maint, { runId: 'incomplete', rel: 'chats/Actor/a.jsonl', status: 'plan', ts: new Date().toISOString() });
    await assert.rejects(() => preflight(f.task), { code: 'NEEDS_OFFLINE_RECOVERY' });
    fs.writeFileSync(path.join(f.maint, 'apply-journal.jsonl'), '{broken');
    await assert.rejects(() => preflight(f.task), { code: 'CORRUPT_STATE' });
    assert.deepEqual(fs.readFileSync(f.target), f.current);
});

(async () => {
    for (const t of tests) {
        try { await t.fn(); results.push({ name: t.name, verdict: 'pass' }); console.log('[PASS] ' + t.name); }
        catch (e) { results.push({ name: t.name, verdict: 'fail', error: e.stack }); console.error('[FAIL] ' + t.name + '\n' + e.stack); }
    }
    const summary = { total: results.length, pass: results.filter(x => x.verdict === 'pass').length, fail: results.filter(x => x.verdict === 'fail').length, skip: 0 };
    fs.writeFileSync(path.resolve(__dirname, '..', 'test-artifacts', 'setup-service-results.json'), JSON.stringify({ summary, results }, null, 2));
    console.log('summary=' + JSON.stringify(summary));
    process.exitCode = summary.fail ? 1 : 0;
})().catch(e => { console.error(e.stack); process.exitCode = 1; });

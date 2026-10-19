#!/usr/bin/env node
'use strict';
// Isolated VM/DOM contract tests. No browser, GitHub, host, real token or chat access.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'client/index.js'), 'utf8');
const CAPABILITIES = { onlineSnapshot: true, startupApply: true, setupWizard: true, safePreview: true, statusHistory: true };
const VERIFICATION = { private: true, read: 'verified', write: 'unverified', checkedAt: '2026-10-19T06:00:00Z' };
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function json(value) { return JSON.parse(JSON.stringify(value)); }
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settled(rt) {
    for (let i = 0; i < 100; i++) {
        await tick();
        if (!rt.exp.isAnyOpInProgress()) return;
    }
    throw new Error('VM operation did not settle');
}
function runtime(options = {}) {
    const elements = {};
    class Node {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {};
            this.style = {}; this.id = ''; this.value = ''; this.checked = false;
            this.disabled = false; this.readOnly = false; this.open = false; this._text = '';
        }
        set textContent(value) { this._text = String(value); this.children = []; }
        get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
        appendChild(node) { this.children.push(node); return node; }
        addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
        dispatch(name) { for (const listener of this.listeners[name] || []) listener({ target: this }); }
    }
    const state = {
        config: { githubRepo: 'owner/private-data', branch: 'main', autoCheckEnabled: false, autoCheckMinutes: 30 },
        hasToken: true, targetLocked: false,
        status: { configured: true, connected: true, readyForSync: true, busy: false, targetLocked: false,
            stageId: null, stagedFiles: [], remoteSource: 'cached', scheduledApply: null,
            history: { lastCheck: null, lastUpload: null, verification: json(VERIFICATION) }, lastAppliedAt: null },
        ...options.state,
    };
    const calls = []; const notifications = []; const logs = [];
    const handlers = options.handlers || {};
    const ns = { isChatSaving: false, isGenerating: () => false };
    const sandbox = {
        module: { exports: {} }, exports: {},
        document: { readyState: 'loading', createElement: tag => new Node(tag), getElementById: id => elements[id] || null,
            body: new Node('body'), addEventListener() {} },
        SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'synthetic-csrf' }) }) },
        __JG_BUSY_LOADER__: () => ns,
        console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
        toastr: Object.fromEntries(['success','warning','error','info'].map(kind => [kind, message => notifications.push({ kind, message })])),
        setInterval: () => 0, setTimeout: () => 0, clearInterval() {},
        fetch: async (url, opts) => {
            const endpoint = url.split('/api/plugins/github-data-sync')[1];
            const method = opts.method; const body = opts.body ? JSON.parse(opts.body) : undefined;
            const call = { endpoint, method, body, headers: opts.headers }; calls.push(call);
            let data; let status = 200;
            const handler = handlers[method + ' ' + endpoint];
            if (handler) data = await handler({ state, call, calls });
            else if (endpoint === '/health') data = { success: true, version: '1.4.0-preview.1', capabilities: options.capabilities || CAPABILITIES };
            else if (endpoint === '/config' && method === 'GET') data = { success: true, config: state.config, hasToken: state.hasToken, targetLocked: state.targetLocked };
            else if (endpoint === '/config' && method === 'PUT') {
                for (const field of ['githubRepo','branch','autoCheckEnabled','autoCheckMinutes']) if (body[field] !== undefined) state.config[field] = body[field];
                if (body.token) state.hasToken = true;
                data = { success: true, config: state.config, hasToken: state.hasToken, targetLocked: state.targetLocked };
            } else if (endpoint === '/status') data = { success: true, status: state.status };
            else if (endpoint === '/connect') data = { success: true, connected: true, initializedRemote: false, needsRemoteInit: false, verification: VERIFICATION };
            else throw new Error('unexpected VM request ' + method + ' ' + endpoint);
            if (data && data.__httpStatus) { status = data.__httpStatus; data = { ...data }; delete data.__httpStatus; }
            return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(data) };
        },
    };
    vm.createContext(sandbox); sandbox.globalThis = sandbox;
    vm.runInContext(SOURCE, sandbox, { filename: 'client/index.js' });
    const exp = sandbox.module.exports; const panel = exp.buildPanelHtml();
    const index = node => { if (node.id) elements[node.id] = node; for (const child of node.children) index(child); };
    index(panel);
    return { exp, elements, panel, state, calls, notifications, logs, ns };
}
async function warm(rt, bind = false) {
    if (bind) rt.exp.bind();
    else { rt.exp.applyConfig({ config: rt.state.config, targetLocked: rt.state.targetLocked, hasToken: rt.state.hasToken }, true); await rt.exp.refreshStatus(); }
    await settled(rt);
    return rt;
}
function requestCount(rt, endpoint) { return rt.calls.filter(c => c.endpoint === endpoint).length; }
function text(rt, id) { return rt.elements[id].textContent; }
function visible(rt, id) { return rt.elements[id].style.display !== 'none'; }

test('three setup steps, direct GitHub links, only two daily primary buttons, folded details', async () => {
    const rt = await warm(runtime());
    const daily = rt.elements['jg-main-actions'].children;
    assert.deepStrictEqual(daily.map(n => n.id), ['jg-upload','jg-download']);
    assert.strictEqual(daily[1].textContent, '检查更新');
    assert.strictEqual(rt.elements['jg-settings'].tagName, 'DETAILS');
    for (const id of ['jg-auto-settings','jg-technical-details','jg-branch-details']) {
        assert.strictEqual(rt.elements[id].tagName, 'DETAILS');
        assert.strictEqual(rt.elements[id].open, false);
    }
    const all = []; const walk = node => { all.push(node); node.children.forEach(walk); }; walk(rt.panel);
    const links = all.filter(n => n.tagName === 'A');
    assert.ok(links.some(n => n.href === 'https://github.com/new'));
    assert.ok(links.some(n => n.href === 'https://github.com/settings/personal-access-tokens/new'));
    assert.ok(rt.panel.textContent.includes('明文进入 Git 历史'));
    assert.ok(rt.panel.textContent.includes('不代表聊天已同步'));
});

test('missing setup capability blocks old backend and imperative actions with no downgrade', async () => {
    const rt = await warm(runtime({ capabilities: { onlineSnapshot: true, startupApply: true } }));
    assert.strictEqual(rt.exp.capabilitiesOk(), false);
    assert.strictEqual(rt.elements['jg-upload'].disabled, true);
    assert.strictEqual(rt.elements['jg-download'].disabled, true);
    await assert.rejects(() => rt.exp.doUpload(), /后端能力/);
    await assert.rejects(() => rt.exp.doDownload(), /后端能力/);
    assert.strictEqual(requestCount(rt, '/push') + requestCount(rt, '/pull'), 0);
    assert.strictEqual(rt.elements['jg-technical-details'].open, true);
});

test('not configured or blocked status disables push and pull even with capable backend', async () => {
    const rt = await warm(runtime({ state: { status: { configured: false, connected: false, readyForSync: false } } }));
    await assert.rejects(() => rt.exp.doUpload(), /同步尚未就绪/);
    await assert.rejects(() => rt.exp.doDownload(), /同步尚未就绪/);
    assert.strictEqual(rt.elements['jg-settings'].open, true);
    rt.exp.renderStatus({ configured: true, readyForSync: false, probeError: 'NEEDS_OFFLINE_RECOVERY' });
    assert.strictEqual(rt.elements['jg-upload'].disabled, true);
    assert.ok(text(rt, 'jg-status-text').includes('NEEDS_OFFLINE_RECOVERY'));
    assert.strictEqual(requestCount(rt, '/push') + requestCount(rt, '/pull'), 0);
});

test('one save-and-verify action, token clears only after save, empty token omitted, read is not write', async () => {
    const rt = await warm(runtime());
    rt.elements['jg-token'].value = 'synthetic-only-secret';
    const before = rt.calls.length;
    await rt.exp.doConnect();
    assert.deepStrictEqual(rt.calls.slice(before).map(c => c.method + ' ' + c.endpoint), ['PUT /config','POST /connect','GET /status','GET /health']);
    assert.strictEqual(rt.elements['jg-token'].value, '');
    assert.strictEqual(rt.calls.find(c => c.endpoint === '/connect').body.initializeEmptyBranch, false);
    assert.ok(text(rt, 'jg-verification').includes('写入待首次实际上传确认'));
    assert.ok(!text(rt, 'jg-verification').includes('实际写入已验证'));
    assert.ok(JSON.stringify(rt.logs).indexOf('synthetic-only-secret') === -1);
    await rt.exp.doConnect();
    const puts = rt.calls.filter(c => c.endpoint === '/config' && c.method === 'PUT');
    assert.ok(!Object.hasOwn(puts[puts.length - 1].body, 'token'));
    assert.ok(puts.every(c => c.headers['X-CSRF-Token'] === 'synthetic-csrf'));
});

test('missing remote branch is unfinished; initialization requires a separate explicit confirmation', async () => {
    const rt = await warm(runtime({ handlers: { 'POST /connect': ({ state, call }) => {
        if (!call.body.initializeEmptyBranch) {
            state.status.readyForSync = false;
            return { success: true, connected: true, needsRemoteInit: true, remoteEmpty: true, verification: VERIFICATION };
        }
        state.status.readyForSync = true;
        state.status.history.verification = { ...VERIFICATION, write: 'verified' };
        return { success: true, connected: true, needsRemoteInit: false, initializedRemote: true, verification: state.status.history.verification };
    } } }));
    await rt.exp.doConnect();
    assert.ok(text(rt, 'jg-setup-result').includes('设置尚未完成'));
    assert.ok(text(rt, 'jg-init-description').includes('远端仓库为空'));
    assert.strictEqual(rt.elements['jg-upload'].disabled, true);
    assert.strictEqual(rt.elements['jg-init-confirm'].disabled, true);
    const before = requestCount(rt, '/connect');
    await rt.exp.doConnect(true);
    assert.strictEqual(requestCount(rt, '/connect'), before);
    rt.elements['jg-init-empty'].checked = true;
    rt.exp.updateButtons();
    assert.strictEqual(rt.elements['jg-init-confirm'].disabled, false);
    await rt.exp.doConnect(true);
    assert.deepStrictEqual(rt.calls.filter(c => c.endpoint === '/connect').map(c => c.body.initializeEmptyBranch), [false,true]);
    assert.ok(text(rt, 'jg-verification').includes('实际写入已验证'));
    assert.strictEqual(rt.elements['jg-init-empty'].checked, false);
    assert.strictEqual(requestCount(rt, '/push') + requestCount(rt, '/pull'), 0);
});

test('missing selected branch in nonempty repository does not call the whole repository empty', async () => {
    const rt = await warm(runtime({ handlers: { 'POST /connect': ({ state }) => {
        state.status.readyForSync = false;
        return { success: true, needsRemoteInit: true, remoteEmpty: false, verification: VERIFICATION };
    } } }));
    await rt.exp.doConnect();
    assert.ok(text(rt, 'jg-init-description').includes('已有内容'));
    assert.ok(!text(rt, 'jg-init-description').includes('远端仓库为空'));
});

test('target lock keeps repo and branch read-only while allowing token replacement', async () => {
    const rt = runtime({ state: { targetLocked: true } });
    rt.state.status.targetLocked = true;
    await warm(rt);
    assert.strictEqual(rt.elements['jg-repo'].readOnly, true);
    assert.strictEqual(rt.elements['jg-branch'].readOnly, true);
    assert.strictEqual(rt.elements['jg-token'].readOnly, false);
    assert.strictEqual(rt.elements['jg-token'].disabled, false);
    rt.elements['jg-repo'].value = '';
    rt.elements['jg-branch'].value = 'other';
    rt.elements['jg-token'].value = 'synthetic-replacement';
    await rt.exp.doConnect();
    const put = rt.calls.find(c => c.endpoint === '/config' && c.method === 'PUT');
    assert.strictEqual(put.body.githubRepo, 'owner/private-data');
    assert.strictEqual(put.body.branch, 'main');
    assert.strictEqual(put.body.token, 'synthetic-replacement');
});

test('unsaved target or token edits disable daily sync even if old status remains ready', async () => {
    const rt = await warm(runtime(), true);
    rt.elements['jg-token'].value = 'synthetic-edit';
    rt.elements['jg-token'].dispatch('input');
    rt.exp.renderStatus(rt.state.status);
    assert.strictEqual(rt.elements['jg-upload'].disabled, true);
    assert.strictEqual(rt.elements['jg-download'].disabled, true);
    assert.ok(text(rt, 'jg-setup-result').includes('设置已修改'));
    await assert.rejects(() => rt.exp.doUpload(), /同步尚未就绪/);
});

test('failed save retains token input and performs no connect', async () => {
    const rt = await warm(runtime({ handlers: { 'PUT /config': () => ({ success: false, code: 'SAVE_FAILED', error: 'synthetic save failure', __httpStatus: 500 }) } }));
    rt.elements['jg-token'].value = 'synthetic-unsaved';
    await rt.exp.doConnect();
    assert.strictEqual(rt.elements['jg-token'].value, 'synthetic-unsaved');
    assert.strictEqual(requestCount(rt, '/connect'), 0);
    assert.ok(text(rt, 'jg-setup-result').includes('验证未完成'));
});

test('push stage candidates are not reported as downloaded or saved stage', async () => {
    const rt = await warm(runtime({ handlers: { 'POST /push': () => ({ success: true, result: { pushed: false, published: [], staged: [{ rel: 'chats/Actor/remote.jsonl' }], conflicts: [] } }) } }));
    await rt.exp.doUpload();
    const message = rt.notifications.find(n => n.message.includes('上传结果')).message;
    assert.ok(message.includes('远端更新候选'));
    assert.ok(message.includes('尚未下载'));
    assert.ok(!/已暂存|下载完成|已下载/.test(message));
    assert.strictEqual(visible(rt, 'jg-stage-panel'), false);
    assert.strictEqual(requestCount(rt, '/pull'), 0);
});

test('pull stages only, successful preview unlocks conditional restart action', async () => {
    const rt = await warm(runtime({ handlers: { 'POST /pull': ({ state }) => {
        state.status.stageId = 'synthetic-stage'; state.status.stagedFiles = ['chats/Actor/a.jsonl'];
        return { success: true, result: { staged: ['chats/Actor/a.jsonl'], conflicts: [] }, preflight: { ready: true, stageId: 'synthetic-stage', files: ['chats/Actor/a.jsonl'] } };
    } } }));
    assert.strictEqual(visible(rt, 'jg-stage-panel'), false);
    await rt.exp.doDownload();
    assert.strictEqual(visible(rt, 'jg-stage-panel'), true);
    assert.strictEqual(rt.elements['jg-schedule'].disabled, true, 'close-client consent is still required');
    rt.elements['jg-close-confirm'].checked = true;
    rt.exp.updateButtons();
    assert.strictEqual(rt.elements['jg-schedule'].disabled, false);
    assert.ok(text(rt, 'jg-preflight-text').includes('尚未写入聊天'));
    assert.strictEqual(requestCount(rt, '/schedule-apply'), 0);
    assert.ok(rt.notifications.some(n => n.message.includes('尚未写入本地聊天')));
});

test('schedule rechecks preview and explicit close confirmation, then shows waiting for restart', async () => {
    const stage = { stageId: 'synthetic-stage', stagedFiles: ['chats/Actor/a.jsonl'] };
    const rt = await warm(runtime({ handlers: {
        'POST /preflight': () => ({ success: true, preflight: { ready: true, ...stage, files: stage.stagedFiles } }),
        'POST /schedule-apply': ({ state, call }) => {
            state.status.scheduledApply = { stageId: call.body.stageId, createdAt: '2026-10-19T06:01:00Z' };
            return { success: true, scheduled: state.status.scheduledApply };
        },
    } }));
    Object.assign(rt.state.status, stage); rt.exp.renderStatus(rt.state.status);
    await rt.exp.doPreflight();
    await rt.exp.doScheduleApply();
    assert.strictEqual(requestCount(rt, '/schedule-apply'), 0, 'unchecked confirmation cannot schedule');
    rt.elements['jg-close-confirm'].checked = true;
    await rt.exp.doScheduleApply();
    const call = rt.calls.find(c => c.endpoint === '/schedule-apply');
    assert.deepStrictEqual(call.body, { stageId: 'synthetic-stage', clientsWillBeClosed: true });
    assert.ok(requestCount(rt, '/preflight') >= 3);
    assert.ok(text(rt, 'jg-status-text').includes('尚未完成同步'));
    assert.ok(text(rt, 'jg-restart-guide').includes('停止酒管服务'));
    assert.strictEqual(visible(rt, 'jg-schedule-controls'), false);
    assert.strictEqual(rt.elements['jg-upload'].disabled, true);
    await assert.rejects(() => rt.exp.doUpload(), /已安排应用/);
    assert.ok(!rt.calls.some(c => c.endpoint === '/apply'));
});

test('failed preview and changed stage cannot schedule, and a new stage resets close consent', async () => {
    const rt = await warm(runtime({ handlers: { 'POST /preflight': () => ({ success: true, preflight: { ready: false, stageId: 'stage-a', files: [], error: { code: 'STALE_LOCAL', message: '聊天已变化' } } }) } }));
    Object.assign(rt.state.status, { stageId: 'stage-a', stagedFiles: ['chats/Actor/a.jsonl'] }); rt.exp.renderStatus(rt.state.status);
    rt.elements['jg-close-confirm'].checked = true;
    await rt.exp.doPreflight();
    assert.strictEqual(rt.elements['jg-schedule'].disabled, true);
    await assert.rejects(() => rt.exp.doScheduleApply(), /未通过预检/);
    assert.strictEqual(requestCount(rt, '/schedule-apply'), 0);
    assert.ok(text(rt, 'jg-preflight-text').includes('聊天已变化'));
    rt.exp.renderStatus({ ...rt.state.status, stageId: 'stage-b' });
    assert.strictEqual(rt.elements['jg-close-confirm'].checked, false);
});

test('persistent history returned by backend is visible again in a new VM without browser storage', async () => {
    const history = { lastCheck: { at: '2026-10-19T06:02:00Z', outcome: 'failed', error: '无法连接远端' }, lastUpload: { at: '2026-10-19T06:03:00Z', outcome: 'success', count: 2 }, verification: VERIFICATION };
    const rt1 = runtime(); rt1.state.status.history = json(history); rt1.state.status.lastAppliedAt = '2026-10-19T06:04:00Z'; await warm(rt1);
    const rt2 = runtime(); rt2.state.status = json(rt1.state.status); await warm(rt2);
    assert.strictEqual(text(rt2, 'jg-history-check'), text(rt1, 'jg-history-check'));
    assert.ok(text(rt2, 'jg-history-check').includes('失败'));
    assert.ok(text(rt2, 'jg-history-check').includes('无法连接远端'));
    assert.ok(text(rt2, 'jg-history-upload').includes('2 个'));
    assert.ok(!text(rt2, 'jg-history-apply').includes('尚无记录'));
    rt2.state.status.history.lastCheck = { at: '2026-10-19T06:05:00Z', outcome: 'no-changes', count: 0 };
    rt2.exp.renderStatus(rt2.state.status);
    assert.ok(text(rt2, 'jg-history-check').includes('无变化'));
    assert.ok(!text(rt2, 'jg-history-check').includes('no-changes'));
    assert.ok(!/localStorage\.(setItem|getItem)/.test(SOURCE));
});

test('live generating/saving changes still block daily operations; unknown remains closed', async () => {
    const rt = await warm(runtime());
    rt.ns.isChatSaving = true; rt.exp.updateButtons();
    assert.strictEqual(rt.elements['jg-upload'].disabled, true);
    await assert.rejects(() => rt.exp.doUpload(), /生成\/保存/);
    rt.ns.isChatSaving = false; rt.exp.updateButtons();
    assert.strictEqual(rt.elements['jg-upload'].disabled, false);
    delete rt.ns.isChatSaving; rt.exp.updateButtons();
    assert.strictEqual(rt.elements['jg-download'].disabled, true);
    await assert.rejects(() => rt.exp.doDownload(), /无法确认宿主/);
    assert.strictEqual(requestCount(rt, '/pull') + requestCount(rt, '/push'), 0);
});

test('pending upload permits explicit upload retry and blocks checks and scheduling', async () => {
    const rt = await warm(runtime({ handlers: { 'POST /push': () => ({ success: true, result: { published: [], conflicts: [] } }) } }));
    rt.state.status.core = { pending: { runId: 'unfinished' } };
    rt.exp.renderStatus(rt.state.status);
    assert.strictEqual(rt.elements['jg-upload'].disabled, false);
    assert.strictEqual(rt.elements['jg-download'].disabled, true);
    assert.ok(text(rt, 'jg-status-text').includes('明确重试'));
    await assert.rejects(() => rt.exp.doDownload(), /上次上传尚未确认/);
    await assert.rejects(() => rt.exp.doScheduleApply(), /上次上传尚未确认/);
    assert.strictEqual(requestCount(rt, '/pull'), 0);
    await rt.exp.doUpload();
    assert.strictEqual(requestCount(rt, '/push'), 1);
});

(async () => {
    const results = [];
    for (const { name, fn } of tests) {
        try { await fn(); results.push({ name, pass: true }); console.log('ok ' + name); }
        catch (e) { results.push({ name, pass: false, error: e.message }); console.error('FAIL ' + name + ': ' + e.message); }
    }
    const summary = { total: results.length, pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length };
    const out = path.join(ROOT, 'test-artifacts', 'wizard-client-results.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ summary, results, note: 'Isolated VM/DOM only; no browser or real GitHub/host/device validation.' }, null, 2));
    console.log('[wizard-client] ' + JSON.stringify(summary));
    process.exitCode = summary.fail ? 1 : 0;
})();

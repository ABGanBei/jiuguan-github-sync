#!/usr/bin/env node
'use strict';
/**
 * 酒管 GitHub 同步 · 前端扩展契约测试（无浏览器实测）。
 *
 * 本测试是纯函数 + 静态契约校验 + nodeVM 沙箱加载，明确【不是浏览器实测】。
 * 覆盖集成合同 docs/integration-contract.md 中前端扩展（client/index.js、client/style.css、
 * client/manifest.json、根 manifest.json）的固定契约点：
 *   1. 根 manifest 为 1.17 前端扩展（js/css/version/display_name=酒管）。
 *   2. client/manifest.json 同步 js/css/version/display_name。
 *   3. client/index.js 语法可解析（node --check 等价：new Function 编译）。
 *   4. 挂载 #extensions_settings2 或 #extensions_settings，且防重复。
 *   5. schedule-apply body 为 {stageId, clientsWillBeClosed:true}。
 *   6. 禁止 force / ours / theirs / 在线 apply（不出现危险端点调用）。
 *   7. PAT 不入 localStorage / settings / 日志（不引用 localStorage，token 不持久）。
 *   8. 远端字段安全渲染（textContent，不 innerHTML 注入远端数据）。
 *   9. 忙碌检测：能力检测动态 import isGenerating/isChatSaving，缺失时保守提示。
 *  10. 401/404/非 JSON 清晰报错。
 *  11. 窄屏适配（style.css 含 @media）。
 *  12. nodeVM 沙箱加载后 exports 暴露 safeText/isBusy/buildPanelHtml/EXT_ID/API_BASE。
 *
 * 环境：仅 node 内置模块（assert/fs/path/vm），无新增依赖，不触网络/真实凭据/数据。
 *
 * 用法：node test/client-contract.test.js [--keep]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'client');
const resultsPath = path.join(ROOT, 'test-artifacts', 'client-contract-results.json');

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];
const asyncTests = [];

function test(name, fn) {
    const r = fn();
    if (r && typeof r.then === 'function') {
        asyncTests.push(r.then(
            () => { pass++; console.log('  ok  ' + name); },
            (e) => { fail++; failures.push({ name, error: e.message }); console.error('  FAIL ' + name + ': ' + e.message); }
        ));
    } else {
        pass++;
        console.log('  ok  ' + name);
    }
}

function skipTest(name, reason) {
    skip++;
    console.log('  SKIP ' + name + ' (' + reason + ')');
}

const read = p => fs.readFileSync(path.join(ROOT, p), 'utf-8');

// ---- 1) 根 manifest（1.17 前端扩展） ----
const rootManifest = JSON.parse(read('manifest.json'));
const clientManifest = JSON.parse(read(path.join('client', 'manifest.json')));
const indexSrc = read(path.join('client', 'index.js'));
const styleSrc = fs.readFileSync(path.join(CLIENT, 'style.css'), 'utf-8');

test('根 manifest：display_name=酒管、version=1.3.0-preview.1、js/css 指向 client', () => {
    assert.strictEqual(rootManifest.display_name, '酒管 GitHub 同步');
    assert.strictEqual(rootManifest.version, '1.3.0-preview.1');
    assert.strictEqual(rootManifest.js, 'client/index.js');
    assert.strictEqual(rootManifest.css, 'client/style.css');
});

test('client/manifest.json：js/css/version/display_name 同步', () => {
    assert.strictEqual(clientManifest.display_name, '酒管 GitHub 同步');
    assert.strictEqual(clientManifest.version, '1.3.0-preview.1');
    assert.strictEqual(clientManifest.js, 'index.js');
    assert.strictEqual(clientManifest.css, 'style.css');
});

// ---- 2) index.js 语法可解析 ----
test('client/index.js 语法可解析（new Function 编译）', () => {
    // eslint-disable-next-line no-new-func
    new Function(indexSrc); // 语法错误会 throw
});

test('client/style.css 存在且非空', () => {
    assert.ok(styleSrc.length > 0);
});

// ---- 3) 挂载目标与防重复 ----
test('挂载 #extensions_settings2 或 #extensions_settings，且防重复', () => {
    assert.ok(indexSrc.includes('extensions_settings2'), '应包含 #extensions_settings2');
    assert.ok(indexSrc.includes('extensions_settings'), '应包含 #extensions_settings');
    // 防重复：挂载前检查已存在
    assert.ok(/if\s*\(\s*el\(\s*EXT_ID\s*\)\s*\)/.test(indexSrc) || indexSrc.includes('el(EXT_ID)'), '应有防重复检查 el(EXT_ID)');
});

// ---- 4) schedule-apply body ----
test('schedule-apply body 为 {stageId, clientsWillBeClosed:true}', () => {
    assert.ok(indexSrc.includes('/schedule-apply'), '应调用 /schedule-apply');
    assert.ok(indexSrc.includes('clientsWillBeClosed: true'), 'body 应含 clientsWillBeClosed: true');
    assert.ok(indexSrc.includes('stageId'), 'body 应含 stageId');
    // 不传路径 / offline flag / 任意命令
    assert.ok(!/schedule-apply[^]*?dataRoot/.test(indexSrc), '不应传 dataRoot');
    assert.ok(!/offlineConfirmed/.test(indexSrc), '不应传 offlineConfirmed');
});

// ---- 5) 禁止危险操作 ----
test('禁止 force / ours / theirs / 在线 apply / resolve-conflict', () => {
    assert.ok(!indexSrc.includes('/force-push'), '不应调用 /force-push');
    assert.ok(!indexSrc.includes('/resolve-conflict'), '不应调用 /resolve-conflict');
    assert.ok(!indexSrc.includes('strategy'), '不应传 strategy(ours/theirs)');
    assert.ok(!/checkoutOurs|checkoutTheirs/.test(indexSrc), '不应出现 checkoutOurs/Theirs');
});

test('下载成功文案为「暂存」，明确不写聊天', () => {
    assert.ok(indexSrc.includes('暂存'), '下载成功文案应含「暂存」');
    assert.ok(indexSrc.includes('尚未写入本地聊天') || indexSrc.includes('不写聊天'), '应明确不写聊天');
});

test('schedule-apply 要求用户勾选关闭其他客户端（不制造无感在线 apply）', () => {
    assert.ok(indexSrc.includes('jg-close-confirm'), '应有关闭确认勾选框');
    assert.ok(indexSrc.includes('我已关闭其他客户端'), '应明确「关闭其他客户端」说明');
});

// ---- 6) PAT 安全 ----
test('PAT 不入 localStorage/settings/日志，保存后清空', () => {
    // 不得真的调用 localStorage 持久化（注释里说明「不持久化到 localStorage」属正确文档，不算违规）
    assert.ok(!/localStorage\.(setItem|getItem|removeItem)/.test(indexSrc), '不应调用 localStorage.setItem/getItem/removeItem');
    assert.ok(!/extension_settings\s*=/.test(indexSrc), '前端不应写 extension_settings');
    assert.ok(indexSrc.includes("el('jg-token').value = ''") || indexSrc.includes("jg-token').value = ''"), '保存后应清空 token 输入框');
});

// ---- 7) 安全渲染（textContent，非 innerHTML 注入远端数据） ----
test('远端字段用 textContent / 安全 DOM 渲染，不 innerHTML 注入远端数据', () => {
    assert.ok(indexSrc.includes('textContent'), '应使用 textContent');
    // 不应把远端/冲突/错误数据拼进 innerHTML
    assert.ok(!/innerHTML\s*=.*status|innerHTML\s*=.*conflict|innerHTML\s*=.*error/i.test(indexSrc), '不应把 status/conflict/error 拼入 innerHTML');
});

// ---- 8) 忙碌检测：isChatSaving 是 live boolean，isGenerating 是函数 ----
test('忙碌检测：isChatSaving 为 live boolean（非函数），isGenerating 为函数', () => {
    // 静态契约：不能把 isChatSaving 当函数调用、不能复制布尔快照
    assert.ok(!/typeof\s+mod\.isChatSaving\s*===\s*'function'/.test(indexSrc), '不应把 isChatSaving 判为 function');
    assert.ok(indexSrc.includes('typeof busyMod.isGenerating === \'function\'') || indexSrc.includes("typeof busyMod.isGenerating === 'function'") || /typeof\s+busyMod\.isGenerating\s*===/.test(indexSrc), 'isGenerating 应按函数调用');
    assert.ok(/typeof\s+busyMod\.isChatSaving\s*===\s*'boolean'/.test(indexSrc), 'isChatSaving 应按 boolean 读取 live 值');
    assert.ok(indexSrc.includes('busyMod.isChatSaving'), '应读取 busyMod.isChatSaving 布尔');
    assert.ok(indexSrc.includes('busyMod.isGenerating()'), '应调用 busyMod.isGenerating()');
});

// ---- 9) 401/404/非 JSON ----
test('401/404/非 JSON 清晰报错', () => {
    assert.ok(indexSrc.includes('401'), '应处理 401');
    assert.ok(indexSrc.includes('404'), '应处理 404');
    assert.ok(indexSrc.includes('非 JSON'), '应处理非 JSON 响应');
});

// ---- 10) 窄屏适配 ----
test('style.css 含窄屏 @media 适配', () => {
    assert.ok(styleSrc.includes('@media'), 'style.css 应含 @media');
});

// ---- 11) nodeVM 沙箱加载（exports 暴露纯函数，非浏览器实测） ----
test('nodeVM 沙箱加载后 exports 暴露 safeText/isBusy/ensureNotBusy/buildPanelHtml/EXT_ID/API_BASE', () => {
    // 构造最小浏览器环境沙箱
    const elems = {};
    const documentMock = {
        readyState: 'complete',
        createElement(tag) {
            const node = {
                tagName: tag,
                id: '',
                className: '',
                textContent: '',
                style: {},
                placeholder: '',
                value: '',
                checked: false,
                disabled: false,
                title: '',
                children: [],
                addEventListener() {},
                appendChild(c) { this.children.push(c); return c; },
            };
            return node;
        },
        getElementById(id) { return elems[id] || null; },
        body: { appendChild() {} },
        addEventListener() {},
    };
    const sandbox = {
        module: { exports: {} },
        exports: {},
        document: documentMock,
        SillyTavern: {
            // 官方：getRequestHeaders 在 context 上，不在 SillyTavern 顶层
            getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'csrftoken', 'X-Custom': 'yes' }) }),
        },
        fetch: () => Promise.resolve({ text: () => Promise.resolve(''), status: 200, ok: true }),
        console: { log() {}, warn() {}, error() {} },
        setInterval: () => 0,
        setTimeout: () => 0,
        clearInterval: () => {},
        globalThis: null, // 将在 createContext 后修正
    };
    vm.createContext(sandbox);
    sandbox.globalThis = sandbox; // 使 globalThis 指向沙箱自身（可注入 __JG_BUSY_LOADER__）
    vm.runInContext(indexSrc, sandbox, { filename: 'client/index.js' });
    const exp = sandbox.module.exports;
    assert.strictEqual(typeof exp.safeText, 'function', 'safeText 应为函数');
    assert.strictEqual(typeof exp.isBusy, 'function', 'isBusy 应为函数');
    assert.strictEqual(typeof exp.ensureNotBusy, 'function', 'ensureNotBusy 应为函数');
    assert.strictEqual(typeof exp.buildPanelHtml, 'function', 'buildPanelHtml 应为函数');
    assert.strictEqual(exp.EXT_ID, 'jiuguan-github-sync');
    assert.strictEqual(exp.API_BASE, '/api/plugins/github-data-sync');

    // getRequestHeaders 必须从 context.getRequestHeaders 取，且含 CSRF
    const h = exp.getRequestHeaders();
    assert.ok(h && h['X-CSRF-Token'] === 'csrftoken', 'getRequestHeaders 应含 CSRF token');

    // 纯函数行为
    assert.strictEqual(exp.safeText(null), '');
    assert.strictEqual(exp.safeText('<script>'), '<script>'); // 不转义，只做类型安全，由 textContent 负责
    assert.strictEqual(exp.safeText(123), '123');
});

// ---- 12) buildPanelHtml 纯函数：panel 含必需元素 id ----
test('buildPanelHtml 生成含必需 id（repo/branch/token/auto-check/init-empty/schedule/close-confirm）', () => {
    const elems = {};
    const documentMock = {
        readyState: 'complete',
        createElement(tag) {
            const node = { tagName: tag, id: '', className: '', textContent: '', style: {}, placeholder: '', value: '', checked: false, children: [], addEventListener() {}, appendChild(c) { this.children.push(c); return c; } };
            return node;
        },
        getElementById(id) { return elems[id] || null; },
        body: { appendChild() {} },
        addEventListener() {},
    };
    const sandbox = {
        module: { exports: {} }, exports: {}, document: documentMock,
        SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({}) }) },
        fetch: () => Promise.resolve({ text: () => Promise.resolve(''), status: 200, ok: true }),
        console: { log() {}, warn() {}, error() {} }, setInterval: () => 0, setTimeout: () => 0, clearInterval: () => {},
    };
    vm.createContext(sandbox);
    sandbox.globalThis = sandbox;
    vm.runInContext(indexSrc, sandbox, { filename: 'client/index.js' });
    const panel = sandbox.module.exports.buildPanelHtml();
    assert.ok(panel, 'panel 应非空');
    const collectIds = node => {
        const ids = [];
        if (node.id) ids.push(node.id);
        (node.children || []).forEach(c => ids.push(...collectIds(c)));
        return ids;
    };
    const ids = collectIds(panel);
    ['jg-repo', 'jg-branch', 'jg-token', 'jg-auto-check', 'jg-minutes', 'jg-init-empty', 'jg-schedule', 'jg-close-confirm', 'jg-backend-guide'].forEach(id => {
        assert.ok(ids.includes(id), 'panel 应含 id=' + id);
    });
});

// ---- 13) isChatSaving live boolean（false→true 活值），isGenerating 函数 ----
test('isBusy 读取 live 值：isChatSaving false→true 活值，isGenerating() 函数调用', async () => {
    const elems = {};
    const documentMock = {
        readyState: 'complete',
        createElement(tag) { return { tagName: tag, id: '', className: '', textContent: '', style: {}, placeholder: '', value: '', checked: false, disabled: false, title: '', children: [], addEventListener() {}, appendChild(c) { this.children.push(c); return c; } }; },
        getElementById(id) { return elems[id] || null; },
        body: { appendChild() {} },
        addEventListener() {},
    };
    // live 模块 namespace：isChatSaving 是可变布尔，isGenerating 是函数
    const busyNamespace = { isChatSaving: false, isGenerating: () => false };
    const sandbox = {
        module: { exports: {} }, exports: {}, document: documentMock,
        SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 't' }) }) },
        fetch: () => Promise.resolve({ text: () => Promise.resolve(''), status: 200, ok: true }),
        console: { log() {}, warn() {}, error() {} }, setInterval: () => 0, setTimeout: () => 0, clearInterval: () => {},
        __JG_BUSY_LOADER__: () => busyNamespace,
    };
    vm.createContext(sandbox);
    sandbox.globalThis = sandbox;
    vm.runInContext(indexSrc, sandbox, { filename: 'client/index.js' });
    const exp = sandbox.module.exports;

    // 等待异步 busyMod 加载完成（轮询直到 isBusy 不再 unknown）
    await (async () => {
        for (let i = 0; i < 50; i++) {
            const b = exp.isBusy();
            if (!b.unknown) return;
            await new Promise(r => setTimeout(r, 10));
        }
    })();

    // 初始：false
    let b = exp.isBusy();
    assert.strictEqual(b.unknown, false, 'busy 能力应已加载');
    assert.strictEqual(b.busy, false, '初始应不忙');

    // 活值变化：isChatSaving true → isBusy 应立即反映（不是复制快照）
    busyNamespace.isChatSaving = true;
    b = exp.isBusy();
    assert.strictEqual(b.busy, true, 'isChatSaving 置 true 后 isBusy 应立即反映（live 值）');

    // 恢复 false
    busyNamespace.isChatSaving = false;
    b = exp.isBusy();
    assert.strictEqual(b.busy, false, 'isChatSaving 置 false 后 isBusy 应恢复');

    // isGenerating 函数调用
    let generating = true;
    busyNamespace.isGenerating = () => generating;
    b = exp.isBusy();
    assert.strictEqual(b.busy, true, 'isGenerating() 返回 true 时应判忙');
    generating = false;
    b = exp.isBusy();
    assert.strictEqual(b.busy, false, 'isGenerating() 返回 false 时应不忙');
});

// ---- 14) getRequestHeaders 从 context.getRequestHeaders 取，含 CSRF，不无 CSRF 降级 ----
test('getRequestHeaders 从 context.getRequestHeaders 取且含 CSRF；无 context 时返回 null（不降级）', () => {
    // 有 context + getRequestHeaders
    const elems = {};
    const documentMock = {
        readyState: 'complete',
        createElement(tag) { return { tagName: tag, id: '', className: '', textContent: '', style: {}, placeholder: '', value: '', checked: false, disabled: false, title: '', children: [], addEventListener() {}, appendChild(c) { this.children.push(c); return c; } }; },
        getElementById(id) { return elems[id] || null; },
        body: { appendChild() {} },
        addEventListener() {},
    };
    const mkSandbox = (getContextFn) => {
        const s = {
            module: { exports: {} }, exports: {}, document: documentMock,
            SillyTavern: { getContext: getContextFn },
            fetch: () => Promise.resolve({ text: () => Promise.resolve(''), status: 200, ok: true }),
            console: { log() {}, warn() {}, error() {} }, setInterval: () => 0, setTimeout: () => 0, clearInterval: () => {},
        };
        vm.createContext(s);
        s.globalThis = s;
        vm.runInContext(indexSrc, s, { filename: 'client/index.js' });
        return s.module.exports;
    };

    // 有 CSRF
    let exp = mkSandbox(() => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'abc123' }) }));
    let h = exp.getRequestHeaders();
    assert.ok(h && h['X-CSRF-Token'] === 'abc123', '应从 context.getRequestHeaders 取到 CSRF');

    // 顶层 SillyTavern 没有 getRequestHeaders，但 context 有 → 仍应取到（证明不依赖顶层）
    exp = mkSandbox(() => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'def456' }) }));
    h = exp.getRequestHeaders();
    assert.strictEqual(h['X-CSRF-Token'], 'def456', '应每次从 context 取最新 headers');

    // 无 context → 返回 null（不降级为空对象）
    exp = mkSandbox(() => null);
    h = exp.getRequestHeaders();
    assert.strictEqual(h, null, '无 context 时应返回 null（apiCall 将拒绝，不无 CSRF 降级）');
});

// ---- 15) 文案不含「本地离线维护 CLI 预览」，为界面集成预览 + 后端一次性 Node 安装命令 ----
test('文案为界面集成预览，后端指引含一次性 Node 安装命令，不含「本地离线维护 CLI 预览」', () => {
    assert.ok(!indexSrc.includes('本地离线维护 CLI 预览'), '不应出现「本地离线维护 CLI 预览」');
    assert.ok(indexSrc.includes('界面集成预览'), '应含「界面集成预览」');
    assert.ok(indexSrc.includes('install-plugin.js'), '后端指引应含一次性 Node 安装命令 install-plugin.js');
    assert.ok(indexSrc.includes('--app-dir'), '应含 --app-dir 参数');
    assert.ok(indexSrc.includes('--enable-server-plugins'), '应含 --enable-server-plugins');
    assert.ok(indexSrc.includes('docs/installation.md'), '应引用 docs/installation.md');
});

// ---- 16) health 能力/版本检查：旧版或缺能力禁危险按钮 ----
test('health 检查存在，缺 onlineSnapshot/startupApply 或旧版时禁止危险按钮', () => {
    assert.ok(indexSrc.includes('/health'), '应调用 GET /health');
    assert.ok(indexSrc.includes('onlineSnapshot'), '应检查 onlineSnapshot 能力');
    assert.ok(indexSrc.includes('startupApply'), '应检查 startupApply 能力');
    assert.ok(indexSrc.includes('CAPABILITY_MISSING') || indexSrc.includes('能力不足'), '能力缺失应报错');
    assert.ok(indexSrc.includes('jg-backend-guide'), '应有后端指引元素');
    // 危险按钮 id 集合
    assert.ok(indexSrc.includes('jg-upload'), '应有 jg-upload');
    assert.ok(indexSrc.includes('jg-download'), '应有 jg-download');
    assert.ok(indexSrc.includes('jg-schedule'), '应有 jg-schedule');
});

// ---- 17) busy unknown 时仅刷新/配置可用，禁止 push/pull/schedule ----
test('busy unknown 时 ensureNotBusy 抛错（禁止 push/pull/schedule），仅刷新/配置可用', async () => {
    const elems = {};
    const documentMock = {
        readyState: 'complete',
        createElement(tag) { return { tagName: tag, id: '', className: '', textContent: '', style: {}, placeholder: '', value: '', checked: false, disabled: false, title: '', children: [], addEventListener() {}, appendChild(c) { this.children.push(c); return c; } }; },
        getElementById(id) { return elems[id] || null; },
        body: { appendChild() {} },
        addEventListener() {},
    };
    // 不注入 busy loader → busyMod 加载失败（import 在 VM 中不可用），isBusy 返回 unknown
    const sandbox = {
        module: { exports: {} }, exports: {}, document: documentMock,
        SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 't' }) }) },
        fetch: () => Promise.resolve({ text: () => Promise.resolve(''), status: 200, ok: true }),
        console: { log() {}, warn() {}, error() {} }, setInterval: () => 0, setTimeout: () => 0, clearInterval: () => {},
    };
    vm.createContext(sandbox);
    sandbox.globalThis = sandbox;
    vm.runInContext(indexSrc, sandbox, { filename: 'client/index.js' });
    const exp = sandbox.module.exports;

    // 等待 busyMod 加载失败（unknown）
    await (async () => {
        for (let i = 0; i < 50; i++) {
            const b = exp.isBusy();
            if (b.unknown) return;
            await new Promise(r => setTimeout(r, 10));
        }
    })();

    const b = exp.isBusy();
    assert.strictEqual(b.unknown, true, '无 busy 能力时 isBusy 应 unknown');

    // ensureNotBusy 应抛错（禁止危险操作），并说明原因
    let threw = false;
    try {
        exp.ensureNotBusy();
    } catch (e) {
        threw = true;
        assert.ok(/无法确认宿主是否正在生成\/保存/.test(e.message), '错误应说明无法确认忙状态');
        assert.ok(/仅刷新与配置可用/.test(e.message), '应说明仅刷新与配置可用');
    }
    assert.ok(threw, 'busy unknown 时 ensureNotBusy 应抛错，禁止 push/pull/schedule');
});

// ---- 18) renderStatus 区分状态：已配置未初始化 / cached / 错误 / 实时 ----
test('renderStatus 区分 未配置/已配置未初始化/错误/cached/实时，不只看 configured 就写「已连接」', () => {
    const elems = {};
    const documentMock = {
        readyState: 'complete',
        createElement(tag) {
            const node = { tagName: tag, id: '', className: '', textContent: '', style: {}, placeholder: '', value: '', checked: false, disabled: false, title: '', children: [], addEventListener() {}, appendChild(c) { this.children.push(c); return c; } };
            return node;
        },
        getElementById(id) { return elems[id] || null; },
        body: { appendChild() {} },
        addEventListener() {},
    };
    // 预先建好 renderStatus 用到的元素（status-text / conflict-box / conflict-list / error-box / error-text / 详情行）
    const mk = (id) => { elems[id] = documentMock.createElement('div'); elems[id].id = id; };
    ['jg-status-text', 'jg-conflict-box', 'jg-conflict-list', 'jg-error-box', 'jg-error-text',
     'jg-probe-error', 'jg-probe-error-text',
     'jg-stage-id', 'jg-staged-count', 'jg-staged-list', 'jg-scheduled', 'jg-last-op', 'jg-backend-version'].forEach(mk);

    const sandbox = {
        module: { exports: {} }, exports: {}, document: documentMock,
        SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({}) }) },
        fetch: () => Promise.resolve({ text: () => Promise.resolve(''), status: 200, ok: true }),
        console: { log() {}, warn() {}, error() {} }, setInterval: () => 0, setTimeout: () => 0, clearInterval: () => {},
    };
    vm.createContext(sandbox);
    sandbox.globalThis = sandbox;
    vm.runInContext(indexSrc, sandbox, { filename: 'client/index.js' });
    const exp = sandbox.module.exports;
    const statusText = () => elems['jg-status-text'].textContent;

    // 未配置
    exp.renderStatus({ configured: false, connected: false, remoteSource: 'cached' });
    assert.ok(statusText().includes('未配置'), '未配置应显示未配置');

    // 已配置但未连接（connected=false）→ 不得写「已连接」
    exp.renderStatus({ configured: true, connected: false, remoteSource: 'cached' });
    assert.ok(!statusText().includes('已连接'), '已配置未连接不得写「已连接」');
    assert.ok(statusText().includes('未连接') || statusText().includes('尚未连接'), '应提示未连接/未初始化');

    // 已连接但 remoteSource=cached → 不得宣称实时远端连通
    exp.renderStatus({ configured: true, connected: true, remoteSource: 'cached' });
    assert.ok(statusText().includes('缓存') || statusText().includes('非实时'), 'cached 不得宣称实时远端连通');
    assert.ok(!statusText().includes('实时连通'), 'cached 不应显示「实时连通」');

    // 已连接 + live → 实时
    exp.renderStatus({ configured: true, connected: true, remoteSource: 'live' });
    assert.ok(statusText().includes('实时'), 'live 应显示实时连通');

    // 错误
    exp.renderStatus({ configured: true, connected: false, remoteSource: 'cached', lastError: 'boom' });
    assert.ok(statusText().includes('错误'), '有 lastError 应显示错误');
});

// ---- 19) 新增刷新按钮 + 状态详情元素 ----
test('面板含刷新按钮 jg-refresh 与状态详情元素（stageId/暂存文件/安排/最后操作）', () => {
    const elems = {};
    const documentMock = {
        readyState: 'complete',
        createElement(tag) { const n = { tagName: tag, id: '', className: '', textContent: '', style: {}, placeholder: '', value: '', checked: false, disabled: false, title: '', children: [], addEventListener() {}, appendChild(c) { this.children.push(c); return c; } }; return n; },
        getElementById(id) { return elems[id] || null; },
        body: { appendChild() {} },
        addEventListener() {},
    };
    const sandbox = {
        module: { exports: {} }, exports: {}, document: documentMock,
        SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({}) }) },
        fetch: () => Promise.resolve({ text: () => Promise.resolve(''), status: 200, ok: true }),
        console: { log() {}, warn() {}, error() {} }, setInterval: () => 0, setTimeout: () => 0, clearInterval: () => {},
    };
    vm.createContext(sandbox);
    sandbox.globalThis = sandbox;
    vm.runInContext(indexSrc, sandbox, { filename: 'client/index.js' });
    const panel = sandbox.module.exports.buildPanelHtml();
    const collectIds = node => { const ids = []; if (node.id) ids.push(node.id); (node.children || []).forEach(c => ids.push(...collectIds(c))); return ids; };
    const ids = collectIds(panel);
    ['jg-refresh', 'jg-stage-id', 'jg-staged-count', 'jg-staged-list', 'jg-scheduled', 'jg-last-op', 'jg-backend-version'].forEach(id => {
        assert.ok(ids.includes(id), 'panel 应含 id=' + id);
    });
});

// ---- 20) summarizeCoreResult 解析 published/staged/conflicts 数 ----
test('summarizeCoreResult 正确解析 published/staged/conflicts 数量', () => {
    const elems = {};
    const documentMock = {
        readyState: 'complete',
        createElement(tag) { return { tagName: tag, id: '', className: '', textContent: '', style: {}, placeholder: '', value: '', checked: false, disabled: false, title: '', children: [], addEventListener() {}, appendChild(c) { this.children.push(c); return c; } }; },
        getElementById(id) { return elems[id] || null; },
        body: { appendChild() {} },
        addEventListener() {},
    };
    const sandbox = {
        module: { exports: {} }, exports: {}, document: documentMock,
        SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({}) }) },
        fetch: () => Promise.resolve({ text: () => Promise.resolve(''), status: 200, ok: true }),
        console: { log() {}, warn() {}, error() {} }, setInterval: () => 0, setTimeout: () => 0, clearInterval: () => {},
    };
    vm.createContext(sandbox);
    sandbox.globalThis = sandbox;
    vm.runInContext(indexSrc, sandbox, { filename: 'client/index.js' });
    const exp = sandbox.module.exports;

    // push 返回：published 为 string[]，staged 为 {rel,remoteHash}[]，conflicts 为 {rel,...}[]
    const s = exp.summarizeCoreResult({ pushed: true, published: ['a.jsonl', 'b.jsonl'], staged: [{ rel: 'c.jsonl' }], conflicts: [{ rel: 'd.jsonl' }] });
    assert.strictEqual(s.published, 2, 'published 应为 2');
    assert.strictEqual(s.staged, 1, 'staged 应为 1');
    assert.strictEqual(s.conflicts, 1, 'conflicts 应为 1');

    // pull 返回：staged 为 string[]
    const s2 = exp.summarizeCoreResult({ staged: ['x.jsonl'], conflicts: [], remoteHead: 'abc' });
    assert.strictEqual(s2.published, 0, 'pull 无 published');
    assert.strictEqual(s2.staged, 1, 'pull staged 应为 1');
    assert.strictEqual(s2.conflicts, 0, 'pull 无冲突');

    // 空 result
    const s3 = exp.summarizeCoreResult(null);
    assert.strictEqual(s3.published, 0, 'null result published=0');
    assert.strictEqual(s3.staged, 0, 'null result staged=0');
    assert.strictEqual(s3.conflicts, 0, 'null result conflicts=0');
});

// ---- 21) push/pull 按真实摘要显示，不无条件「上传全部完成」，冲突保留双方 ----
test('push/pull 按真实摘要显示发布/暂存/冲突数，不无条件「上传全部完成」，冲突保留双方', () => {
    // 静态契约：不得再出现无条件「上传完成」/「下载完成」这类只看成功就宣称的 toast 文案
    assert.ok(!/toast\(['"]success['"],\s*['"]上传完成/.test(indexSrc), '不应无条件 toast「上传完成」');
    assert.ok(!/toast\(['"]success['"],\s*['"]下载完成/.test(indexSrc), '不应无条件 toast「下载完成」');
    // 应解析 result.published / result.staged / result.conflicts
    assert.ok(/published/.test(indexSrc), '应引用 result.published');
    assert.ok(/staged/.test(indexSrc), '应引用 result.staged');
    assert.ok(/conflicts/.test(indexSrc), '应引用 result.conflicts');
    // 冲突保留双方提示
    assert.ok(indexSrc.includes('双方已保留') || indexSrc.includes('保留双方'), '冲突应提示保留双方');
    // 下载后步骤清楚：先勾确认安排 → 关闭全部 → 重启重开
    assert.ok(indexSrc.includes('安排应用'), '下载后应引导「安排应用」');
    assert.ok(indexSrc.includes('含当前标签页') || indexSrc.includes('含当前标签'), '应说明关闭含当前标签页');
    assert.ok(indexSrc.includes('重启后重新打开') || indexSrc.includes('重启后重新打开'), '应说明重启后重新打开');
});

// ---- 22) isChatSaving 非 boolean / isGenerating 非函数 → unknown（不当 false） ----
test('busyMod 缺 isGenerating 函数或 isChatSaving 布尔 → unknown（不当 false）', async () => {
    const elems = {};
    const documentMock = {
        readyState: 'complete',
        createElement(tag) { return { tagName: tag, id: '', className: '', textContent: '', style: {}, placeholder: '', value: '', checked: false, disabled: false, title: '', children: [], addEventListener() {}, appendChild(c) { this.children.push(c); return c; } }; },
        getElementById(id) { return elems[id] || null; },
        body: { appendChild() {} },
        addEventListener() {},
    };
    const mkSandbox = (ns) => {
        const s = {
            module: { exports: {} }, exports: {}, document: documentMock,
            SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 't' }) }) },
            fetch: () => Promise.resolve({ text: () => Promise.resolve(''), status: 200, ok: true }),
            console: { log() {}, warn() {}, error() {} }, setInterval: () => 0, setTimeout: () => 0, clearInterval: () => {},
            __JG_BUSY_LOADER__: () => ns,
        };
        vm.createContext(s);
        s.globalThis = s;
        vm.runInContext(indexSrc, s, { filename: 'client/index.js' });
        return s.module.exports;
    };
    const waitBusy = async (exp) => {
        for (let i = 0; i < 50; i++) {
            const b = exp.isBusy();
            if (!b.unknown || (b.reason && b.reason.includes('能力'))) return b;
            await new Promise(r => setTimeout(r, 10));
        }
        return exp.isBusy();
    };

    // isChatSaving 非 boolean（缺布尔）→ unknown
    let exp = mkSandbox({ isGenerating: () => false, isChatSaving: 0 }); // 0 非 boolean
    let b = await waitBusy(exp);
    assert.strictEqual(b.unknown, true, 'isChatSaving 非 boolean 应 unknown（不当 false）');

    // isGenerating 非函数 → unknown
    exp = mkSandbox({ isGenerating: false, isChatSaving: false }); // isGenerating 非函数
    b = await waitBusy(exp);
    assert.strictEqual(b.unknown, true, 'isGenerating 非函数应 unknown（不当 false）');

    // 两者都缺 → unknown
    exp = mkSandbox({});
    b = await waitBusy(exp);
    assert.strictEqual(b.unknown, true, '两者都缺应 unknown');
});

// ---- 23) backend 指引含 --install-deps --apply + git clone，非 dry-run ----
test('后端安装指引含 --install-deps --apply 可执行命令 + git clone，非仅 dry-run', () => {
    assert.ok(indexSrc.includes('--install-deps'), '应含 --install-deps');
    assert.ok(indexSrc.includes('--apply'), '应含 --apply（可执行，非仅 dry-run）');
    assert.ok(indexSrc.includes('git clone'), '应说明先 git clone 到本地进入仓库');
    // 仍保留 --enable-server-plugins / --app-dir（既有契约）
    assert.ok(indexSrc.includes('--enable-server-plugins'), '应含 --enable-server-plugins');
    assert.ok(indexSrc.includes('--app-dir'), '应含 --app-dir');
    // 不应声称宿主有服务端插件设置页（config 由 installer 启用）
    assert.ok(!indexSrc.includes('在插件页启用'), '不应声称宿主有服务端插件设置页');
});

// ---- 24) PAT 已保存提示来自 hasToken（后端返回），仅 password 成功后清空 ----
test('PAT 已保存提示来自后端 hasToken，非一律提示；保存后仅 password 成功清空', () => {
    // hasToken 提示来自 GET /config 返回的 hasToken
    assert.ok(indexSrc.includes('hasToken'), '应引用后端 hasToken');
    // 保存后清空 token（仅 password 框）
    assert.ok(indexSrc.includes("el('jg-token').value = ''"), '保存后应清空 token 输入框');
    // PAT 不入 settings/localStorage/log
    assert.ok(!/localStorage\.(setItem|getItem|removeItem)/.test(indexSrc), '不应调用 localStorage');
    assert.ok(!/extension_settings\s*=/.test(indexSrc), '不应写 extension_settings');
});

// ===================== status 互斥配套 UI 并发测试 =====================
// 可控 fetch deferred：验证只读刷新与写操作的互斥/深度计数/合并，不触真实后端。

function collectByIds(node, map) {
    if (node && node.id) map[node.id] = node;
    (node && node.children ? node.children : []).forEach(c => collectByIds(c, map));
}

// 构造可控 VM 运行时：fetch 每次调用返回 deferred（手动 resolve），元素按 id 索引供 el() 使用。
function mkRuntime() {
    const elems = {};
    const documentMock = {
        // 'loading' 阻止 index.js 末尾自动 mount()（避免其内部 bind()→refreshStatus 抢在测试填充元素之前
        // 发起首次刷新并挂起 refreshInFlight，导致后续手动 refreshStatus 被合并、不触发 updateButtons）。
        readyState: 'loading',
        createElement(tag) {
            return { tagName: tag, id: '', className: '', textContent: '', style: {}, placeholder: '', value: '', checked: false, disabled: false, title: '', children: [], addEventListener() {}, appendChild(c) { this.children.push(c); return c; } };
        },
        getElementById(id) { return elems[id] || null; },
        body: { appendChild() {} },
        addEventListener() {},
    };
    const fetchCalls = [];
    const sandbox = {
        module: { exports: {} }, exports: {}, document: documentMock,
        SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 't' }) }) },
        fetch: (url, opts) => {
            const call = { url, opts, method: (opts && opts.method) || 'GET' };
            call.promise = new Promise((res, rej) => { call.resolve = res; call.reject = rej; });
            fetchCalls.push(call);
            return call.promise;
        },
        console: { log() {}, warn() {}, error() {} },
        setInterval: () => 0, setTimeout: () => 0, clearInterval: () => {},
        __JG_BUSY_LOADER__: () => ({ isChatSaving: false, isGenerating: () => false }),
    };
    vm.createContext(sandbox);
    sandbox.globalThis = sandbox;
    vm.runInContext(indexSrc, sandbox, { filename: 'client/index.js' });
    const exp = sandbox.module.exports;
    const panel = exp.buildPanelHtml();
    collectByIds(panel, elems);
    return { exp, elems, fetchCalls };
}

// resolve 一个 fetch call 为成功 JSON 响应。
function respond(call, obj) {
    call.resolve({ status: 200, ok: true, text: () => Promise.resolve(JSON.stringify(obj)) });
}

const flush = () => new Promise(r => setTimeout(r, 0));
async function until(fn, ms = 4000) {
    const t0 = Date.now();
    while (!fn()) {
        if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
        await new Promise(r => setTimeout(r, 5));
    }
}
async function waitBusyLoaded(exp) {
    for (let i = 0; i < 50; i++) {
        if (!exp.isBusy().unknown) return;
        await flush();
    }
}

// ---- 25) 刷新在途禁用 mutation 按钮；重复 refreshStatus 合并不新增 status 请求 ----
test('刷新在途禁用 mutation 按钮；重复 refreshStatus 合并不新增 status 请求', async () => {
    const { exp, elems, fetchCalls } = mkRuntime();
    await waitBusyLoaded(exp);

    const statusCalls = () => fetchCalls.filter(c => /\/status/.test(c.url));

    const p1 = exp.refreshStatus();
    assert.strictEqual(statusCalls().length, 1, '首次刷新应发起 1 个 status 请求');

    const p2 = exp.refreshStatus();
    assert.strictEqual(p2, p1, '重复刷新应返回同一 Promise（合并）');
    assert.strictEqual(statusCalls().length, 1, '重复刷新不应新增 status 请求');

    assert.strictEqual(exp.isAnyOpInProgress(), true, '刷新在途 isAnyOpInProgress=true');
    assert.strictEqual(elems['jg-upload'].disabled, true, '刷新在途上传应禁用');
    assert.strictEqual(elems['jg-download'].disabled, true, '刷新在途下载应禁用');
    assert.strictEqual(elems['jg-save'].disabled, true, '刷新在途保存应禁用');

    // 结束刷新：status + health
    respond(statusCalls()[0], { status: { configured: true, connected: true, remoteSource: 'cached' } });
    await until(() => fetchCalls.some(c => /\/health/.test(c.url)));
    respond(fetchCalls.find(c => /\/health/.test(c.url)), { capabilities: { onlineSnapshot: true, startupApply: true }, version: '1.3.0' });
    await p1;
    await until(() => !exp.isAnyOpInProgress());

    assert.strictEqual(elems['jg-upload'].disabled, false, '刷新结束后上传应恢复可用');
});

// ---- 26) 定时刷新（maybeAutoRefresh）在 mutation 在途时跳过，不抢同用户互斥 ----
test('定时刷新（maybeAutoRefresh）在 mutation 在途时跳过，不新增 status 请求', async () => {
    const { exp, elems, fetchCalls } = mkRuntime();
    await waitBusyLoaded(exp);
    elems['jg-repo'].value = 'owner/repo';

    const saveP = exp.doSave();
    await until(() => fetchCalls.some(c => /\/config/.test(c.url) && c.method === 'PUT'));
    assert.strictEqual(exp.isAnyOpInProgress(), true, 'save 在途 isAnyOpInProgress=true');

    // mutation 在途时触发定时刷新 → 跳过，不新增 status 请求
    const before = fetchCalls.filter(c => /\/status/.test(c.url)).length;
    exp.maybeAutoRefresh();
    await flush();
    await flush();
    const after = fetchCalls.filter(c => /\/status/.test(c.url)).length;
    assert.strictEqual(after, before, 'mutation 在途时定时刷新应跳过，不新增 status 请求');

    // 完成 save（config → 内部 refreshStatus 的 status+health）
    respond(fetchCalls.find(c => /\/config/.test(c.url) && c.method === 'PUT'), { success: true });
    await until(() => fetchCalls.some(c => /\/status/.test(c.url)));
    respond(fetchCalls.find(c => /\/status/.test(c.url)), { status: {} });
    await until(() => fetchCalls.some(c => /\/health/.test(c.url)));
    respond(fetchCalls.find(c => /\/health/.test(c.url)), { capabilities: { onlineSnapshot: true, startupApply: true } });
    await saveP;
    await until(() => !exp.isAnyOpInProgress());
});

// ---- 27) doConnect 嵌套 doSave：内层保存返回后 connect 仍在途，按钮继续禁用（深度计数） ----
test('doConnect 嵌套 doSave：save 返回后 connect 仍在途，按钮继续禁用（深度计数）', async () => {
    const { exp, elems, fetchCalls } = mkRuntime();
    await waitBusyLoaded(exp);
    elems['jg-repo'].value = 'owner/repo';

    const connectP = exp.doConnect();

    // 1) 内层 doSave → PUT /config
    await until(() => fetchCalls.some(c => /\/config/.test(c.url) && c.method === 'PUT'));
    assert.strictEqual(elems['jg-connect'].disabled, true, 'connect 在途连接按钮应禁用');

    // 2) 完成内层 doSave（config + 其内部 refreshStatus）
    respond(fetchCalls.find(c => /\/config/.test(c.url) && c.method === 'PUT'), { success: true });
    await until(() => fetchCalls.some(c => /\/status/.test(c.url)));
    respond(fetchCalls.find(c => /\/status/.test(c.url)), { status: {} });
    await until(() => fetchCalls.some(c => /\/health/.test(c.url)));
    respond(fetchCalls.find(c => /\/health/.test(c.url)), { capabilities: { onlineSnapshot: true, startupApply: true } });
    await until(() => fetchCalls.some(c => /\/connect/.test(c.url) && c.method === 'POST'));

    // 3) 内层 doSave 已返回、POST /connect 在途：外层 opDepth 仍为 1，按钮继续禁用
    assert.strictEqual(exp.isAnyOpInProgress(), true, 'save 返回后 connect 仍在途，isAnyOpInProgress 仍 true');
    assert.strictEqual(elems['jg-connect'].disabled, true, 'save 返回后 connect 仍在途，连接按钮应继续禁用');
    assert.strictEqual(elems['jg-upload'].disabled, true, 'save 返回后 connect 仍在途，上传应继续禁用');

    // 4) 完成 connect（connect → 其内部 refreshStatus）
    respond(fetchCalls.find(c => /\/connect/.test(c.url) && c.method === 'POST'), { success: true, initializedRemote: false });
    const sc = fetchCalls.filter(c => /\/status/.test(c.url)).length;
    await until(() => fetchCalls.filter(c => /\/status/.test(c.url)).length > sc);
    respond(fetchCalls.filter(c => /\/status/.test(c.url))[sc], { status: {} });
    const hc = fetchCalls.filter(c => /\/health/.test(c.url)).length;
    await until(() => fetchCalls.filter(c => /\/health/.test(c.url)).length > hc);
    respond(fetchCalls.filter(c => /\/health/.test(c.url))[hc], { capabilities: { onlineSnapshot: true, startupApply: true } });
    await connectP;
    await until(() => !exp.isAnyOpInProgress());

    assert.strictEqual(elems['jg-connect'].disabled, false, 'connect 结束后连接按钮应恢复可用');
});

// ---- 28) renderStatus 展示 probeError 明确原因；probeError 清除后旧探测错误清掉，mutation lastError 保留 ----
test('renderStatus 展示 probeError 明确原因（PATH_UNSAFE/CORRUPT_STORAGE/权限）；清除后清掉探测错误且 mutation lastError 保留', () => {
    const elems = {};
    const documentMock = {
        readyState: 'complete',
        createElement(tag) { return { tagName: tag, id: '', className: '', textContent: '', style: {}, placeholder: '', value: '', checked: false, disabled: false, title: '', children: [], addEventListener() {}, appendChild(c) { this.children.push(c); return c; } }; },
        getElementById(id) { return elems[id] || null; },
        body: { appendChild() {} },
        addEventListener() {},
    };
    const mk = (id) => { elems[id] = documentMock.createElement('div'); elems[id].id = id; };
    ['jg-status-text', 'jg-conflict-box', 'jg-conflict-list', 'jg-error-box', 'jg-error-text',
     'jg-probe-error', 'jg-probe-error-text',
     'jg-stage-id', 'jg-staged-count', 'jg-staged-list', 'jg-scheduled', 'jg-last-op', 'jg-backend-version'].forEach(mk);

    const sandbox = {
        module: { exports: {} }, exports: {}, document: documentMock,
        SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({}) }) },
        fetch: () => Promise.resolve({ text: () => Promise.resolve(''), status: 200, ok: true }),
        console: { log() {}, warn() {}, error() {} }, setInterval: () => 0, setTimeout: () => 0, clearInterval: () => {},
    };
    vm.createContext(sandbox);
    sandbox.globalThis = sandbox;
    vm.runInContext(indexSrc, sandbox, { filename: 'client/index.js' });
    const exp = sandbox.module.exports;
    const statusText = () => elems['jg-status-text'].textContent;
    const probeBoxVisible = () => elems['jg-probe-error'].style.display !== 'none';
    const probeText = () => elems['jg-probe-error-text'].textContent;
    const errBoxVisible = () => elems['jg-error-box'].style.display !== 'none';

    // 1) probeError 存在（core:null，connected=false）：不得静默显示「未连接/请初始化」，应展示明确原因
    exp.renderStatus({ configured: true, connected: false, core: null, remoteSource: 'cached', probeError: 'PATH_UNSAFE：数据目录祖先含不安全链接' });
    assert.ok(!statusText().includes('未连接'), '有 probeError 时不应静默显示「未连接/请初始化」');
    assert.ok(statusText().includes('错误'), '有 probeError 时应显示错误');
    assert.ok(statusText().includes('PATH_UNSAFE'), 'status 文本应包含 probeError 明确原因 PATH_UNSAFE');
    assert.strictEqual(probeBoxVisible(), true, 'probeError 存在时 probe box 应可见');
    assert.ok(probeText().includes('PATH_UNSAFE'), 'probe box 应展示 probeError 内容');

    // 2) probeError 为对象形式（{message}）也应安全展示（textContent，不输出堆栈）
    exp.renderStatus({ configured: true, connected: false, remoteSource: 'cached', probeError: { message: 'CORRUPT_STORAGE：存储状态损坏' } });
    assert.ok(statusText().includes('CORRUPT_STORAGE'), 'probeError 对象应展示 message');
    assert.ok(probeText().includes('CORRUPT_STORAGE'), 'probe box 应展示对象 message');

    // 3) probeError 清除后：旧探测错误 UI 清掉，但 mutation lastError 保留
    exp.renderStatus({ configured: true, connected: true, remoteSource: 'live', lastError: '上一次上传冲突：已保留双方' });
    assert.strictEqual(probeBoxVisible(), false, 'probeError 清除后 probe box 应隐藏');
    assert.strictEqual(probeText(), '', 'probeError 清除后 probe box 文本应清空');
    assert.strictEqual(errBoxVisible(), true, 'mutation lastError 不可被抹除，err box 应仍可见');
    assert.ok(elems['jg-error-text'].textContent.includes('上一次上传冲突'), 'err box 应保留 mutation lastError 内容');

    // 4) probeError 与 mutation lastError 同时存在：两者都展示，probeError 优先于 status 文本
    exp.renderStatus({ configured: true, connected: false, remoteSource: 'cached', probeError: '权限不足：无法读取 token', lastError: '上次上传失败' });
    assert.strictEqual(probeBoxVisible(), true, 'probeError 应可见');
    assert.ok(probeText().includes('权限不足'), 'probe box 应展示 probeError');
    assert.strictEqual(errBoxVisible(), true, 'mutation lastError 应仍可见');
    assert.ok(elems['jg-error-text'].textContent.includes('上次上传失败'), 'err box 应保留 lastError');
    assert.ok(statusText().includes('权限不足'), 'status 文本应优先展示 probeError 原因');
});

(async () => {
    await Promise.all(asyncTests);
    const summary = { total: pass + fail + skip, pass, fail, skip };
    const out = {
        summary,
        node: process.version,
        platform: process.platform,
        note: '非浏览器实测：纯函数 + 静态契约校验 + nodeVM 沙箱加载。',
        failures,
    };
    fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
    fs.writeFileSync(resultsPath, JSON.stringify(out, null, 2));

    console.log('\n[client-contract] summary=' + JSON.stringify(summary));
    if (fail > 0) {
        process.exit(1);
    }
    process.exit(0);
})();

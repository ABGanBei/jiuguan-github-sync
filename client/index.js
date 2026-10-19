// 酒管 GitHub 同步 · 前端扩展（SillyTavern 1.17+）
// 目标：界面集成预览，一对一角色聊天的 GitHub 同步前端。
// 仅上传已保存磁盘聊天 / 下载仅暂存 / 应用须停服务并重启。禁止 force/在线 apply。

(() => {
    'use strict';

    const API_BASE = '/api/plugins/github-data-sync';
    const EXT_ID = 'jiuguan-github-sync';

    // ---- SillyTavern 上下文 ----
    // 不缓存 context：每次都从 getContext() 取最新，避免状态陈旧。
    function getContext() {
        return (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') ? SillyTavern.getContext() : null;
    }
    // 每次从 context.getRequestHeaders 取（含 CSRF）；不存在即视为无可用头，不得无 CSRF 降级。
    function getRequestHeaders() {
        const ctx = getContext();
        if (ctx && typeof ctx.getRequestHeaders === 'function') {
            return ctx.getRequestHeaders() || {};
        }
        return null;
    }

    // ===================== 能力检测（忙碌状态） =====================
    // 官方 /script.js:418 `export let isChatSaving=false` 是 live boolean（非函数），
    // `export function isGenerating()` 是函数。必须每次读取模块命名空间的 live 值，
    // 不能复制布尔快照（否则保存状态变化不会被看到）。
    let busyMod = null;      // 模块 namespace 引用（保持 live）
    let busyError = null;    // { reason: string }，加载失败时说明原因

    // 加载忙碌能力模块：优先使用注入的 loader（测试/宿主可注入），否则动态 import /script.js。
    function loadBusyModule() {
        const injected = (typeof globalThis !== 'undefined' && typeof globalThis.__JG_BUSY_LOADER__ === 'function') ? globalThis.__JG_BUSY_LOADER__ : null;
        if (injected) {
            return Promise.resolve(injected());
        }
        return import('/script.js');
    }

    (async () => {
        try {
            busyMod = await loadBusyModule();
        } catch (e) {
            busyError = { reason: '无法加载 /script.js：' + (e && e.message ? e.message : String(e)) };
        }
    })();

    /**
     * 返回是否正在生成/保存。
     * 每次调用都读取 busyMod 的 live 值：isGenerating() 调函数、isChatSaving 读布尔。
     * 能力缺失（isGenerating 非函数 / isChatSaving 非布尔）一律 unknown，绝不当作 false。
     */
    function isBusy() {
        if (!busyMod) {
            return { busy: false, unknown: true, reason: busyError ? busyError.reason : '能力检测尚未完成' };
        }
        try {
            // isGenerating 必须是函数，否则能力缺失 → unknown（不能当 false）。
            const hasGeneratingFn = typeof busyMod.isGenerating === 'function';
            // isChatSaving 必须是 live boolean，否则能力缺失 → unknown（不能当 false）。
            const hasSavingBool = typeof busyMod.isChatSaving === 'boolean';
            if (!hasGeneratingFn || !hasSavingBool) {
                const missing = !hasGeneratingFn && !hasSavingBool
                    ? '宿主缺少 isGenerating()/isChatSaving 能力'
                    : (!hasGeneratingFn ? '宿主缺少 isGenerating() 能力' : '宿主缺少 isChatSaving 布尔能力');
                return { busy: false, unknown: true, reason: missing + '，无法判断是否正在生成/保存' };
            }
            const generating = !!busyMod.isGenerating();
            const saving = busyMod.isChatSaving;
            return { busy: !!(generating || saving), unknown: false };
        } catch (e) {
            return { busy: false, unknown: true, reason: '读取宿主忙状态失败：' + (e && e.message ? e.message : String(e)) };
        }
    }

    /**
     * 危险操作（push/pull/schedule）前的忙碌守卫。
     * busy 或 unknown 均阻断：unknown 时不能确认宿主是否正在生成/保存，
     * 若贸然读磁盘可能拿到写到一半的聊天，故保守禁止并明确原因。
     */
    function ensureNotBusy() {
        const b = isBusy();
        if (b.busy) {
            throw new Error('宿主正在生成/保存聊天，请等待完成后再操作。');
        }
        if (b.unknown) {
            throw new Error('无法确认宿主是否正在生成/保存聊天（' + (b.reason || '能力不可用') + '）。为避免读到未完成写入的聊天，已禁止上传/下载/安排应用；仅刷新与配置可用。');
        }
    }

    // ===================== 工具 =====================

    function el(id) { return document.getElementById(id); }

    // 只用于把文本放入 textContent / 属性值等安全位置；绝不用作 HTML 注入。
    function safeText(v) {
        if (v === null || v === undefined) return '';
        return String(v);
    }

    // 把任意值安全地写入元素 textContent（避免 XSS）。
    function setText(node, v) {
        if (!node) return;
        node.textContent = safeText(v);
    }

    // ===================== API =====================

    async function apiCall(method, endpoint, body) {
        let headers = {};
        try {
            headers = getRequestHeaders();
        } catch (e) {
            headers = null;
        }
        // 无可用请求头（含 CSRF）时不得静默降级：直接报错，避免无 CSRF 的请求被后端拒绝或造成跨站风险。
        if (!headers) {
            throw Object.assign(new Error('无法获取宿主请求头（含 CSRF 令牌）。请确认已登录且页面加载完成后再试。'), { code: 'NO_REQUEST_HEADERS' });
        }
        const opts = { method, headers: Object.assign({}, headers) };
        if (body !== undefined && body !== null) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        let resp;
        try {
            resp = await fetch(`${API_BASE}${endpoint}`, opts);
        } catch (e) {
            throw Object.assign(new Error('网络请求失败：' + (e && e.message ? e.message : String(e))), { networkError: true });
        }

        let data = null;
        let rawText = '';
        try {
            rawText = await resp.text();
            data = rawText ? JSON.parse(rawText) : null;
        } catch (e) {
            // 非 JSON 响应
            throw new Error('后端返回非 JSON（HTTP ' + resp.status + '）。' + (rawText ? ' 内容片段：' + rawText.slice(0, 120) : ''));
        }

        if (resp.status === 401) {
            throw Object.assign(new Error('未认证（401）：请确认已登录且用户身份有效。'), { code: 'UNAUTHORIZED', status: 401 });
        }
        if (resp.status === 404) {
            throw Object.assign(new Error('后端接口不存在（404）。请确认服务端插件已正确安装并启用（见面板「后端安装」指引）。'), { code: 'NOT_FOUND', status: 404 });
        }
        if (resp.status === 403) {
            throw Object.assign(new Error('禁止访问（403）：' + (data && data.error ? data.error : '权限不足。')), { code: 'FORBIDDEN', status: 403 });
        }
        if (data && data.success === false) {
            const msg = data.error || (data.errors && data.errors.join(', ')) || '未知错误';
            throw Object.assign(new Error(msg), { code: data.code || 'UNKNOWN', status: resp.status });
        }
        if (!resp.ok) {
            throw Object.assign(new Error('HTTP ' + resp.status + '：' + (data && data.error ? data.error : '请求失败')), { code: data && data.code, status: resp.status });
        }
        return data;
    }

    function toast(kind, msg) {
        try {
            if (typeof toastr !== 'undefined') {
                toastr[kind](msg, '酒管同步');
                return;
            }
        } catch (e) { /* ignore */ }
        console.log('[酒管同步]', kind, msg);
    }

    // ===================== 状态渲染 =====================

    function setStatusText(msg, kind) {
        const node = el('jg-status-text');
        if (!node) return;
        setText(node, msg);
        node.className = 'jg-status-text jg-' + (kind || 'info');
    }

    // ===================== 后端健康/能力检查 =====================
    // 后端旧版或缺 onlineSnapshot/startupApply 能力时禁止危险按钮（push/pull/schedule），
    // 并指引更新；不自动执行更新。
    let health = null; // { ok: boolean, version: string, onlineSnapshot: boolean, startupApply: boolean, reason: string }

    function capabilitiesOk() {
        return !!(health && health.ok && health.onlineSnapshot && health.startupApply);
    }

    // 危险操作守卫：后端旧版或缺能力时阻断，指引更新（不自动更新）。
    function requireCapabilities() {
        if (!capabilitiesOk()) {
            throw Object.assign(new Error('后端能力不足或不可用（需 onlineSnapshot/startupApply）。请更新服务端插件后重试。'), { code: 'CAPABILITY_MISSING' });
        }
    }

    async function checkHealth() {
        try {
            const data = await apiCall('GET', '/health');
            const cap = (data && data.capabilities) || {};
            health = {
                ok: !!data,
                version: (data && data.version) || null,
                onlineSnapshot: cap.onlineSnapshot === true,
                startupApply: cap.startupApply === true,
                reason: null,
            };
        } catch (e) {
            health = { ok: false, version: null, onlineSnapshot: false, startupApply: false, reason: (e && e.message) ? e.message : String(e) };
        }
        // 版本信息展示（不涉及敏感数据）。
        const verNode = el('jg-backend-version');
        if (verNode) {
            if (health && health.ok && health.version) {
                setText(verNode, '后端版本 ' + safeText(health.version));
            } else {
                setText(verNode, '');
            }
        }
        updateButtons();
    }

    // 危险操作按钮 id 列表（push/pull/schedule）；refresh/config 始终可用。
    const DANGER_BTN_IDS = ['jg-upload', 'jg-download', 'jg-schedule'];
    // 所有「操作类」按钮：操作进行中时全部禁用，避免并发/重复点击。
    const OP_BTN_IDS = ['jg-save', 'jg-connect', 'jg-upload', 'jg-download', 'jg-schedule', 'jg-cancel', 'jg-refresh'];

    // 操作深度计数（支持 doConnect 内嵌 doSave 等嵌套 runOperation：内层结束不提前恢复按钮）。
    let opDepth = 0;
    // 只读刷新（refreshStatus）的独立 inflight Promise：重复调用合并，避免并发 status 请求。
    let refreshInFlight = null;

    // 任意「操作（写）」或「只读刷新」在途时返回 true（用于禁用操作按钮，避免与 status 抢互斥/重复请求）。
    function isAnyOpInProgress() {
        return opDepth > 0 || !!refreshInFlight;
    }

    function updateButtons() {
        const capOk = capabilitiesOk();
        const busyState = isBusy();
        const anyOp = isAnyOpInProgress();
        // 刷新按钮：任意操作或刷新在途时禁用，其余情况始终可用（busy/能力不影响只读刷新与配置）。
        const refreshBtn = el('jg-refresh');
        if (refreshBtn) {
            refreshBtn.disabled = !!anyOp;
        }
        OP_BTN_IDS.forEach(id => {
            if (id === 'jg-refresh') return; // 上面已处理
            const btn = el(id);
            if (!btn) return;
            let disabled = !!anyOp;
            let reason = '';
            if (disabled) {
                reason = '操作进行中，请稍候。';
            } else if (DANGER_BTN_IDS.includes(id)) {
                if (!capOk) {
                    disabled = true;
                    reason = '后端能力不足或不可用，请更新服务端插件后重试。';
                } else if (busyState.busy || busyState.unknown) {
                    disabled = true;
                    reason = busyState.unknown
                        ? '无法确认宿主是否正在生成/保存，禁止操作。'
                        : '宿主正在生成/保存聊天。';
                }
            }
            btn.disabled = disabled;
            btn.title = disabled ? reason : '';
        });
    }

    // 展示后端安装/更新指引（后端缺失或旧版时）。
    function showBackendGuide(message) {
        const guide = el('jg-backend-guide');
        if (guide) {
            guide.style.display = '';
            setText(guide, message);
        }
    }

    // 清空状态详情区（暂存列表、安排、最后操作等）。
    function clearStatusDetail() {
        setText(el('jg-stage-id'), '');
        setText(el('jg-staged-count'), '');
        const list = el('jg-staged-list');
        if (list) list.textContent = '';
        setText(el('jg-scheduled'), '');
        setText(el('jg-last-op'), '');
    }

    function renderStatus(status) {
        if (!status) {
            setStatusText('未配置', 'warn');
            el('jg-conflict-box').style.display = 'none';
            el('jg-error-box').style.display = 'none';
            clearStatusDetail();
            return;
        }
        const cfg = status.configured;
        const connected = !!status.connected;
        const remoteSource = status.remoteSource || 'cached';
        // mutation 错误（后端持久 lastError，不可被 probeError 抹除）。
        const lastErr = status.lastError || (status.core && status.core.lastError);
        // 只读探测错误（后端独立脱敏，解释为何 connected=false / core 探测失败，不污染 mutation lastError）。
        const probeErr = status.probeError;
        // status 文本综合错误：probeError 优先（能解释 PATH_UNSAFE / CORRUPT_STORAGE / 权限等探测失败原因，
        // 避免 core:null 时静默显示「未连接/请初始化」而隐藏真实原因）。
        const err = probeErr || lastErr;

        // 状态区分：未配置 / 已配置未初始化 / 错误 / cached / 实时。
        if (!cfg) {
            setStatusText('未配置（请填写仓库/分支并保存）', 'warn');
        } else if (status.busy) {
            setStatusText('忙：操作进行中…', 'info');
        } else if (status.scheduledApply) {
            setStatusText('已安排应用：关闭客户端重启后自动应用暂存的聊天', 'info');
        } else if (err) {
            setStatusText('错误：' + safeText(typeof err === 'string' ? err : (err.message || JSON.stringify(err))), 'err');
        } else if (!connected) {
            setStatusText('已配置（尚未连接/初始化，请先「连接」）', 'warn');
        } else if (remoteSource === 'cached') {
            setStatusText('已连接（远端状态为缓存，非实时）', 'info');
        } else {
            setStatusText('已连接（实时）', 'ok');
        }

        // 冲突
        const conflicts = (status.conflicts && status.conflicts.length) ? status.conflicts : null;
        const conflictBox = el('jg-conflict-box');
        if (conflictBox) {
            if (conflicts) {
                conflictBox.style.display = '';
                const list = el('jg-conflict-list');
                list.textContent = '';
                conflicts.forEach(c => {
                    const li = document.createElement('li');
                    li.textContent = safeText(typeof c === 'string' ? c : (c.rel || c.file || JSON.stringify(c)));
                    list.appendChild(li);
                });
            } else {
                conflictBox.style.display = 'none';
            }
        }

        // mutation 错误（lastError）：展示真实原因，probeError 不覆盖/不抹除它。
        const errBox = el('jg-error-box');
        if (errBox) {
            if (lastErr) {
                errBox.style.display = '';
                setText(el('jg-error-text'), typeof lastErr === 'string' ? lastErr : (lastErr.message || JSON.stringify(lastErr)));
            } else {
                errBox.style.display = 'none';
                const et = el('jg-error-text');
                if (et) setText(et, '');
            }
        }

        // 只读探测错误（probeError）：独立展示，每次 renderStatus 按当前 status.probeError 重写，
        // 以便 probeError 清除后旧探测错误 UI 一并清掉（不影响上面的 mutation lastError）。
        const probeBox = el('jg-probe-error');
        if (probeBox) {
            if (probeErr) {
                probeBox.style.display = '';
                setText(el('jg-probe-error-text'), typeof probeErr === 'string' ? probeErr : (probeErr.message || JSON.stringify(probeErr)));
            } else {
                probeBox.style.display = 'none';
                const pt = el('jg-probe-error-text');
                if (pt) setText(pt, '');
            }
        }

        // ---- 状态详情：stageId / 暂存文件数及列表 / 安排状态 / 最后操作 ----
        setText(el('jg-stage-id'), status.stageId ? ('暂存 stageId：' + safeText(status.stageId)) : '');
        const staged = Array.isArray(status.stagedFiles) ? status.stagedFiles : [];
        setText(el('jg-staged-count'), '暂存文件数：' + staged.length);
        const stagedList = el('jg-staged-list');
        if (stagedList) {
            stagedList.textContent = '';
            staged.forEach(f => {
                const li = document.createElement('li');
                li.textContent = safeText(f);
                stagedList.appendChild(li);
            });
        }
        if (status.scheduledApply) {
            setText(el('jg-scheduled'), '已安排应用：stageId=' + safeText(status.scheduledApply.stageId) + '（' + safeText(status.scheduledApply.createdAt) + '）');
        } else {
            setText(el('jg-scheduled'), '');
        }
        const lastOp = status.lastOperation;
        setText(el('jg-last-op'), lastOp ? ('最后操作：' + safeText(lastOp)) : '');
    }

    // 只读刷新：带独立 inflight 合并。重复调用（定时/手动/操作内 await）共享同一 Promise，
    // 不并发发起多个 status 请求；自身绝不检查 opDepth，操作内部 await 时仍能执行（不自锁）。
    function refreshStatus() {
        if (refreshInFlight) {
            return refreshInFlight;
        }
        const p = (async () => {
            try {
                const data = await apiCall('GET', '/status');
                renderStatus(data && data.status);
            } catch (e) {
                // 404/网络等：进入错误提示
                showError(e);
            }
            // 后端健康/能力检查：缺 onlineSnapshot/startupApply 或旧版时禁危险按钮并指引。
            await checkHealth();
            if (!capabilitiesOk()) {
                const capMsg = (health && health.ok) ? '后端版本过旧或缺 onlineSnapshot/startupApply 能力' : ('后端不可用：' + (health && health.reason ? health.reason : '未知'));
                showBackendGuide(capMsg + '。请更新服务端插件（见下方「后端安装」）。上传/下载/安排应用已禁用，仅刷新与配置可用。');
            } else {
                const guide = el('jg-backend-guide');
                if (guide) guide.style.display = 'none';
            }
        })();
        refreshInFlight = p;
        // refresh 在途：立即禁用操作按钮（定时刷新不经过 runOperation，必须在此主动禁用）。
        updateButtons();
        // 无论成功/失败都清空 inflight 并恢复按钮，允许后续刷新。
        p.finally(() => {
            refreshInFlight = null;
            updateButtons();
        });
        return refreshInFlight;
    }

    // 定时刷新的入口：写操作在途（opDepth>0）时跳过本次，避免与 mutation 抢同用户互斥；
    // 空闲时发起只读刷新（refreshStatus 内部会合并重复）。
    function maybeAutoRefresh() {
        if (opDepth === 0) {
            refreshStatus();
        }
    }

    function showError(err) {
        const errBox = el('jg-error-box');
        if (errBox) {
            errBox.style.display = '';
            setText(el('jg-error-text'), (err && err.message) ? err.message : String(err));
        }
    }

    async function loadConfig() {
        const data = await apiCall('GET', '/config');
        return data || {};
    }

    // ===================== 操作 =====================

    // 操作进行中的统一包裹：深度计数（嵌套时内层结束不提前恢复按钮）、完成后恢复，避免并发/重复点击 + 未捕获 promise。
    async function runOperation(label, fn) {
        opDepth++;
        updateButtons();
        try {
            return await fn();
        } finally {
            opDepth--;
            updateButtons();
        }
    }

    async function doSave() {
        return runOperation('保存', async () => {
            const repo = el('jg-repo').value.trim();
            const branch = el('jg-branch').value.trim() || 'main';
            const token = el('jg-token').value;
            const autoCheck = el('jg-auto-check').checked;
            const minutes = parseInt(el('jg-minutes').value, 10) || 30;

            const body = { githubRepo: repo, branch, autoCheckEnabled: autoCheck, autoCheckMinutes: minutes };
            // PAT：只在用户本次输入了非空值时发送；发送后立即清空输入框，绝不持久化到 settings/localStorage。
            if (token && token.trim()) {
                body.token = token;
            }

            try {
                const data = await apiCall('PUT', '/config', body);
                el('jg-token').value = ''; // 保存后清空，不持久
                toast('success', '配置已保存。');
                await refreshStatus();
                return data;
            } catch (e) {
                showError(e);
                toast('error', '保存失败：' + e.message);
                throw e;
            }
        });
    }

    async function doConnect() {
        return runOperation('连接', async () => {
            const initialize = el('jg-init-empty') && el('jg-init-empty').checked;
            try {
                await doSave();
                const data = await apiCall('POST', '/connect', { initializeEmptyBranch: !!initialize });
                if (data && data.initializedRemote) {
                    toast('success', '已连接并初始化空分支（普通 push，非 force）。');
                } else {
                    toast('success', '已连接。');
                }
                await refreshStatus();
            } catch (e) {
                showError(e);
                toast('error', '连接失败：' + e.message);
            }
        });
    }

    // 把核心 push/pull 的 result 转成真实摘要：发布数 / 暂存数 / 冲突数。
    function summarizeCoreResult(res) {
        const r = res && typeof res === 'object' ? res : {};
        const published = Array.isArray(r.published) ? r.published.length : 0;
        const staged = Array.isArray(r.staged) ? r.staged.length : 0;
        const conflicts = Array.isArray(r.conflicts) ? r.conflicts.length : 0;
        return { published, staged, conflicts, raw: r };
    }

    async function doUpload() {
        return runOperation('上传', async () => {
            try {
                requireCapabilities();
                ensureNotBusy();
                const data = await apiCall('POST', '/push');
                const s = summarizeCoreResult(data && data.result);
                // 按真实摘要显示，不无条件「上传全部完成」。
                const parts = [];
                parts.push('已发布 ' + s.published + ' 个');
                if (s.staged > 0) parts.push('暂存 ' + s.staged + ' 个');
                if (s.conflicts > 0) parts.push('冲突 ' + s.conflicts + ' 个（双方已保留，见下方冲突列表）');
                toast(s.conflicts > 0 ? 'warning' : 'success', '上传结果：' + parts.join('，') + '。');
                await refreshStatus();
                return data;
            } catch (e) {
                showError(e);
                toast('error', '上传失败：' + e.message);
                throw e;
            }
        });
    }

    async function doDownload() {
        return runOperation('下载', async () => {
            try {
                requireCapabilities();
                ensureNotBusy();
                const data = await apiCall('POST', '/pull');
                const s = summarizeCoreResult(data && data.result);
                // 下载成功只是暂存，不写聊天；按真实摘要显示暂存/冲突数。
                const parts = [];
                parts.push('已暂存 ' + s.staged + ' 个');
                if (s.conflicts > 0) parts.push('冲突 ' + s.conflicts + ' 个（双方已保留，见下方冲突列表）');
                toast(s.conflicts > 0 ? 'warning' : 'success', '下载结果：' + parts.join('，') + '（远端聊天仅暂存，尚未写入本地聊天）。');
                // 后续步骤：先勾确认安排 → 关闭全部（含当前标签）→ 重启后重新打开应用。
                if (s.staged > 0) {
                    toast('info', '下一步：勾选下方「我已关闭其他客户端」并点击「安排应用（重启后）」，然后关闭全部客户端（含当前标签页）并重启后重新打开。');
                }
                await refreshStatus();
                return data;
            } catch (e) {
                showError(e);
                toast('error', '下载失败：' + e.message);
                throw e;
            }
        });
    }

    async function doScheduleApply() {
        return runOperation('安排应用', async () => {
            try {
                requireCapabilities();
                ensureNotBusy();
                // 先确认当前 stageId
                let stageId = null;
                try {
                    const data = await apiCall('GET', '/status');
                    stageId = data && data.status && data.status.stageId;
                } catch (e) { /* status 读取失败会在下面 API 报错 */ }
                if (!stageId) {
                    toast('warning', '当前没有已暂存的 stage，无法安排应用。请先「检查下载」。');
                    return;
                }
                // 用户必须显式勾选「我已关闭其他客户端，重启后重新打开」。
                if (!el('jg-close-confirm') || !el('jg-close-confirm').checked) {
                    toast('warning', '请先勾选「我已关闭其他客户端，重启后重新打开」。');
                    return;
                }
                const data = await apiCall('POST', '/schedule-apply', { stageId, clientsWillBeClosed: true });
                toast('success', '已安排应用：请关闭本客户端（含当前标签页）并重启后重新打开，将在启动时应用暂存的聊天。');
                await refreshStatus();
                return data;
            } catch (e) {
                showError(e);
                toast('error', '安排应用失败：' + e.message);
                throw e;
            }
        });
    }

    async function doCancelApply() {
        return runOperation('取消安排', async () => {
            try {
                const data = await apiCall('POST', '/cancel-apply');
                toast('success', '已取消安排（暂存备份保留，不删除）。');
                await refreshStatus();
                return data;
            } catch (e) {
                showError(e);
                toast('error', '取消失败：' + e.message);
            }
        });
    }

    async function doRefresh() {
        return runOperation('刷新', async () => {
            try {
                await refreshStatus();
            } catch (e) {
                showError(e);
                toast('error', '刷新失败：' + e.message);
            }
        });
    }

    // ===================== 面板构建 =====================

    function buildPanelHtml() {
        const root = document.createElement('div');
        root.id = EXT_ID;
        root.className = 'jg-panel';

        const heading = document.createElement('h4');
        heading.textContent = '酒管 GitHub 同步';
        root.appendChild(heading);

        const note = document.createElement('div');
        note.className = 'jg-note';
        note.textContent = '界面集成预览 · 仅一对一角色聊天。上传为已保存磁盘聊天；下载仅暂存，应用须停服务并重启。';
        root.appendChild(note);

        // ---- 仓库配置 ----
        const cfgSection = section('仓库配置');
        addField(cfgSection, '仓库 (owner/repo)', 'jg-repo', 'text', '用户名/仓库名');
        addField(cfgSection, '分支', 'jg-branch', 'text', 'main');
        const tokenRow = document.createElement('div');
        tokenRow.className = 'jg-row';
        const tokenInput = document.createElement('input');
        tokenInput.type = 'password';
        tokenInput.id = 'jg-token';
        tokenInput.className = 'text_pole';
        tokenInput.placeholder = '个人访问令牌 (PAT)，保存后即清空、不持久';
        tokenInput.autocomplete = 'off';
        tokenRow.appendChild(tokenInput);
        cfgSection.appendChild(tokenRow);
        root.appendChild(cfgSection);

        // ---- 自动检查 ----
        const autoSection = section('自动检查');
        const autoRow = document.createElement('div');
        autoRow.className = 'jg-row';
        const autoCheck = document.createElement('input');
        autoCheck.type = 'checkbox';
        autoCheck.id = 'jg-auto-check';
        autoCheck.checked = false; // 默认关闭
        const autoLabel = document.createElement('label');
        autoLabel.htmlFor = 'jg-auto-check';
        autoLabel.textContent = '启用自动检查（默认关闭；仅定时 pull 暂存，不应用）';
        autoRow.appendChild(autoCheck);
        autoRow.appendChild(autoLabel);
        autoSection.appendChild(autoRow);
        const minRow = document.createElement('div');
        minRow.className = 'jg-row';
        const minLabel = document.createElement('label');
        minLabel.htmlFor = 'jg-minutes';
        minLabel.textContent = '间隔（分钟）';
        const minInput = document.createElement('input');
        minInput.type = 'number';
        minInput.id = 'jg-minutes';
        minInput.className = 'text_pole';
        minInput.value = '30';
        minInput.min = '5';
        minRow.appendChild(minLabel);
        minRow.appendChild(minInput);
        autoSection.appendChild(minRow);
        root.appendChild(autoSection);

        // ---- 初始化空分支 ----
        const initRow = document.createElement('div');
        initRow.className = 'jg-row';
        const initCheck = document.createElement('input');
        initCheck.type = 'checkbox';
        initCheck.id = 'jg-init-empty';
        const initLabel = document.createElement('label');
        initLabel.htmlFor = 'jg-init-empty';
        initLabel.textContent = '连接时初始化空分支（仅当远端无分支时 bootstrap 普通 push，非 force）';
        initRow.appendChild(initCheck);
        initRow.appendChild(initLabel);
        root.appendChild(initRow);

        // ---- 操作按钮 ----
        const ops = document.createElement('div');
        ops.className = 'jg-ops';
        const mkBtn = (id, label, handler) => {
            const b = document.createElement('button');
            b.id = id;
            b.className = 'menu_button';
            b.textContent = label;
            b.addEventListener('click', () => { handler().catch(e => { console.error('[酒管同步] 操作未捕获异常:', e && e.message); }); });
            ops.appendChild(b);
            return b;
        };
        mkBtn('jg-refresh', '刷新', doRefresh);
        mkBtn('jg-save', '保存', doSave);
        mkBtn('jg-connect', '连接', doConnect);
        mkBtn('jg-upload', '上传已保存聊天', doUpload);
        mkBtn('jg-download', '检查下载', doDownload);
        mkBtn('jg-schedule', '安排应用（重启后）', doScheduleApply);
        mkBtn('jg-cancel', '取消安排', doCancelApply);
        root.appendChild(ops);

        // ---- 关闭确认 ----
        const closeRow = document.createElement('div');
        closeRow.className = 'jg-row jg-close-row';
        const closeCheck = document.createElement('input');
        closeCheck.type = 'checkbox';
        closeCheck.id = 'jg-close-confirm';
        const closeLabel = document.createElement('label');
        closeLabel.htmlFor = 'jg-close-confirm';
        closeLabel.textContent = '我已关闭其他客户端，并将在重启后重新打开（应用不是无感在线原位应用）';
        closeRow.appendChild(closeCheck);
        closeRow.appendChild(closeLabel);
        root.appendChild(closeRow);

        // ---- 状态 ----
        const statusBox = document.createElement('div');
        statusBox.className = 'jg-status';
        statusBox.id = 'jg-status';
        const statusText = document.createElement('span');
        statusText.id = 'jg-status-text';
        statusText.className = 'jg-status-text';
        statusText.textContent = '未配置';
        statusBox.appendChild(statusText);
        root.appendChild(statusBox);

        // ---- 状态详情（stageId / 暂存文件 / 安排 / 最后操作 / 后端版本） ----
        const detailBox = document.createElement('div');
        detailBox.className = 'jg-status-detail';
        const mkDetail = (id) => {
            const d = document.createElement('div');
            d.id = id;
            d.className = 'jg-detail-line';
            detailBox.appendChild(d);
            return d;
        };
        mkDetail('jg-stage-id');
        mkDetail('jg-staged-count');
        const stagedList = document.createElement('ul');
        stagedList.id = 'jg-staged-list';
        stagedList.className = 'jg-staged-list';
        detailBox.appendChild(stagedList);
        mkDetail('jg-scheduled');
        mkDetail('jg-last-op');
        mkDetail('jg-backend-version');
        root.appendChild(detailBox);

        // ---- 冲突 ----
        const conflictBox = document.createElement('div');
        conflictBox.id = 'jg-conflict-box';
        conflictBox.className = 'jg-box jg-warn-box';
        conflictBox.style.display = 'none';
        const conflictTitle = document.createElement('b');
        conflictTitle.textContent = '冲突（保留双方，不自动选择）：';
        conflictBox.appendChild(conflictTitle);
        const conflictList = document.createElement('ul');
        conflictList.id = 'jg-conflict-list';
        conflictBox.appendChild(conflictList);
        root.appendChild(conflictBox);

        // ---- 错误 ----
        const errBox = document.createElement('div');
        errBox.id = 'jg-error-box';
        errBox.className = 'jg-box jg-err-box';
        errBox.style.display = 'none';
        const errText = document.createElement('pre');
        errText.id = 'jg-error-text';
        errBox.appendChild(errText);
        root.appendChild(errBox);

        // ---- 只读探测错误（probeError，独立于 mutation 错误） ----
        const probeBox = document.createElement('div');
        probeBox.id = 'jg-probe-error';
        probeBox.className = 'jg-box jg-err-box';
        probeBox.style.display = 'none';
        const probeText = document.createElement('pre');
        probeText.id = 'jg-probe-error-text';
        probeBox.appendChild(probeText);
        root.appendChild(probeBox);

        // ---- 后端安装指引（后端缺失/旧版时显示） ----
        const backSection = section('后端安装');
        const backNote = document.createElement('div');
        backNote.className = 'jg-note';
        backNote.textContent = '本扩展仅为前端界面；同步需要服务端插件一并安装到宿主 plugins 目录。请先 git clone 本仓库到本地并进入仓库目录，再运行一次性 Node 安装命令：node bin/install-plugin.js --app-dir <应用目录> --enable-server-plugins --install-deps --apply（详见 docs/installation.md；去掉 --apply 可先看 dry-run 计划）。安装后需重启宿主并关闭旧标签页。仅前端无法独立运行同步。';
        backSection.appendChild(backNote);
        const backGuide = document.createElement('div');
        backGuide.id = 'jg-backend-guide';
        backGuide.className = 'jg-box jg-err-box';
        backGuide.style.display = 'none';
        backSection.appendChild(backGuide);
        root.appendChild(backSection);

        return root;
    }

    function section(title) {
        const sec = document.createElement('div');
        sec.className = 'jg-section';
        const h = document.createElement('div');
        h.className = 'jg-section-title';
        h.textContent = title;
        sec.appendChild(h);
        return sec;
    }

    function addField(sec, labelText, id, type, placeholder) {
        const row = document.createElement('div');
        row.className = 'jg-row';
        const lbl = document.createElement('label');
        lbl.htmlFor = id;
        lbl.textContent = labelText;
        const inp = document.createElement('input');
        inp.type = type;
        inp.id = id;
        inp.className = 'text_pole';
        inp.placeholder = placeholder || '';
        row.appendChild(lbl);
        row.appendChild(inp);
        sec.appendChild(row);
    }

    // ===================== 挂载 =====================

    function mount() {
        // 防重复：若已存在面板则不重复挂载。
        if (el(EXT_ID)) return;
        const target = el('extensions_settings2') || el('extensions_settings');
        if (!target) {
            console.warn('[酒管同步] 未找到 #extensions_settings2 或 #extensions_settings 容器，挂载到 body。');
            const panel = buildPanelHtml();
            document.body.appendChild(panel);
            bind();
            return;
        }
        target.appendChild(buildPanelHtml());
        bind();
    }

    function bind() {
        // 加载配置回填（仅回填非敏感字段；PAT 永不回填）
        loadConfig().then(data => {
            const cfg = data && data.config ? data.config : {};
            if (el('jg-repo')) el('jg-repo').value = cfg.githubRepo || '';
            if (el('jg-branch')) el('jg-branch').value = cfg.branch || 'main';
            if (el('jg-auto-check')) el('jg-auto-check').checked = cfg.autoCheckEnabled === true;
            if (el('jg-minutes')) el('jg-minutes').value = cfg.autoCheckMinutes || 30;
            // token 输入框保持为空；已保存提示来自 hasToken（后端返回，非本地猜测）。
            if (el('jg-token')) el('jg-token').placeholder = (data && data.hasToken) ? '已保存令牌（留空不修改）；如需更换请重新输入' : '个人访问令牌 (PAT)，保存后即清空、不持久';
        }).catch(e => {
            // 加载配置失败：不阻断 UI，但提示
            console.warn('[酒管同步] 配置加载失败:', e && e.message);
        });

        // 初始状态 + 定时刷新
        refreshStatus();
        // 定时刷新：写操作（opDepth>0）在途时跳过本次，避免与 mutation 抢同用户互斥；
        // 操作自身 await refreshStatus() 仍会执行（refreshStatus 不检查 opDepth，不自锁）。
        setInterval(maybeAutoRefresh, 30000);
        // 仅读忙碌状态的小间隔刷新（不请求后端）：生成/保存结束能及时解除按钮禁用。
        setInterval(() => { updateButtons(); }, 2000);
    }

    // ---- 挂载时机：DOM ready ----
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }

    // 暴露给契约测试（纯函数部分可在 node 环境安全 require 时不依赖浏览器）
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            safeText,
            isBusy,
            ensureNotBusy,
            capabilitiesOk,
            requireCapabilities,
            getContext,
            getRequestHeaders,
            buildPanelHtml,
            renderStatus,
            summarizeCoreResult,
            // 供测试驱动按钮/刷新并发与深度计数行为（非 HTTP API，仅为 VM 测试入口）
            refreshStatus,
            updateButtons,
            isAnyOpInProgress,
            maybeAutoRefresh,
            doSave,
            doConnect,
            doRefresh,
            doUpload,
            doDownload,
            doScheduleApply,
            doCancelApply,
            EXT_ID,
            API_BASE,
        };
    }
})();

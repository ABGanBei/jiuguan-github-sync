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
    // 首次设置和安全预检需要同一版后端。缺任一能力即阻断，不能降级到旧操作流程。
    const REQUIRED_CAPABILITIES = ['onlineSnapshot', 'startupApply', 'setupWizard', 'safePreview', 'statusHistory'];
    let health = null;
    let currentStatus = null;
    let savedConfig = null;
    let targetLocked = false;
    let formDirty = false;
    let pendingRemoteInit = null;
    let setupResult = null;
    let preflightState = null;
    let setupAutoSettled = false;
    let configurationLoading = false;

    function capabilitiesOk() {
        return !!(health && health.ok && REQUIRED_CAPABILITIES.every(key => health[key] === true));
    }

    // 危险操作守卫：后端旧版或缺能力时阻断，指引更新（不自动更新）。
    function requireCapabilities() {
        if (!capabilitiesOk()) {
            throw Object.assign(new Error('后端能力不足或不可用（需 setupWizard/safePreview/statusHistory 及 onlineSnapshot/startupApply）。请更新服务端插件并重启后重试。'), { code: 'CAPABILITY_MISSING' });
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
                setupWizard: cap.setupWizard === true,
                safePreview: cap.safePreview === true,
                statusHistory: cap.statusHistory === true,
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
    const OP_BTN_IDS = ['jg-save', 'jg-connect', 'jg-init-confirm', 'jg-upload', 'jg-download', 'jg-schedule', 'jg-cancel', 'jg-refresh', 'jg-preflight'];

    function readyForSync() {
        return !!(currentStatus && currentStatus.readyForSync === true && !currentStatus.busy && !formDirty && !pendingRemoteInit);
    }

    function hasPendingUpload() {
        return !!(currentStatus && currentStatus.core && currentStatus.core.pending);
    }

    function requireReady(allowPendingUpload = false) {
        requireCapabilities();
        if (!readyForSync()) {
            throw new Error('同步尚未就绪：请完成保存并验证、分支初始化，或先处理状态区中的阻断原因。');
        }
        if (currentStatus.scheduledApply) throw new Error('已安排应用：请完成重启，或先取消安排。');
        if (hasPendingUpload() && !allowPendingUpload) throw new Error('上次上传尚未确认，请先点击「上传已保存聊天」明确重试。');
    }

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
            let disabled = !!anyOp || configurationLoading;
            let reason = '';
            if (disabled) {
                reason = '操作进行中，请稍候。';
            } else if (DANGER_BTN_IDS.includes(id) || id === 'jg-preflight') {
                if (!capOk) {
                    disabled = true;
                    reason = '后端能力不足或不可用，请更新服务端插件后重试。';
                } else if (busyState.busy || busyState.unknown) {
                    disabled = true;
                    reason = busyState.unknown
                        ? '无法确认宿主是否正在生成/保存，禁止操作。'
                        : '宿主正在生成/保存聊天。';
                } else if (!readyForSync()) {
                    disabled = true;
                    reason = '请先完成设置与验证，或处理同步状态中的阻断原因。';
                } else if (hasPendingUpload() && id !== 'jg-upload') {
                    disabled = true;
                    reason = '上次上传尚未确认，请先点击「上传已保存聊天」明确重试。';
                } else if (currentStatus && currentStatus.scheduledApply && id !== 'jg-preflight') {
                    disabled = true;
                    reason = '已安排应用，请关闭所有客户端并停服再启动；也可先取消安排。';
                } else if (id === 'jg-schedule' && !(preflightState && preflightState.ready === true && preflightState.stageId === currentStatus.stageId)) {
                    disabled = true;
                    reason = '请先检查待更新项，确认当前暂存可安排应用。';
                } else if (id === 'jg-schedule' && (!el('jg-close-confirm') || !el('jg-close-confirm').checked)) {
                    disabled = true;
                    reason = '关闭其他客户端后，请先勾选确认。';
                }
            } else if ((id === 'jg-connect' || id === 'jg-init-confirm') && !capOk) {
                disabled = true;
                reason = '请安装或升级支持首次设置的服务端插件。';
            } else if (id === 'jg-init-confirm' && (!pendingRemoteInit || formDirty || !el('jg-init-empty') || !el('jg-init-empty').checked)) {
                disabled = true;
                reason = '请先验证仓库，再明确确认初始化目标分支。';
            }
            btn.disabled = disabled;
            btn.title = disabled ? reason : '';
        });
        ['jg-repo', 'jg-branch', 'jg-token', 'jg-auto-check', 'jg-minutes', 'jg-init-empty', 'jg-close-confirm'].forEach(id => {
            const node = el(id);
            if (node) node.disabled = !!anyOp || configurationLoading;
        });
    }

    function show(id, visible) {
        const node = el(id);
        if (node) node.style.display = visible ? '' : 'none';
    }

    function renderTargetLock() {
        ['jg-repo', 'jg-branch'].forEach(id => {
            const node = el(id);
            if (node) node.readOnly = targetLocked;
        });
        show('jg-target-lock', targetLocked);
    }

    function applyConfig(data, fillForm) {
        const cfg = data && data.config;
        if (cfg) savedConfig = cfg;
        if (data && typeof data.targetLocked === 'boolean') targetLocked = data.targetLocked;
        renderTargetLock();
        if (cfg && fillForm) {
            if (el('jg-repo')) el('jg-repo').value = cfg.githubRepo || '';
            if (el('jg-branch')) el('jg-branch').value = cfg.branch || 'main';
            if (el('jg-auto-check')) el('jg-auto-check').checked = cfg.autoCheckEnabled === true;
            if (el('jg-minutes')) el('jg-minutes').value = cfg.autoCheckMinutes || 30;
        }
        if (el('jg-token') && data && typeof data.hasToken === 'boolean') {
            el('jg-token').placeholder = data.hasToken ? '已保存令牌（留空不修改）；更换后需重新验证' : '个人访问令牌 (PAT)，成功保存后清空';
        }
    }

    function verificationText(v) {
        if (!v) return '仓库尚未验证。';
        const privacy = v.private === true ? '私有仓库已确认' : '尚未确认私有仓库';
        const read = v.read === 'verified' ? '读取已验证' : '读取尚未验证';
        const write = v.write === 'verified' ? '实际写入已验证' : '写入待首次实际上传确认';
        return privacy + ' · ' + read + ' · ' + write;
    }

    function renderSetup() {
        const verified = setupResult && setupResult.verification;
        const historyVerification = currentStatus && currentStatus.history && currentStatus.history.verification;
        setText(el('jg-verification'), verificationText(formDirty ? null : (historyVerification || verified)));
        show('jg-init-section', !!pendingRemoteInit && !formDirty);
        if (pendingRemoteInit) {
            setText(el('jg-init-description'), pendingRemoteInit.remoteEmpty === true
                ? '远端仓库为空。确认后将创建所选分支，并推送一个不含聊天的初始化提交。'
                : '仓库中已有内容，但所选分支不存在。确认后将新建该分支并推送一个不含聊天的初始化提交；其他分支保持原样。');
        }
        let message = '完成验证后，在这里查看结果，再选择第一次检查更新或上传。';
        if (formDirty) message = '设置已修改，请点「保存并验证」后继续。';
        else if (pendingRemoteInit) message = '设置尚未完成：需要确认初始化所选分支。尚未同步聊天。';
        else if (setupResult && setupResult.error) message = '验证未完成：' + setupResult.error;
        else if (readyForSync()) message = '设置已完成。建议先用下方「检查更新」查看远端聊天；也可选择「上传已保存聊天」。连接成功不代表聊天已同步。';
        else if (currentStatus && currentStatus.configured) message = '配置已保存，尚未连接或未通过就绪检查。请重新验证，或查看下方阻断原因。';
        setText(el('jg-setup-result'), message);
        const setup = el('jg-settings');
        if (setup && !readyForSync()) setup.open = true;
        if (setup && readyForSync() && !setupAutoSettled) {
            setup.open = false;
            setupAutoSettled = true;
        }
    }

    function formatTimestamp(at) {
        if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return '未记录';
        return new Date(at).toLocaleString('zh-CN', { hour12: false });
    }

    function historyLine(label, entry) {
        if (!entry || !entry.at) return label + '：尚无记录';
        const outcomes = { success: '成功', ok: '成功', failed: '失败', error: '失败', conflict: '有冲突', conflicts: '有冲突', 'no-change': '无变化', 'no-changes': '无变化', unchanged: '无变化', staged: '已暂存', published: '已上传', blocked: '被阻断' };
        const outcome = outcomes[entry.outcome] || safeText(entry.outcome || '已结束');
        const count = Number.isFinite(entry.count) ? '，' + entry.count + ' 个' : '';
        const error = entry.error ? '：' + safeText(typeof entry.error === 'string' ? entry.error : entry.error.message) : '';
        return label + '：' + formatTimestamp(entry.at) + ' · ' + outcome + count + error;
    }

    function renderPreflight(preflight) {
        preflightState = preflight || null;
        if (!preflight) {
            setText(el('jg-preflight-text'), '先检查待更新项。预检仅反映检查时点，重启时还会重新核对。');
        } else if (preflight.ready === true) {
            const count = Array.isArray(preflight.files) ? preflight.files.length : 0;
            setText(el('jg-preflight-text'), '当前 ' + count + ' 个待更新文件通过预检。尚未写入聊天；安排与重启时都会再次核对。');
        } else {
            const error = preflight.error;
            setText(el('jg-preflight-text'), '暂不能安排应用：' + safeText(error && (error.message || error.code) || '请检查当前暂存状态。'));
        }
        updateButtons();
    }

    // 展示后端安装/更新指引（后端缺失或旧版时）。
    function showBackendGuide(message) {
        const guide = el('jg-backend-guide');
        if (guide) {
            guide.style.display = '';
            setText(guide, message);
        }
        const technical = el('jg-technical-details');
        if (technical) technical.open = true;
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
        const previousStage = currentStatus && currentStatus.stageId;
        currentStatus = status || null;
        if (status && status.readyForSync === true) pendingRemoteInit = null;
        if (!status || previousStage !== status.stageId) {
            preflightState = null;
            if (el('jg-close-confirm')) el('jg-close-confirm').checked = false;
        }
        if (status && typeof status.targetLocked === 'boolean') targetLocked = status.targetLocked;
        renderTargetLock();
        const staged = status && Array.isArray(status.stagedFiles) ? status.stagedFiles : [];
        const hasStage = !!(status && status.stageId && staged.length);
        show('jg-stage-panel', hasStage || !!(status && status.scheduledApply));
        show('jg-schedule-controls', hasStage && !(status && status.scheduledApply));
        show('jg-cancel', !!(status && status.scheduledApply));
        show('jg-restart-guide', !!(status && status.scheduledApply));
        const history = status && status.history || {};
        setText(el('jg-history-check'), historyLine('最近检查更新', history.lastCheck));
        setText(el('jg-history-upload'), historyLine('最近上传', history.lastUpload));
        setText(el('jg-history-apply'), '最近应用：' + (status && status.lastAppliedAt ? formatTimestamp(status.lastAppliedAt) : '尚无记录'));
        renderSetup();
        if (!preflightState) renderPreflight(null);
        updateButtons();
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
            setStatusText('等待重启应用：尚未完成同步。请关闭当前及其他客户端，停止服务后重新启动。', 'info');
        } else if (hasPendingUpload() && !probeErr) {
            setStatusText('上次上传尚未确认：请点击「上传已保存聊天」明确重试；检查更新已暂停。', 'warn');
        } else if (err) {
            setStatusText('错误：' + safeText(typeof err === 'string' ? err : (err.message || JSON.stringify(err))), 'err');
        } else if (pendingRemoteInit) {
            setStatusText('等待确认初始化分支，设置尚未完成', 'warn');
        } else if (!connected) {
            setStatusText('已配置（尚未连接/初始化，请先「连接」）', 'warn');
        } else if (!readyForSync()) {
            setStatusText('已连接，但同步尚未就绪；请完成验证或处理阻断原因', 'warn');
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
                currentStatus = null;
                preflightState = null;
                showError(e);
            }
            // 后端健康/能力检查：缺 onlineSnapshot/startupApply 或旧版时禁危险按钮并指引。
            await checkHealth();
            if (!capabilitiesOk()) {
                const capMsg = (health && health.ok) ? '后端版本过旧或缺首次设置/安全预检/历史状态能力' : ('后端不可用：' + (health && health.reason ? health.reason : '未知'));
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

    async function doSave(options = {}) {
        return runOperation('保存', async () => {
            const repo = targetLocked && savedConfig ? savedConfig.githubRepo : el('jg-repo').value.trim();
            const branch = targetLocked && savedConfig ? savedConfig.branch : (el('jg-branch').value.trim() || 'main');
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
                applyConfig(data, false);
                formDirty = false;
                pendingRemoteInit = null;
                setupResult = null;
                preflightState = null;
                currentStatus = null;
                if (!options.quiet) toast('success', '配置已保存。仓库或令牌变更后请验证再同步。');
                if (options.refresh !== false) await refreshStatus();
                return data;
            } catch (e) {
                showError(e);
                toast('error', '保存失败：' + e.message);
                throw e;
            }
        });
    }

    async function doConnect(initializeEmptyBranch = false) {
        return runOperation('连接', async () => {
            try {
                if (!capabilitiesOk()) await checkHealth();
                requireCapabilities();
                // 初始化必须来自单独确认按钮；普通保存验证始终不写远端。
                if (initializeEmptyBranch === true) {
                    if (!pendingRemoteInit || formDirty || !el('jg-init-empty') || !el('jg-init-empty').checked) {
                        throw new Error('请先验证仓库，并明确勾选确认初始化所选分支。');
                    }
                } else {
                    await doSave({ refresh: false, quiet: true });
                }
                const data = await apiCall('POST', '/connect', { initializeEmptyBranch: initializeEmptyBranch === true });
                setupResult = data || {};
                pendingRemoteInit = data && data.needsRemoteInit ? { remoteEmpty: data.remoteEmpty === true } : null;
                if (el('jg-init-empty')) el('jg-init-empty').checked = false;
                renderSetup();
                if (data && data.initializedRemote) {
                    toast('success', '私有仓库分支已初始化（普通 push）。尚未上传或应用聊天。');
                } else if (pendingRemoteInit) {
                    toast('warning', '已完成仓库读取检查，所选分支需要单独确认初始化。设置尚未完成。');
                } else {
                    toast('success', '私有仓库读取已验证。聊天尚未同步，写入待首次实际上传确认。');
                }
                await refreshStatus();
                if (readyForSync() && el('jg-settings')) el('jg-settings').open = false;
                return data;
            } catch (e) {
                setupResult = { error: e.message };
                renderSetup();
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
                requireReady(true);
                ensureNotBusy();
                const data = await apiCall('POST', '/push');
                const s = summarizeCoreResult(data && data.result);
                // 按真实摘要显示，不无条件「上传全部完成」。
                const parts = [];
                parts.push('已发布 ' + s.published + ' 个');
                if (s.staged > 0) parts.push('另有 ' + s.staged + ' 个远端更新候选，请点「检查更新」（尚未下载）');
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
                requireReady();
                ensureNotBusy();
                const data = await apiCall('POST', '/pull');
                if (data && data.preflight) renderPreflight(data.preflight);
                const s = summarizeCoreResult(data && data.result);
                // 下载成功只是暂存，不写聊天；按真实摘要显示暂存/冲突数。
                const parts = [];
                parts.push('已暂存 ' + s.staged + ' 个');
                if (s.conflicts > 0) parts.push('冲突 ' + s.conflicts + ' 个（双方已保留，见下方冲突列表）');
                toast(s.conflicts > 0 ? 'warning' : 'success', '下载结果：' + parts.join('，') + '（远端聊天仅暂存，尚未写入本地聊天）。');
                // 后续步骤：先勾确认安排 → 关闭全部（含当前标签）→ 重启后重新打开应用。
                if (s.staged > 0) {
                    toast('info', '下一步：关闭其他客户端后勾选确认，安排重启应用；再关闭当前标签页，停止服务并重新启动。');
                }
                await refreshStatus();
                if (data && data.preflight && currentStatus && data.preflight.stageId === currentStatus.stageId) renderPreflight(data.preflight);
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
                requireReady();
                ensureNotBusy();
                const checked = await apiCall('POST', '/preflight', {});
                renderPreflight(checked && checked.preflight);
                const stageId = preflightState && preflightState.stageId;
                if (!preflightState || preflightState.ready !== true) {
                    throw new Error('当前暂存未通过预检，未安排应用。请查看待更新项。');
                }
                if (!currentStatus || stageId !== currentStatus.stageId) {
                    throw new Error('待更新项已变化，请刷新状态并重新确认当前暂存后再安排。');
                }
                if (!stageId) {
                    toast('warning', '当前没有已暂存的 stage，无法安排应用。请先「检查下载」。');
                    return;
                }
                // 用户必须显式勾选「我已关闭其他客户端，重启后重新打开」。
                if (!el('jg-close-confirm') || !el('jg-close-confirm').checked) {
                    toast('warning', '请先勾选「我已关闭其他客户端，重启后重新打开」。');
                    return;
                }
                ensureNotBusy();
                const data = await apiCall('POST', '/schedule-apply', { stageId, clientsWillBeClosed: true });
                if (el('jg-close-confirm')) el('jg-close-confirm').checked = false;
                toast('success', '等待重启应用，尚未完成同步：请关闭当前标签页，停止酒管服务并重新启动，再打开页面。');
                await refreshStatus();
                return data;
            } catch (e) {
                showError(e);
                toast('error', '安排应用失败：' + e.message);
                throw e;
            }
        });
    }

    async function doPreflight() {
        return runOperation('检查待更新项', async () => {
            try {
                requireReady();
                ensureNotBusy();
                const data = await apiCall('POST', '/preflight', {});
                renderPreflight(data && data.preflight);
                return data;
            } catch (e) {
                renderPreflight({ ready: false, error: { message: e.message } });
                showError(e);
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
        const make = (tag, id, className, text) => {
            const node = document.createElement(tag);
            if (id) node.id = id;
            if (className) node.className = className;
            if (text) node.textContent = text;
            return node;
        };
        const note = (parent, text) => parent.appendChild(make('p', null, 'jg-note', text));
        const detail = (parent, id, text) => parent.appendChild(make('div', id, 'jg-detail-line', text));
        const button = (parent, id, label, handler) => {
            const node = make('button', id, 'menu_button', label);
            node.type = 'button';
            node.addEventListener('click', () => {
                handler().catch(e => { console.error('[酒管同步] 操作未捕获异常:', e && e.message); });
            });
            parent.appendChild(node);
            return node;
        };
        const fold = (parent, id, title) => {
            const node = make('details', id, 'jg-fold');
            node.appendChild(make('summary', null, null, title));
            parent.appendChild(node);
            return node;
        };
        const root = make('div', EXT_ID, 'jg-panel');
        root.appendChild(make('h4', null, null, '酒管 GitHub 同步'));
        note(root, '仅同步一对一角色的已保存聊天。检查更新会暂存远端内容，应用需要关闭客户端并停服再启动。');

        const statusBox = make('div', 'jg-status', 'jg-status');
        statusBox.appendChild(make('span', 'jg-status-text', 'jg-status-text', '正在读取设置…'));
        root.appendChild(statusBox);
        const historyBox = make('div', 'jg-history', 'jg-history');
        detail(historyBox, 'jg-history-check', '最近检查更新：尚无记录');
        detail(historyBox, 'jg-history-upload', '最近上传：尚无记录');
        detail(historyBox, 'jg-history-apply', '最近应用：尚无记录');
        root.appendChild(historyBox);

        const settings = fold(root, 'jg-settings', '首次设置 / 仓库与令牌');
        settings.open = true;
        const prepare = section('1 · 准备私有数据仓库');
        note(prepare, '为聊天单独建立一个私有仓库，不要填写插件源码仓库。聊天会以明文进入 Git 历史，本版本未加密。两端需要相同的角色卡。');
        const links = make('div', null, 'jg-links');
        const addLink = (label, href) => {
            const link = make('a', null, null, label);
            link.href = href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            links.appendChild(link);
        };
        addLink('在 GitHub 创建仓库（选 Private）', 'https://github.com/new');
        addLink('创建细粒度访问令牌', 'https://github.com/settings/personal-access-tokens/new');
        prepare.appendChild(links);
        note(prepare, '令牌仅选择这个数据仓库，给予 Contents 读写权限；Metadata 保持默认只读。分支保护仍可能拒绝实际推送。');
        settings.appendChild(prepare);

        const cfgSection = section('2 · 填写并验证');
        addField(cfgSection, '数据仓库 (owner/repo)', 'jg-repo', 'text', '用户名/私有数据仓库名');
        const branchSection = fold(cfgSection, 'jg-branch-details', '分支（默认 main）');
        addField(branchSection, '分支', 'jg-branch', 'text', 'main');
        const tokenRow = make('div', null, 'jg-row');
        const tokenLabel = make('label', null, null, '访问令牌 (PAT)');
        tokenLabel.htmlFor = 'jg-token';
        tokenRow.appendChild(tokenLabel);
        const tokenInput = make('input', 'jg-token', 'text_pole');
        tokenInput.type = 'password';
        tokenInput.placeholder = '个人访问令牌 (PAT)，成功保存后清空';
        tokenInput.autocomplete = 'off';
        tokenRow.appendChild(tokenInput);
        cfgSection.appendChild(tokenRow);
        note(cfgSection, '令牌不会回填。留空会保留已保存的令牌；更换令牌后需要重新验证。');
        const lock = detail(cfgSection, 'jg-target-lock', '已有同步状态，仓库与分支已绑定。可更新令牌；本版不提供直接切换目标或清除历史。');
        lock.style.display = 'none';
        const setupOps = make('div', null, 'jg-ops');
        button(setupOps, 'jg-connect', '保存并验证', doConnect);
        cfgSection.appendChild(setupOps);
        settings.appendChild(cfgSection);

        const resultSection = section('3 · 查看结果，开始第一次同步');
        detail(resultSection, 'jg-verification', '仓库尚未验证。');
        detail(resultSection, 'jg-setup-result', '完成验证后，选择下方的检查更新或上传。连接成功不代表聊天已同步。');
        const initSection = make('div', 'jg-init-section', 'jg-box jg-warn-box');
        initSection.style.display = 'none';
        detail(initSection, 'jg-init-description', '所选分支需要初始化。');
        const initRow = make('div', null, 'jg-row');
        const initCheck = make('input', 'jg-init-empty');
        initCheck.type = 'checkbox';
        const initLabel = make('label', null, null, '我确认初始化所选分支（普通 push，不含聊天，不强制覆盖）');
        initLabel.htmlFor = 'jg-init-empty';
        initRow.appendChild(initCheck);
        initRow.appendChild(initLabel);
        initSection.appendChild(initRow);
        button(initSection, 'jg-init-confirm', '确认初始化分支', () => doConnect(true));
        resultSection.appendChild(initSection);
        settings.appendChild(resultSection);

        const autoSection = fold(settings, 'jg-auto-settings', '自动检查与其他设置');
        const autoRow = make('div', null, 'jg-row');
        const autoCheck = make('input', 'jg-auto-check');
        autoCheck.type = 'checkbox';
        autoCheck.checked = false;
        const autoLabel = make('label', null, null, '启用自动检查（默认关闭，仅定时检查并暂存）');
        autoLabel.htmlFor = 'jg-auto-check';
        autoRow.appendChild(autoCheck);
        autoRow.appendChild(autoLabel);
        autoSection.appendChild(autoRow);
        addField(autoSection, '间隔（分钟）', 'jg-minutes', 'number', '30');
        note(autoSection, '自动检查不上传、不应用。关闭服务或手机休眠时不保证运行；已安排应用时暂停检查，保留当前暂存。');
        button(autoSection, 'jg-save', '仅保存设置', doSave);

        const ops = make('div', 'jg-main-actions', 'jg-ops jg-main-actions');
        button(ops, 'jg-upload', '上传已保存聊天', doUpload);
        button(ops, 'jg-download', '检查更新', doDownload);
        root.appendChild(ops);
        note(root, '上传只处理已经保存到磁盘的聊天；检查更新不会立即覆盖聊天。先完成设置与验证，两项操作才会开放。');

        const stagePanel = section('待更新聊天');
        stagePanel.id = 'jg-stage-panel';
        stagePanel.style.display = 'none';
        detail(stagePanel, 'jg-staged-count', '暂存文件数：0');
        const stagedList = make('ul', 'jg-staged-list', 'jg-staged-list');
        stagePanel.appendChild(stagedList);
        detail(stagePanel, 'jg-scheduled');
        const scheduleControls = make('div', 'jg-schedule-controls');
        detail(scheduleControls, 'jg-preflight-text', '预检仅反映检查时点，重启应用前还会重新核对。');
        button(scheduleControls, 'jg-preflight', '检查待更新项', doPreflight);
        const closeRow = make('div', null, 'jg-row jg-close-row');
        const closeCheck = make('input', 'jg-close-confirm');
        closeCheck.type = 'checkbox';
        const closeLabel = make('label', null, null, '我已关闭其他客户端与旧标签页；安排后会关闭当前标签页，停止酒管服务再重新启动。');
        closeLabel.htmlFor = 'jg-close-confirm';
        closeRow.appendChild(closeCheck);
        closeRow.appendChild(closeLabel);
        scheduleControls.appendChild(closeRow);
        button(scheduleControls, 'jg-schedule', '安排应用（重启后）', doScheduleApply);
        stagePanel.appendChild(scheduleControls);
        const restart = detail(stagePanel, 'jg-restart-guide', '等待重启，尚未完成同步。现在关闭当前标签页 → 停止酒管服务 → 重新启动服务 → 再打开页面。');
        restart.style.display = 'none';
        button(stagePanel, 'jg-cancel', '取消安排（保留暂存）', doCancelApply).style.display = 'none';
        root.appendChild(stagePanel);

        const conflictBox = make('div', 'jg-conflict-box', 'jg-box jg-warn-box');
        conflictBox.style.display = 'none';
        conflictBox.appendChild(make('b', null, null, '冲突：双方内容已保留，需要手工处理；不会自动选边。'));
        conflictBox.appendChild(make('ul', 'jg-conflict-list', 'jg-conflict-list'));
        root.appendChild(conflictBox);
        [['jg-error-box', 'jg-error-text'], ['jg-probe-error', 'jg-probe-error-text']].forEach(ids => {
            const box = make('div', ids[0], 'jg-box jg-err-box');
            box.style.display = 'none';
            box.appendChild(make('pre', ids[1]));
            root.appendChild(box);
        });
        const technical = fold(root, 'jg-technical-details', '技术详情与后端安装');
        button(technical, 'jg-refresh', '刷新状态', doRefresh);
        note(technical, '状态刷新读取缓存，不等同于联网检查更新。预检不是写入安全保证，安排与启动时仍会重新核验。');
        detail(technical, 'jg-stage-id');
        detail(technical, 'jg-last-op');
        detail(technical, 'jg-backend-version');
        const backSection = section('后端安装');
        note(backSection, '请下载并解压本版源码，关闭所有酒管页面和客户端并停止服务。Windows 双击 install.cmd；Termux 在源码目录运行 bash setup.sh。向导会先展示计划，确认后一起安装前端和后台。完成后手动启动酒管并打开全新页面；如提示用户级同名扩展，请先处理遮蔽问题。详见 docs/quickstart.md。');
        const backGuide = make('div', 'jg-backend-guide', 'jg-box jg-err-box');
        backGuide.style.display = 'none';
        backSection.appendChild(backGuide);
        technical.appendChild(backSection);
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
        return inp;
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
        // 修改仓库/分支/令牌后立即关掉同步入口，直到重新保存并验证。
        ['jg-repo', 'jg-branch', 'jg-token'].forEach(id => {
            const node = el(id);
            if (node) node.addEventListener('input', () => {
                formDirty = true;
                preflightState = null;
                pendingRemoteInit = null;
                if (el('jg-init-empty')) el('jg-init-empty').checked = false;
                renderSetup();
                updateButtons();
            });
        });
        if (el('jg-init-empty')) el('jg-init-empty').addEventListener('change', updateButtons);
        if (el('jg-close-confirm')) el('jg-close-confirm').addEventListener('change', updateButtons);
        if (el('jg-minutes')) {
            el('jg-minutes').value = '30';
            el('jg-minutes').min = '1';
            el('jg-minutes').max = '10080';
        }
        // 加载配置回填（仅回填非敏感字段；PAT 永不回填）
        configurationLoading = true;
        loadConfig().then(data => {
            applyConfig(data, !formDirty);
            renderSetup();
        }).catch(e => {
            // 加载配置失败：不阻断 UI，但提示
            console.warn('[酒管同步] 配置加载失败:', e && e.message);
            showError(e);
        }).finally(() => {
            configurationLoading = false;
            updateButtons();
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
            doPreflight,
            verificationText,
            historyLine,
            renderPreflight,
            readyForSync,
            applyConfig,
            bind,
            EXT_ID,
            API_BASE,
        };
    }
})();

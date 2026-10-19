'use strict';
/**
 * 后端集成入口：把 service / api / startup 组装成可挂载的宿主插件。
 *
 * - createService：纯工厂（测试注入依赖）；
 * - createPlugin：生产入口，解析 globalThis.DATA_ROOT / process.cwd / os.homedir，
 *   动态加载宿主 src/users.js 的 getUserDirectoriesList；
 * - info / init / exit：宿主插件三件套。
 */
const path = require('path');
const os = require('os');
const { createService, VERSION } = require('./service');
const api = require('./api');
const startup = require('./startup');

const info = {
    id: 'github-data-sync',
    name: '酒管 GitHub 同步',
    version: VERSION,
    description: '酒管一对一角色聊天记录同步到 GitHub 私有仓库（在线 snapshot + 启动期应用，预览）。',
};

/**
 * 生产插件：绑定 router，init 时解析生产依赖、注册路由、跑启动期应用。
 * @param {Object} opts
 * @param {Object} opts.router
 * @param {Object} [opts.deps]  额外依赖覆盖（测试用；生产留空）
 */
function createPlugin(opts = {}) {
    const router = opts.router;
    if (!router) throw new Error('createPlugin 需要 router');

    let started = false;
    let service = null;

    function resolveDeps() {
        const globalDataRoot = globalThis.DATA_ROOT; // 缺失时 undefined（service 会明确拒绝，不许 cwd fallback）
        const hostRoot = process.cwd();
        return {
            dataRoot: globalDataRoot,
            hostRoot,
            storageBase: path.join(os.homedir(), '.jiuguan-github-sync'),
            getUsers: () => startup.loadUserDirectories(hostRoot),
            failClosed: (code) => { process.exit(code); },
            ...(opts.deps || {}),
        };
    }

    // 懒创建 service：resolveDeps / createService 抛错（如 DATA_ROOT 缺失）不能发生在 start 之前，
    // 否则官方 loader 会在 listen 前吞掉 init 抛出的异常；统一放进 start() 的 fail-closed 保护里。
    function ensureService() {
        if (!service) service = createService(resolveDeps());
        return service;
    }

    async function start() {
        if (started) return;
        let svc;
        try {
            svc = ensureService();
            api.registerRoutes(router, svc);

            // 启动期应用：显式安排的 stage 才处理；阻断（可能半改写）→ fail-closed。
            // 枚举/collect/load 异常（含 loadUserDirectories 抛错）→ 不能吞后继续监听 → fail-closed。
            const summary = await startup.runStartupApply(svc);

            // 启动期预检失败记录到 runtime lastError（status 可见，不只 console）。
            for (const p of (summary.precheckFailed || [])) {
                try { await svc.recordPrecheckFailed(p.handle, p.error || p.reason || ''); } catch { /* 记录失败不影响启动判定 */ }
            }

            // 恢复持久化已开启的自动检查定时器（无需用户再保存）。
            try { await svc.startTimers(); } catch (e) { svc.log(`[startup] 恢复定时器失败: ${e && e.message ? e.message : String(e)}`); }

            if (summary.blocked.length > 0) {
                const detail = summary.blocked.map(b => `${b.handle}:${b.reason}`).join(', ');
                svc.log(`[startup] 存在无法收敛的启动期应用（聊天可能被部分改写），阻止宿主继续启动: ${detail}`);
                svc.failClosed(70);
                return;
            }
            started = true;
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            if (svc) svc.log(`[startup] 启动期应用枚举/收集失败（fail-closed）: ${msg}`);
            else console.error('[github-data-sync] 创建服务失败（fail-closed）:', msg);
            const fc = svc ? svc.failClosed : (opts.deps && typeof opts.deps.failClosed === 'function' ? opts.deps.failClosed : ((code) => process.exit(code)));
            fc(70);
            return;
        }
    }

    async function stop() {
        if (service) service.stopAll();
        started = false;
    }

    return { info, start, stop, service: () => ensureService() };
}

module.exports = {
    info,
    VERSION,
    createService,
    createPlugin,
    registerRoutes: api.registerRoutes,
    runStartupApply: startup.runStartupApply,
};

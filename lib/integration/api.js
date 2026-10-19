'use strict';
/**
 * HTTP API 路由注册（/api/plugins/github-data-sync）。
 *
 * 固定协议（integration-contract.md API）：
 * - 成功统一 `{success:true,...}`，错误 `{success:false,code,error}`；
 * - 无 token、原始堆栈或系统路径；
 * - 无身份 → 401；未知请求字段 → 400；HTTP 绝不接受 handle/dataRoot/repoDir/tokenFile/remoteURL/env/command/offlineConfirmed。
 *
 * 宿主在 listen 前 mount 本路由，路径前缀由宿主决定；本模块只注册相对路径。
 */
const serviceMod = require('./service');

/** 错误响应（脱敏，无堆栈/绝对路径）。 */
function sendError(res, e, service) {
    const code = e && e.code ? e.code : 'UNKNOWN';
    const statusCode = e && e.statusCode ? e.statusCode : 500;
    const msg = service && typeof service._redactToken === 'function'
        ? service._redactToken('', e && e.message ? e.message : String(e))
        : (e && e.message ? e.message : String(e));
    res.status(statusCode).json({ success: false, code, error: msg });
}

/**
 * 注册路由。
 * @param {Object} router  宿主 router（或测试轻量 stub，提供 get/post/put 等）
 * @param {Object} service createService 返回的服务
 */
function registerRoutes(router, service) {
    const userOf = (req) => service.identityFromReq(req);
    const handle = (req) => {
        // 包装：解析身份失败抛 IntegrationError（401）
        return userOf(req);
    };

    router.get('/health', async (req, res) => {
        try {
            // 身份策略统一：health 也走无身份 401（contract 后端安全：无身份 401，不回退默认用户）。
            handle(req);
            res.json(await service.health());
        } catch (e) { sendError(res, e, service); }
    });

    router.get('/config', async (req, res) => {
        try {
            const user = handle(req);
            res.json(await service.getConfig(user));
        } catch (e) { sendError(res, e, service); }
    });

    router.put('/config', async (req, res) => {
        try {
            const user = handle(req);
            res.json(await service.putConfig(user, req.body || {}));
        } catch (e) { sendError(res, e, service); }
    });

    router.post('/connect', async (req, res) => {
        try {
            const user = handle(req);
            res.json(await service.connect(user, req.body || {}));
        } catch (e) { sendError(res, e, service); }
    });

    router.post('/push', async (req, res) => {
        try {
            const user = handle(req);
            res.json(await service.push(user, req.body || {}));
        } catch (e) { sendError(res, e, service); }
    });

    router.post('/pull', async (req, res) => {
        try {
            const user = handle(req);
            res.json(await service.pull(user, req.body || {}));
        } catch (e) { sendError(res, e, service); }
    });

    router.post('/schedule-apply', async (req, res) => {
        try {
            const user = handle(req);
            res.json(await service.scheduleApply(user, req.body || {}));
        } catch (e) { sendError(res, e, service); }
    });

    router.post('/cancel-apply', async (req, res) => {
        try {
            const user = handle(req);
            res.json(await service.cancelApply(user, req.body || {}));
        } catch (e) { sendError(res, e, service); }
    });

    router.get('/status', async (req, res) => {
        try {
            const user = handle(req);
            res.json(await service.status(user));
        } catch (e) { sendError(res, e, service); }
    });
}

module.exports = { registerRoutes, sendError };

'use strict';
/**
 * 酒管 GitHub 同步 · 服务端插件入口（v1.4.0-preview.1 设置向导 + 启动期应用）。
 *
 * 只导出 info / init / exit（integration-contract.md 后端）：
 * - init(router)：官方只传 router；registerRoutes + 启动期应用（显式安排才应用，fail-closed）。
 * - exit()：清定时器（自动检查默认关闭）。
 *
 * 旧版危险实现（push/pull/force/restore 在线写入口、明文 token、全局扫描用户）已整体移除，
 * 由 lib/integration/* 替代。
 */
const integration = require('./lib/integration');

let instance = null;

/**
 * 官方 loadPlugins 在 listen 之前 await init，但会吞掉 init 抛出的异常。
 * 因此「启动期应用存在 active manifest 且无法收敛」时不能只 throw —— 由 createPlugin.start()
 * 内部调用 failClosed 真正 process.exit 非零，阻止宿主继续启动。
 */
async function init(router) {
    instance = integration.createPlugin({ router });
    await instance.start();
}

async function exit() {
    if (instance) {
        try { await instance.stop(); } catch { /* 退出阶段忽略 */ }
    }
    instance = null;
}

module.exports = {
    info: integration.info,
    init,
    exit,
};

'use strict';
/**
 * 集成测试 · 故障子进程载体（由 test/integration-server.test.js spawn）。
 *
 * 用途：验证「启动期应用存在无法收敛的 active manifest / 无 intent 但有活动事务」时真正 process.exit 非零
 * （fail-closed）。官方 loader 会吞 init 抛出的异常，所以必须用真实子进程确认退出码。
 *
 * 用法：node test/integration-worker.js <runDir> <mode>
 *   mode = 'active-no-intent' | 'active-unresolved' | 'corrupt-intent-with-active' | 'enum-throws'
 * 退出码：70 表示 fail-closed 命中；71 表示未命中（异常）；72 表示未捕获异常。
 */

const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');

const integration = require(path.join(__dirname, '..', 'lib', 'integration'));
const stateCore = require(path.join(__dirname, '..', 'lib', 'reliable', 'state'));

async function main() {
    const runDir = path.resolve(process.argv[2]);
    const mode = process.argv[3] || 'active-no-intent';

    const storageBase = path.join(runDir, 'home', '.jiuguan-github-sync');
    const globalDataRoot = path.join(runDir, 'data-root');
    const handle = 'alice';
    const dataRoot = path.join(globalDataRoot, handle);

    fs.mkdirSync(path.join(dataRoot, 'chats', 'Actor'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'chats', 'Actor', 'a.jsonl'), JSON.stringify({ mes: 'seed' }) + '\n');

    // 轻量 router stub（生产 createPlugin 需要）
    const router = {
        get() {}, post() {}, put() {},
    };

    const plugin = integration.createPlugin({
        router,
        deps: {
            storageBase,
            dataRoot: globalDataRoot,
            hostRoot: runDir,
            getUsers: () => {
                if (mode === 'enum-throws') throw new Error('用户枚举失败（模拟宿主 users.js 加载异常）');
                return [{ handle, root: dataRoot }];
            },
            failClosed: (code) => { process.exit(code); },
            log: () => {},
        },
    });

    const service = plugin.service();
    await service.putConfig({ handle, dataRoot }, { githubRepo: 'owner/repo', branch: 'main' });

    const maint = await service._maintDir(await service._userDir(handle));
    await fs.ensureDir(maint);
    const identity = stateCore.bindTargetIdentity({ repo: 'owner/repo', branch: 'main', stDataRoot: dataRoot });

    // 合法 schema 的 active manifest（candidate/backup 指向不存在的文件 → recover 时无法收敛）。
    const manifest = {
        schemaVersion: stateCore.MANIFEST_SCHEMA_VERSION,
        runId: 'run-1',
        targetIdentity: identity,
        stageId: 'stage-1',
        remoteHead: '0'.repeat(40),
        createdAt: new Date().toISOString(),
        entries: [{
            rel: 'chats/Actor/a.jsonl',
            expectedBaselineHash: null,
            expectedLocalHash: 'a'.repeat(64),
            expectedLocalMissing: false,
            candidateHash: 'b'.repeat(64),
            candidatePath: 'stage/stage-1/missing.content',
            backupPath: 'backups/run-1/x.backup',
            backupHash: 'a'.repeat(64),
        }],
    };

    if (mode === 'active-no-intent') {
        // 有 active，但无 intent（无授权 recover）→ fail-closed
        await stateCore.writeApplyActive(maint, manifest);
    } else if (mode === 'active-unresolved') {
        // 有 active + 正确 intent，但 active 无法收敛（candidate/backup 缺失）→ fail-closed
        const state = {
            schemaVersion: stateCore.SCHEMA_VERSION,
            targetIdentity: identity,
            repo: 'owner/repo',
            branch: 'main',
            stDataRoot: dataRoot,
            remoteHead: null,
            baseline: {},
        };
        await stateCore.saveState(maint, state);
        await service._saveIntent(handle, {
            schemaVersion: 1,
            stageId: 'stage-1',
            targetIdentity: identity,
            digest: crypto.randomBytes(16).toString('hex'),
            entryCount: 1,
            clientsWillBeClosed: true,
            createdAt: new Date().toISOString(),
        });
        await stateCore.writeApplyActive(maint, manifest);
    } else if (mode === 'corrupt-intent-with-active') {
        // 损坏 intent（非 JSON）+ 有 active → fail-closed
        await stateCore.writeApplyActive(maint, manifest);
        const intentPath = path.join(await service._userDir(handle), 'intent.json');
        await fs.writeFile(intentPath, '{ not valid json');
    }

    // start()：注册路由 + 启动期应用；阻断 → failClosed(70)
    await plugin.start();

    // 走到这里说明未 fail-closed（异常）
    process.exit(71);
}

main().catch(err => {
    console.error('[integration-worker] 未捕获异常:', err && err.stack ? err.stack : err);
    process.exit(72);
});

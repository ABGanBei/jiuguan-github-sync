'use strict';

const state = require('../reliable/state');
const apply = require('../reliable/apply');

// Reuse the verified validators; never call applyStage or recover while online.
async function preflight(task) {
    const maint = state.getMaintDir(task.repoDir);
    await state.assertRepoDirReal(task.repoDir);
    await state.assertMaintDirChainReal(maint);
    const lock = await state.acquireLock(maint);
    let dataLock;
    try {
        dataLock = await state.acquireDataRootLock(task.dataRoot);
        if (await state.loadApplyActive(maint) || await state.loadPending(maint)) {
            throw Object.assign(new Error('有未完成事务，请先处理恢复提示。'), { code: 'NEEDS_OFFLINE_RECOVERY' });
        }
        const recoveryNeeded = await require('./startup').hasActiveOrIncompletePlan({
            _userDir: async () => task.repoDir,
            _maintDir: async () => maint,
        }, 'preview');
        if (recoveryNeeded) {
            throw Object.assign(new Error('有未完成的应用记录，请先离线恢复。'), { code: 'NEEDS_OFFLINE_RECOVERY' });
        }
        const saved = await state.loadState(maint);
        const stage = await state.loadStage(maint);
        if (!saved) throw Object.assign(new Error('请先完成连接设置。'), { code: 'NOT_INITIALIZED' });
        if (!stage) return { ready: false, stageId: null, files: [], checkedAt: new Date().toISOString() };
        const identity = state.bindTargetIdentity({ repo: task.githubRepo, branch: task.branch || 'main', stDataRoot: task.dataRoot });
        if (saved.targetIdentity !== identity) throw Object.assign(new Error('同步目标已变化，不能应用。'), { code: 'TARGET_MISMATCH' });
        await apply.precheckStage(saved, stage, maint, task.dataRoot, identity);
        return { ready: true, stageId: stage.runId, files: stage.entries.map(e => e.rel), checkedAt: new Date().toISOString() };
    } finally {
        if (dataLock) state.releaseDataRootLock(dataLock);
        await state.releaseLock(maint, lock);
    }
}

module.exports = { preflight };

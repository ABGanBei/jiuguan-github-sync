'use strict';
/**
 * 编排：把 scan / planner / git-tree / state / apply 串成 init/status/push/pull/apply/recover。
 *
 * 核心不变量（合同 + P1 初审 + P1 二检）：
 * - sync/push 只发布快照，pull 只暂存，两者都不写 data；
 * - pending 在 push 前保存完整【原字节快照路径+hash、原 B、L 快照 hash、H、目标身份、C】；
 * - 基线只在「已确认发布 / 成功 apply / L=R」时逐文件推进（ok 必须持久化共同 B）；
 * - 上传期间新增本地编辑不覆盖（B 最多推进到已发布快照）；
 * - planner 的 L 来自 scanLocal(keepBytes) 的**一次原字节读取**，hash 与 buf/快照一致；
 * - 构造 tree 固定单次读取 bytes 并传 hash（P1 二检第 4 条）：正常 push 传扫描 bytes+hash；
 *   recover 先读回校验原快照 bytes+publishHash 再交 git-tree，不二次读；
 * - 只有 status 免离线确认（init/recover 也要求离线，P1 二检第 5 条）；导出只暴露 run 与纯函数，
 *   cmd* 不导出以杜绝绕过锁（P1 二检第 5 条）；
 * - blocked pending 时 cmdPush 立即停，不继续计划覆盖 pending（P1 二检第 1 条）；
 * - replanFromPending 首次无 B（B=null）且远端已存在不同内容（R≠null）→ 阻断，不覆盖（P1 二检第 1 条）；
 * - cmdRecover 同时接入 pending 恢复与 apply 恢复（journal 活动事务 + 完成标志，P1 二检第 2 条）；
 * - status 明确 cached 来源，读错误不得用远端 0 伪装空（P1 二检第 5 条）。
 */
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const scan = require('./hash-scan');
const stateMod = require('./state');
const planner = require('./planner');
const gitTree = require('./git-tree');
const applyMod = require('./apply');

class ReliableError extends Error {
    constructor(message, code = 'RELIABLE_ERROR') {
        super(message);
        this.name = 'ReliableError';
        this.code = code;
    }
}

/** 维护配置：repo、branch、stDataRoot、commitAuthor、tokenFile。 */
function normalizeConfig(opts) {
    const repo = opts.githubRepo;
    const branch = opts.branch || 'main';
    if (!repo || typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
        throw new ReliableError('githubRepo 必须为 "用户名/仓库名"。', 'INVALID_CONFIG');
    }
    if (!branch || !/^[^\s~^:?*\[\\]+$/.test(branch)) {
        throw new ReliableError('branch 非法。', 'INVALID_CONFIG');
    }
    const stDataRoot = path.resolve(opts.dataRoot);
    const commitAuthor = opts.commitAuthor || { name: '酒管 Sync', email: 'st-sync@localhost' };
    const tokenFile = opts.tokenFile || '';
    return { githubRepo: repo, branch, stDataRoot, commitAuthor, tokenFile };
}

/** 打开维护目录上下文：校验 repoDir 是 git 仓库，maintDir = repoDir/.git/dsr。 */
function openMaint(repoDir) {
    const dotGit = path.join(repoDir, '.git');
    if (!fs.existsSync(dotGit)) {
        throw new ReliableError(`repoDir 不是 git 仓库（缺少 .git）: ${repoDir}`, 'NOT_A_REPO');
    }
    const maintDir = path.join(dotGit, 'dsr');
    return { repoDir: path.resolve(repoDir), maintDir };
}

/**
 * 离线确认 flag 校验（所有统一入口都走这里，不只 CLI）。
 * P1 二检第 5 条：只有 status 免离线确认；init/recover 也要求离线。
 */
function requireOffline(opts, command) {
    if (command === 'status') return;
    if (opts.offlineConfirmed !== true) {
        throw new ReliableError(
            `${command} 要求显式声明已停止服务并关闭所有客户端：请加 --offline-confirmed（每次运行都要重新声明，该声明不是软件证明，由操作人负责保证）。`,
            'OFFLINE_NOT_CONFIRMED'
        );
    }
}

/** 目标身份校验。 */
function assertIdentity(state, identity) {
    if (state.targetIdentity !== identity) {
        throw new ReliableError('目标身份与已初始化状态不符，需重新 init。', 'IDENTITY_CHANGED');
    }
}

/**
 * 一次读取 L 表并保证 hash 与 bytes 一致（P1 第 4 条）。
 */
async function scanLocalConsistent(stDataRoot) {
    const map = await scan.scanLocal(stDataRoot, { keepBytes: true });
    const out = new Map();
    for (const [rel, entry] of map) {
        if (!entry || !Buffer.isBuffer(entry.bytes)) {
            throw new ReliableError(`scanLocal 未返回一次读取的 bytes（keepBytes 缺失）: ${rel}`, 'SCAN_INCONSISTENT');
        }
        const recomputed = crypto.createHash('sha256').update(entry.bytes).digest('hex');
        if (entry.hash && entry.hash !== recomputed) {
            throw new ReliableError(`scanLocal hash 与 bytes 不一致: ${rel}`, 'SCAN_INCONSISTENT');
        }
        out.set(rel, { hash: recomputed, size: entry.bytes.length, bytes: entry.bytes });
    }
    return out;
}

/**
 * init：仅本地初始化，不写远端。写入目标身份与空基线。
 * 已有状态：目标身份变化 → 拒绝；相同身份 → 幂等返回（不覆盖）。
 */
async function cmdInit(opts) {
    requireOffline(opts, 'init');
    const { repoDir, maintDir } = openMaint(opts.repoDir);
    const cfg = normalizeConfig(opts);
    const identity = stateMod.bindTargetIdentity({ repo: cfg.githubRepo, branch: cfg.branch, stDataRoot: cfg.stDataRoot });

    const existing = await stateMod.loadState(maintDir);
    if (existing && existing.targetIdentity !== identity) {
        throw new ReliableError(
            `目标身份已变化（旧: ${existing.repo}@${existing.branch} → 新: ${cfg.githubRepo}@${cfg.branch}），需重新初始化，不得复用旧基线。`,
            'IDENTITY_CHANGED'
        );
    }
    if (existing) {
        return { initialized: false, identity, message: '已初始化（身份一致，基线保留）。' };
    }

    const state = {
        schemaVersion: stateMod.SCHEMA_VERSION,
        targetIdentity: identity,
        repo: cfg.githubRepo,
        branch: cfg.branch,
        stDataRoot: cfg.stDataRoot,
        remoteHead: null,
        baseline: {},
    };
    await stateMod.saveState(maintDir, state);
    return { initialized: true, identity, message: '本地已初始化（仅本地，未写远端）。' };
}

/** 读取状态，未初始化则报错。 */
async function requireState(maintDir) {
    const state = await stateMod.loadState(maintDir);
    if (!state) {
        throw new ReliableError('尚未初始化，请先运行 init。', 'NOT_INITIALIZED');
    }
    return state;
}

/** 安全解析 chats 下 rel 到数据根下绝对路径（复用 hash-scan，越界阻断）。 */
function resolveUnderDataRootSafe(stDataRoot, rel) {
    return scan.resolveUnderDataRoot(stDataRoot, rel);
}

/**
 * 判定 commitId 是否在远端分支可达（自实现，不依赖 git-tree.isAncestorOfRemote）。
 * 正确做法：fetch 后取 merge-base(commitId, origin/branch)，可达当且仅当 == commitId。
 */
async function isAncestorOfRemoteSafe(cfg, repoDir, commitId) {
    await gitTree.fetchRemote(cfg, repoDir);
    const git = gitTree.reliableGit(repoDir, cfg);
    try {
        const mb = String(await git.raw(['merge-base', commitId, `refs/remotes/origin/${cfg.branch}`]) || '').trim();
        return mb === commitId;
    } catch {
        return false;
    }
}

/**
 * push：fetch 固定 H → plan → 对 publish 集合构造 tree → 写 pending（含完整快照）→ commit → push → 确认 → 推进 B。
 * 先恢复未知 pending；若 pending 阻断（无法确认），立即停，不继续计划覆盖 pending（P1 二检第 1 条）。
 */
async function cmdPush(opts) {
    requireOffline(opts, 'push');
    const { repoDir, maintDir } = openMaint(opts.repoDir);
    const cfg = normalizeConfig(opts);
    const identity = stateMod.bindTargetIdentity({ repo: cfg.githubRepo, branch: cfg.branch, stDataRoot: cfg.stDataRoot });
    const state = await requireState(maintDir);
    assertIdentity(state, identity);

    // 先恢复未知 pending（合同第 20/21 条）；阻断则立即停，不得覆盖 pending。
    const pendRec = await recoverPending(maintDir, cfg, state, repoDir, identity);
    if (pendRec && pendRec.result === 'blocked') {
        throw new ReliableError(`存在无法确认的 pending，已阻断 push: ${pendRec.message}`, 'PENDING_BLOCKED');
    }

    // 处理或阻断活动 apply 事务（P1 三次第 19 条：新操作前不绕过 active）
    await recoverOrBlockApply(cfg.stDataRoot, maintDir);

    // 重新读 state（recover 可能推进了 B 并清除 pending）
    const state2 = await requireState(maintDir);

    // fetch 固定 H
    const H = await gitTree.fetchRemote(cfg, repoDir);

    // L / R：L 用一次读取的 bytes（hash 一致），R 来自固定 H 的 tree
    const localMap = await scanLocalConsistent(cfg.stDataRoot);
    const remoteMap = await gitTree.remoteHashesAt(repoDir, H);

    // plan
    const { actions } = planner.plan({ state: state2, localHashes: localMap, remoteHashes: remoteMap, remoteHead: H });

    const publishActions = actions.filter(a => a.kind === 'publish');
    const stageActions = actions.filter(a => a.kind === 'stage');
    const conflictActions = actions.filter(a => a.kind === 'conflict');
    const deleteActions = actions.filter(a => a.kind === 'delete-pending');
    const okActions = actions.filter(a => a.kind === 'ok');

    // 有删除待处理：阻断（不传播删除）
    if (deleteActions.length > 0) {
        throw new ReliableError(
            `存在删除待处理，已阻断（不传播删除）: ${deleteActions.map(a => a.rel).join(', ')}`,
            'DELETE_PENDING'
        );
    }

    // ok（L=R 验证一致）：立即推进 B = L（合同第 16 条 / P1 第 1 条），无需 push
    let baselineNow = { ...state2.baseline };
    if (okActions.length > 0) {
        const now = new Date().toISOString();
        for (const a of okActions) {
            baselineNow[a.rel] = { hash: a.localHash, setAt: now };
        }
    }

    // conflict：写双方快照（用 localMap 里一次读取的 bytes 作为本地内容，不重读）
    const conflicts = [];
    for (const a of conflictActions) {
        const localEntry = localMap.get(a.rel);
        const localBuf = localEntry ? localEntry.bytes : null;
        const remoteBuf = await gitTree.readRemoteBlob(repoDir, H, a.rel);
        if (remoteBuf === null) {
            throw new ReliableError(`远端 blob 读取失败（非缺失）: ${a.rel}`, 'REMOTE_BLOB_ERROR');
        }
        if (localBuf === null) {
            throw new ReliableError(`本地内容缺失却进入冲突: ${a.rel}`, 'SCAN_INCONSISTENT');
        }
        const snap = await stateMod.writeConflictSnapshot(maintDir, a.rel, localBuf, remoteBuf);
        conflicts.push({ rel: a.rel, localHash: a.localHash, remoteHash: a.remoteHash, localPath: snap.localAbs, remotePath: snap.remoteAbs });
    }

    // 若无 publish：只报告 stage/conflict，不构造 tree、不 push；但仍推进 ok 的 B
    if (publishActions.length === 0) {
        if (okActions.length > 0) {
            const stateN = await requireState(maintDir);
            stateN.baseline = baselineNow;
            stateN.remoteHead = H;
            await stateMod.saveState(maintDir, stateN);
        }
        return {
            pushed: false,
            published: [],
            staged: stageActions.map(a => ({ rel: a.rel, remoteHash: a.remoteHash })),
            conflicts,
            deletePending: [],
            remoteHead: H,
        };
    }

    // 构造快照目录（push 前保存完整快照，合同第 21 条）
    const runId = applyMod.makeRunId();
    const snapshotDir = path.join(maintDir, 'snapshots', runId);
    await stateMod.safeEnsureDir(snapshotDir);
    const edits = [];
    const pendingEdits = [];
    for (const a of publishActions) {
        const localEntry = localMap.get(a.rel);
        if (!localEntry || !localEntry.bytes) {
            throw new ReliableError(`publish 文件一次读取的 bytes 缺失: ${a.rel}`, 'SCAN_INCONSISTENT');
        }
        const buf = localEntry.bytes; // 一次读取的原始字节，hash 与快照一致
        const base = stateMod.fileKeyForRel(a.rel);
        const snapRel = `${base}.snapshot`;
        const snapAbs = path.join(snapshotDir, snapRel);
        await stateMod.atomicWriteBytes(snapAbs, buf);
        // P1 二检第 4 条：构造 tree 固定单次 bytes + hash；snapshotPath 为 maintDir 内相对路径。
        edits.push({ rel: a.rel, bytes: buf, hash: a.localHash });
        pendingEdits.push({
            rel: a.rel,
            originalHash: a.localHash,                 // 原字节快照 hash（发布内容）
            publishHash: a.localHash,
            originalBaselineHash: a.baselineHash,       // 原 B
            localSnapshotHash: a.localHash,             // L 快照 hash
            snapshotPath: `snapshots/${runId}/${snapRel}`, // maintDir 内相对路径（非绝对）
            absTargetPath: resolveUnderDataRootSafe(cfg.stDataRoot, a.rel),
        });
    }

    // 构造 tree + commit
    const { treeId } = await gitTree.buildTreeFromRemote(cfg, repoDir, H, edits);
    const commitId = await gitTree.commitTree(cfg, repoDir, treeId, H, `sync: ${new Date().toISOString()}`);

    // 写 pending（含完整快照信息，phase=committed）
    const pending = {
        runId,
        remoteHead: H,
        targetIdentity: identity,
        treeId,
        commitId,
        phase: 'committed',
        edits: pendingEdits,
        createdAt: new Date().toISOString(),
    };
    await stateMod.writePending(maintDir, pending);

    // push
    try {
        await gitTree.pushBranch(cfg, repoDir, commitId);
    } catch (e) {
        // push 失败：保留 pending（含快照），抛错让 recover 处理
        throw e;
    }

    // 确认可达（fetch 后 merge-base --is-ancestor）
    const reachable = await isAncestorOfRemoteSafe(cfg, repoDir, commitId);
    if (!reachable) {
        throw new ReliableError('推送后确认提交在远端分支可达性失败，pending 已保留，请运行 recover。', 'CONFIRM_LOST');
    }

    // 推进 B（逐文件）：以 baselineNow（含 ok 推进）为基础，叠加 publish
    const state3 = await requireState(maintDir);
    const baseline = { ...baselineNow };
    const now = new Date().toISOString();
    for (const a of publishActions) {
        baseline[a.rel] = { hash: a.localHash, setAt: now };
    }
    state3.baseline = baseline;
    state3.remoteHead = commitId;
    await stateMod.saveState(maintDir, state3);

    // 清除 pending
    await stateMod.clearPending(maintDir);

    return {
        pushed: true,
        published: publishActions.map(a => a.rel),
        staged: stageActions.map(a => ({ rel: a.rel, remoteHash: a.remoteHash })),
        conflicts,
        deletePending: [],
        remoteHead: commitId,
    };
}

/**
 * pull：fetch 固定 H → plan → 对 stage 集合写候选快照（只暂存，不写 data）。
 * 先恢复/阻断 pending（P1 第 5 条：pull/apply 不能跨越未知发布）。
 */
async function cmdPull(opts) {
    requireOffline(opts, 'pull');
    const { repoDir, maintDir } = openMaint(opts.repoDir);
    const cfg = normalizeConfig(opts);
    const identity = stateMod.bindTargetIdentity({ repo: cfg.githubRepo, branch: cfg.branch, stDataRoot: cfg.stDataRoot });
    const state = await requireState(maintDir);
    assertIdentity(state, identity);

    // 先恢复未知 pending（若有，先判定，不得跨越未知发布）
    const pendRec = await recoverPending(maintDir, cfg, state, repoDir, identity);
    if (pendRec && pendRec.result === 'blocked') {
        throw new ReliableError(`存在无法确认的 pending，已阻断 pull: ${pendRec.message}`, 'PENDING_BLOCKED');
    }

    // 处理或阻断活动 apply 事务（P1 三次第 19 条）
    await recoverOrBlockApply(cfg.stDataRoot, maintDir);

    const state2 = await requireState(maintDir);

    const H = await gitTree.fetchRemote(cfg, repoDir);
    const localMap = await scanLocalConsistent(cfg.stDataRoot);
    const remoteMap = await gitTree.remoteHashesAt(repoDir, H);

    const { actions } = planner.plan({ state: state2, localHashes: localMap, remoteHashes: remoteMap, remoteHead: H });
    const stageActions = actions.filter(a => a.kind === 'stage');
    const conflictActions = actions.filter(a => a.kind === 'conflict');
    const deleteActions = actions.filter(a => a.kind === 'delete-pending');
    const okActions = actions.filter(a => a.kind === 'ok');

    if (deleteActions.length > 0) {
        throw new ReliableError(`存在删除待处理，已阻断: ${deleteActions.map(a => a.rel).join(', ')}`, 'DELETE_PENDING');
    }

    // ok（L=R）：推进 B（pull 侧也确认共同内容，合同第 16 条）
    if (okActions.length > 0) {
        const stateN = await requireState(maintDir);
        const baseline = { ...stateN.baseline };
        const now = new Date().toISOString();
        for (const a of okActions) baseline[a.rel] = { hash: a.localHash, setAt: now };
        stateN.baseline = baseline;
        stateN.remoteHead = H;
        await stateMod.saveState(maintDir, stateN);
    }

    // 冲突：写快照并报告（pull 阶段不写本地）
    const conflicts = [];
    for (const a of conflictActions) {
        const localEntry = localMap.get(a.rel);
        const localBuf = localEntry ? localEntry.bytes : null;
        const remoteBuf = await gitTree.readRemoteBlob(repoDir, H, a.rel);
        if (remoteBuf === null) {
            throw new ReliableError(`远端 blob 读取失败（非缺失）: ${a.rel}`, 'REMOTE_BLOB_ERROR');
        }
        if (localBuf === null) {
            throw new ReliableError(`本地内容缺失却进入冲突: ${a.rel}`, 'SCAN_INCONSISTENT');
        }
        const snap = await stateMod.writeConflictSnapshot(maintDir, a.rel, localBuf, remoteBuf);
        conflicts.push({ rel: a.rel, localPath: snap.localAbs, remotePath: snap.remoteAbs });
    }

    if (stageActions.length === 0) {
        return { staged: [], conflicts, remoteHead: H, message: '无待暂存的远端更新。' };
    }

    // 写候选快照
    const runId = applyMod.makeRunId();
    const stageDir = path.join(maintDir, 'stage', runId);
    await stateMod.safeEnsureDir(stageDir);
    const entries = [];
    for (const a of stageActions) {
        const remoteBuf = await gitTree.readRemoteBlob(repoDir, H, a.rel);
        if (remoteBuf === null) {
            throw new ReliableError(`远端 blob 读取失败（非缺失）: ${a.rel}`, 'REMOTE_BLOB_ERROR');
        }
        const base = stateMod.fileKeyForRel(a.rel);
        const candRel = `${base}.content`;
        const candAbs = path.join(stageDir, candRel);
        await stateMod.atomicWriteBytes(candAbs, remoteBuf);
        entries.push({
            rel: a.rel,
            expectedBaselineHash: a.baselineHash,   // 可为 null（首次 R-only）
            expectedLocalHash: a.localHash,          // 可为 null（本地缺失）
            expectedLocalMissing: a.lMissing,
            candidateHash: a.remoteHash,
            candidatePath: `stage/${runId}/${candRel}`,
            remoteCommit: H,
        });
    }

    const stage = {
        runId,
        remoteHead: H,
        targetIdentity: identity,
        entries,
        createdAt: new Date().toISOString(),
    };
    await stateMod.writeStage(maintDir, stage);

    return {
        staged: entries.map(e => e.rel),
        conflicts,
        remoteHead: H,
        stageId: runId,
        message: '远端更新已暂存（未写入本地聊天），请停止服务并关闭客户端后运行 apply --offline-confirmed。',
    };
}

/**
 * apply：离线确认 → 先恢复/阻断 pending → precheck → backup → 逐文件原子替换 → journal → 推进 B → 清 stage + 完成标志。
 * 状态保存成功后才写完成标志并清 stage（可重复恢复，P1 二检第 6 条）。
 */
async function cmdApply(opts) {
    requireOffline(opts, 'apply');
    const { repoDir, maintDir } = openMaint(opts.repoDir);
    const cfg = normalizeConfig(opts);
    const identity = stateMod.bindTargetIdentity({ repo: cfg.githubRepo, branch: cfg.branch, stDataRoot: cfg.stDataRoot });
    const state = await requireState(maintDir);
    assertIdentity(state, identity);

    // 先恢复/阻断 pending（P1 第 5 条）
    const pendRec = await recoverPending(maintDir, cfg, state, repoDir, identity);
    if (pendRec && pendRec.result === 'blocked') {
        throw new ReliableError(`存在无法确认的 pending，已阻断 apply: ${pendRec.message}`, 'PENDING_BLOCKED');
    }

    // 先处理未完成 apply 事务（若有阻断项则停）
    await recoverOrBlockApply(cfg.stDataRoot, maintDir);

    const state2 = await requireState(maintDir);

    const stage = await stateMod.loadStage(maintDir);
    if (!stage) {
        throw new ReliableError('没有待应用的暂存（请先 pull）。', 'NO_STAGE');
    }
    if (opts.stageId && stage.runId !== opts.stageId) {
        throw new ReliableError(`指定的 stage-id 与当前暂存不匹配。`, 'STAGE_ID_MISMATCH');
    }

    const result = await applyMod.applyStage(state2, stage, maintDir, cfg.stDataRoot, {
        offlineConfirmed: true,
        targetIdentity: identity,
    });

    // 推进 B（逐文件）
    const state3 = await requireState(maintDir);
    const baseline = { ...state3.baseline };
    const now = new Date().toISOString();
    for (const rel of result.applied) {
        const entry = stage.entries.find(e => e.rel === rel);
        baseline[rel] = { hash: entry.candidateHash, setAt: now };
    }
    state3.baseline = baseline;
    state3.remoteHead = stage.remoteHead;
    await stateMod.saveState(maintDir, state3);

    // 状态保存成功后（P1 三复审第 1 项）：先清所属 stage（仅 stageId 匹配）→ 写完成标志(fsync) → 最后清 active manifest。
    // 顺序与 recover 路径一致：完成标志先落盘，确保「active 仍存在但已完成」可被 recover 幂等收敛，
    // 不制造「无 manifest 但有未 complete 日志」的阻断态。
    await clearStageIfMatch(maintDir, stage.runId);
    await stateMod.appendApplyComplete(maintDir, result.runId); // journal 审计完成标志（fsync）
    await stateMod.clearApplyActive(maintDir);

    return { applied: result.applied, backupDir: result.backupDir, message: `已应用 ${result.applied.length} 个文件。` };
}

/**
 * status：只读输出 B/L/R 摘要与 pending/stage/active 状态。
 * P1 三次第 10 条：只读 refs/remotes（不 fetch），必须总标 cached；出错 remoteCount 为 null（明确
 * unknown），不得用 live/0 伪装空。
 */
async function cmdStatus(opts) {
    const { repoDir, maintDir } = openMaint(opts.repoDir);
    const cfg = normalizeConfig(opts);
    const identity = stateMod.bindTargetIdentity({ repo: cfg.githubRepo, branch: cfg.branch, stDataRoot: cfg.stDataRoot });
    const state = await requireState(maintDir);

    let H = state.remoteHead;
    const remoteHeadSource = 'cached'; // 恒 cached：不 fetch（P1 三次第 10 条）
    let remoteMap = new Map();
    let remoteError = null;
    let remoteCount = null; // 读取失败时 unknown（null），不伪装 0
    try {
        // 只读 refs/remotes，不 fetch
        H = await gitTree.resolveRemoteHead(cfg, repoDir);
        remoteMap = await gitTree.remoteHashesAt(repoDir, H);
        remoteCount = remoteMap.size;
    } catch (e) {
        // 远端读取失败：如实暴露，不回退成「空远端」伪装；remoteHead 保持缓存的 state.remoteHead。
        remoteError = e.code || 'REMOTE_ERROR';
        H = state.remoteHead;
        remoteCount = null;
    }
    const localMap = await scanLocalConsistent(cfg.stDataRoot);
    const pending = await stateMod.loadPending(maintDir);
    const stage = await stateMod.loadStage(maintDir);
    const active = await stateMod.loadApplyActive(maintDir);

    return {
        initialized: true,
        identity: state.targetIdentity === identity ? 'ok' : 'mismatch',
        remoteHead: H,
        remoteHeadSource,
        remoteError,
        pending: pending ? { runId: pending.runId, phase: pending.phase, edits: pending.edits.map(e => e.rel) } : null,
        stage: stage ? { runId: stage.runId, entries: stage.entries.map(e => e.rel) } : null,
        activeApply: active ? { runId: active.runId, stageId: active.stageId, entries: active.entries.map(e => e.rel) } : null,
        fileCount: { local: localMap.size, remote: remoteCount, baseline: Object.keys(state.baseline).length },
    };
}

/**
 * recover：恢复未知 pending（优先），再按 journal 恢复未完成 apply 事务。
 * 需要离线确认（P1 二检第 5 条）。
 */
async function cmdRecover(opts) {
    requireOffline(opts, 'recover');
    const { repoDir, maintDir } = openMaint(opts.repoDir);
    const cfg = normalizeConfig(opts);
    const identity = stateMod.bindTargetIdentity({ repo: cfg.githubRepo, branch: cfg.branch, stDataRoot: cfg.stDataRoot });
    const state = await requireState(maintDir);
    assertIdentity(state, identity);

    // 1) 恢复 pending
    const pendRec = await recoverPending(maintDir, cfg, state, repoDir, identity);

    // 2) 恢复 apply（未完成事务）
    const applyRec = await recoverOrBlockApply(cfg.stDataRoot, maintDir, true /* return detail */);

    return {
        pending: pendRec,
        apply: applyRec,
    };
}

/**
 * 清 stage，但仅当当前 stage.runId 与给定 stageId 匹配（P1 三次第 16 条：不能清掉与当前事务不匹配的 stage）。
 */
async function clearStageIfMatch(maintDir, stageId) {
    const stage = await stateMod.loadStage(maintDir);
    if (stage && stage.runId === stageId) {
        await stateMod.clearStage(maintDir);
    }
}

/**
 * 处理或阻断活动 apply 事务（P1 三次第 16/18/19 条）：所有 push/pull/apply 在新操作前先调用。
 * - 有活动 manifest（active）→ 尝试恢复；若存在阻断项（第三值/一致性）则抛错阻断后续操作；
 * - 无活动 manifest → 无操作。
 *
 * 恢复基于完整 manifest（非半 journal）：
 * - current == candidate → 已应用 → 推进 B；
 * - current == expected → 待应用 → 从候选快照重试 rename（每次 rename 前重新 CAS + 祖先检查）；
 * - 第三种值 → 阻断，保留双方，不覆盖；
 * 全部落地后：先原子落 B，再清所属 stage，最后清 active manifest（可重复恢复）。
 * @returns {Promise<{appliedRels, retriedRels, blockedRels, activeRunIds}>}
 */
async function recoverOrBlockApply(stDataRoot, maintDir, returnDetail = false) {
    const state = await requireState(maintDir);
    const rec = await applyMod.recoverApply(state, maintDir, stDataRoot);

    // 无活动事务：不做任何事（不清 stage、不写完成标志），直接返回。
    if (rec.activeRunIds.size === 0) {
        const detail = { appliedRels: [], retriedRels: [], blockedRels: [], activeRunIds: [], blocked: false };
        return returnDetail ? detail : detail;
    }

    const manifest = rec.manifest;
    const runId = manifest.runId;

    if (rec.blockedRels.length > 0) {
        // 阻断：不推进 B、不清 stage、不清 active，保留双方。
        const err = new ReliableError(
            `apply 恢复时发现无法确认的内容（保留双方，不覆盖）: ${rec.blockedRels.map(b => `${b.rel}(reason=${b.reason || 'third-value'}, current=${b.currentHash || 'missing'})`).join(', ')}`,
            'APPLY_RECOVERY_BLOCKED'
        );
        if (returnDetail) {
            return { appliedRels: rec.appliedRels, retriedRels: [], blockedRels: rec.blockedRels, activeRunIds: [...rec.activeRunIds], blocked: true, message: err.message };
        }
        throw err;
    }

    // 待应用项：从候选快照重试（每次 rename 前重新 CAS + 祖先检查）
    const toRetry = manifest.entries.filter(e => rec.pendingRels.includes(e.rel));
    const retriedRels = toRetry.length > 0
        ? await applyMod.retryApplyPending(maintDir, stDataRoot, runId, toRetry)
        : [];

    // 推进 B（已应用 + 重试成功）
    const appliedSet = new Set([...rec.appliedRels, ...retriedRels]);
    if (appliedSet.size > 0) {
        const state2 = await requireState(maintDir);
        const baseline = { ...state2.baseline };
        const now = new Date().toISOString();
        for (const rel of appliedSet) {
            const entry = manifest.entries.find(e => e.rel === rel);
            if (entry) baseline[rel] = { hash: entry.candidateHash, setAt: now };
        }
        state2.baseline = baseline;
        state2.remoteHead = manifest.remoteHead;
        await stateMod.saveState(maintDir, state2);
    }

    // 状态保存成功后（P1 三复审第 1 项，与 cmdApply 同序）：清所属 stage（仅 stageId 匹配）→ 写完成标志(fsync) → 最后清 active。
    await clearStageIfMatch(maintDir, manifest.stageId);
    await stateMod.appendApplyComplete(maintDir, runId);
    await stateMod.clearApplyActive(maintDir);

    const detail = { appliedRels: rec.appliedRels, retriedRels, blockedRels: rec.blockedRels, activeRunIds: [...rec.activeRunIds], blocked: false };
    return returnDetail ? detail : detail;
}

/**
 * 恢复 pending（核心，合同第 20/21 条 + P1 第 5 条 + P1 二检第 1 条）：
 * 1. 无 pending → 无待恢复；
 * 2. pending 有 commitId：判定 commit 是否在远端分支可达；
 *    - 可达 → 视为已发布，逐文件推进 B（按 pending.edits 里存下的原快照 hash），清 pending；
 *    - 不可达 → 重新 fetch 得新 H′，用【原快照 / 原 B / 新 R】三方重计划（不读实时 L），
 *      仍失败则阻断保留双方；
 * 3. pending 无 commitId（built）：重新 fetch，H′==H 则重放，否则重计划。
 * 禁止覆盖原 pending 快照；禁止 clearPending 后递归 cmdPush。
 */
async function recoverPending(maintDir, cfg, state, repoDir, identity) {
    const pending = await stateMod.loadPending(maintDir);
    if (!pending) return { recovered: false, message: '无待恢复的 pending。' };

    if (pending.targetIdentity !== identity) {
        throw new ReliableError('pending 目标身份与当前状态不符，禁止恢复。', 'IDENTITY_CHANGED');
    }

    // 快照读回校验（P1 二检第 3 条）：恢复前确认原快照仍在且内容哈希 == publishHash。
    await stateMod.verifyPendingSnapshots(maintDir, pending);

    const H2 = await gitTree.fetchRemote(cfg, repoDir);

    if (pending.commitId) {
        const reachable = await isAncestorOfRemoteSafe(cfg, repoDir, pending.commitId);
        if (reachable) {
            const baseline = { ...state.baseline };
            const now = new Date().toISOString();
            for (const e of pending.edits) {
                baseline[e.rel] = { hash: e.publishHash, setAt: now };
            }
            state.baseline = baseline;
            state.remoteHead = pending.commitId;
            await stateMod.saveState(maintDir, state);
            await stateMod.clearPending(maintDir);
            return { recovered: true, result: 'published', published: pending.edits.map(e => e.rel) };
        }
        // 不可达：远端已变或推送从未成功 → 用原快照/原 B/新 R 三方重计划
        const rep = await replanFromPending(maintDir, cfg, state, repoDir, identity, pending, H2);
        if (rep.blocked) {
            return { recovered: false, result: 'blocked', message: rep.message };
        }
        return rep.result;
    }

    // built：无 commitId → 重新 fetch，H′==H 则重放，否则重计划
    if (H2 === pending.remoteHead) {
        const edits = await editsFromPendingSnapshots(maintDir, pending);
        const { treeId } = await gitTree.buildTreeFromRemote(cfg, repoDir, H2, edits);
        const commitId = await gitTree.commitTree(cfg, repoDir, treeId, H2, `sync: recover ${pending.runId}`);
        const pending2 = { ...pending, remoteHead: H2, treeId, commitId, phase: 'committed' };
        await stateMod.writePending(maintDir, pending2);
        try {
            await gitTree.pushBranch(cfg, repoDir, commitId);
        } catch (e) {
            throw e;
        }
        const reachable = await isAncestorOfRemoteSafe(cfg, repoDir, commitId);
        if (!reachable) {
            throw new ReliableError('恢复推送后确认失败，pending 已保留。', 'CONFIRM_LOST');
        }
        const baseline = { ...state.baseline };
        const now = new Date().toISOString();
        for (const e of pending.edits) baseline[e.rel] = { hash: e.publishHash, setAt: now };
        state.baseline = baseline;
        state.remoteHead = commitId;
        await stateMod.saveState(maintDir, state);
        await stateMod.clearPending(maintDir);
        return { recovered: true, result: 'replayed', published: pending.edits.map(e => e.rel) };
    }
    // H′ != H：重计划（用原快照/原 B/新 R）
    const rep = await replanFromPending(maintDir, cfg, state, repoDir, identity, pending, H2);
    if (rep.blocked) {
        return { recovered: false, result: 'blocked', message: rep.message };
    }
    return rep.result;
}

/**
 * 从 pending 的原快照构造 edits：读回校验原快照 bytes + publishHash，交 git-tree（固定单次 bytes + hash）。
 */
async function editsFromPendingSnapshots(maintDir, pending) {
    const edits = [];
    for (const e of pending.edits) {
        const buf = await stateMod.readVerifiedSnapshot(maintDir, e.snapshotPath, e.publishHash, 'pending.edits[].snapshotPath');
        edits.push({ rel: e.rel, bytes: buf, hash: e.publishHash });
    }
    return edits;
}

/**
 * 用 pending 原快照 / 原 B / 新远端 R 做三方重计划（P1 第 5 条 + P1 二检第 1 条）：
 * 不读实时 L；不 clearPending 后递归；对无法确认内容明确保留（blocked）。
 *
 * 三方语义：原承诺快照（snapshotPath 字节 hash = publishHash）相当于「L 快照」，
 * 原 B（originalBaselineHash）相当于基线，新远端 R 相当于 R。
 * - 新 R == 原快照 → 视为已发布，推进 B；
 * - 新 R == 原 B（远端未变）→ 可重新发布原快照；首次无 B（B=null）须 R 仍缺失（R=null）才可重发；
 * - 其它 → 无法自动选择，阻断保留双方（尤其首次无 B 且远端已有不同内容，绝不覆盖）。
 */
async function replanFromPending(maintDir, cfg, state, repoDir, identity, pending, H2) {
    const remoteMap = await gitTree.remoteHashesAt(repoDir, H2);
    const toPublish = [];
    const publishedRels = [];
    const blockedRels = [];

    for (const e of pending.edits) {
        // 原快照已在 recoverPending 入口经 verifyPendingSnapshots 读回校验（内容 == publishHash）。
        // 这里只需比较 hash；真正重建 tree 时（toPublish 分支）再读回一次拿 bytes。
        const R = remoteMap.get(e.rel) ? remoteMap.get(e.rel).hash : null;
        const B = e.originalBaselineHash; // 可为 null（首次发布）

        if (R === e.publishHash) {
            // 远端已是原快照内容 → 视为已发布，推进 B
            publishedRels.push({ rel: e.rel, hash: e.publishHash });
        } else if ((B === null && R === null) || (B !== null && R === B)) {
            // 远端未变（首次无 B 且远端仍缺失；或已有 B 且 R==B）→ 可重新发布原快照
            toPublish.push(e);
        } else {
            // 远端又变（第三种值），含「首次无 B 但远端已有不同内容」→ 阻断保留双方
            blockedRels.push({ rel: e.rel, reason: 'remote-diverged', remoteHash: R });
        }
    }

    if (blockedRels.length > 0) {
        return {
            blocked: true,
            message: `恢复时发现无法确认的内容（保留双方，不清 pending）: ${blockedRels.map(b => `${b.rel}(${b.reason})`).join(', ')}`,
        };
    }

    // 先推进「已发布」的 B（R==publishHash）
    if (publishedRels.length > 0) {
        const baseline = { ...state.baseline };
        const now = new Date().toISOString();
        for (const p of publishedRels) baseline[p.rel] = { hash: p.hash, setAt: now };
        state.baseline = baseline;
    }

    if (toPublish.length === 0) {
        state.remoteHead = H2;
        await stateMod.saveState(maintDir, state);
        await stateMod.clearPending(maintDir);
        return { blocked: false, result: { recovered: true, result: 'replanned-published', published: publishedRels.map(p => p.rel) } };
    }

    // 有待重发：用原快照（读回校验 bytes+publishHash）重建 tree + commit + push（新父 H2）
    const edits = [];
    for (const e of toPublish) {
        const buf = await stateMod.readVerifiedSnapshot(maintDir, e.snapshotPath, e.publishHash, 'pending.edits[].snapshotPath');
        edits.push({ rel: e.rel, bytes: buf, hash: e.publishHash });
    }
    const { treeId } = await gitTree.buildTreeFromRemote(cfg, repoDir, H2, edits);
    const commitId = await gitTree.commitTree(cfg, repoDir, treeId, H2, `sync: recover ${pending.runId}`);

    const pending2 = {
        runId: pending.runId,
        remoteHead: H2,
        targetIdentity: identity,
        treeId,
        commitId,
        phase: 'committed',
        edits: toPublish.map(e => ({ ...e })),
        createdAt: pending.createdAt,
    };
    await stateMod.writePending(maintDir, pending2);

    try {
        await gitTree.pushBranch(cfg, repoDir, commitId);
    } catch (e) {
        throw e;
    }
    const reachable = await isAncestorOfRemoteSafe(cfg, repoDir, commitId);
    if (!reachable) {
        throw new ReliableError('恢复推送后确认失败，pending 已保留。', 'CONFIRM_LOST');
    }

    const baseline = { ...state.baseline };
    const now = new Date().toISOString();
    for (const e of toPublish) baseline[e.rel] = { hash: e.publishHash, setAt: now };
    state.baseline = baseline;
    state.remoteHead = commitId;
    await stateMod.saveState(maintDir, state);
    await stateMod.clearPending(maintDir);

    return { blocked: false, result: { recovered: true, result: 'replanned', published: toPublish.map(e => e.rel) } };
}

/** 统一入口：在锁内分发命令。 */
async function run(opts) {
    const { repoDir, maintDir } = openMaint(opts.repoDir);
    const cfg = normalizeConfig(opts);

    // 锁创建前验证并安全逐段创建 repo/.git/dsr 全链（P1 三复审第 2 项：不只是 repo）
    await stateMod.ensureMaintDirReal(repoDir);

    // 两层锁：repo 锁 + dataRoot 锁（跨 repoDir 互斥）
    const lock = await stateMod.acquireLock(maintDir);
    let dataRootLock = null;
    try {
        dataRootLock = await stateMod.acquireDataRootLock(cfg.stDataRoot);
    } catch (e) {
        await stateMod.releaseLock(maintDir, lock);
        throw e;
    }

    try {
        switch (opts.command) {
            case 'init': return await cmdInit(opts);
            case 'status': return await cmdStatus(opts);
            case 'push': return await cmdPush(opts);
            case 'pull': return await cmdPull(opts);
            case 'apply': return await cmdApply(opts);
            case 'recover': return await cmdRecover(opts);
            default: throw new ReliableError(`未知命令: ${opts.command}`, 'UNKNOWN_COMMAND');
        }
    } finally {
        if (dataRootLock) await stateMod.releaseDataRootLock(dataRootLock);
        await stateMod.releaseLock(maintDir, lock);
    }
}

// P1 二检第 5 条：只导出 run 与必要纯函数；cmd* / recoverPending 不导出，杜绝绕过锁。
module.exports = {
    ReliableError,
    normalizeConfig,
    openMaint,
    run,
};

'use strict';
/**
 * 应用器：离线确认 → 全量预检 + 备份（读回校验）→ 逐文件同目录临时文件原子替换 → 持久 journal → 恢复。
 *
 * 硬性要求（合同第 27/28/29/30/31 条 + P1 第 6/7/8 条 + P1 二检第 2/6 条）：
 * - apply 必须离线确认（--offline-confirmed），不能从在线 HTTP 调用；
 * - 应用前重新读持久 B 校验，拒绝旧 stage 覆盖后来已确认版本；
 * - 先全量预检 + 备份全部当前字节（不去重/裁剪），**读回校验哈希**，全部成功后才允许任何 rename；
 *   任一备份失败/读回不一致 → 拒绝，不动任何聊天文件；
 * - 在改写聊天**之前**，把完整 apply 计划（每文件 expected/candidate/backup + 进度）持久化到 journal；
 * - 候选内容固定为**一次读取**的 bytes（后续写 temp + 哈希校验都基于这一份，不二次读源路径）；
 * - 逐文件「同目录临时文件 + 原子 rename」，记录逐文件 journal；每次 rename 前再次核对当前磁盘
 *   仍为 expected（或仍缺失）且目标祖先非符号链接；
 * - 部分应用或状态保存中断 → 下次 recover 按当前 hash 识别已应用/待应用；新编辑（第三种值）拒绝覆盖；
 * - recover 只处理「未完成事务」（无完成标志的 runId），历史已完成的 plan 不算恢复项（P1 二检第 2 条）；
 * - 不自动删除备份、不清理历史。
 */
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { sha256Buffer, resolveUnderDataRoot, assertValidJsonlBytes, assertDataRootReal, isReparsePoint } = require('./hash-scan');
const stateMod = require('./state');

class ApplyError extends Error {
    constructor(message, code = 'APPLY_ERROR') {
        super(message);
        this.name = 'ApplyError';
        this.code = code;
    }
}

function assertOfflineConfirmed(cliArgs) {
    if (cliArgs.offlineConfirmed !== true) {
        throw new ApplyError(
            'apply 改写本地聊天文件，必须显式声明已停止服务并关闭所有客户端：请加 --offline-confirmed（每次运行都要重新声明，该声明不是软件证明，由操作人负责保证）。',
            'OFFLINE_NOT_CONFIRMED'
        );
    }
}

/** 生成 runId。 */
function makeRunId() {
    return `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * lstat 错误语义（P1 三次第 1 条）：仅 ENOENT 表示缺失；EACCES/EIO 等其它错误必须抛出。
 */
async function lstatOrMissing(absPath) {
    try {
        return await fs.lstat(absPath);
    } catch (e) {
        if (e && e.code === 'ENOENT') return null;
        throw e;
    }
}

/**
 * 校验数据根到目标文件的所有父段（含 dataRoot 自身）都是真实目录，拒绝 symlink/junction。
 * 缺失的父段：仅当 `allowCreateParents` 为 true 时逐段 mkdir 并重新 lstat 验证（预期创建新聊天时），
 * 否则抛错（P1 三次第 8 条：不能只 assertDataRootReal(dataRoot)）。
 * @param {string} stDataRoot
 * @param {string} rel  chats/**\/*.jsonl
 * @param {boolean} allowCreateParents
 * @returns {Promise<string>} 目标绝对路径
 */
async function verifyTargetParents(stDataRoot, rel, allowCreateParents) {
    await assertDataRootReal(stDataRoot);
    const absRoot = path.resolve(stDataRoot);
    const abs = resolveUnderDataRoot(stDataRoot, rel);
    const segs = rel.split('/'); // ['chats', ...dirs, 'file.jsonl']
    // 父段 = chats 及其中间目录（不含最后文件名）
    let cur = absRoot;
    for (let i = 0; i < segs.length - 1; i++) {
        cur = path.join(cur, segs[i]);
        let st = await lstatOrMissing(cur);
        if (!st) {
            if (!allowCreateParents) {
                throw new ApplyError(`目标父目录缺失: ${cur}`, 'LOCAL_CHANGED');
            }
            await fs.mkdir(cur);
            st = await fs.lstat(cur);
            if (st.isSymbolicLink() || isReparsePoint(st)) {
                throw new ApplyError(`创建后目标父目录是链接/junction: ${cur}`, 'SYMLINK_REJECTED');
            }
            if (!st.isDirectory()) {
                throw new ApplyError(`创建后目标父目录不是目录: ${cur}`, 'LOCAL_CHANGED');
            }
            continue;
        }
        if (st.isSymbolicLink() || isReparsePoint(st)) {
            throw new ApplyError(`目标父目录是符号链接/junction: ${cur}`, 'SYMLINK_REJECTED');
        }
        if (!st.isDirectory()) {
            throw new ApplyError(`目标父目录不是目录: ${cur}`, 'LOCAL_CHANGED');
        }
    }
    return abs;
}

/**
 * 校验目标路径（数据根内）当前状态：非符号链接、祖先真实。
 * 返回 { missing, buf, hash }，buf 为一次读取的当前字节。
 */
async function readCurrentTarget(stDataRoot, rel, allowCreateParents = false) {
    const absTarget = await verifyTargetParents(stDataRoot, rel, allowCreateParents);
    const st = await lstatOrMissing(absTarget);
    if (!st) {
        return { missing: true, buf: null, hash: null, absTarget };
    }
    if (st.isSymbolicLink() || isReparsePoint(st)) {
        throw new ApplyError(`目标为符号链接，拒绝: ${rel}`, 'SYMLINK_REJECTED');
    }
    if (!st.isFile()) {
        throw new ApplyError(`目标不是普通文件: ${rel}`, 'LOCAL_CHANGED');
    }
    const buf = await fs.readFile(absTarget);
    return { missing: false, buf, hash: sha256Buffer(buf), absTarget };
}

/**
 * 全量预检 stage：校验目标身份、候选文件存在且哈希匹配、候选 JSONL 合法、逐文件 expected 校验。
 * 候选内容固定为一次读取的 bytes，存入 perFile（后续写 temp 与哈希校验都基于这一份）。
 * @returns {Promise<Array<{entry, absTarget, currentBuf|null, currentMissing, currentHash, candidateBuf}>>}
 */
async function precheckStage(state, stage, maintDir, stDataRoot, targetIdentity) {
    if (stage.targetIdentity !== targetIdentity) {
        throw new ApplyError('暂存目标身份与当前状态不符，stage 已过期。', 'STAGE_STALE');
    }
    const baseline = state.baseline || {};
    const perFile = [];
    for (const e of stage.entries) {
        const abs = await stateMod.assertRealWithinMaintDir(maintDir, e.candidatePath, 'stage.entries[].candidatePath');
        const st = await lstatOrMissing(abs);
        if (!st || !st.isFile()) {
            throw new ApplyError(`暂存候选快照缺失: ${e.candidatePath}`, 'STAGE_MISSING');
        }
        const candidateBuf = await fs.readFile(abs); // 固定一次读取
        if (sha256Buffer(candidateBuf) !== e.candidateHash) {
            throw new ApplyError(`暂存候选快照哈希不匹配: ${e.candidatePath}`, 'STAGE_CORRUPT');
        }
        // 候选 JSONL 合法校验（畸形 JSONL → 失败，合同第 27 条）
        try {
            assertValidJsonlBytes(candidateBuf, e.rel);
        } catch (err) {
            throw new ApplyError(`暂存候选不是合法 JSONL: ${e.rel}: ${err.message}`, 'STAGE_INVALID_JSONL');
        }
        // 校验持久 B
        const curB = baseline[e.rel] ? baseline[e.rel].hash : null;
        if (curB !== e.expectedBaselineHash) {
            throw new ApplyError(`基线已变化，stage 过期（拒绝用旧暂存覆盖后来确认版本）: ${e.rel}`, 'STAGE_STALE');
        }
        // 校验当前本地
        const cur = await readCurrentTarget(stDataRoot, e.rel);
        if (e.expectedLocalMissing) {
            if (!cur.missing) {
                throw new ApplyError(`暂存后本地新出现文件，拒绝覆盖: ${e.rel}`, 'LOCAL_CHANGED');
            }
        } else {
            if (cur.missing) {
                throw new ApplyError(`暂存后本地文件被删除，拒绝应用: ${e.rel}`, 'LOCAL_CHANGED');
            }
            if (cur.hash !== e.expectedLocalHash) {
                throw new ApplyError(`暂存后本地已改，拒绝覆盖: ${e.rel}`, 'LOCAL_CHANGED');
            }
        }
        perFile.push({
            entry: e,
            absTarget: cur.absTarget,
            currentBuf: cur.buf,
            currentMissing: cur.missing,
            currentHash: cur.hash,
            candidateBuf,
        });
    }
    return perFile;
}

/**
 * 备份全部当前字节（不去重、不裁剪）：为 stage 涉及的每个「已存在」文件在当前磁盘状态备份，
 * 并**读回校验 SHA-256**。任一备份失败或读回不一致 → 抛错，调用方中止 apply，不动任何聊天文件。
 * @returns {Promise<{runId: string, backupDir: string, backups: Map<rel, {path, hash}>}>}
 */
async function backupCurrent(stDataRoot, perFile, maintDir) {
    const runId = makeRunId();
    const backupDir = path.join(maintDir, 'backups', runId);
    await stateMod.safeEnsureDir(backupDir);
    const backups = new Map();
    for (const pf of perFile) {
        if (pf.currentMissing) continue; // 原本就缺失的无需备份
        const buf = pf.currentBuf;
        const base = stateMod.fileKeyForRel(pf.entry.rel);
        const relFile = `${base}.backup`;
        const absBackup = path.join(backupDir, relFile);
        try {
            await stateMod.atomicWriteBytes(absBackup, buf);
        } catch (err) {
            throw new ApplyError(`备份失败: ${pf.entry.rel}: ${err.message}`, 'BACKUP_FAILED');
        }
        // 读回校验（合同第 7 条：备份未经读回校验不得动聊天）
        let readBack;
        try {
            readBack = await fs.readFile(absBackup);
        } catch (err) {
            throw new ApplyError(`备份读回失败: ${pf.entry.rel}: ${err.message}`, 'BACKUP_FAILED');
        }
        if (sha256Buffer(readBack) !== sha256Buffer(buf)) {
            throw new ApplyError(`备份读回哈希不一致: ${pf.entry.rel}`, 'BACKUP_FAILED');
        }
        backups.set(pf.entry.rel, { path: `backups/${runId}/${relFile}`, hash: sha256Buffer(buf) });
    }
    return { runId, backupDir, backups };
}

/**
 * 单文件原子替换：写同目录临时文件（完整写入 + fsync）→ rename。
 * 使用固定候选 bytes（candidateBuf），不二次读候选文件。
 */
async function atomicReplaceFile(absTarget, candidateBuf) {
    const dir = path.dirname(absTarget);
    await fs.ensureDir(dir);
    const tmp = path.join(dir, `.${path.basename(absTarget)}.dsr-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    try {
        const fh = await fs.open(tmp, 'w');
        try {
            let off = 0;
            while (off < candidateBuf.length) {
                const { bytesWritten } = await fs.write(fh, candidateBuf, off, candidateBuf.length - off, null);
                if (!bytesWritten || bytesWritten <= 0) {
                    throw new Error(`write 返回 0 字节: off=${off}/${candidateBuf.length}`);
                }
                off += bytesWritten;
            }
            await fs.fsync(fh);
        } finally {
            await fs.close(fh);
        }
        await fs.rename(tmp, absTarget);
    } catch (err) {
        await fs.remove(tmp).catch(() => {});
        throw err;
    }
}

/**
 * 应用 stage（P1 三次第 12-20 条原子完整 manifest 设计）：
 * 1. 全量预检（candidate 读回校验 + 持久 B + 当前本地 expected）；
 * 2. 全量备份（读回校验）；
 * 3. **原子写完整 apply-active manifest 并读回验证**（任何 rename 前落盘）；
 * 4. 逐文件 CAS + 祖先检查 → 同目录临时文件原子 rename；
 * 5. journal 仅审计（非恢复真相）。
 *
 * manifest 持久前崩溃：没有聊天被写，stage 保留可重试。
 * @returns {Promise<{applied: Array, runId: string, backupDir: string}>}
 */
async function applyStage(state, stage, maintDir, stDataRoot, opts) {
    assertOfflineConfirmed(opts);
    const targetIdentity = opts.targetIdentity;

    const perFile = await precheckStage(state, stage, maintDir, stDataRoot, targetIdentity);

    // 备份全部（含读回校验）；失败抛错，不动聊天
    const { runId, backupDir, backups } = await backupCurrent(stDataRoot, perFile, maintDir);

    // ---- 构造完整 manifest entries ----
    const entries = perFile.map(pf => {
        const e = pf.entry;
        const bk = backups.get(e.rel) || null;
        return {
            rel: e.rel,
            expectedBaselineHash: e.expectedBaselineHash, // 可为 null
            expectedLocalHash: pf.currentMissing ? null : pf.currentHash,
            expectedLocalMissing: pf.currentMissing,
            candidateHash: e.candidateHash,
            candidatePath: e.candidatePath,
            backupPath: bk ? bk.path : null,
            backupHash: bk ? bk.hash : null,
        };
    });

    // ---- 原子写完整 manifest 并读回验证（rename 前） ----
    const manifest = {
        schemaVersion: stateMod.MANIFEST_SCHEMA_VERSION,
        runId,
        targetIdentity,
        stageId: stage.runId,
        remoteHead: stage.remoteHead,
        createdAt: new Date().toISOString(),
        entries,
    };
    await stateMod.writeApplyActive(maintDir, manifest);

    // journal 仅审计（记录 plan 阶段，非恢复真相）
    for (const pf of perFile) {
        const e = pf.entry;
        const bk = backups.get(e.rel) || null;
        await stateMod.appendApplyJournal(maintDir, {
            runId,
            rel: e.rel,
            status: 'plan',
            expectedHash: pf.currentMissing ? null : pf.currentHash,
            expectedMissing: pf.currentMissing,
            candidateHash: e.candidateHash,
            candidatePath: e.candidatePath,
            backupPath: bk ? bk.path : null,
            backupHash: bk ? bk.hash : null,
            ts: new Date().toISOString(),
        });
    }

    const applied = [];
    for (const pf of perFile) {
        const e = pf.entry;
        const absTarget = pf.absTarget;
        const candidateBuf = pf.candidateBuf; // 固定候选 bytes

        // 每次 rename 前再次核对：候选 bytes 仍匹配（不变式），当前磁盘仍为 expected（或仍缺失）+ 祖先检查。
        if (sha256Buffer(candidateBuf) !== e.candidateHash) {
            throw new ApplyError(`应用中途候选哈希不匹配: ${e.rel}`, 'STAGE_CORRUPT');
        }
        // allowCreateParents=true：预期创建新聊天（expectedLocalMissing 且目标是新路径）时允许逐段创建父目录。
        const curNow = await readCurrentTarget(stDataRoot, e.rel, e.expectedLocalMissing);
        if (e.expectedLocalMissing) {
            if (!curNow.missing) {
                throw new ApplyError(`应用前本地出现新文件，拒绝覆盖: ${e.rel}`, 'LOCAL_CHANGED');
            }
        } else {
            if (curNow.missing) {
                throw new ApplyError(`应用前本地文件被删除，拒绝: ${e.rel}`, 'LOCAL_CHANGED');
            }
            if (curNow.hash !== e.expectedLocalHash) {
                throw new ApplyError(`应用前本地内容变化，拒绝覆盖: ${e.rel}`, 'LOCAL_CHANGED');
            }
        }

        try {
            await atomicReplaceFile(absTarget, candidateBuf);
        } catch (err) {
            throw new ApplyError(`原子替换失败: ${e.rel}: ${err.message}`, 'REPLACE_FAILED');
        }

        await stateMod.appendApplyJournal(maintDir, {
            runId,
            rel: e.rel,
            status: 'applied',
            expectedHash: pf.currentMissing ? null : pf.currentHash,
            candidateHash: e.candidateHash,
            candidatePath: e.candidatePath,
            backupHash: backups.get(e.rel) ? backups.get(e.rel).hash : null,
            ts: new Date().toISOString(),
        });
        applied.push(e.rel);
    }

    return { applied, runId, backupDir };
}

/**
 * 依据完整 apply-active manifest 识别「活动事务」的已应用/待应用项（P1 三次第 18 条）：
 * - manifest 是唯一恢复真相（journal 仅审计，不用于恢复分类）。
 * - 若 manifest 缺失但有旧半 journal plan：明确阻断人工检查，不自动恢复猜测（P1 三次第 16 条）。
 * - 校验 manifest 身份 + 每条持久 B（原 B 或 candidate）+ 所有 candidate/backup 存在/哈希/路径。
 * - 分类：current==candidate 已应用；current==expected 待应用；第三值阻断。
 * @returns {Promise<{appliedRels, pendingRels, blockedRels, activeRunIds, manifest}>}
 */
async function recoverApply(state, maintDir, stDataRoot) {
    const manifest = await stateMod.loadApplyActive(maintDir);

    if (!manifest) {
        // 无 manifest：检查是否有**未完成**的旧半 journal plan。
        // 仅当存在「无完成标志」的 plan 记录时才阻断（P1 三次第 16 条：半份事务不猜测恢复）；
        // 已 complete 的历史 plan 不算活动事务（P1 三次第 24 条：旧完整 apply 历史不阻断后续编辑）。
        const journal = await stateMod.readApplyJournal(maintDir);
        const completed = new Set(journal.filter(r => r.status === 'complete').map(r => r.runId));
        const hasIncompletePlan = journal.some(r => r.status === 'plan' && !completed.has(r.runId));
        if (hasIncompletePlan) {
            throw new ApplyError(
                '存在旧的不完整 apply 计划但缺少完整 manifest，无法可靠恢复，请人工检查（不自动猜测/删除）。',
                'APPLY_MANIFEST_MISSING'
            );
        }
        // 无 manifest 且无未完成 plan：无活动事务
        return { appliedRels: [], pendingRels: [], blockedRels: [], activeRunIds: new Set(), manifest: null };
    }

    if (manifest.targetIdentity !== state.targetIdentity) {
        throw new ApplyError('apply-active manifest 目标身份与当前状态不符，拒绝恢复。', 'IDENTITY_CHANGED');
    }

    const baseline = state.baseline || {};
    const appliedRels = [];
    const pendingRels = [];
    const blockedRels = [];
    const activeRunIds = new Set([manifest.runId]);

    // 先全量校验 manifest：每条持久 B（原 B 或 candidate）+ candidate/backup 存在/哈希/路径（P1 三次第 18 条）。
    for (const e of manifest.entries) {
        const curB = baseline[e.rel] ? baseline[e.rel].hash : null;
        const validB = curB === e.expectedBaselineHash || curB === e.candidateHash;
        if (!validB) {
            blockedRels.push({ rel: e.rel, reason: 'baseline-diverged', expectedBaselineHash: e.expectedBaselineHash, candidateHash: e.candidateHash, currentBaselineHash: curB });
            continue;
        }
        // candidate 快照读回校验
        try {
            await stateMod.readVerifiedSnapshot(maintDir, e.candidatePath, e.candidateHash, 'recoverApply.candidate');
        } catch (err) {
            blockedRels.push({ rel: e.rel, reason: 'candidate-missing-or-corrupt', error: err.message });
            continue;
        }
        // backup 读回校验（若存在）
        if (e.backupPath !== null) {
            try {
                await stateMod.readVerifiedSnapshot(maintDir, e.backupPath, e.backupHash, 'recoverApply.backup');
            } catch (err) {
                blockedRels.push({ rel: e.rel, reason: 'backup-missing-or-corrupt', error: err.message });
                continue;
            }
        }
    }
    if (blockedRels.length > 0) {
        // 已有一致性阻断，直接返回（不进入分类）
        return { appliedRels, pendingRels, blockedRels, activeRunIds, manifest };
    }

    // 分类（P1 三次第 18 条）：current==candidate 已应用 / ==expected 待应用 / 第三值阻断。
    for (const e of manifest.entries) {
        const cur = await readCurrentTarget(stDataRoot, e.rel, e.expectedLocalMissing);

        if (!cur.missing && cur.hash === e.candidateHash) {
            appliedRels.push(e.rel);
        } else if (e.expectedLocalMissing && cur.missing) {
            pendingRels.push(e.rel);
        } else if (!e.expectedLocalMissing && !cur.missing && cur.hash === e.expectedLocalHash) {
            pendingRels.push(e.rel);
        } else {
            blockedRels.push({ rel: e.rel, candidateHash: e.candidateHash, expectedHash: e.expectedLocalHash, currentHash: cur.missing ? null : cur.hash });
        }
    }

    return { appliedRels, pendingRels, blockedRels, activeRunIds, manifest };
}

/**
 * 重试「待应用」项：对活动事务中当前仍为 expected 的文件，从候选快照（candidatePath + candidateHash）
 * 重新原子替换，并追加 applied journal。候选内容一次读取校验。
 * **每次 rename 前重新读当前 CAS + 祖先检查，不覆盖刚出现第三值**（P1 三次第 18 条）。
 * @param {Array<{rel, candidatePath, candidateHash, expectedLocalHash, expectedLocalMissing}>} manifestEntries 待重试的 manifest 条目
 * @param {string} maintDir
 * @param {string} stDataRoot
 * @param {string} runId
 * @returns {Promise<Array<string>>} 本次实际重试应用的 rel
 */
async function retryApplyPending(maintDir, stDataRoot, runId, manifestEntries) {
    const applied = [];
    for (const entry of manifestEntries) {
        // 候选快照：限 maintDir、非符号链接、哈希匹配，一次读取
        const candidateBuf = await stateMod.readVerifiedSnapshot(maintDir, entry.candidatePath, entry.candidateHash, 'retryApplyPending.candidate');
        const absTarget = resolveUnderDataRoot(stDataRoot, entry.rel);

        // 每次 rename 前重新读当前 CAS + 祖先检查（不覆盖刚出现第三值）
        const curNow = await readCurrentTarget(stDataRoot, entry.rel, entry.expectedLocalMissing);
        if (entry.expectedLocalMissing) {
            if (!curNow.missing) {
                throw new ApplyError(`重试前本地出现新文件，拒绝覆盖: ${entry.rel}`, 'LOCAL_CHANGED');
            }
        } else {
            if (curNow.missing) {
                throw new ApplyError(`重试前本地文件被删除，拒绝: ${entry.rel}`, 'LOCAL_CHANGED');
            }
            if (curNow.hash !== entry.expectedLocalHash) {
                throw new ApplyError(`重试前本地内容变化，拒绝覆盖: ${entry.rel}`, 'LOCAL_CHANGED');
            }
        }

        await atomicReplaceFile(absTarget, candidateBuf);
        await stateMod.appendApplyJournal(maintDir, {
            runId,
            rel: entry.rel,
            status: 'applied',
            expectedHash: entry.expectedLocalHash != null ? entry.expectedLocalHash : null,
            candidateHash: entry.candidateHash,
            candidatePath: entry.candidatePath,
            ts: new Date().toISOString(),
        });
        applied.push(entry.rel);
    }
    return applied;
}

module.exports = {
    ApplyError,
    assertOfflineConfirmed,
    makeRunId,
    precheckStage,
    backupCurrent,
    applyStage,
    recoverApply,
    retryApplyPending,
    atomicReplaceFile,
    readCurrentTarget,
    verifyTargetParents,
    lstatOrMissing,
};

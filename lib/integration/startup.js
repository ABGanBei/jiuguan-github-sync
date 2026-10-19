'use strict';
/**
 * 启动期应用（真正应用）：在宿主 loadPlugins await init 的窗口、listen 之前，处理「显式安排」的
 * stage。不是每次启动自动应用所有 stage。
 *
 * 语义（integration-contract.md 真正应用 + 三次复审 + 完成态复审）：
 * - 只处理「已有配置 + 显式 intent（schedule-apply 落盘）」的用户；
 * - **先核** active.stageId/targetIdentity/remoteHead/entries 候选 + expected B/L 投影 与 intent、stage
 *   完整绑定，**再**恢复/应用；绝不「任意 active 先 recover 才校验 intent」（会错恢复别的用户/别的 stage）；
 *   active 与 intent 不匹配 → 绝不执行 recover。
 * - 无 intent / 损坏 intent / 缺 config，但存在 active 或未完成 plan → **fail-closed**（禁止监听，
 *   不许无授权 recover），绝不静默跳过；
 * - 成功：写持久化执行 receipt（stageId/digest/真实 applyRunId 来自与当前 stage.entries 精确匹配的 journal
 *   complete 记录，不是盲取最新、不是 pull stage id）；真实恢复确认完成才清 intent；无法确认 → 保守保留 intent；
 * - 纯预检 stale/digest 失败且无 active → 记录并继续启动（让 UI 取消），不 fail-closed；
 * - receipt 崩溃窗口（核心 apply 完整清 stage + complete + clearActive 之后、receipt 之前退出）：数据已应用，
 *   但 journal plan 字段不足（不含 expectedBaselineHash/stageId），**无法安全重建**完整授权证明（选任意 complete
 *   会把历史其它 stage 完成冒认为本次 intent 完成）。因此不做历史推断：无 stage/无 active/无未 complete plan 时
 *   只接受「严格 schema 且 stageId/identity/digest 匹配当前 intent 的已落盘 receipt」，否则一律 precheck-failed
 *   保留 intent 供 UI 取消。这是**有意产品限制**，注释清晰，不假成功、不永久整宿主阻断、不引入 proof 新系统。
 * - **fail-closed**：存在 active manifest 且无法收敛（聊天可能被部分改写）→ 真正阻止宿主继续启动
 *   （process.exit 非零）。官方 loader 会吞 init 抛出的异常，因此不能用「仅 throw」表达失败关闭。
 *
 * 读错误语义（P1 三次第 1 条 + 完成态复审）：核心 state 层的 loadApplyActive / readApplyJournal /
 * loadStage 只有「ENOENT」表示缺失（返回 null/[]），其它错误（EIO/EACCES/损坏 schema/目录非普通文件）
 * 一律抛 CorruptStateError。此处**绝不** catch-all 吞成 null/[]（损坏 active/journal 必须向上 fail-closed）。
 */
const path = require('path');
const { pathToFileURL } = require('url');
const stateCore = require('../reliable/state');

// ============================== schema 校验 ==============================

function isHex64(s) { return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s); }
function isHex16(s) { return typeof s === 'string' && /^[0-9a-f]{16}$/.test(s); }
function isIso(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s); }

/**
 * intent schema 严格校验（完成态复审）：
 * schemaVersion 1、stageId 非空、digest hex64、targetIdentity hex16、clientsWillBeClosed === true、
 * entryCount 非负整数、createdAt ISO。
 * 任一项不符 → 抛错（调用方据此区分「损坏 intent 有 active → fail-closed」与「无 active → precheck-failed」）。
 */
function assertIntentSchema(intent) {
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
        throw new Error('intent 非对象');
    }
    if (intent.schemaVersion !== 1) throw new Error('intent schemaVersion 应为 1');
    if (typeof intent.stageId !== 'string' || intent.stageId.length === 0) throw new Error('intent stageId 非空字符串');
    if (!isHex64(intent.digest)) throw new Error('intent digest 非法（须 hex64）');
    if (!isHex16(intent.targetIdentity)) throw new Error('intent targetIdentity 非法（须 hex16）');
    if (intent.clientsWillBeClosed !== true) throw new Error('intent clientsWillBeClosed 应为 true');
    if (!Number.isInteger(intent.entryCount) || intent.entryCount < 0) throw new Error('intent entryCount 非法（须非负整数）');
    if (!isIso(intent.createdAt)) throw new Error('intent createdAt 非法（须 ISO）');
    return intent;
}

/**
 * receipt schema 严格校验（完成态复审）：schemaVersion 1、stageId 非空、targetIdentity hex16、
 * digest hex64、**applyRunId** 非空（真实 apply 事务 runId，来自 journal complete/active manifest.runId，
 * 不是 pull stage id）、appliedAt ISO。remoteHead 允许 null。
 */
function assertReceiptSchema(receipt) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
        throw new Error('receipt 非对象');
    }
    if (receipt.schemaVersion !== 1) throw new Error('receipt schemaVersion 应为 1');
    if (typeof receipt.stageId !== 'string' || receipt.stageId.length === 0) throw new Error('receipt stageId 非空字符串');
    if (!isHex16(receipt.targetIdentity)) throw new Error('receipt targetIdentity 非法（须 hex16）');
    if (!isHex64(receipt.digest)) throw new Error('receipt digest 非法（须 hex64）');
    if (typeof receipt.applyRunId !== 'string' || receipt.applyRunId.length === 0) throw new Error('receipt applyRunId 非法（须非空真实 applyRunId）');
    if (!isIso(receipt.appliedAt)) throw new Error('receipt appliedAt 非法（须 ISO）');
    if (receipt.remoteHead !== null && receipt.remoteHead !== undefined && !/^[0-9a-f]{40}$/.test(receipt.remoteHead)) {
        throw new Error('receipt remoteHead 非法');
    }
    return receipt;
}

/**
 * 从 journal 取「与当前 stage 精确匹配的那次 apply 事务」的真实 applyRunId（不是盲取最新 complete）。
 *
 * 精确匹配（完成态复审）：journal 中同一 runId 的 plan 计划集合必须
 *   - 存在同 runId 的 complete 记录；
 *   - plan 条数 === stage.entries.length；
 *   - 每条 plan 的 (rel, candidatePath, candidateHash) 与 stage.entries 的对应项**逐条精确一致**。
 * 找不到精确证据 → 返回 null（调用方保守保留 intent，不伪造 applyRunId）。
 */
function findExactCompletedApplyRunId(journal, stage) {
    const stageEntries = stage.entries;
    const byRel = new Map();
    for (const e of stageEntries) byRel.set(e.rel, e);

    // 收集所有 complete runId
    const completed = new Set(journal.filter(r => r.status === 'complete').map(r => r.runId));
    // 按 runId 分组 plan 记录（保持 journal 顺序）
    const plansByRun = new Map();
    for (const r of journal) {
        if (r.status === 'plan') {
            if (!plansByRun.has(r.runId)) plansByRun.set(r.runId, []);
            plansByRun.get(r.runId).push(r);
        }
    }

    for (const [runId, plans] of plansByRun) {
        if (!completed.has(runId)) continue;
        if (plans.length !== stageEntries.length) continue;
        let allOk = true;
        for (const p of plans) {
            const e = byRel.get(p.rel);
            if (!e || e.candidatePath !== p.candidatePath || e.candidateHash !== p.candidateHash) {
                allOk = false;
                break;
            }
        }
        if (allOk) return runId;
    }
    return null;
}

/**
 * 动态 import 宿主 src/users.js 的 getAllUserHandles + getUserDirectories（官方 1.17 ESM）。
 * 官方 getUserDirectoriesList() 每项是 UserDirectoryList 自身（含 root 等字段），不是 {handle,directories} 包装；
 * 且 getUserDirectories(handle).root === path.join(DATA_ROOT, handle)（USER_DIRECTORY_TEMPLATE.root 为空）。
 * 生产统一返回 `{handle, root}`（root 精确 path.resolve）。
 *
 * 枚举失败（找不到 / 非官方宿主 / 形状不符）→ **抛错**（调用方 fail-closed），不再静默返回 []。
 * @param {string} hostRoot
 * @returns {Promise<Array<{handle:string, root:string}>>}
 */
async function loadUserDirectories(hostRoot) {
    const modPath = path.join(hostRoot, 'src', 'users.js');
    const mod = await import(pathToFileURL(modPath).href);
    if (typeof mod.getAllUserHandles !== 'function') {
        throw new Error(`宿主 users.js 缺少 getAllUserHandles（非官方 1.17 形状）: ${modPath}`);
    }
    if (typeof mod.getUserDirectories !== 'function') {
        throw new Error(`宿主 users.js 缺少 getUserDirectories（非官方 1.17 形状）: ${modPath}`);
    }
    const handles = await mod.getAllUserHandles();
    if (!Array.isArray(handles)) {
        throw new Error(`getAllUserHandles 返回非数组: ${modPath}`);
    }
    const out = [];
    for (const handle of handles) {
        const dirs = mod.getUserDirectories(handle);
        if (!dirs || typeof dirs.root !== 'string' || dirs.root.length === 0) {
            throw new Error(`用户 ${handle} 的 directories.root 缺失（非官方形状）`);
        }
        out.push({ handle, root: path.resolve(dirs.root) });
    }
    return out;
}

/** 判断某用户是否存在「活动 apply 事务」或「无 manifest 但未 complete 的 plan」（需要离线恢复的事务）。 */
async function hasActiveOrIncompletePlan(service, handle) {
    const dir = await service._userDir(handle);
    const maint = await service._maintDir(dir);
    // P1 三次第 1 条 + 完成态复审：核心 loadApplyActive 仅在 ENOENT 返回 null，其它错误（损坏/EIO/非普通文件）
    // 抛 CorruptStateError —— **不得 catch-all 吞成 null**（损坏 active 必须向上 fail-closed）。
    const active = await stateCore.loadApplyActive(maint);
    if (active) return { kind: 'active', active };

    // 同理：readApplyJournal 仅在 ENOENT 返回 []，其它错误抛 —— 不得吞成 []。
    const journal = await stateCore.readApplyJournal(maint);
    const completed = new Set(journal.filter(r => r.status === 'complete').map(r => r.runId));
    const hasIncomplete = journal.some(r => r.status === 'plan' && !completed.has(r.runId));
    if (hasIncomplete) return { kind: 'incomplete-plan' };
    return null;
}

/**
 * 收集「需要启动期应用」的用户：有配置 + 有 intent。
 * 同时：枚举 / 载入 config / intent 的过程若抛错，向上抛（fail-closed），不静默吞。
 * 对「无 intent / 损坏 intent / 缺 config」但存在 active 或未完成 plan 的用户 → 标记为 fail-closed 阻断项
 * （不能静默跳过、不能无授权 recover）。
 * @returns {Promise<{items:Array, blockNoIntent:Array}>}
 */
async function collectIntents(service) {
    const usersList = service.getUsers ? await service.getUsers() : [];
    if (!Array.isArray(usersList) || usersList.length === 0) return { items: [], blockNoIntent: [] };

    const items = [];
    const blockNoIntent = [];
    for (const u of usersList) {
        if (!u || typeof u.handle !== 'string' || typeof u.root !== 'string') {
            throw new Error('用户枚举项形状非法（须 {handle,root}）');
        }
        const rt = await service._getRuntime(u.handle); // config 载入异常向上抛（fail-closed）
        let intent = null;
        let intentError = null;
        try {
            intent = await service._loadIntent(u.handle);
            if (intent) {
                // schema 损坏（合法 JSON 但字段不符）也在收集期识别为「损坏 intent」。
                assertIntentSchema(intent);
            }
        } catch (e) {
            intentError = e; // 损坏 intent JSON / 损坏 intent schema
            intent = null;
        }

        if (!intent) {
            // 无 intent 或损坏 intent：检查是否存在需要恢复的事务；有则 fail-closed（不许无授权 recover / 静默跳过）。
            const active = await hasActiveOrIncompletePlan(service, u.handle);
            if (active) {
                blockNoIntent.push({
                    handle: u.handle,
                    reason: intentError ? 'corrupt-intent-with-active' : 'no-intent-with-active',
                    detail: active.kind,
                    error: intentError ? String(intentError.message || intentError) : null,
                });
            }
            continue;
        }

        // 有 intent：检查是否有配置（缺 config 但有 active/未完成 plan → fail-closed）
        if (!rt.config.githubRepo) {
            const active = await hasActiveOrIncompletePlan(service, u.handle);
            if (active) {
                blockNoIntent.push({ handle: u.handle, reason: 'no-config-with-active', detail: active.kind });
            }
            continue;
        }
        items.push({ handle: u.handle, dataRoot: u.root, intent });
    }
    return { items, blockNoIntent };
}

/**
 * 启动期应用单个用户。
 * @returns {Promise<{handle, outcome: 'applied'|'idempotent'|'precheck-failed'|'blocked', reason?:string, error?:string}>}
 */
async function applyStartupIntent(service, { handle, dataRoot, intent }) {
    const dir = await service._userDir(handle);
    const maint = await service._maintDir(dir);
    const rt = await service._getRuntime(handle);
    const identity = stateCore.bindTargetIdentity({
        repo: rt.config.githubRepo,
        branch: rt.config.branch || 'main',
        stDataRoot: dataRoot,
    });

    // 读 active + stage + journal（先读，用于「先核绑定再恢复」）。
    // 完成态复审：绝不 catch-all 吞 CorruptStateError 成 null/[]（损坏 active/journal 必须向上 fail-closed）。
    const active = await stateCore.loadApplyActive(maint);
    const stage = await stateCore.loadStage(maint);
    const journal = await stateCore.readApplyJournal(maint);

    // intent schema 严格校验：损坏 → 有 active/未完成 plan 则 fail-closed（blocked），否则 precheck-failed（UI 取消）。
    let intentErr = null;
    try {
        assertIntentSchema(intent);
    } catch (e) {
        intentErr = e;
    }
    if (intentErr) {
        const completed = new Set(journal.filter(r => r.status === 'complete').map(r => r.runId));
        const hasIncompletePlan = journal.some(r => r.status === 'plan' && !completed.has(r.runId));
        if (active || hasIncompletePlan) {
            return { handle, outcome: 'blocked', reason: 'corrupt-intent-with-active', error: intentErr.message };
        }
        return { handle, outcome: 'precheck-failed', reason: 'intent-schema-invalid', error: intentErr.message };
    }

    // ---- 有活动事务：必须先核 active 与 intent/stage 完整绑定，再恢复 ----
    if (active) {
        // 1) intent 身份不符 → 阻断（有 active，无法确认，不许恢复）
        if (intent.targetIdentity !== identity) {
            return { handle, outcome: 'blocked', reason: 'identity-mismatch', error: 'intent 身份与当前配置不符（存在活动事务）' };
        }
        // 2) active 身份不符 → 阻断（active 属于别的 dataRoot/身份，绝不误恢复）
        if (active.targetIdentity !== identity) {
            return { handle, outcome: 'blocked', reason: 'active-identity-mismatch', error: '活动事务身份与当前配置不符' };
        }
        // 3) active.stageId 与 intent.stageId 不符 → 阻断（active 是另一个 stage 的事务）
        if (active.stageId !== intent.stageId) {
            return { handle, outcome: 'blocked', reason: 'active-stage-id-mismatch', error: `活动事务 stageId=${active.stageId} 与 intent stageId=${intent.stageId} 不符` };
        }
        // 4) entryCount 与 active 条目数对应
        if (intent.entryCount !== active.entries.length) {
            return { handle, outcome: 'blocked', reason: 'entry-count-mismatch', error: `intent entryCount=${intent.entryCount} 与活动事务条目数=${active.entries.length} 不符` };
        }
        // 5) active 候选摘要与 intent.digest 不符 → 阻断（active.entries 必须与授权摘要一致，完成态复审：
        //    active.entries 从未绑定 → 现在直接按 active 的 stageId/targetIdentity/remoteHead/entries 投影校验）
        const activeDigest = await service._stageDigest(active);
        if (activeDigest !== intent.digest) {
            return { handle, outcome: 'blocked', reason: 'digest-mismatch', error: '活动事务候选摘要与 intent 不符' };
        }
        // 6) stage 存在时：stage.runId 必须是 intent stage；stage 存在但不是 intent stage 一律阻断。
        if (stage) {
            if (stage.runId !== intent.stageId) {
                return { handle, outcome: 'blocked', reason: 'stage-mismatch', error: `stage.runId=${stage.runId} 与 intent stageId=${intent.stageId} 不符（存在活动事务）` };
            }
            const stageDigest = await service._stageDigest(stage);
            if (stageDigest !== intent.digest) {
                return { handle, outcome: 'blocked', reason: 'digest-mismatch', error: 'stage 摘要与 intent 不符（存在活动事务）' };
            }
        }

        // 现在才恢复（离线 recover，收敛活动事务）。active 与 intent/stage 已完整绑定，绝不误恢复别的 stage。
        await service._runCore({ handle, dataRoot }, 'recover', { executionMode: 'offline', offlineConfirmed: true });
        const active2 = await stateCore.loadApplyActive(maint);
        if (active2) {
            return { handle, outcome: 'blocked', reason: 'active-apply-unresolved', error: 'recover 后活动事务仍未收敛' };
        }
        // 收敛成功：写 receipt（真实 applyRunId = active.runId，来自 active manifest，不是 pull stage id），清 intent
        const receipt = makeReceipt({ intent, identity, applyRunId: active.runId, remoteHead: active.remoteHead });
        await service._saveReceipt(handle, receipt);
        await service._clearIntent(handle);
        return { handle, outcome: 'applied', reason: 'recovered-active' };
    }

    // ---- 无 active：检查是否有「无 manifest 但未完成 plan」→ 阻断（fail-closed，不猜测） ----
    const completedRunIds = new Set(journal.filter(r => r.status === 'complete').map(r => r.runId));
    const hasIncompletePlan = journal.some(r => r.status === 'plan' && !completedRunIds.has(r.runId));
    if (hasIncompletePlan) {
        return { handle, outcome: 'blocked', reason: 'active-apply-unresolved', error: '存在无 manifest 的未完成 apply 计划，无法可靠恢复' };
    }

    // ---- 无活动事务：纯预检 ----
    // 身份不符（无 active）→ 预检失败，继续启动（让 UI 取消），不 fail-closed
    if (intent.targetIdentity !== identity) {
        return { handle, outcome: 'precheck-failed', reason: 'identity-mismatch', error: 'intent 身份与当前配置不符（无活动事务，可取消）' };
    }

    if (!stage) {
        // 无 stage、无 active、无未 complete plan（上面已确认）：只接受「严格 schema 且
        // stageId/identity/digest 匹配当前 intent 的已落盘 receipt」作幂等确认，否则一律 precheck-failed
        // 保留 intent 供 UI 取消。
        //
        // 注意（有意产品限制，完成态复审）：核心 apply 完整清 stage + complete + clearActive 之后、receipt
        // 落盘之前崩溃，下次启动无法从 journal 的不足字段重建完整授权证明（journal plan 不含
        // expectedBaselineHash/stageId，选任意 complete 会把历史其它 stage 完成冒认为本次 intent 完成）。
        // 因此该崩溃窗口的数据虽已应用，但 UI 明确「无法确认，可取消安排」，而非假成功/永久整宿主阻断。
        let receipt = null;
        try {
            receipt = await service._loadReceipt(handle);
            if (receipt) assertReceiptSchema(receipt);
        } catch (e) {
            receipt = null; // receipt 损坏：视作无有效 receipt（保守 precheck-failed，不冒认）
        }
        if (receipt && receipt.stageId === intent.stageId && receipt.targetIdentity === identity && receipt.digest === intent.digest) {
            // 真实确认已应用：清 intent（幂等），不重复应用
            await service._clearIntent(handle);
            return { handle, outcome: 'idempotent', reason: 'receipt-confirmed-applied' };
        }
        // 无 receipt / 坏 receipt / 不匹配：保守 precheck-failed 保留安排供 UI 取消，不假成功也不必 exit70。
        return { handle, outcome: 'precheck-failed', reason: 'stage-missing-no-receipt', error: '无待应用 stage 且无匹配执行凭据，无法确认是否已应用（保留安排，可取消）' };
    }

    if (stage.runId !== intent.stageId) {
        return { handle, outcome: 'precheck-failed', reason: 'stage-id-mismatch', error: `stageId=${stage.runId} 与 intent ${intent.stageId} 不符（无活动事务）` };
    }
    if (stage.targetIdentity !== identity) {
        return { handle, outcome: 'precheck-failed', reason: 'stage-identity-mismatch', error: 'stage 身份与当前配置不符' };
    }
    if (intent.entryCount !== stage.entries.length) {
        return { handle, outcome: 'precheck-failed', reason: 'entry-count-mismatch', error: `intent entryCount=${intent.entryCount} 与 stage 条目数=${stage.entries.length} 不符` };
    }
    const digest = await service._stageDigest(stage);
    if (digest !== intent.digest) {
        return { handle, outcome: 'precheck-failed', reason: 'digest-mismatch', error: 'stage 摘要与 intent 不符（无活动事务）' };
    }

    // ---- 执行核心离线 apply（沿用核心备份/manifest） ----
    try {
        await service._runCore({ handle, dataRoot }, 'apply', {
            executionMode: 'offline',
            offlineConfirmed: true,
            stageId: stage.runId,
        });
    } catch (e) {
        // apply 失败：判断是否可能已部分改写聊天（有 active manifest）
        const activeNow = await stateCore.loadApplyActive(maint);
        if (activeNow) {
            return { handle, outcome: 'blocked', reason: 'apply-failed-active', error: e.message };
        }
        // 无 active manifest：预检失败（未改聊天），记录并继续
        return { handle, outcome: 'precheck-failed', reason: 'apply-failed', error: e.message };
    }

    // 成功：写 receipt（真实 applyRunId 来自与当前 stage.entries 精确匹配的 journal complete 记录，
    // 不是盲取最新 complete、也不是 pull stage id），清 intent
    const journalAfter = await stateCore.readApplyJournal(maint);
    const applyRunId = findExactCompletedApplyRunId(journalAfter, stage);
    if (!applyRunId) {
        // apply 成功但 journal 无与当前 stage 精确匹配的 complete 记录（异常）：保守阻断（不能写非法 receipt）
        return { handle, outcome: 'blocked', reason: 'apply-complete-missing', error: 'apply 成功但 journal 缺少与当前 stage 精确匹配的 complete 标志，无法取得真实 applyRunId' };
    }
    const receipt = makeReceipt({ intent, identity, applyRunId, remoteHead: stage.remoteHead });
    await service._saveReceipt(handle, receipt);
    await service._clearIntent(handle);
    return { handle, outcome: 'applied' };
}

/**
 * 构造持久化执行 receipt（记录准确 stageId/digest/真实 applyRunId/原 apply 事务绑定）。
 * applyRunId 来自对应 journal complete / active manifest.runId（不是 pull stage id），完成态复审。
 * 返回前经 assertReceiptSchema 校验，保证落盘的是合法 receipt。
 */
function makeReceipt({ intent, identity, applyRunId, remoteHead }) {
    const receipt = {
        schemaVersion: 1,
        stageId: intent.stageId,
        targetIdentity: identity,
        digest: intent.digest,
        applyRunId,
        remoteHead: remoteHead || null,
        appliedAt: new Date().toISOString(),
    };
    return assertReceiptSchema(receipt);
}

/**
 * 运行启动期应用；返回结果摘要。调用方（index.js init）据此决定是否 fail-closed。
 * @returns {Promise<{applied:number, blocked:Array<{handle,reason}>, precheckFailed:Array<{handle,error}>}>}
 */
async function runStartupApply(service) {
    const summary = { applied: 0, blocked: [], precheckFailed: [] };

    // 枚举/收集异常向上抛（不吞），由 createPlugin.start 捕获并 fail-closed。
    const { items, blockNoIntent } = await collectIntents(service);

    // 无 intent / 损坏 intent / 缺 config 但有 active 或未完成 plan → 阻断（fail-closed）
    for (const b of blockNoIntent) {
        summary.blocked.push({ handle: b.handle, reason: b.reason, error: b.error || b.detail });
        service.log(`[startup] 用户 ${b.handle} 存在待恢复事务但无有效 intent（${b.reason}），阻断`);
    }

    for (const it of items) {
        let outcome;
        try {
            outcome = await applyStartupIntent(service, it);
        } catch (e) {
            // apply 阶段异常（含损坏 active/journal 的 CorruptStateError）：可能已改写聊天（无法判定），保守阻断。
            outcome = { handle: it.handle, outcome: 'blocked', reason: 'exception', error: e.message };
        }
        if (outcome.outcome === 'applied') {
            summary.applied++;
        } else if (outcome.outcome === 'idempotent') {
            // 幂等确认已应用：不计入 applied，但也不算阻断
        } else if (outcome.outcome === 'precheck-failed') {
            // 未改聊天：记录 status，继续服务（不 fail-closed）
            summary.precheckFailed.push({ handle: it.handle, error: outcome.error || outcome.reason });
            service.log(`[startup] 用户 ${it.handle} 应用预检失败（未改聊天，继续）: ${outcome.error || outcome.reason}`);
        } else {
            // 阻断（可能已部分改写聊天 / active 未收敛 / 绑定不符）
            summary.blocked.push({ handle: it.handle, reason: outcome.reason || 'blocked', error: outcome.error || null });
            service.log(`[startup] 用户 ${it.handle} 启动期应用阻断: ${outcome.reason}`);
        }
    }
    return summary;
}

module.exports = {
    loadUserDirectories,
    hasActiveOrIncompletePlan,
    collectIntents,
    applyStartupIntent,
    makeReceipt,
    runStartupApply,
    assertIntentSchema,
    assertReceiptSchema,
    findExactCompletedApplyRunId,
};

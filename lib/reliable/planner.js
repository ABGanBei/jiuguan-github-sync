'use strict';
/**
 * 规划器：单一内容 planner，按 B（基线）/ L（本地）/ R（远端固定 H）做三向比较。
 *
 * 规则（合同第 13/15/16 条）：
 * 1. L=B 且 R≠B → R 改：可 stage（暂存 R，待 apply）。
 * 2. L≠B 且 R=B → L 改：可 publish（发布 L）。
 * 3. L=R → 内容一致：可确认共同内容（推进 B）。
 * 4. L≠B 且 R≠B 且 L≠R → 冲突，保存双方快照，不自动选择。
 * 5. 首次无 B（B=null）且 L 与 R 异内容 → 冲突；L=R → 可确认共同内容。
 * 6. 任一端缺失（已登记路径一端消失）→ delete-pending，阻断，不传播。
 *
 * 缺失语义（合同第 28 条）：
 * - 首次（无 B）：L-only → 上传（L 存在 R 缺失）；R-only → 暂存（R 存在 L 缺失）；
 *   相同（L=R）→ 确认；异内容 → 冲突。
 * - 已有 B：任一侧缺失 → delete-pending（双方缺失也不接受，不按 L=R 自动接受）。
 */
const { ScanError, findCasefoldCollision } = require('./hash-scan');

/**
 * @param {Object} opts
 * @param {Object} opts.state       已校验的 state（含 baseline map）
 * @param {Map<string,{hash:string,size:number}>} opts.localHashes  L 表（rel -> hash；缺失即本地无此文件）
 * @param {Map<string,{hash:string,size:number}>} opts.remoteHashes R 表（rel -> hash；缺失即远端无此文件）
 * @param {string} opts.remoteHead   固定 H
 * @returns {{actions: Array, remoteHead: string}}
 *   actions[].kind ∈ 'publish' | 'stage' | 'conflict' | 'delete-pending' | 'ok'
 */
function plan(opts) {
    const { state, localHashes, remoteHashes, remoteHead } = opts;
    const baseline = state.baseline || {};

    // 并集路径，稳定排序
    const rels = new Set([...localHashes.keys(), ...remoteHashes.keys(), ...Object.keys(baseline)]);
    const sorted = [...rels].sort((a, b) => a.localeCompare(b));

    // 跨路径大小写不敏感（casefold）碰撞检测：对 B/L/R 路径并集做逐段前缀折叠检测。
    // 防止本地与远端各持一种拼写（如本地 chats/Actor/、远端 chats/actor/），最终 push 会造出
    // Windows 上不可用的 tree（同前缀两种拼写）。必须在规划前阻断。
    const collision = findCasefoldCollision(rels);
    if (collision) {
        throw new ScanError(
            `路径大小写不敏感碰撞（B/L/R 并集 casefold 前缀冲突）: ${collision.a} vs ${collision.b}`,
            'UNSAFE_PATH'
        );
    }

    const actions = [];
    for (const rel of sorted) {
        const B = baseline[rel] ? baseline[rel].hash : null; // 基线内容哈希或 null
        const L = localHashes.get(rel) ? localHashes.get(rel).hash : null;
        const R = remoteHashes.get(rel) ? remoteHashes.get(rel).hash : null;

        const lMissing = L === null;
        const rMissing = R === null;

        let action;
        if (B === null) {
            // 首次无基线
            if (lMissing && rMissing) {
                // 双缺失且从未登记：无此文件，跳过
                continue;
            } else if (lMissing && !rMissing) {
                action = { rel, kind: 'stage', lMissing: true, rMissing: false, remoteHash: R, baselineHash: null, localHash: null };
            } else if (!lMissing && rMissing) {
                action = { rel, kind: 'publish', lMissing: false, rMissing: true, localHash: L, baselineHash: null, remoteHash: null };
            } else if (L === R) {
                action = { rel, kind: 'ok', localHash: L, remoteHash: R, baselineHash: null, lMissing: false, rMissing: false };
            } else {
                action = { rel, kind: 'conflict', localHash: L, remoteHash: R, baselineHash: null, lMissing: false, rMissing: false };
            }
        } else {
            // 已有基线
            if (lMissing || rMissing) {
                // 任一端缺失 → delete-pending（含双方缺失）
                action = {
                    rel, kind: 'delete-pending',
                    lMissing, rMissing,
                    baselineHash: B,
                    localHash: L, remoteHash: R,
                };
            } else if (L === B && R === B) {
                action = { rel, kind: 'ok', localHash: L, remoteHash: R, baselineHash: B, lMissing: false, rMissing: false };
            } else if (L === B && R !== B) {
                action = { rel, kind: 'stage', lMissing: false, rMissing: false, remoteHash: R, baselineHash: B, localHash: L };
            } else if (L !== B && R === B) {
                action = { rel, kind: 'publish', lMissing: false, rMissing: false, localHash: L, baselineHash: B, remoteHash: R };
            } else if (L === R) {
                // 双方改但结果相同（同内容双改）
                action = { rel, kind: 'ok', localHash: L, remoteHash: R, baselineHash: B, lMissing: false, rMissing: false };
            } else {
                action = { rel, kind: 'conflict', localHash: L, remoteHash: R, baselineHash: B, lMissing: false, rMissing: false };
            }
        }

        action.remoteHead = remoteHead;
        actions.push(action);
    }
    return { actions, remoteHead };
}

module.exports = { plan };

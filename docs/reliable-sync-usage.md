# 酒管可靠同步 · 离线维护 CLI 使用说明（预览）

> 首版交付形态：独立进程入口 `bin/reliable-sync.js`（`lib/reliable/cli.js`），与在线插件 HTTP 路由彻底分离。
> 本阶段仅为**本地分支离线维护预览**，不接入真实应用、真实凭据、真实远端；不运行 `install.sh`、不改现有安装/手机/真实聊天。

---

## 1. 命令总览

| 命令 | 作用 | 是否改写聊天 | 是否要求 `--offline-confirmed` |
| --- | --- | --- | --- |
| `init` | 本地初始化（写目标身份与空基线），**不写远端** | 否 | **是** |
| `status` | 只读输出 B/L/R 与 pending/stage/journal 摘要 | 否 | **否**（唯一免离线确认） |
| `push` | 发布本地快照到远端（构造 Git tree + commit + 普通 push） | 否（只读本地、只写远端） | **是** |
| `pull` | 拉取远端更新并**暂存**（不落地到聊天） | 否 | **是** |
| `apply` | 把暂存应用到本地聊天（备份 + 原子替换 + journal） | **是** | **是** |
| `recover` | 恢复未完成的 push / apply，可能重试应用文件并推进基线 | 可能：重试未完成应用 | **是** |

> `--offline-confirmed` 每次运行都必须重新声明，不持久化；它是**操作人声明**（已停止服务并关闭所有客户端），不是软件证明，操作人自行负责保证。除 `status` 外，所有命令（含 `init`/`recover`）都要求离线确认。

## 2. 用法示例

```bash
node bin/reliable-sync.js init \
  --repo-dir /path/to/repo \
  --data-root /path/to/data \
  --github-repo owner/repo --branch main \
  --offline-confirmed

node bin/reliable-sync.js push \
  --repo-dir /path/to/repo --data-root /path/to/data \
  --github-repo owner/repo --branch main \
  --offline-confirmed

node bin/reliable-sync.js pull \
  --repo-dir /path/to/repo --data-root /path/to/data \
  --github-repo owner/repo --branch main \
  --offline-confirmed

node bin/reliable-sync.js apply \
  --repo-dir /path/to/repo --data-root /path/to/data \
  --github-repo owner/repo --branch main \
  --offline-confirmed [--stage-id <id>]

node bin/reliable-sync.js recover \
  --repo-dir /path/to/repo --data-root /path/to/data \
  --github-repo owner/repo --branch main \
  --offline-confirmed
```

也可用 `--config <json>` 提供 `githubRepo/branch/commitAuthor/tokenFile`。

## 3. 核心语义（B/L/R 三向比较）

- **B** = 最近一次「已确认共同内容」的文件字节 SHA-256（持久于 `.git/dsr/state.json`）。
- **L** = 当前磁盘 `chats/**/*.jsonl` 实际字节的 SHA-256（一次原字节读取）。
- **R** = 固定远端提交 H 中该路径文件的字节 SHA-256。

| 情形 | 动作 |
| --- | --- |
| L=B 且 R≠B | 暂存 R（pull 侧） |
| L≠B 且 R=B | 发布 L（push 侧） |
| L=R | 确认共同内容，**逐文件推进 B**（含首次无 B 时建立共同基线） |
| L≠B 且 R≠B 且 L≠R | 冲突：保存 `.local`/`.remote` 双方快照并阻断，不自动选择 |
| 已有共同 B 时任一端缺失 | 删除待处理：阻断，不传播删除 |
| 首次无 B 的 L-only | 正常发布 L（建立新文件） |
| 首次无 B 的 R-only | 暂存 R（pull 侧新文件） |

**基线只在**发布成功且提交在远端可达、应用成功且校验通过、或 L=R 验证一致时逐文件推进。**只对成功确认已发布/已应用/已验证的快照推进 B**，不把未下载、未应用的远端变更当作已应用；只暂存不推进 B。

## 4. 私有状态（全部在 `.git/dsr/` 下）

```
.git/dsr/
  state.json            基线 B + 目标身份 + 最近已确认远端 H
  pending.json          push 前原子持久化的待确认提交（含原快照/原 B/L 快照/hash/H/身份/C）
  stage/<runId>/        pull 的候选内容 + stage.json
  conflict/<runId>/     冲突双方快照（SHA256(rel) 基名，独立 runId，不覆盖旧版本）
  snapshots/<runId>/    push 前原字节快照
  apply-active.json     apply 的**原子完整 manifest**（恢复唯一真相，rename 前落盘并读回验证）
  apply-journal.jsonl   逐文件 apply 审计日志（append-only，先 fsync，仅审计不用于恢复）
  backups/<runId>/      apply 前逐文件备份（读回校验）
  lock                  跨进程 repo 锁
```

所有快照/候选/备份/冲突路径用 `SHA256(rel)` + 独立 `runId`，`chats/a/b.jsonl` 与 `chats/a__b.jsonl` 不会互相覆盖，重复运行不覆盖旧版本。`git add '.'` 不可能提交 `.git/` 内内容。

### apply 原子 manifest（恢复真相）

- 改写任何聊天文件**之前**，先做全量预检 + 全量备份读回校验，再**原子写单份 `apply-active.json` 并读回验证**，最后才逐文件 CAS + 祖先检查 → 同目录临时文件原子 rename。
- `apply-active.json` 含 schema/runId/targetIdentity/stageId/remoteHead 及全部 entries（每条 rel、expectedBaselineHash、expectedLocalHash/expectedMissing、candidatePath/hash、backupPath/hash）。它是恢复的唯一真相；`apply-journal.jsonl` 仅审计，不作为唯一恢复依据。
- manifest 每条 entry 严格绑定：原文件缺失时 `backupPath`/`backupHash` 必须为 `null`；原文件存在时 `backupPath` 必须非空、且 `backupHash === expectedLocalHash`（备份即原内容）。写入后对**整份 manifest** 做规范化 JSON 读回比对（非仅 runId/条数），防半份/截断。
- 恢复：加载严格 schema manifest 并核对身份与每条持久 B（原 B 或 candidate），验证所有 candidate/backup 存在/哈希/路径，再分类 `current==candidate`（已应用→推进 B）/ `==expected`（待应用→从候选快照重试，每次 rename 前重新 CAS + 祖先检查）/ 第三种值（阻断，保留双方不覆盖）。全部落地后先原子落 B，再清所属 stage（仅 stageId 匹配），再写完成标志（fsync），最后清 active。
- 若 manifest 缺失但存在旧的不完整 plan，明确阻断人工检查，不自动恢复猜测、不自动删除。

## 5. 锁与并发

- **repo 锁**（`.git/dsr/lock`）：同一 repoDir 维护互斥；遗留锁不自动清理（持有者 PID 存活→拒绝；已死→报告遗留锁，人工清理）。
- **dataRoot 锁**（`<dataRoot 父目录>/.dsr-lock-<sha256(dataRoot)[:16]>`）：相同 dataRoot 的不同 repoDir 共享互斥；路径按 Windows 大小写归一，取锁前先校验数据根及祖先为真实目录（非 symlink/junction）。
- 锁创建前验证 repo 绝对路径从盘根到 repoDir 每个祖先都是真实目录，拒绝 symlink/junction（P1 三次第 7 条）。
- 只有 `status` 免离线确认；`init`/`recover`/`push`/`pull`/`apply` 都要求 `--offline-confirmed`。
- 统一 API 只暴露 `run`（加锁入口）与纯函数，不导出可绕过锁的 `cmd*`。
- 所有 push/pull/apply 在新操作前先处理或阻断活动 apply 事务，不绕过 active。

### 路径与读错误（数据保护边界）

- `fs.lstat` **仅 ENOENT 表示缺失**；EACCES/EIO 等其它错误一律抛出，绝不 catch-all 成 null/缺失。
- 所有维护写入、锁创建前，验证 repo 绝对路径从盘根至 `.git/dsr` 每个现有祖先都是真实目录，拒绝 symlink/junction；不存在的下层**逐段 mkdir 后重新 lstat 验证**（不在先 `ensureDir` 写出外部子目录后才拒绝 junction）。目标文件若存在必须普通文件且非链接。清理状态文件用 `fs.unlink` 单文件删除，绝不递归删除目录。
- apply 验证从 dataRoot 到 chats 每个目标父段，缺失父段仅在预期创建新聊天时逐段创建并验证；每次 rename 前重读 expected（含 missing）与祖先检查。
- `status` 只读 `refs/remotes`（不 fetch），恒标 `cached`；读取出错时 `remoteError` 如实暴露、`fileCount.remote` 为 `null`（明确 unknown），不以 `live`/`0` 伪装。

## 6. 恢复（recover）

- **pending**：有 commitId → 判定远端可达（`merge-base(commitId, origin/branch) == commitId`）；可达→逐文件推进 B；不可达→用 pending 原快照/原 B/新 R 三方重计划（**不读实时 L、不清 pending 后递归**），无法确认时阻断保留双方。恢复前先读回校验原快照 bytes == publishHash。首次无 B（B=null）且远端已存在不同内容 → 阻断，绝不覆盖（P1 二检第 1 条）。
- **apply**：基于原子完整 manifest（见上文），不是半 journal。current==candidate 已应用→推进 B；==expected 待应用→从候选快照重试（每次 rename 前重新 CAS + 祖先检查）；第三种值阻断保留双方。清理顺序（与正常 apply 一致）：**持久 B → 清所属 stage（仅 stageId 匹配）→ 写完成标志（fsync）→ 清 active**（可重复恢复）。

## 7. 已知边界（首版）

- 离线条件不可软件证明；哈希 CAS 与锁是附加防护。
- 不传播删除；不做 JSONL 自动合并；无自动冲突解决（只阻断并保留双方）。
- Windows 上 `rename` 覆盖语义、目录 fsync 与 POSIX 有差异；本目录（Windows）结果不等于 Android/Termux 或真实应用。
- 首次远端空分支 → 报「需先初始化」，不把 fetch 失败当空仓库。

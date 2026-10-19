# 酒管可靠同步核心 · 架构说明（本地分支离线维护 CLI 预览）

> 目标：新增可靠同步核心与维护入口，**不重写现有插件**。本文档按**已实际实现的架构**整理，不再标注「待核准」状态。
> 首版范围：仅调用者指定的一个用户数据根下的 `chats/**/*.jsonl` 一对一角色聊天记录（群聊正文位于其他目录，首版不包含），原字节保留，不解析后重写消息，不自动合并 JSONL，不传播删除。其余类别明确「暂不支持」，且不得默默走旧引擎。

---

## 0. 术语与符号

| 符号 | 含义 |
| --- | --- |
| B | 基线（baseline）：最近一次「已确认共同内容」的文件字节 SHA-256，持久化于本地状态 |
| L | 本地快照：当前磁盘 `chats/**/*.jsonl` 实际字节的 SHA-256 |
| R | 远端快照：固定远端提交 H 中该路径文件的字节 SHA-256 |
| H | 本次操作「固定的远端提交」，作为新提交的唯一父 |
| 内容哈希 | 对文件**原始字节**做 SHA-256（十六进制），与 Git object id 无关，用于逐文件三向比较 |

三向（three-way）比较规则：

1. `L = B` 且 `R ≠ B` → R 改：可**暂存** R（待用户离线确认后 apply）。
2. `L ≠ B` 且 `R = B` → L 改：可**发布** L。
3. `L = R` → 内容一致：可确认共同内容（推进 B 到该值）。
4. `L ≠ B` 且 `R ≠ B` 且 `L ≠ R` → 双方改且不同：**冲突**，保存双方两份快照并报告，不自动选择。
5. 首次无 B 且同路径异内容（首次 L ≠ R）→ 报冲突。
6. 任一端缺失（有登记记录的路径一端消失）→ 删除待处理，阻断，禁止传播/恢复/镜像删除。

---

## 1. 目标与硬边界

### 1.1 交付形态

- 一个**离线维护 CLI**（独立进程入口 `lib/reliable/cli.js`，命令入口 `bin/reliable-sync.js`），与在线插件 HTTP 路由彻底分离。
- 所有改写聊天或推进状态的操作（`push`、`pull`、`apply`、`recover`、`init`）**必须**要求用户以显式参数声明「已停止服务并关闭所有客户端」（如 `--offline-confirmed`，每次运行都重新声明，不得持久化该声明）。**只有 `status` 免离线确认。**
- 在线 API 在 `init` 最前**明确返回「预览插件不可启用」**，使原插件的危险路由（旧 pull/force/restore 写入口、force-push、ours/theirs 冲突回写、在线 backup restore）不被注册。

### 1.2 不做的事（明确边界）

- **不实现假在线锁**：不做浏览器按钮锁、哈希检查或重启服务来「宣称」排除了应用写入。离线条件由操作人负责保证。
- **不传播删除**：任何删除只报告，不 push、不 apply、不镜像。
- **不自动合并** JSONL，不做 Git 文本 merge，不按时间戳/较新覆盖。
- **不引入**新的大型依赖：仅复用现有 `simple-git`、`fs-extra`、`crypto`；Git 操作走 `git hash-object`/`ls-tree`/`read-tree`/`update-index`/`write-tree`/`commit-tree`/`push` 原始命令。
- 远端空分支 → 明确报「需先初始化」，不得把 fetch 失败当空仓库。
- 冲突只阻断并保留双方，无自动解决。

### 1.3 私有状态位置

- 全部私有状态、journal、备份、冲突快照、暂存位于 `.git/` 下的维护目录（`dsr/`，见 §4），**绝不可能**被 `git add '.'` 提交。
- 维护目录落在 `.git/` 内，则 `git add('.')` 也不会扫到（`.git` 目录对 index 不可见）。

---

## 2. 模块划分

实际实现位于 `lib/reliable/`（不触碰既有 `lib/*.js`）：

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| ① 内容哈希与扫描 | `lib/reliable/hash-scan.js` | 逐文件 SHA-256（原字节）、路径安全校验（符号链接/越界/设备名/ADS/大小写碰撞/缺失阻断）、目录枚举 |
| ② 状态与 journal | `lib/reliable/state.js` | B/R/状态持久化、pending/stage/apply-journal 读写、原子写（临时文件 + rename + fsync）、目标身份绑定、锁 |
| ③ 规划器 | `lib/reliable/planner.js` | 三向比较、生成每文件动作（publish / stage / conflict / delete-pending / ok）、固定 H |
| ④ Git 对象与传输 | `lib/reliable/git-tree.js` | fetch、`hash-object --no-filters`、`ls-tree -rz` 枚举、临时 index 构造 tree、`commit-tree` 以 H 为唯一父、普通 push |
| ⑤ 应用器 | `lib/reliable/apply.js` | 离线确认校验、备份、逐文件原子替换、apply-journal、失败恢复 |
| ⑥ 编排 | `lib/reliable/orchestrator.js` | 命令编排（`init`/`push`/`pull`/`apply`/`status`/`recover`）、离线门禁、pending 恢复 |
| 入口 | `lib/reliable/cli.js` | 参数解析、命令分发 |

> 复用：凭据与超时 fetch 全部走 `git-ops.gitWithEnv`（含 askpass、`GIT_TIMEOUT_MS`、重试）。**不继承**旧 `pullRepo`/`pushRepo` 的全目录覆盖逻辑。

---

## 3. 关键机制（按实现）

### 3.1 内容哈希与扫描

- 每文件 `bytes` 与 `hash` 来自**同一次 read**，`keepBytes` 时直接给出 buf，不二次读；`hash-object --no-filters` 后校验实际写入 blob 的 SHA-256 与期望一致，防「读 A 写 B」。
- 路径安全：拒绝 `..`、绝对路径、反斜杠越界、NUL、Windows 设备名（`CON.jsonl`/`NUL.txt`/`COM1.jsonl` 及 `COM¹/²/³`、`LPT¹/²/³`）、任何段冒号 ADS、尾随空格/点、段内非法字符 `<>"|?*` 与控制字符 0x01–0x1F、大小写碰撞（`A.jsonl` vs `a.jsonl`、`chats/Actor/a.jsonl` vs `chats/actor/a.jsonl` 等逐段前缀折叠）。
- 校验数据根及所有祖先非符号链接/junction，扫描失败的根缺失、符号链接一律阻断，不当空目录。

### 3.2 远端 tree 与 blob

- `git ls-tree -rz` 用 `execFile` + `encoding:'buffer'` 直接枚举，`TextDecoder('utf-8',{fatal:true})` 严格解码路径；非法 UTF-8 文件名拒绝，不替换、不遗漏。
- 后缀筛选前先校验 `chats` 根（必须 `type==='tree'` 且 `mode==='040000'`，普通 blob/symlink 一律阻断）及全部后代条目的 mode/type（仅普通 blob 参与 planner，symlink/submodule/gitlink 阻断）。
- `cat-file blob` 用 `execFile` + `encoding:'buffer'` 读原字节（保留 CRLF/BOM/首尾空白），非法 UTF-8 校验拒绝；只有 tree 证实缺失才返回 null，读取错误不得当 null。

### 3.3 构造 Git tree

`push` **不下载写真实文件**，仅用 Git 对象构造 tree：

1. `fetchRemote` 固定 `H = origin/<branch>`（远端无分支 → 报「需先初始化」）。
2. 临时 index `read-tree <H>`，**继承 H 全部条目**，未改远端文件原样保留。
3. 对本轮「确认可上传」的每个文件：单次读 bytes → `hash-object --no-filters -w` → `cat-file blob` 读回逐字节比对 → `update-index --add --cacheinfo 100644,<blobId>,<relPath>`。
4. `write-tree` → `treeId`；`commit-tree <treeId> -p <H> -m <msg>` → `commitId`（父唯一为 H）。
5. 普通 `git push origin <commitId>:refs/heads/<branch>`，**禁止 force**。远端变化导致非快进 → 失败保留状态，下次重新 fetch/比较。

> 分支名用 `git check-ref-format` 校验，拒绝以 `-` 开头等注入；不 shell 插值。

### 3.4 基线前移规则

基线 B 只在以下**充分条件**下逐文件、原子落盘推进：

- **发布成功**：push 成功且 commit 在配置分支上可达 → `B = 已发布内容哈希`。
- **应用成功**：apply 逐文件完成且校验通过（当前磁盘字节哈希 == candidateHash）→ `B = candidateHash`。
- **验证一致**（L=R 且无冲突、无删除）→ `B = L`。

**禁止**：只上传（push 失败/未确认）不得记共同基线；只暂存不得把 R 视为已应用；push 后状态保存失败 → 下次先按 pending/journal 恢复未知结果；目标身份改变 → 必须重新 `init`。

### 3.5 pending 与恢复

- `pending.json` 在 push 前原子持久化，含重放所需全部信息（父 H、treeId、commitId、edits、phase）。
- `recover` 按可达性判定优先，**先恢复未知结果**，不覆盖原 pending：commit 在分支上可达 → 已发布，逐文件推进 B；不可达 → 重新 fetch 得新 H′ 重跑规划；无 commitId → 按原 edits 重放或重规划。
- 恢复成功后写回 state 并清 pending（原子）。不因工作区无改动而跳过。
- 活动事务（无完成标志）才参与恢复，历史 plan 不算恢复项。

### 3.6 apply 与备份

- `apply`：读 stage → 重新核对（目标身份、基线版本、预期本地哈希/缺失、候选哈希）→ 备份当前字节（失败 → 拒绝）→ 逐文件「同目录临时文件 + 原子 rename + fsync」→ append apply-journal → 逐文件推进 B。
- 候选内容固定为一次读取的 bytes，写 temp 与哈希校验都用这一份；每次 rename 前再次核对当前磁盘仍为 expected（或仍缺失）且祖先非符号链接。
- apply 中断：依据 journal 识别已应用/待应用项，可重复恢复；第三种编辑（中断后磁盘又变）→ 阻断保留双方，不覆盖。

---

## 4. 持久状态结构（全部在 `.git/` 下）

```
.git/
  dsr/
    state.json          # B 表 + 目标身份 + 最近一次已确认远端 H
    pending.json        # 待 push 的提交（push 前原子持久化）
    stage/              # 暂存的远端候选（pull 只暂存）
      <relPath>.content   # 候选原字节
      stage.json          # 暂存元数据
    conflict/           # 冲突双方快照
      <relPath>.local
      <relPath>.remote
    apply-active.json   # 活动 apply 事务完整 manifest（含候选哈希、预期本地状态、备份位置）
    apply-journal.jsonl # 逐文件 apply 结果（append-only，含完成标志）
    backups/            # apply 前逐文件备份
      <runId>/<relPath>
    lock                # 互斥锁文件（PID + 时间戳；遗留锁人工处理）
```

> 以上均在 `.git/` 下，`git add('.')` 或 `git add ./` 不可能将其纳入 index。

---

## 5. 无法可靠实现的边界

1. **离线条件本身**：无法通过软件证明「服务已停止、客户端已关闭」。只能要求显式声明 + 互斥锁 + 哈希 CAS 兜底；真实环境（Android/Termux、真实酒管应用）未接入，无法在本目录验收。
2. **跨进程写入窗口**：即使持锁，同一数据根若被外部进程直接写文件，仍可能发生「校验通过后、rename 前」的竞态；哈希 CAS 是附加防护，非绝对。
3. **原子性上限**：`commit-tree`+`push` 与本地 state/pending 落盘之间没有分布式事务；只能靠可达性判定 + 幂等重放逼近「恰好一次」，无法严格保证。
4. **删除语义**：首版完全不传播删除，远端永久保留已删除文件的最后一版；如需回收需后续版本专门设计。
5. **并发多写者**：两设备同时 push，后者必非快进失败；无自动合并，需人介入重跑规划。
6. **文件系统原子 rename 语义**：Windows 与 POSIX 的 `rename` 覆盖行为存在差异；本目录（Windows）结果不等于 Android/Termux 或真实应用。
7. **Git 版本差异**：`hash-object --no-filters`、`--cacheinfo`、临时 `GIT_INDEX_FILE` 依赖 git 2.x 行为。

> 本文档只说明设计与已实现机制，**不声称上述边界已被完全证实安全**；测试覆盖与验收结果以 Codex 的最终报告为准，此处不填写最终测试计数。

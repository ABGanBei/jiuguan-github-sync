# 同步引擎基线复现结果（baseline-results）

## 概述

本基线使用**真实产品引擎**复现 `github-data-sync` 插件的同步漏洞：

- `lib/sync-engine.js`（`pushData` / `pullData` / `copyFileIfChanged` / `copyDirIfChanged`）
- `lib/git-ops.js`（`pullRepo` / `pushRepo` 等）
- 真实 `git` 可执行文件

远端并非真实 GitHub，而是被 `url.<local-bare>.insteadOf` 重写为**本地 bare 夹具**的合成仓库。
调用顺序**等价于产品 `index.js executePush`**：先 `gitOps.pullRepo`（预拉取）再 `syncEngine.pushData`，
正是被测漏洞的顺序（先拉取、后把 `data` 目录的陈旧字节复制回 shadow、再提交推送）。

- 执行入口：`node test/baseline-minimal.js [--keep]`
- 证据输出：`test-artifacts/baseline-results.json`
- 父进程创建 `test-artifacts/minimal-<uuid>/`，子进程隔离环境后运行；`--keep` 仅保留运行目录（父进程**永不自动删除**运行目录）。

### 实测环境（真实，非 mock）

| 项 | 值 |
|---|---|
| Node.js | v24.20.0 |
| Git | 2.49.0.windows.1 |
| 产品版本 | 1.1.0 |

### 边界声明

- **非 HTTP/UI 实测**：未起 HTTP/UI、未初始化产品、未访问真实应用或任何真实凭据。
- 远端内容一律用 `git --git-dir <bare> show main:<path>` 从 bare 对象库读取，绝不读 bare 工作树。
- 环境隔离：`HOME`/`USERPROFILE`/`TMP`/`TEMP` 指向 `test-artifacts/minimal-<uuid>/`，
  空 `.gitconfig`，`GIT_CONFIG_NOSYSTEM=1`，`GIT_ALLOW_PROTOCOL=file`（仅允许 file:// 协议），
  清除 `GITHUB_TOKEN`/`GH_TOKEN`/`ST_GITHUB_SYNC_TOKEN` 等全部令牌与 `GIT_ASKPASS`。
- 每个 shadow 仓库各自配置 `url.file:///<bare>.insteadOf = https://github.com/fixture/<n>.git`（每场景恰好一条）。
- 未做任何网络 push。

## 结果摘要

| 场景 | 判定 | 说明 |
|---|---|---|
| 1 | safe-pass | 正常同步字节一致（正控制） |
| 2 | expected-vulnerability | B 预拉取后仍用陈旧 a 覆盖远端，a 倒退 |
| 3 | expected-vulnerability | 同文件冲突静默覆盖，无 Git conflict |
| 4 | expected-vulnerability | B 推送后远端 new 被删除 |
| 5 | expected-vulnerability | hook 拒绝后 ahead=1，无新改动重试仍 ahead=1 / 远端仍旧 |
| 6 | expected-vulnerability | size+mtime 相同被漏检，新字节未到远端 |

汇总：`safePass=1`，`expectedVulnerability=5`，`harnessError=0`，`scenariosRun=6`，exit code `0`。

## 各场景详情

### 场景 1（safe-pass）：A 编辑 a → 推送 → B 拉取，本地 a 字节等于远端

正常同步的正控制。A 推 a 的新编辑，B 拉取后本地 a 与远端字节一致、未改动的 b 也一致。

### 场景 2（expected-vulnerability）：B 预拉取后仍用陈旧 a 覆盖远端，a 倒退

A 改 a 并推送；B 改 b 后推送。`ops.push` 先 `pullRepo(B)` 把 A 的新 a 拉进 B 的 shadow，
随后 `pushData(B)` 把 B 数据目录里**陈旧的 base a** 复制回 shadow 并提交推送。
结果：远端 a 倒退为 B 的旧副本（base），b 为 B 的新编辑。

### 场景 3（expected-vulnerability）：同文件冲突静默覆盖，无 Git conflict

A、B 各自把 a 改成不同内容后分别推送。B 预拉取后其数据目录的 a 覆盖远端 A 的 a，
最终远端 a 为 B 的版本、A 的版本静默丢失，且**无 merge commit、无冲突标记**。

### 场景 4（expected-vulnerability）：B 推送后远端 new 被删除

A 新增 `new.jsonl` 并推送；B 只改 b 后推送。B 预拉取拿到 new，但 `copyDirIfChanged`
把「源目录中不存在的 new」当作应删除项，从 shadow 移除并提交。结果：远端 new 被删除。

### 场景 5（expected-vulnerability）：hook 拒绝后无新改动重试仍 ahead=1

推送被 bare 的 pre-receive hook 拒绝一次 → 本地 ahead=1（提交已生成但未推送）。
移除 hook 后、无新改动再次推送：`copyFileIfChanged` 判定「未变化」→ `pushData` 返回
`skipped` 且不调用 `pushRepo`，于是已提交未推送的改动**永远不会被 flush**。
结果：ahead 仍为 1，远端 a 仍旧。

### 场景 6（expected-vulnerability）：size+mtime 相同被漏检，新字节未到远端

把 real 与 shadow 的 a 都 `utimes` 到同一整数秒（1700000000），再用等长替换
（`'a-base'` → `'a-edit'`，两词长度相同）写入异内容并恢复 mtime。
`copyFileIfChanged` 只看 `size === size && mtimeMs === mtimeMs`，判定「未变化」→ 跳过复制。
结果：新字节未到远端，远端 a 仍是 base 字节。

## 被测漏洞清单（对应产品代码位置）

| 漏洞 | 触发条件 | 产品位置 |
|---|---|---|
| 陈旧覆盖（a 倒退） | 预拉取后 data→shadow 复制未按内容去重 | `sync-engine.js` `copyFileIfChanged` |
| 静默丢失冲突 | 同文件等长（或 mtime 相同）时跳过复制 | `sync-engine.js` `copyFileIfChanged` |
| 误删远端文件 | `copyDirIfChanged` 将源目录缺失项当作删除 | `sync-engine.js` `copyDirIfChanged` |
| 漏推已提交改动 | `pushData` 无变化时跳过 `pushRepo` | `sync-engine.js` `pushData` |
| size+mtime 漏检 | 仅比较 size 与 mtime 判等 | `sync-engine.js` `copyFileIfChanged` |

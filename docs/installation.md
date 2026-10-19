# 酒管同步 · 安装说明（1.3.0-preview.1 界面集成预览）

本文档说明如何把本仓库安装为酒管宿主的**服务端插件**（以及可选的前端扩展）。

> 范围：**一对一角色聊天**的 GitHub 同步（群聊正文位于其他目录，首版不包含）。
> 本分支为「1.3.0-preview.1 界面集成预览」。已在**官方 1.17 隔离宿主 + 合成数据 + 本地 bare** 上完成验收（扩展 URL 安装、后端安装器 `--apply --install-deps`、UI 保存 token 清空不回填、连接/推送、另一端合成修改、拉取只暂存、安排并重启 apply、续聊保存、续聊后再次 push（bare 远端与宿主字节完全相同、`swipes2`/`swipe_id1`/`swipe_info`/`peerNote` 保留）、chat-manager 打开同步分支正文后 `/checkpoint-exit` 回主线等；分支场景仅限定该合成主线/分支样本）；但**真实用户安装、真实手机（Termux 实机）、真实 GitHub PAT、真实 GitHub bootstrap 的 HTTP 鉴权 push、加密均未验收**。本仓库**不声称**已在本机真实数据部署、或真实 GitHub 已发布。

## 一、两种安装方式

酒管插件分两部分，分别安装：

1. **前端扩展**（根 `manifest.json`，js=`client/index.js`、css=`client/style.css`）：可在酒管「扩展」设置里**粘贴仓库 URL** 安装，或手动复制到前端扩展目录。前端安装器**不会**自动 `npm install` 或安装服务端。
2. **服务端插件**（`package.json` 的 `main`= `index.js`）：需要执行一次后端安装脚本，见下文。

## 二、后端一次性安装脚本（Windows / Termux 通用）

脚本入口是 Node 脚本 `bin/install-plugin.js`，`install.sh` 只是它的薄封装（正确引号转发参数）。

### 基本用法

首装请先 `git clone` 本仓库并 `cd` 进入仓库目录，再执行安装器：

```bash
git clone <本仓库地址> && cd <仓库目录>

# Windows PowerShell / Termux 通用（Node >= 20）
node bin/install-plugin.js --app-dir <酒管应用目录> [--enable-server-plugins] [--install-deps] [--apply]
```

或通过薄封装（POSIX shell）：

```bash
bash install.sh --app-dir /path/to/app [--enable-server-plugins] [--install-deps] [--apply]
```

### 选项

| 选项 | 说明 |
| --- | --- |
| `--app-dir <路径>` | 酒管应用根目录（必须含 `server.js` 与 `package.json`）。 |
| `--enable-server-plugins` | 将 `config.yaml` 顶层 `enableServerPlugins` 由 `false` 改为 `true`（幂等）。 |
| `--install-deps` | 在新插件目录内执行 `npm ci --omit=dev` 安装依赖。 |
| `--apply` | 真正写文件；**默认是 dry-run**，只打印计划、不写任何文件。实际安装必须显式加 `--apply`。 |

### 行为要点

- **默认 dry-run**：列出确切的 source / target / config 计划，不写任何文件；必须显式 `--apply` 才落盘。
- **源复制**：源目录 = 本仓库根，复制到 `<app>/plugins/jiuguan-github-sync`，排除 `.git`、`node_modules`、`test-artifacts`、`research`、`outputs` 及令牌文件（任何 basename 以 `token`/`pat` 开头、`.env*`、`credentials*` 等）。
- **不覆盖**：目标目录 `jiuguan-github-sync` 已存在即明确报错（更新属另一阶段，本安装器不做递归覆盖）。
- **安全校验**：源目录本身非 symlink 且其祖先真实无链接；目标祖先（盘根 → `app` → `app/plugins`）无 junction/symlink；`app` 的 `server.js` / `package.json` 必须存在；目标必须落在 `app/plugins` 内（不靠目录名含英文判断）；`plugins` 父目录缺失时安全逐段创建（每段创建前校验父链真实非链接）。
- **config.yaml**：仅严格处理**单行顶层裸键** `enableServerPlugins: false → true`；已 `true` 幂等；缺 key / 重复键 / **加引号键名（`"enableServerPlugins"` / `'enableServerPlugins'`）** / mapping 复杂形式 / 非顶层缩进 / 复杂值 / 混合注释同名一律拒绝，不重写整个 yaml。**配置预检在复制之前完成**，任何配置问题都在写任何文件前即报错（不留半份 target）。改写前先 `copy` 备份到唯一文件名（`config.yaml.bak-<时间戳>`），再用临时文件 + rename 原子替换。**只有加 `--enable-server-plugins` 才改 config.yaml。**
- **依赖安装**：只在显式 `--install-deps` 时执行 `npm ci --omit=dev`。Windows 上通过 `node <npm-cli.js>` 安全执行（先定位可信的 `npm-cli.js`，用 `process.execPath` 直接运行，**不** spawn `npm.cmd`、不拼接 shell 字符串、无用户文本注入）。定位覆盖：npm 注入的 `npm_execpath`、node 同目录 `node_modules/npm/bin/npm-cli.js`、Windows 全局前缀，以及 **Termux 常见布局** `$PREFIX/lib/node_modules/npm/bin/npm-cli.js`（node 位于 `$PREFIX/bin/node`）。**执行顺序为「复制 → 依赖 → 启用配置」**：依赖失败时保留新 target 但 config.yaml 原字节不变，脚本会准确输出插件路径与**手工恢复指引**（进入保留目录用 `node <npm-cli.js> ci --omit=dev` 装依赖，再在宿主停止时手工改 config.yaml 并备份；本脚本**不会**升级或递归删除该保留目标，也不建议“重跑本脚本”——target 已存在会报 `TARGET_EXISTS`）。若原 config.yaml 已为 `true`，会明确提示「原字节保留但可能仍已启用，依赖完成前不要启动宿主」。不加该 flag 时，脚本会提示你自行在插件目录执行 `npm ci`。

### 安装后

1. 关闭所有旧客户端标签页。
2. **重启酒管**，并在浏览器重新打开页面（旧标签页内存未清，不能无感在线原位应用）。
3. 在扩展设置里配置仓库 owner/repo、branch 与 PAT（PAT 只写后保存即清空，不入配置/日志/URL/进程参数）。

### 隐私说明（使用前必读）

- **使用专门的私有数据仓库**；不要把聊天同步进其他代码/文档仓库。
- **令牌用 fine-grained PAT（细粒度令牌）**，只勾选该仓库的 `Contents` 读/写即可（`Metadata` 由 GitHub 隐式只读）。**不需要**组织/账户/其它仓库权限，也**不要**用 classic 全仓库权限令牌。
- 确认该仓库**没有 ruleset 保护**阻止普通 push。
- **私有仓库访问控制 ≠ 端到端加密**：聊天以**明文**进入 Git 历史；删除文件不会删除旧 commit 里的内容；本版本**未加密、未做历史清理、无旧版 GUI 恢复**，有强隐私需求请先不要同步真实数据。

### 日常使用流程（一次后端安装 + 前端 URL 安装之后）

- **上传已保存聊天**：在扩展界面点「上传已保存聊天」，把磁盘上已保存的一对一聊天正文推到远端（push）。
- **检查下载只暂存**：点「检查下载」只把远端内容**暂存（stage）**到本地，**不立即改写聊天**（无在线原位 apply）。
- **安排重启应用**：点「安排重启应用」绑定当前 stage 与目标身份/摘要，随后**关闭所有客户端标签页 → 重启酒管 → 重新打开页面**，插件才会在启动早期窗口真正应用暂存内容。

> 上述「前端 URL 安装 + 一次后端安装 + 日常上传/下载暂存 → 关所有标签 → 重启 apply」是完整闭环；任一步省略都不会产生“无感在线覆盖”。

## 三、前端扩展 manifest（可粘贴仓库 URL）

根 `manifest.json` 为前端扩展声明（js=`client/index.js`、css=`client/style.css`）。上传 GitHub 源码后，可用实际仓库 URL 在酒管扩展页粘贴安装。

> 说明：本文档不创建任何真实 GitHub 仓库；下面的 URL 仅为占位，需在上传源码后替换为实际地址。

```
（占位）https://github.com/<owner>/<repo>
```

## 四、已知边界

- 本目录（Windows）测试结果不等于 Android/Termux 或真实酒管应用；真实环境未接入验收。Termux 的支持目前仅为**设计 + 合成路径测试**（如 `$PREFIX/lib/node_modules/npm/bin/npm-cli.js` 定位），**未实机**。
- 前端安装器不能自动 npm / 安装服务端；服务端必须跑一次本安装脚本。
- 仅一对一角色聊天；群聊正文首版不包含；角色需两端同名配置，删除不传播。
- **真实 GitHub bootstrap 的 HTTP 鉴权 push 尚未实测**：本地 bare 仓库功能与「HTTP fetch 合成鉴权」分别验证，尚未在真实 GitHub 端到端打通。真实 GitHub PAT、真实手机（Termux 实机）均未验收。
- 本仓库**不声称已做加密**：令牌经独立 secrets 存储与 `GIT_ASKPASS` 传递、不进日志/URL/参数，但并非加密存储。
- **收据（receipt）窄窗口限制**：应用已完成（stage/active 已清）但落盘收据前崩溃的窗口内，下次启动会保留安排并提示「无法确认，可在 UI 取消」，**不从历史 complete 记录猜测成功**（有意保留的产品限制）。

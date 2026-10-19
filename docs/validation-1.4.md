# 1.4.0-preview.1 验证记录

日期：2026-10-19。此版本是统一安装与设置向导预览版；本记录区分自动化验证和实际设备验收。

## 已验证的范围

测试环境：Windows，Node.js 20.19.5、npm 10.8.2、Git 2.49.0.windows.1。全部使用隔离目录、合成聊天、模拟 GitHub API 或本地 bare 仓库，没有接触用户真实安装、聊天、PAT 或私有数据仓库。

| 测试入口 | 通过 | 跳过 | 主要内容 |
| --- | ---: | ---: | --- |
| `test/reliable-transport.test.js` | 20 | 1 | 并发、重试、Git 传输和凭据边界；一项受 Windows 文件系统限制而跳过 |
| `test/reliable-sync.test.js` | 29 | 0 | 三方比较、冲突、暂存与恢复 |
| `test/focused-safety.test.js` | 12 | 0 | 路径、链接、并发和故障保护 |
| `test/reliable-cli.test.js` | 4 | 0 | 独立命令行入口 |
| `test/online-snapshot.test.js` | 10 | 0 | 上传快照、锁和未确认上传；检查更新不代为重试上传 |
| `test/integration-server.test.js` | 34 | 0 | 用户隔离、配置、权限和应用门禁 |
| `test/client-contract.test.js` | 32 | 0 | 前后端协议与界面门禁 |
| `test/installer.test.js` | 18 | 0 | 保留的旧安装器接口 |
| `test/integration-runtime.test.js` | 8 | 0 | 插件生命周期与运行时 |
| `test/startup-safety.test.js` | 7 | 0 | 启动期应用与执行凭据 |
| `test/worker-safety.test.js` | 7 | 0 | 子进程、超时和锁 |
| `test/wizard-client.test.js` | 16 | 0 | 三步设置、按钮状态、自动检查和未确认上传提示 |
| `test/setup-service.test.js` | 15 | 0 | GitHub 固定接口、私有性验证、预检和状态记录 |
| `test/setup.test.js --keep` | 60 | 0 | 统一安装、升级、交互、回滚、依赖校验和断电恢复 |
| `test/installer-adversarial.test.js` | 8 | 0 | 真实 rename 后强制退出、新进程恢复、恶意事务记录与配置并发修改 |
| `test/build-release.test.js` | 14 | 0 | ZIP/TAR.GZ 的文件集合、字节、CRC 和路径校验 |

合计 294 项通过、1 项跳过、0 项失败。这是分套验证结果汇总，不表示额外重复执行过一次完整 `npm test`。`npm run check`、`npm run check:reliable`、`npm run check:integration` 及 `git diff --check` 通过。

测试结果保存在本地 `test-artifacts/`，不随代码或发行包上传。安装器的依赖故障注入测试使用 fake npm；下面另列实际依赖安装演练。

## 官方宿主隔离演练

在官方 1.17 隔离源码实例上完成：

1. 使用外置配置和独立数据、用户主目录，真实执行统一安装及 `npm ci --omit=dev`（仅使用已有离线缓存）。
2. 一次安装 37 个后端运行文件和 3 个前端文件；重复计划识别为无需安装。
3. 启动宿主，实际加载一个后台插件；health 接口返回版本 `1.4.0-preview.1` 和设置向导、预检、历史状态等能力。
4. 浏览器打开实际扩展面板，检查三步设置、GitHub 网页链接、两个主按钮及未配置时的门禁；没有填写 PAT。
5. 停止隔离服务后执行回滚，恢复原后端、撤回本次首装前端，保留新版于隔离目录；重复回滚不再修改。

本次 1.4 浏览器演练覆盖安装和首次设置界面。聊天接收、启动期应用和续聊保存有原集成基线及本次自动化回归证据，本次没有重做真实 GitHub 上的双设备聊天演练。演练后的修改仅纠正旧扩展处理提示文案，并重新执行安装器回归。

ZIP 与 TAR.GZ 发布包分别读回校验完整文件集合及字节，附 SHA256。另验证过 WSL Info-ZIP 生成的 ZIP；WSL 没有 Node.js，这不构成 Linux Node 或 Termux 运行验收。

## 核心改动与协作

复用现有三方比较、冲突保护、暂存和启动期应用逻辑。可靠同步核心仅新增一个集成层可选门禁：取得锁后，若检查更新遇到未确认上传则停止，要求用户点击上传明确重试。独立 CLI 保留原恢复语义。该变化有快照和界面测试覆盖。

Codex 负责同步核心、集成、交叉审查和验收；DSH 使用实际返回的 `deepseek-v4.1-flash` 参与边界明确的测试工作，产出经 Codex 修正夹具并独立运行。没有让 DSH 的报告替代运行结果。

## 尚未验收与保留限制

- Android/Termux 真机安装、休眠恢复、实际手机目录及 npm 兼容性。
- 真实 GitHub PAT、私有仓库的初始化/推送权限、组织审批及分支保护规则。
- 两台真实设备的完整同步及聊天继续保存。
- 自动发现所有安装目录、自动停止/重启宿主、在线替换活动聊天；这些不属于本版能力。
- 只同步当前用户已保存的一对一聊天正文；两端角色卡实际文件名必须一致。
- 仓库内容和 Git 历史为明文，秘密存储本身未加密；私有仓库不是端到端加密。

普通用户从[简明使用说明](quickstart.md)开始；首次请先备份并在独立测试实例演练。无法确认配置、目录、冲突或应用状态时保持阻断，不以自动覆盖绕过。

# 酒管同步集成合同（2026-10-19）

用户授权继续实现可安装、可在酒管界面操作的产品。DSH写产品代码和测试，Codex负责审查验收。仅本地隔离开发，不改真实安装/聊天/PAT，不创建GitHub仓库或互联网推送。

## 安装与界面

根manifest.json为前端扩展（js=client/index.js css=client/style.css）；根package.main=index.js为服务端插件。同仓库分别装到前端扩展目录及宿主plugins。前端可粘贴仓库URL安装；一次性后端安装脚本启用官方enableServerPlugins。不能声称前端安装器可自动npm/安装服务端。

界面提供仓库owner/repo、branch、PAT密码框（只写保存后清空）、自动检查默认关闭、保存/连接/上传/下载/安排重启应用/取消安排/状态/错误。仅一对一聊天正文。下载仅暂存，应用须关闭其他客户端并重启后重新打开，UI明确告知。

## 核心

显式executionMode=online-snapshot只允许init/status/push/pull，操作真实dataRoot；不做mirror、不伪造offlineConfirmed。遇active apply或未complete计划仅阻断，不调用apply恢复或写聊天；仅未知push pending可恢复。默认offline模式不变；CLI不暴露online模式参数。

## API（/api/plugins/github-data-sync）

成功统一{success:true,...}，错误{success:false,code,error}。无token、原始堆栈或系统路径。

- GET /health → {success:true,version,capabilities:{onlineSnapshot:true,startupApply:true},startupApplyOnly:true}
- GET /config → {success:true,config:{githubRepo,branch,autoCheckEnabled,autoCheckMinutes},hasToken}
- PUT /config：仅githubRepo/branch/autoCheckEnabled/autoCheckMinutes/token。空token保留。已有state/pending/stage时拒绝换目标，不清历史。
- POST /connect {initializeEmptyBranch?:boolean} → {success:true,connected:true,initializedRemote}。新repo创建本地，缺分支只在明确true时bootstrap普通push，不force。
- POST /push → {success:true,result:coreResult}
- POST /pull → {success:true,result:coreResult}，只暂存。
- POST /schedule-apply {stageId,clientsWillBeClosed:true} → {success:true,scheduled:{stageId}}。精确绑定当前stage及targetIdentity/候选摘要，要求用户关客户端声明，不能传路径/offlineflag。
- POST /cancel-apply → {success:true,cancelled:true}，只清安排，不删stage备份。
- GET /status → {success:true,status:{configured,connected,busy,stageId,stagedFiles,scheduledApply,lastOperation,lastError,conflicts,core,remoteSource}}，未配置正常响应，cached真实标注。

## 真正应用

插件init在官方1.17 loadPlugins await窗口、listen前处理显式安排的stage；不是每次启动自动应用全部stage。必须校验相同stageId/targetIdentity/摘要、原B和真实L，沿用核心备份/manifest。失败保留intent/stage/旧B；不能用当前L改写expected绕过。

官方loader会吞init异常，故部分apply失败存在active manifest时必须真正阻止宿主继续启动（明确进程非零退出或安装的启动wrapper），不能仅throw。未改聊天的预检失败可记录阻断并继续服务。禁止HTTP调用startup apply、任意命令或自动重启。故障退出需在合成子进程验证。

startup-only不能证明旧标签页内存已清，必须明确关旧客户端并重启后重新打开，不声称无感在线原位应用安全。

## 后端安全

只取req.user.profile.handle与req.user.directories.root，并验证root与globalThis.DATA_ROOT/handle一致。无身份401，不回退默认用户。禁止HTTP传handle/dataRoot/repoDir/tokenFile/remoteURL/env/command/offlineConfirmed。

每用户独立repo/config/锁；存储键SHA256(全局dataRoot+handle)，根在OS个人目录独立.jiuguan-github-sync。token在独立secrets目录，原子写；POSIX0700/0600，Windows当前用户ACL（无法收紧明确失败），不伪称chmod限制Windows。PAT不入配置、settings、日志、仓库、URL或进程参数。

Git/核心在专用worker中执行，清继承token/GIT_CONFIG/askpass/SSH变量，禁交互；忽略全局/系统Git配置，凭据仅当前用户tokenFile。测试file映射只工厂测试选项，不从HTTP取。所有存储路径拒绝symlink/junction/越界及非普通文件。

自动检查默认关闭，开启仅定时pull暂存、不apply；用户互斥，exit清timer，失败退避，有真实最后错误。不能声称手机后台永远运行。

## 文件责任

核心任务：orchestrator.js及online测试。前端：client、根manifest及client测试。后端：lib/integration、index.js及backend测试。安装：bin/install-plugin.js、install.sh、安装测试/文档。package/README/CI最后专门整理，避免互相覆盖。

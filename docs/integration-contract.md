# 酒管同步集成合同（2026-10-19）

用户授权实现可安装、可在酒管界面操作的产品。DSH承担安装模块及测试，Codex负责后端、安全审查与整合。仅隔离开发，不改真实安装/聊天/PAT或远端数据仓库。

## 安装与界面

根manifest.json为前端扩展（js=client/index.js css=client/style.css）；根package.main=index.js为服务端插件。1.4统一安装器bin/setup.js、Windows install.cmd及Termux setup.sh一次安装两者。前端URL安装仍只安装前端。统一发行包无.git，升级、备份及恢复由统一安装器负责。

界面以三步首设向导和上传/检查更新两个主操作组织；合并保存与验证，空分支初始化另行确认。PAT密码框只写保存后清空，自动检查默认关闭。仅一对一聊天正文。下载与预检不写聊天，应用须关全部旧客户端、手动重启服务后重新打开。

## 核心

显式executionMode=online-snapshot只允许init/status/push/pull，操作真实dataRoot；不做mirror、不伪造offlineConfirmed。遇active apply或未complete计划仅阻断，不调用apply恢复或写聊天。集成worker对pull固定设置blockPendingRecovery=true，在核心已取得两层锁后遇到未确认上传即阻断；必须由用户点击上传明确重试，自动检查不会代为上传。CLI和未启用此限制的调用保留原恢复行为；三方比较、冲突与应用算法不变。CLI不暴露online模式参数。

## API（/api/plugins/github-data-sync）

成功统一{success:true,...}，错误{success:false,code,error}。无token、原始堆栈或系统路径。

- GET /health → {success:true,version,capabilities:{onlineSnapshot:true,startupApply:true,setupWizard:true,safePreview:true,statusHistory:true},startupApplyOnly:true}
- GET /config → {success:true,config:{githubRepo,branch,autoCheckEnabled,autoCheckMinutes},hasToken,targetLocked}
- PUT /config：仅githubRepo/branch/autoCheckEnabled/autoCheckMinutes/token。空token保留。已有state/pending/stage时拒绝换目标，不清历史。
- POST /connect {initializeEmptyBranch?:boolean} → {success:true,connected,initializedRemote,needsRemoteInit,remoteEmpty,verification}。固定GitHub API验证私有仓库及身份，然后git读取。缺分支返回connected=false，不提前建基线；只在明确true时bootstrap普通push，不force。verification区分read与实际write。
- POST /push → {success:true,result:coreResult}
- POST /pull → {success:true,result:coreResult,preflight}，只暂存。
- POST /preflight {} → {success:true,preflight:{ready,stageId,files,checkedAt?,error?}}。锁内复用核心预检，只读聊天；识别pending/active/未完成或损坏journal，不恢复或应用。
- POST /schedule-apply {stageId,clientsWillBeClosed:true} → {success:true,scheduled:{stageId}}。精确绑定当前stage及targetIdentity/候选摘要，要求用户关客户端声明，不能传路径/offlineflag。
- POST /cancel-apply → {success:true,cancelled:true}，只清安排，不删stage备份。
- GET /status 还包含history:{lastCheck,lastUpload,verification}、historyError、lastAppliedAt、readyForSync和targetLocked。记录来自实际操作及启动receipt；缓存状态不冒充远端新检查。

## 真正应用

插件init在官方1.17 loadPlugins await窗口、listen前处理显式安排的stage；不是每次启动自动应用全部stage。必须校验相同stageId/targetIdentity/摘要、原B和真实L，沿用核心备份/manifest。失败保留intent/stage/旧B；不能用当前L改写expected绕过。

官方loader会吞init异常，故部分apply失败存在active manifest时必须真正阻止宿主继续启动（明确进程非零退出或安装的启动wrapper），不能仅throw。未改聊天的预检失败可记录阻断并继续服务。禁止HTTP调用startup apply、任意命令或自动重启。故障退出需在合成子进程验证。

startup-only不能证明旧标签页内存已清，必须明确关旧客户端并重启后重新打开，不声称无感在线原位应用安全。

## 后端安全

只取req.user.profile.handle与req.user.directories.root，并验证root与globalThis.DATA_ROOT/handle一致。无身份401，不回退默认用户。禁止HTTP传handle/dataRoot/repoDir/tokenFile/remoteURL/env/command/offlineConfirmed。

每用户独立repo/config/锁；存储键SHA256(全局dataRoot+handle)，根在OS个人目录独立.jiuguan-github-sync。token在独立secrets目录，原子写；POSIX0700/0600，Windows当前用户ACL（无法收紧明确失败），不伪称chmod限制Windows。PAT不入配置、settings、日志、仓库、URL或进程参数。

每次push/pull/自动检查前，重新验证GitHub仓库仍私有。更换凭据必须先严格持久化旧验证失效，失败即停止；token只接受文本。activity.json仅保存脱敏操作记录和验证结果，记录写失败不能把已确认上传改报上传失败。私有仓库并非额外加密。

Git/核心在专用worker中执行，清继承token/GIT_CONFIG/askpass/SSH变量，禁交互；忽略全局/系统Git配置，凭据仅当前用户tokenFile。测试file映射只工厂测试选项，不从HTTP取。所有存储路径拒绝symlink/junction/越界及非普通文件。

自动检查默认关闭，开启仅定时pull暂存、不apply；用户互斥，exit清timer，失败退避，有真实最后错误。不能声称手机后台永远运行。

## 文件责任

可靠核心lib/reliable仅新增上述显式pull限制，原有同步算法不变；回归风险是未确认上传时检查会阻断，须由上传按钮恢复。前端client；后端lib/integration；统一安装bin/setup.js、lib/installer和平台入口；scripts/build-release.js生成源码发行包。合成测试覆盖新门禁、预检、安装与恢复；真实GitHub和Termux验收单列。

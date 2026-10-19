'use strict';
/**
 * 酒管 GitHub 同步统一安装器：前后端一起准备、切换和回滚。
 *
 * 仅接受 1.17.x 宿主。运行时 payload 使用固定文件集合；正式目录无 .git。
 * 未知来源/用户修改须显式接管，正常已知版本走 upgrade。
 * 事务和备份在宿主 .jiuguan-install，处于插件与扩展扫描范围外。
 * prepare 固定完整的旧/新目录快照，commit 复核原授权选项与原配置哈希。
 * journal 必须严格校验；路径从可信 app 和安全 ID 推导，不接受任意绝对路径。
 * 外置配置恢复/回滚须用户显式指定，并匹配已授权路径摘要。
 * 目录 rename 前后都可能断电；恢复用实际 target/backup 哈希识别状态，
 * 不依赖动作后的记账是否完成。配置写入前保存预期结果并复核原字节。
 * 所有回滚先持久化事务；完整旧目标已恢复时可由哈希确认，重复执行幂等。
 * 只在用户确认停服后切换，不启动宿主，不删除旧目录或同步数据。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const installer = require('../../bin/install-plugin.js');
const discovery = require('./discovery');
const fx = require('./fsutil');

const {
    InstallError,
    scanEnableServerPlugins,
    runNpmCi,
    locateNpmCli,
    safeMkdirChain,
    PLUGIN_TARGET_NAME,
} = installer;

// 发行包根（本仓库根）。
const PKG_ROOT = path.resolve(__dirname, '..', '..');
const RELEASE_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version || 'unknown';
    } catch {
        return 'unknown';
    }
})();

const FRONTEND_REL = path.join('public', 'scripts', 'extensions', 'third-party', PLUGIN_TARGET_NAME);
const BACKEND_REL = path.join('plugins', PLUGIN_TARGET_NAME);
const WORK_REL = '.jiuguan-install';
const MANIFEST_BASENAME = '.jiuguan-install-manifest.json';
const MANIFEST_SCHEMA = 2;
const JOURNAL_SCHEMA = 2;
const CONFIG_SOURCE_BASENAME = 'config-source.json';

// 前端固定文件（平铺到扩展目录）。
const FRONTEND_FILES = [
    { src: path.join('client', 'manifest.json'), dest: 'manifest.json' },
    { src: path.join('client', 'index.js'), dest: 'index.js' },
    { src: path.join('client', 'style.css'), dest: 'style.css' },
];

const OPEN_PHASES = ['PREPARING', 'PREPARED', 'SWITCHING', 'ROLLING_BACK', 'FAILED'];
const ALL_PHASES = OPEN_PHASES.concat(['DONE', 'ROLLED_BACK']);
const SIDES = ['backend', 'frontend'];

// 后端依赖（来自发行包 package.json，用于 --no-deps 的「依赖已存在」检查）。
function releaseDependencies() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
        return Object.keys(pkg.dependencies || {});
    } catch {
        return [];
    }
}

// ───────────────────────────── 路径推导（绝不信任 journal 绝对路径）─────────

function appPaths(appDir) {
    const app = path.resolve(appDir);
    const work = path.join(app, WORK_REL);
    return {
        appDir: app,
        work,
        journal: path.join(work, 'journal.json'),
        configSource: path.join(work, CONFIG_SOURCE_BASENAME),
        txBase: path.join(work, 'tx'),
        backups: path.join(work, 'backups'),
        quarantineBase: path.join(work, 'quarantine'),
        runLock: path.join(work, 'run.lock'),
        backendDir: path.join(app, BACKEND_REL),
        frontendDir: path.join(app, FRONTEND_REL),
        configPath: path.join(app, 'config.yaml'),
    };
}

/** 由固定相对名 + txId 推导事务内目录（txId 必须是安全 token）。 */
function txPaths(appDir, txId) {
    if (!/^tx-[0-9A-Za-z-]+$/.test(String(txId || ''))) {
        throw new InstallError('JOURNAL_INVALID', `journal 中的 txId 非法（拒绝）: ${txId}`);
    }
    const ap = appPaths(appDir);
    const base = path.join(ap.txBase, txId);
    return {
        base,
        journal: path.join(base, 'journal.json'),
        stageBackend: path.join(base, 'stage', 'backend'),
        stageFrontend: path.join(base, 'stage', 'frontend'),
        quarantine: path.join(base, 'quarantine'),
    };
}

/** 备份目录（backupId 必须是安全 token）。 */
function backupPaths(appDir, backupId) {
    if (!/^bk-[0-9A-Za-z-]+$/.test(String(backupId || ''))) {
        throw new InstallError('JOURNAL_INVALID', `journal 中的 backupId 非法（拒绝）: ${backupId}`);
    }
    const ap = appPaths(appDir);
    const base = fx.assertWithin(path.join(ap.backups, backupId), ap.backups, 'PATH_ESCAPE');
    return {
        base,
        backend: path.join(base, 'backend'),
        frontend: path.join(base, 'frontend'),
        config: path.join(base, 'config.yaml'),
        meta: path.join(base, 'backup.json'),
    };
}

// ───────────────────────────── 宿主与来源校验 ─────────────────────────────

/** 校验 appDir：含 server.js/package.json（真实文件）、仅 1.17.x。 */
function assertValidApp(appDir) {
    const app = path.resolve(appDir);
    const st = fx.lstatOrNull(app);
    if (!st || !st.isDirectory()) {
        throw new InstallError('APP_NOT_FOUND', `宿主目录不存在（或不是目录）: ${app}`);
    }
    fx.safeResolve(app, 'appDir');
    for (const must of ['server.js', 'package.json']) {
        const p = path.join(app, must);
        let s;
        try {
            s = fx.lstatOrNull(p);
        } catch (e) {
            throw new InstallError('APP_UNREADABLE', `无法读取宿主 ${must}（${e.code || e.message}）: ${p}`);
        }
        if (!s) throw new InstallError('APP_NOT_FOUND', `目录缺少 ${must}（不像是酒管宿主目录）: ${app}`);
        if (s.isSymbolicLink()) throw new InstallError('LINK_REJECTED', `宿主关键文件为符号链接（拒绝）: ${p}`);
        if (!s.isFile()) throw new InstallError('APP_NOT_FOUND', `宿主 ${must} 不是普通文件（拒绝）: ${p}`);
        if (fx.isLink(p)) throw new InstallError('LINK_REJECTED', `宿主关键文件是 junction/重解析点（拒绝）: ${p}`);
    }
    const version = discovery.readHostVersion(app);
    if (!discovery.isSupportedHostVersion(version)) {
        throw new InstallError(
            'HOST_VERSION_UNSUPPORTED',
            `仅支持酒管 1.17.x（当前 ${version || '无法识别'}）。不自动升级宿主，请先手动升级到 1.17。`
        );
    }
    return version;
}

/** 校验清单严格 schema（本安装器产物证明）。返回规范化对象或 null。 */
function validateManifest(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    if (m.schema !== MANIFEST_SCHEMA) return null;
    if (typeof m.version !== 'string' || !m.version) return null;
    if (typeof m.action !== 'string') return null;
    if (typeof m.createdAt !== 'string') return null;
    if (!m.hash || typeof m.hash !== 'object' || Array.isArray(m.hash)) return null;
    if (!m.frontendHash || typeof m.frontendHash !== 'object' || Array.isArray(m.frontendHash)) return null;
    for (const k of Object.keys(m.hash)) if (typeof m.hash[k] !== 'string') return null;
    for (const k of Object.keys(m.frontendHash)) if (typeof m.frontendHash[k] !== 'string') return null;
    return m;
}

/** 读取目标目录清单（不存在/损坏/链接均返回 null）。 */
function readManifest(dir) {
    const p = path.join(dir, MANIFEST_BASENAME);
    let st;
    try {
        st = fx.lstatOrNull(p);
    } catch {
        return null;
    }
    if (!st || !st.isFile()) return null;
    return validateManifest(fx.readJsonOrNull(p));
}

/**
 * 目录内容「文件」哈希（后端排除清单文件自身；前端不含清单文件）。
 * 目录条目不参与（只记录文件入口；链接/junction/特殊文件以哨兵参与，必然与真实文件不等）。
 * node_modules（已安装依赖）不计入「发行包内容」：它由 --no-deps/依赖检查单独治理。
 */
function contentHash(dir, { excludeManifest, acceptJunction }) {
    const map = fx.dirContentMap(dir, acceptJunction === undefined ? {} : { acceptJunction });
    if (excludeManifest) delete map[MANIFEST_BASENAME];
    for (const k of Object.keys(map)) {
        if (map[k] === fx.SENTINEL.DIR || k === 'node_modules' || k.startsWith('node_modules/')) delete map[k];
    }
    return map;
}

/** 发行包运行时文件哈希（后端为固定 payload；前端为 3 个固定文件）。 */
function releaseHashes() {
    const backend = {};
    const files = releaseSourceFiles();
    for (const f of files) {
        backend[f.relPosix] = fx.fileSha256(f.abs);
    }
    const frontend = {};
    for (const f of FRONTEND_FILES) {
        const abs = path.join(releaseRoot(), f.src);
        const h = fx.fileSha256(abs);
        if (!h) throw new InstallError('SOURCE_FILE_MISSING', `发行包缺少前端文件: ${f.src}`);
        frontend[f.dest] = h;
    }
    return { backend, frontend };
}

// ── 测试注入点（仅测试用；生产路径恒为当前磁盘发行包，无 hook）──
let _release = null;
let _stepHook = null;

function releaseRoot() {
    return _release ? _release.root : PKG_ROOT;
}

function releaseVersion() {
    return _release ? _release.version : RELEASE_VERSION;
}

function releaseSourceFiles() {
    if (_release) return _release.files;
    const files = [];
    const roots = ['bin', 'client', 'lib'];
    for (const root of roots) {
        const abs = path.join(PKG_ROOT, root);
        fx.safeDirMustExist(abs, 'release');
        const map = fx.dirContentMap(abs);
        if (!validSnapshot(map, false)) throw new InstallError('SOURCE_LINK', '发行包运行时目录含链接/特殊文件。');
        for (const [rel, hash] of Object.entries(map)) {
            if (hash === fx.SENTINEL.DIR) continue;
            files.push({ abs: path.join(abs, rel.split('/').join(path.sep)), relPosix: root + '/' + rel });
        }
    }
    for (const rel of ['index.js','manifest.json','package.json','package-lock.json','LICENSE']) {
        const abs = path.join(PKG_ROOT, rel); fx.safeFile(abs, 'release'); files.push({ abs, relPosix: rel });
    }
    return files.sort((a,b) => a.relPosix.localeCompare(b.relPosix));
}

function __setReleaseForTesting(r) {
    if (!r || !r.root || !Array.isArray(r.files)) throw new InstallError('TEST_HOOK', '注入结构需 {root, files, version}');
    _release = { root: path.resolve(r.root), files: r.files, version: String(r.version || '0.0.0-test') };
}

function __resetReleaseForTesting() {
    _release = null;
}

/** 进程内步进 hook（只在 journal 落盘之后触发；真实断电由测试子进程在 fs 层 process.exit 模拟）。 */
function __setStepHookForTesting(fn) {
    _stepHook = typeof fn === 'function' ? fn : null;
}

// ───────────────────────────── 决策 gate（prepare/commit/CLI 唯一入口）──────

/**
 * 计算安装计划 + 全部门禁决策（只读，不落盘）。
 *
 * @param {object} input
 *   appDir?               显式宿主目录
 *   searchRoots?          额外候选搜索根（只读一层）
 *   dataRoot?             用户数据根（只读扫描用户级同名扩展遮蔽；发现即 gate 拒绝）
 *   configPath?           外置 config 绝对路径（默认 <app>/config.yaml；必须真实普通文件）
 *   enableServerPlugins?  是否改写 enableServerPlugins
 *   installDeps?          是否安装后端依赖
 *   takeover?             显式接管「未知来源 / 用户改动 / 单侧」目标（先完整备份）；已知旧版本升级不需要它
 */
function plan(input = {}) {
    const opts = Object.assign({ enableServerPlugins: true, installDeps: true, takeover: false }, input);

    const candidates = discovery.discoverCandidates({
        appDir: opts.appDir,
        searchRoots: opts.searchRoots,
        journal: null, // 不信任 journal 里的绝对路径
    });
    if (candidates.length === 0) {
        throw new InstallError('NO_CANDIDATE', '未找到酒管宿主目录。请用 --app-dir 指定，或从宿主根目录运行。');
    }
    if (candidates.length > 1 && !opts.appDir) {
        throw new InstallError(
            'MULTIPLE_CANDIDATES',
            `发现多个候选宿主目录（不猜测），请明确其中一个：\n  ${candidates.join('\n  ')}`
        );
    }
    const appDir = candidates[0];
    const hostVersion = assertValidApp(appDir);
    const ap = appPaths(appDir);

    // 工作区与目标路径：祖先 + 最终节点均拒绝链接。
    fx.safeResolve(ap.work, 'work');
    fx.safeResolve(ap.backendDir, 'backend');
    fx.safeResolve(ap.frontendDir, 'frontend');

    // 未完成事务阻断（必须在任何写之前）。损坏/不可读/未知 schema 一律阻断（不吞、不覆盖）。
    const pending = readJournal(appDir);
    const pendingTx = pending && OPEN_PHASES.includes(pending.phase) ? pending : null;
    if (pendingTx && !opts._allowPendingTx) {
        throw new InstallError(
            'PENDING_TX',
            `检测到未完成的安装事务（tx ${pendingTx.txId || '(无 id)'}，阶段 ${pendingTx.phase}）。` +
                `请先执行 --recover（停服确认后收敛）或 --rollback（回到安装前状态）再重新安装。`
        );
    }

    // config 来源（本地受控凭据记录 / 显式 --config / 默认 <app>/config.yaml）。
    const config = resolveConfigSource(appDir, { configPath: opts.configPath, enable: opts.enableServerPlugins });

    // 来源与双侧完整性判定。
    const src = releaseHashes();
    const inspect = inspectTargets(appDir, src);

    // 决策。
    let action;
    let reason = null;
    const takeoverStates = ['modified', 'unknown', 'incomplete'];
    if (inspect.state === 'none') {
        action = 'install';
    } else if (inspect.state === 'match') {
        action = 'noop';
    } else if (inspect.state === 'upgrade') {
        action = 'upgrade';
    } else if (inspect.state === 'mismatch' || inspect.state === 'link') {
        action = 'rejected';
        reason = inspect.reason;
    } else if (takeoverStates.includes(inspect.state)) {
        if (opts.takeover) {
            action = 'takeover';
        } else {
            action = 'rejected';
            reason = inspect.reason;
        }
    } else {
        action = 'rejected';
        reason = inspect.reason || '目标状态不允许安装。';
    }

    // 用户级同名扩展遮蔽检查（只读）。发现任何一处 → gate 拒绝（不存在「口头确认」绕过）。
    const shadow = opts.dataRoot ? scanShadowExtensions(opts.dataRoot, appDir) : null;
    const shadowBlocked = !!(shadow && (shadow.found.length > 0 || (shadow.hardError && shadow.hardError.length)));
    if (shadowBlocked && action !== 'rejected') {
        action = 'rejected';
        reason = shadow.error || '检测到用户级同名扩展或扫描失败（fail-closed）。';
    }

    // 依赖前置（--no-deps 时目标内「这次安装后」的依赖必须可验证存在，否则不冒称成功）。
    const deps = releaseDependencies();
    let depsCheck = inspectDeps({
        backendDir: ap.backendDir,
        targetExists: inspect.backend ? !!inspect.backend.existedBefore : false,
        sourceHashes: src,
        txId: pendingTx ? pendingTx.txId : null,
        deps,
        installDeps: opts.installDeps,
    });
    if (action === 'noop' && (installedDepsIn(ap.backendDir, deps).length || !inspect.backend.manifest.dependencyHash || !fx.mapsEqual(inspect.backend.manifest.dependencyHash, fx.dirContentMap(path.join(ap.backendDir, 'node_modules'))))) {
        if (opts.installDeps) action = 'upgrade';
        else depsCheck = { ok: false, missing: installedDepsIn(ap.backendDir, deps), reason: '现有依赖缺失或被修改，拒绝 no-op。' };
    }
    if (!depsCheck.ok && action !== 'rejected') {
        action = 'rejected';
        reason = depsCheck.reason;
    }

    const planObj = {
        appDir,
        hostVersion,
        releaseVersion: releaseVersion(),
        action,
        reason,
        takeover: !!opts.takeover,
        backendDir: ap.backendDir,
        frontendDir: ap.frontendDir,
        configPath: config.path,
        configSource: config.source,
        configRelative: path.relative(appDir, config.path),
        configSig: config.sha256,
        configBytesSize: config.size,
        enableServerPlugins: !!opts.enableServerPlugins,
        installDeps: !!opts.installDeps,
        pendingTx: pendingTx ? { txId: pendingTx.txId, phase: pendingTx.phase } : null,
        inspect,
        sourceHashes: src,
        dependencies: deps,
        depsCheck,
        shadow,
        shadowBlocked,
        dataRoot: opts.dataRoot ? path.resolve(opts.dataRoot) : null,
        noDataRoot: !!opts.noDataRoot,
        paths: ap,
        canProceed: action === 'install' || action === 'noop' || action === 'upgrade' || action === 'takeover',
    };
    return planObj;
}

// ───────────────────────────── config 来源 ─────────────────────────────

function fileStatSig(p) {
    const st = fs.statSync(p);
    return { sha256: fx.fileSha256(p), size: st.size };
}

/**
 * 外置 config 的「本地受控凭据记录」（<app>/.jiuguan-install/config-source.json）。
 *  - 由 prepare（服务端）在用户明确指定后生成，记录绝对路径 + 首次标识（sha256/size/inode）；
 *  - 此记录只用于正常向导的候选提示；恢复/回滚仍需显式 config 路径；
 *  - 实际写入须匹配 prepare 固定的路径摘要与配置原字节，不把 inode 当持久身份。
 */
function readConfigSourceRecord(appDir) {
    const ap = appPaths(appDir);
    let rec;
    try {
        rec = fx.readJsonStrict(ap.configSource, { code: 'CONFIG_SOURCE_INVALID', label: 'config 来源记录' });
    } catch (e) {
        if (e.code === 'JOURNAL_CORRUPT') {
            throw new InstallError('CONFIG_SOURCE_INVALID', 'config 来源记录已损坏，拒绝据其恢复（请人工核对后删除该文件并显式 --config 重新指定）。');
        }
        throw e;
    }
    if (rec === null) return null;
    if (!rec || typeof rec !== 'object' || rec.schema !== 1) {
        throw new InstallError('CONFIG_SOURCE_INVALID', 'config 来源记录 schema 非法（拒绝）。');
    }
    if (typeof rec.path !== 'string' || !path.isAbsolute(rec.path)) {
        throw new InstallError('CONFIG_SOURCE_INVALID', 'config 来源记录缺少绝对路径（拒绝）。');
    }
    if (rec.sha256 != null && !/^[0-9a-f]{64}$/.test(String(rec.sha256))) {
        throw new InstallError('CONFIG_SOURCE_INVALID', 'config 来源记录的 sha256 非法（拒绝）。');
    }
    return rec;
}

function writeConfigSourceRecord(appDir, rec) {
    const ap = appPaths(appDir);
    fx.safeResolve(ap.work, 'work');
    fx.writeJsonAtomic(ap.configSource, rec);
}

/**
 * 确定本次操作使用的 config 路径（绝不信任 journal 字段）。
 * @returns {{path:string, sha256:string|null, size:number|null, source:'default'|'cli'|'record', record:object|null}}
 */

function resolveConfigSource(appDir, { configPath, enable, allowMissing } = {}) {
    const ap = appPaths(appDir);
    const record = readConfigSourceRecord(appDir);
    const source = configPath ? 'cli' : record ? 'record' : 'default';
    const chosen = configPath || (record && record.path) || ap.configPath;
    if (!path.isAbsolute(chosen)) throw new InstallError('CONFIG_PATH_INVALID', '--config 必须是绝对路径。');
    const abs = path.resolve(chosen);
    if (configPath && record && path.resolve(record.path) !== abs) {
        throw new InstallError('CONFIG_SOURCE_MISMATCH', '显式 config 与已记录路径不一致，请人工核对来源记录。');
    }
    try { fx.safeFile(abs, 'config'); }
    catch (e) {
        if (e.code !== 'FILE_MISSING' || !allowMissing) throw e.code === 'FILE_MISSING' ? new InstallError('CONFIG_PATH_INVALID', 'config 文件不存在。') : e;
        return { path: abs, sha256: null, size: null, source, record };
    }
    const sig = fileStatSig(abs);
    if (enable) scanEnableServerPlugins(fs.readFileSync(abs, 'utf8'));
    return { path: abs, sha256: sig.sha256, size: sig.size, source, record };
}

function readClientManifestVersion(dir) {
    const p = path.join(dir, 'manifest.json');
    let st;
    try {
        st = fx.lstatOrNull(p);
    } catch {
        return null;
    }
    if (!st || !st.isFile()) return null;
    const j = fx.readJsonOrNull(p);
    return j && typeof j.version === 'string' ? j.version : null;
}

/** 前端目录是否具备一次完整安装的形态（manifest.json/index.js/style.css 均为真实文件）。 */
function frontendLooksInstalled(dir) {
    for (const f of ['manifest.json', 'index.js', 'style.css']) {
        let st;
        try {
            st = fx.lstatOrNull(path.join(dir, f));
        } catch {
            return false;
        }
        if (!st || !st.isFile()) return false;
    }
    return true;
}

/**
 * 检查两个目标目录的来源与完整性。
 * 返回 { state: 'none'|'match'|'upgrade'|'modified'|'unknown'|'incomplete'|'mismatch'|'link', reason, backend, frontend }
 */
function inspectTargets(appDir, src) {
    const ap = appPaths(appDir);
    const out = { state: null, reason: null, backend: null, frontend: null };
    for (const side of SIDES) {
        const dir = side === 'backend' ? ap.backendDir : ap.frontendDir;
        let st;
        try {
            st = fx.lstatOrNull(dir);
        } catch (e) {
            throw new InstallError('APP_UNREADABLE', `无法读取目标目录（${e.code || e.message}）: ${dir}`);
        }
        if (!st) {
            out[side] = { exists: false, existedBefore: false };
            continue;
        }
        if (st.isSymbolicLink() || fx.isLink(dir)) {
            out[side] = { exists: true, existedBefore: true, link: true, dir };
            continue;
        }
        if (!st.isDirectory()) {
            out[side] = { exists: true, existedBefore: true, notDir: true, dir };
            continue;
        }
        const manifest = readManifest(dir);
        const current = contentHash(dir, { excludeManifest: side === 'backend' });
        const expected = side === 'backend' ? src.backend : src.frontend;
        // 前端目录内没有安装清单文件：其记录哈希来自后端清单的 frontendHash（两侧互相绑定）。
        const beManifest = side === 'backend' ? manifest : readManifest(ap.backendDir);
        const recorded = beManifest ? (side === 'backend' ? beManifest.hash : beManifest.frontendHash) : null;
        out[side] = {
            exists: true,
            existedBefore: true,
            link: false,
            notDir: false,
            dir,
            manifest: side === 'backend' ? manifest : null,
            current,
            recorded,
            manifestMatchesContent: !!recorded && fx.mapsEqual(current, recorded),
            matchesRelease: fx.mapsEqual(current, expected),
            diff: fx.mapDiff(recorded || {}, current),
        };
    }

    const be = out.backend;
    const fe = out.frontend;
    if (!be.exists && !fe.exists) {
        out.state = 'none';
        return out;
    }
    if (be.link || fe.link) {
        out.state = 'link';
        out.reason = '目标路径为符号链接/junction，拒绝。';
        return out;
    }
    if (be.notDir || fe.notDir) {
        out.state = 'unknown';
        out.reason = '目标路径存在但不是目录，拒绝覆盖。';
        return out;
    }
    if (!be.exists || !fe.exists) {
        out.state = 'incomplete';
        out.reason = `只存在${be.exists ? '后端' : '前端'}一侧（另一侧缺失），不是完整的本安装器产物，拒绝覆盖。`;
        return out;
    }
    if (!be.manifest) {
        out.state = 'unknown';
        out.reason =
            '目标目录已存在但缺少（或损坏）本安装器的安装清单，无法精确识别来源（可能是旧版发布或用户手改）。' +
            '在无法确认版本与内容的情况下本安装器不冒认任何历史版本，也拒绝直接覆盖。' +
            '确认是旧版安装且愿意保留备份时，请显式加 --takeover（旧目录会完整保留到备份目录）。';
        return out;
    }
    const feVersion = readClientManifestVersion(fe.dir);
    if (be.manifest.version !== releaseVersion() && feVersion && feVersion !== be.manifest.version) {
        out.state = 'mismatch';
        out.reason = `前后端记录版本不一致（后端 ${be.manifest.version} / 前端 ${feVersion}），状态异常，拒绝覆盖。`;
        return out;
    }
    if (!be.manifestMatchesContent) {
        out.state = 'modified';
        out.reason = `后端目录内容与安装清单记录不一致（可能有用户改动或未知来源），拒绝覆盖。差异项: ${be.diff.join(', ')}`;
        return out;
    }
    if (!fe.manifestMatchesContent) {
        if (!frontendLooksInstalled(fe.dir)) {
            out.state = 'incomplete';
            out.reason = '前端目录缺少必要文件（不是完整的本安装器产物），拒绝覆盖。';
            return out;
        }
        out.state = 'modified';
        out.reason = `前端目录内容与安装清单记录不一致（可能有用户改动或未知来源），拒绝覆盖。差异项: ${fe.diff.join(', ')}`;
        return out;
    }
    if (be.manifest.version === releaseVersion() && be.matchesRelease && fe.matchesRelease) {
        out.state = 'match';
        return out;
    }
    if (be.manifest.version === releaseVersion()) {
        out.state = 'mismatch';
        out.reason = '已装目录与本次发行包内容不一致（版本号相同但内容不同），不能视为已安装，拒绝静默覆盖。';
        return out;
    }
    // 不同版本 + 双侧清单与内容自洽 → 正常升级（无需 --takeover，也不冒称接管）。
    out.state = 'upgrade';
    out.reason = null;
    return out;
}

// ───────────────────────────── 依赖 ─────────────────────────────

function installedDepsIn(dir, deps) {
    const missing = [];
    for (const d of deps) {
        const p = path.join(dir, 'node_modules', d, 'package.json');
        let st;
        try {
            st = fx.lstatOrNull(p);
        } catch {
            st = null;
        }
        if (!st || !st.isFile() || st.isSymbolicLink() || fx.isLink(p)) missing.push(d);
    }
    return missing;
}

/**
 * 检查「这次安装完成后」的依赖是否会存在。
 *  - installDeps=true：安装阶段负责（但要能定位 npm）。
 *  - installDeps=false（--no-deps）：
 *      * 首装或升级（会替换后端目录）→ 只能从「旧版本已核验依赖」复制，或拒绝（不可首装 ok 缺依赖）；
 *      * noop → 当前后端目录必须已含全部依赖，否则提示修依赖而不是假成功。
 */
function inspectDeps({ backendDir, targetExists, sourceHashes, txId, deps, installDeps }) {
    if (installDeps) {
        if (!locateNpmCli()) {
            return {
                ok: false,
                mode: 'install',
                missing: deps,
                reason: '未定位到 npm-cli.js，无法安装依赖。请确认 Node.js >= 20 且 npm 可用（或加 --no-deps 且目标内已有依赖）。',
            };
        }
        return { ok: true, mode: 'install', missing: [] };
    }
    const m = backendDir && readManifest(backendDir);
    const depHash = backendDir && fx.exists(path.join(backendDir, 'node_modules')) ? fx.dirContentMap(path.join(backendDir, 'node_modules')) : {};
    const usableTarget = targetExists && backendDir && fx.exists(backendDir) && depsEverywhere(backendDir, deps) && m && m.dependencyHash && fx.mapsEqual(m.dependencyHash, depHash);
    if (usableTarget) {
        return { ok: true, mode: 'reuse-target', missing: [], reason: null };
    }
    const missing = deps.slice();
    const have = backendDir && fx.exists(backendDir) ? deps.filter((d) => !missing.includes(d)) : [];
    return {
        ok: false,
        mode: 'no-deps-unverified',
        missing,
        have,
        reason:
            `--no-deps 已指定，但目标内没有可验证的完整依赖。` +
            `首装与升级都不允许在缺依赖的情况下冒充成功：请去掉 --no-deps 让向导安装依赖，或先把依赖装到目标目录。`,
    };
}

function depsEverywhere(dir, deps) {
    return installedDepsIn(dir, deps).length === 0;
}

/** stage 内依赖是否齐全（复制/安装后校验）。 */
function depsSatisfied(dir, deps) {
    return depsEverywhere(dir, deps);
}

/**
 * 升级/接管前必须保证旧目标内容与「决策时」一致（plan → commit 之间无并发替换）。
 * 任何变化都抛错，不写任何东西。
 */
function assertUnchangedSincePlan(p) {
    if (!p || !p.inspect) throw new InstallError('PLAN_INVALID', '安装计划缺失，请重新运行向导。');
    const insp = inspectTargets(p.appDir, p.sourceHashes);
    const before = p.inspect;
    if (p.action === 'install') {
        if (insp.state !== 'none') {
            throw new InstallError('TARGET_CHANGED', '自生成安装计划后目标目录已出现内容，请重新运行向导。');
        }
    } else if (p.action === 'noop') {
        if (insp.state !== 'match') {
            throw new InstallError('TARGET_CHANGED', '自生成安装计划后目标内容已变化，请重新运行向导。');
        }
    } else if (p.action === 'upgrade' || p.action === 'takeover') {
        if (insp.state !== before.state) {
            throw new InstallError('TARGET_CHANGED', `自生成安装计划后目标状态已变化（${before.state} → ${insp.state}），请重新运行向导。`);
        }
        for (const side of SIDES) {
            const b = before[side];
            const n = insp[side];
            if (!fx.mapsEqual(b.current || {}, n.current || {})) {
                throw new InstallError('TARGET_CHANGED', `自生成安装计划后 ${side} 目录内容发生变化，请重新运行向导。`);
            }
        }
    }
    if (p.configPath) {
        const sig = configSignature(p.configPath);
        if (p.configSig && sig !== p.configSig) {
            throw new InstallError('CONFIG_CHANGED', '自生成安装计划后 config 已变化，请重新运行向导。');
        }
    }
    return insp;
}

function configSignature(p) {
    return fx.fileSha256(p);
}

// ───────────────────────────── journal ─────────────────────────────

/**
 * 读 journal：不存在 → null；损坏/不可读/结构非法/未知 schema → 抛错（阻断，不覆盖）。
 */

function readJournal(appDir) {
    if (!appDir) return null;
    const app = path.resolve(appDir);
    const ap = appPaths(app);
    const j = fx.readJsonStrict(ap.journal, { code: 'JOURNAL_CORRUPT', label: '安装 journal' });
    if (j === null) return null;
    if (j.schema !== JOURNAL_SCHEMA) throw new InstallError('JOURNAL_SCHEMA_UNKNOWN', '未知/旧版 journal schema，保留并阻断安装。');
    validateJournalShape(j, app);
    return j;
}


function writeJournal(appDir, data) {
    const app = path.resolve(appDir);
    validateJournalShape(data, app);
    fx.safeResolve(appPaths(app).work, 'work');
    fx.writeJsonAtomic(appPaths(app).journal, data);
}

function pushStep(tx, step, extra) {
    tx.steps = Array.isArray(tx.steps) ? tx.steps : [];
    tx.steps.push(Object.assign({ step, at: new Date().toISOString() }, extra || {}));
    writeJournal(tx.appDir, tx);
    if (_stepHook) _stepHook(step, tx);
}

/** 把一个阶段写进 journal（先持久化再动作）。 */
function setPhase(tx, phase, extra) {
    tx.phase = phase;
    if (extra) Object.assign(tx, extra);
    writeJournal(tx.appDir, tx);
    if (_stepHook) _stepHook('PHASE_' + phase, tx);
}

// ───────────────────────────── 运行锁（同进程可重入，跨进程互斥）──────────

const _heldLocks = new Map(); // runLockPath → { depth, fd }

function acquireRunLock(ap) {
    const key = ap.runLock, held = _heldLocks.get(key);
    if (held) { held.depth++; return { path: key, reentrant: true }; }
    safeMkdirChain(ap.work);
    for (let attempt = 0; attempt < 2; attempt++) {
        const lock = { path: key, fd: null, reentrant: false, depth: 1, token: crypto.randomUUID() };
        try {
            lock.fd = fs.openSync(key, 'wx', 0o600);
            lock.bytes = JSON.stringify({ pid: process.pid, token: lock.token, at: new Date().toISOString() });
            fs.writeFileSync(lock.fd, lock.bytes); fs.fsyncSync(lock.fd);
            _heldLocks.set(key, lock); return lock;
        } catch (e) {
            if (lock.fd !== null) { try { fs.closeSync(lock.fd); } catch {} }
            if (e.code !== 'EEXIST') throw e;
            fx.safeFile(key, 'runLock');
            const bytes = fs.readFileSync(key, 'utf8');
            let stale = false;
            try {
                const old = JSON.parse(bytes);
                if (Number.isSafeInteger(old.pid) && old.pid > 0) {
                    try { process.kill(old.pid, 0); } catch (err) { stale = err.code === 'ESRCH'; }
                }
            } catch {}
            if (attempt === 0 && stale && fs.readFileSync(key, 'utf8') === bytes) { fs.unlinkSync(key); continue; }
            throw new InstallError('INSTALL_BUSY', '安装锁仍被占用；确认无其他向导后再处理 run.lock。');
        }
    }
    throw new InstallError('INSTALL_BUSY', '安装锁争用。');
}

function releaseRunLock(lock) {
    if (!lock) return;
    const held = _heldLocks.get(lock.path);
    if (!held) return;
    held.depth--;
    if (held.depth > 0) return;
    _heldLocks.delete(lock.path);
    try { fs.closeSync(held.fd); } catch {}
    try { if (fs.readFileSync(held.path, 'utf8') === held.bytes) fs.unlinkSync(held.path); } catch {}
}

function prepare(p = {}, deps = {}) {
    // 生产 gate：与 apply 完全一致，禁止 CLI 绕过。
    const planObj = p && p.paths && p.inspect ? p : plan(p);
    if (planObj.action === 'noop') {
        if (!planObj.depsCheck || !planObj.depsCheck.ok) {
            throw new InstallError('DEPS_MISSING', planObj.depsCheck ? planObj.depsCheck.reason : '依赖不可验证。');
        }
        return { action: 'noop', appDir: planObj.appDir, message: '同版本且前后端内容哈希均匹配，无需重复安装。' };
    }
    if (planObj.action === 'rejected') {
        throw new InstallError('REJECTED_TARGET', planObj.reason || '目标状态不允许安装。');
    }
    if (!planObj.canProceed) {
        throw new InstallError('REJECTED_TARGET', '安装计划不允许继续。');
    }
    if (planObj.shadowBlocked) {
        throw new InstallError('SHADOW_EXTENSION', planObj.shadow ? planObj.shadow.error : '检测到用户级同名扩展。');
    }
    if (!planObj.depsCheck || !planObj.depsCheck.ok) {
        throw new InstallError('DEPS_MISSING', planObj.depsCheck ? planObj.depsCheck.reason : '依赖不可验证。');
    }
    // 未完成事务阻断（CLI 的 prepare 入口同样适用）。
    const pending = readJournal(planObj.appDir);
    if (pending && OPEN_PHASES.includes(pending.phase)) {
        throw new InstallError('PENDING_TX', `存在未完成事务 ${pending.txId}（${pending.phase}），请先 --recover 或 --rollback。`);
    }
    // plan → prepare 并发校验。
    assertUnchangedSincePlan(planObj);

    const ap = planObj.paths;
    const txId = fx.newId('tx');
    const tp = txPaths(planObj.appDir, txId);
    const backupId = fx.newId('bk');
    const bp = backupPaths(planObj.appDir, backupId);

    const configSt = fs.statSync(planObj.configPath);
    const tx = {
        schema: JOURNAL_SCHEMA,
        txId,
        // 必须匹配调用者已验证的宿主；不会将 journal 中的其它绝对路径用于写入。
        appDir: planObj.appDir,
        phase: 'PREPARING',
        kind: 'install',
        action: planObj.action,
        releaseVersion: planObj.releaseVersion,
        hostVersion: planObj.hostVersion,
        createdAt: new Date().toISOString(),
        backupId,
        oldSnapshots: { backend: snapshot(ap.backendDir), frontend: snapshot(ap.frontendDir) },
        options: { takeover: !!planObj.takeover, dataRoot: planObj.dataRoot || null, noDataRoot: !!planObj.noDataRoot },
        configSpec: { external: path.resolve(planObj.configPath) !== path.resolve(ap.configPath), pathHash: pathHash(planObj.configPath), beforeHash: planObj.configSig, enable: !!planObj.enableServerPlugins },
        configSource: planObj.configSource,
        // journal 只留「标识 + 期望哈希」，不留可用于写外部的路径。
        configIdent: {
            basename: path.basename(planObj.configPath),
            sha256: planObj.configSig,
            size: planObj.configBytesSize,
            inode: String(configSt.ino),
            dev: String(configSt.dev),
        },
        configSigBefore: planObj.configSig,
        configSig: planObj.configSig,
        enableServerPlugins: planObj.enableServerPlugins,
        installDeps: planObj.installDeps,
        prepareHashes: {
            backend: (planObj.inspect.backend && planObj.inspect.backend.current) || null,
            frontend: (planObj.inspect.frontend && planObj.inspect.frontend.current) || null,
        },
        targetPresent: {
            backend: !!(planObj.inspect.backend && planObj.inspect.backend.existedBefore),
            frontend: !!(planObj.inspect.frontend && planObj.inspect.frontend.existedBefore),
        },
        inspectStateBefore: planObj.inspect.state,
        steps: [],
    };

    const runLock = acquireRunLock(ap);
    try {
        const latest = readJournal(planObj.appDir);
        if (latest && OPEN_PHASES.includes(latest.phase)) throw new InstallError('PENDING_TX', '另一个安装事务已准备，拒绝覆盖。');
        assertUnchangedSincePlan(planObj);
        // 1) 外置 config：用户明确指定后，由服务端生成独立本地受控凭据记录。
        if (planObj.configSource !== 'default') {
            writeConfigSourceRecord(planObj.appDir, {
                schema: 1,
                createdAt: new Date().toISOString(),
                path: planObj.configPath,
                ident: {
                    sha256: planObj.configSig,
                    size: planObj.configBytesSize,
                    inode: String(configSt.ino),
                    dev: String(configSt.dev),
                },
                note: '本文件由安装器在用户明确指定 config 后生成，仅记录绝对路径与首次标识；恢复/回滚只认这里。',
            });
        }
        // 2) journal 先持久化，再动文件。
        fx.safeResolve(tp.base, 'tx');
        fx.safeResolve(bp.base, 'backup');
        fx.safeResolve(ap.work, 'work');
        writeJournal(planObj.appDir, tx);

        // 3) 复制新版本到 stage。
        safeMkdirChain(tp.stageBackend);
        const files = releaseSourceFiles();
        for (const f of files) {
            const dest = path.join(tp.stageBackend, f.relPosix.split('/').join(path.sep));
            safeMkdirChain(path.dirname(dest));
            fs.copyFileSync(f.abs, dest);
        }
        safeMkdirChain(tp.stageFrontend);
        for (const f of FRONTEND_FILES) {
            fs.copyFileSync(path.join(releaseRoot(), f.src), path.join(tp.stageFrontend, f.dest));
        }
        pushStep(tx, 'STAGE_COPIED', { backendFiles: files.length, frontendFiles: FRONTEND_FILES.length });

        // 4) 依赖。
        let depsInstalled = false;
        let depsCopied = false;
        if (planObj.installDeps) {
            if (typeof deps.runNpmCi === 'function') {
                deps.runNpmCi(tp.stageBackend); // 测试注入（不联网）
            } else if (typeof planObj._runNpmCi === 'function') {
                planObj._runNpmCi(tp.stageBackend);
            } else {
                runNpmCi(tp.stageBackend);
            }
            depsInstalled = true;
            if (!depsSatisfied(tp.stageBackend, planObj.dependencies)) {
                throw new InstallError(
                    'DEPS_INCOMPLETE',
                    `依赖安装命令已结束，但 stage 内仍缺少：${installedDepsIn(tp.stageBackend, planObj.dependencies).join(', ')}。拒绝继续（不冒充成功）。`
                );
            }
            pushStep(tx, 'DEPS_INSTALLED');
        } else {
            // --no-deps：必须从「旧版本已核验依赖」原样复制，否则拒绝。
            depsCopied = copyVerifiedDeps(planObj, tp);
            pushStep(tx, 'DEPS_COPIED', { depsCopied });
            if (!depsSatisfied(tp.stageBackend, planObj.dependencies)) {
                throw new InstallError(
                    'DEPS_MISSING',
                    `--no-deps 且无法从旧版本复制出完整的已验证依赖（缺 ${installedDepsIn(tp.stageBackend, planObj.dependencies).join(', ')}），拒绝继续。`
                );
            }
        }

        // 5) 清单（后端清单含前端哈希，两侧互相绑定）。
        const stageBackendHash = contentHash(tp.stageBackend, { excludeManifest: true });
        const stageFrontendHash = contentHash(tp.stageFrontend, { excludeManifest: false });
        const manifest = {
            schema: MANIFEST_SCHEMA,
            generator: 'jiuguan-github-sync installer',
            version: planObj.releaseVersion,
            action: planObj.action,
            createdAt: new Date().toISOString(),
            hash: stageBackendHash,
            frontendHash: stageFrontendHash,
            dependencyHash: fx.dirContentMap(path.join(tp.stageBackend, 'node_modules')),
        };
        fs.writeFileSync(path.join(tp.stageBackend, MANIFEST_BASENAME), JSON.stringify(manifest, null, 2), 'utf8');
        tx.preparedManifest = manifest;
        pushStep(tx, 'MANIFEST_WRITTEN');

        // 6) 准备完成（事务仍待提交）。
        tx.phase = 'PREPARED';
        tx.stageHashes = { backend: stageBackendHash, frontend: stageFrontendHash };
        tx.newSnapshots = { backend: snapshot(tp.stageBackend), frontend: snapshot(tp.stageFrontend) };
        pushStep(tx, 'PREPARED');

        return {
            txId,
            backupId,
            appDir: planObj.appDir,
            stageBackend: tp.stageBackend,
            stageFrontend: tp.stageFrontend,
            backendCount: files.length,
            frontendCount: FRONTEND_FILES.length,
            depsInstalled,
            depsCopied,
            journalPath: ap.journal,
            plan: planObj,
        };
    } catch (e) {
        try {
            const j = readJournal(planObj.appDir);
            if (j && j.txId === txId && !['PREPARED', 'SWITCHING', 'DONE', 'ROLLED_BACK'].includes(j.phase)) {
                j.phase = 'FAILED';
                j.error = e && e.message ? e.message : String(e);
                j.failedAt = new Date().toISOString();
                writeJournal(planObj.appDir, j);
            }
        } catch {
            /* journal 写失败不掩盖原始错误 */
        }
        throw e;
    } finally {
        releaseRunLock(runLock);
    }
}

/**
 * --no-deps：从旧目标目录复制「已核验」的依赖到 stage。
 * 只允许复制：旧目录清单与内容完全自洽（不信任用户改动过的依赖），且不含链接/特殊文件。
 */
function copyVerifiedDeps(planObj, tp) {
    const deps = planObj.dependencies || [];
    if (!deps.length) return false;
    const srcBackend = planObj.backendDir;
    const insp = planObj.inspect && planObj.inspect.backend;
    if (!insp || !insp.existedBefore || insp.link || insp.notDir) return false;
    // 旧目录必须是本安装器产物且内容未被改动（依赖才可被信任）。
    if (!insp.manifestMatchesContent) return false;
    const cands = [srcBackend];
    const pending = planObj.pendingTx;
    if (pending && pending.txId) {
        try {
            cands.push(txPaths(planObj.appDir, pending.txId).stageBackend);
        } catch {
            /* 非法 txId：忽略 */
        }
    }
    for (const cand of cands) {
        if (installedDepsIn(cand, deps).length || !fx.exists(path.join(cand, 'node_modules'))) continue;
        const from = path.join(cand, 'node_modules');
        const to = path.join(tp.stageBackend, 'node_modules');
        try {
            // 先整体「形状」校验（链接/特殊文件一律拒绝），再复制。
            const currentDeps = fx.dirContentMap(from, {
                onSpecial: (rel, kind, abs) => {
                    throw new InstallError('DEPS_UNSAFE', `依赖目录含${kind === 'link' ? '符号链接' : '特殊条目'}（拒绝复制）: ${abs}`);
                },
            });
            const manifest = readManifest(cand);
            if (!manifest || !manifest.dependencyHash || !fx.mapsEqual(manifest.dependencyHash, currentDeps)) {
                throw new InstallError('DEPS_UNSAFE', '依赖与原安装清单不符，拒绝复制。');
            }
            fx.copyDirContents(from, to);
            if (!fx.mapsEqual(fx.dirContentMap(to), currentDeps)) {
                throw new InstallError('DEPS_UNSAFE', '依赖复制结果与核验快照不符，拒绝继续。');
            }
        } catch (e) {
            if (e instanceof InstallError && e.code === 'DEPS_UNSAFE') throw e;
            continue;
        }
        if (depsSatisfied(tp.stageBackend, deps)) return true;
    }
    return false;
}

// ───────────────────────────── commit ─────────────────────────────

/**
 * 提交切换（必须已停服确认）：每一步动作前先写 journal。
 * 关键约束：
 *  - 备份两侧**分别**移动并逐步持久化，任一侧失败 → 整体回滚（恢复已移动侧，另一侧不动）。
 *  - config 改写前 CAS 原字节；预期改写后哈希先写 journal，再 rename。
 *  - DONE 判定必须复核「两侧内容 + 清单 + config 已设置且哈希符合」。
 */
function commit(prepared = {}, planOrOpts = {}, opts = {}) {
    const original = planOrOpts && planOrOpts.paths ? planOrOpts : prepared.plan || null;
    const o = planOrOpts && planOrOpts.paths ? opts : planOrOpts;
    if (!o || !o.stoppedConfirmed) throw new InstallError('NOT_CONFIRMED', '切换前必须停服并关闭所有页面。');
    const app = path.resolve(prepared.appDir || '');
    assertValidApp(app);
    const ap = appPaths(app), lock = acquireRunLock(ap);
    try {
        const tx = readJournal(app);
        if (!tx || tx.txId !== prepared.txId || tx.phase !== 'PREPARED') throw new InstallError('TX_INVALID', '事务与待提交阶段不匹配。');
        const cfg = trustedConfig(app, tx, o, original);
        if (fx.fileSha256(cfg) !== tx.configSpec.beforeHash) throw new InstallError('CONFIG_CHANGED', 'config 自准备以来已改动，拒绝覆盖。');
        // Restore only choices the user approved, and compare targets to preparation snapshots.
        for (const side of SIDES) {
            if (!snapshotMatches(side === 'backend' ? ap.backendDir : ap.frontendDir, tx.oldSnapshots[side])) throw new InstallError('TARGET_CHANGED', side + ' 自准备以来已改动。');
        }
        const choices = tx.options;
        const fresh = plan({ appDir: app, configPath: cfg, enableServerPlugins: tx.configSpec.enable,
            installDeps: tx.installDeps, takeover: choices.takeover, dataRoot: choices.dataRoot,
            noDataRoot: choices.noDataRoot, _allowPendingTx: true });
        if (!fresh.canProceed) throw new InstallError('REJECTED_TARGET', fresh.reason || '目标无法安全升级。');
        const tp = txPaths(app, tx.txId), bp = backupPaths(app, tx.backupId);
        verifyStageIntegrity(tx, tp);
        const missing = installedDepsIn(tp.stageBackend, releaseDependencies());
        if (missing.length) throw new InstallError('DEPS_MISSING', 'stage 缺少依赖: ' + missing.join(', '));
        const p = Object.assign({}, fresh, { configPath: cfg, configSig: tx.configSpec.beforeHash });
        setPhase(tx, 'SWITCHING');
        try {
            backupTargets(tx, ap, bp);
            pushStep(tx, 'BACKED_UP');
            backupConfigBytes(tx, bp, p);
            pushStep(tx, 'CONFIG_BACKED_UP');
            fx.moveNoClobber(tp.stageBackend, ap.backendDir);
            tx.swap = { backend: true, frontend: false }; pushStep(tx, 'BACKEND_SWAPPED');
            fx.moveNoClobber(tp.stageFrontend, ap.frontendDir);
            tx.swap.frontend = true; pushStep(tx, 'FRONTEND_SWAPPED');
            const result = applyConfigChange(tx, p);
            pushStep(tx, 'CONFIG_UPDATED', { configChanged: result.changed });
            if (!isFullyNew(tx, ap, { configPath: cfg }).ok) throw new InstallError('COMMIT_VERIFY_FAILED', '前后端或配置与事务不一致。');
            pushStep(tx, 'VERIFIED');
            tx.configSha256After = result.sha256After;
            updateBackupMeta(app, tx);
            setPhase(tx, 'DONE', { completedAt: new Date().toISOString() });
            return { action: tx.action, txId: tx.txId, backupId: tx.backupId, appDir: app,
                backendDir: ap.backendDir, frontendDir: ap.frontendDir, configPath: cfg,
                configChanged: result.changed, backupDir: bp.base };
        } catch (e) {
            const rb = rollbackTx(app, tx, { configPath: cfg, reason: e.message });
            if (!rb.ok) throw new InstallError('COMMIT_FAILED_ROLLBACK_FAILED', e.message + '；回滚未完成: ' + rb.errors.join('；'));
            throw new InstallError(e.code || 'COMMIT_FAILED', e.message + '；已回滚，新内容保留在 quarantine。');
        }
    } finally { releaseRunLock(lock); }
}

function verifyStageIntegrity(tx, tp) {
    if (!tx.newSnapshots || !snapshotMatches(tp.stageBackend, tx.newSnapshots.backend) || !snapshotMatches(tp.stageFrontend, tx.newSnapshots.frontend)) {
        throw new InstallError('STAGE_INVALID', 'stage 完整快照与准备时不一致。');
    }
    const m = readManifest(tp.stageBackend);
    if (!m || m.version !== tx.releaseVersion) throw new InstallError('STAGE_INVALID', 'stage 清单/版本不一致。');
    return m;
}

function checkConfigState(configPath, configResult) {
    if (!configPath) return { ok: false, reason: '缺少 config 路径（信息不足，拒绝判定完成）。' };
    let text;
    try {
        text = fs.readFileSync(configPath, 'utf8');
    } catch (e) {
        return { ok: false, reason: `无法读取 config（${e.code || e.message}），拒绝判定完成。` };
    }
    let scan;
    try {
        scan = scanEnableServerPlugins(text);
    } catch (e) {
        return { ok: false, reason: `config 格式无法确认（${e.code || e.message}），拒绝判定完成。` };
    }
    if (!scan.found || scan.value !== 'true') return { ok: false, reason: 'config 未设置为 enableServerPlugins: true，拒绝判定完成。' };
    if (configResult && configResult.sha256After) {
        const cur = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
        if (cur !== configResult.sha256After) {
            return { ok: false, reason: 'config 内容与本次改写的预期哈希不符（可能被并发改动），拒绝判定完成。' };
        }
    }
    return { ok: true };
}

/**
 * 备份旧目标（存在才备份）。逐侧移动、逐侧持久化：
 *  tx.backupState 保留逐侧日志；恢复以完整 old/new 快照和实际目录内容为准，
 *  因为 rename 成功后可能在 moved 标志持久化前断电。
 */
function backupTargets(tx, ap, bp) {
    fx.safeResolve(bp.base, 'backup');
    tx.backupState = {};
    for (const side of SIDES) tx.backupState[side] = {
        existedBefore: tx.targetPresent[side], expectedHash: tx.oldSnapshots[side], moved: false,
    };
    writeJournal(ap.appDir, tx);
    updateBackupMeta(ap.appDir, tx);
    for (const side of SIDES) {
        const target = side === 'backend' ? ap.backendDir : ap.frontendDir;
        const dest = bp[side], old = tx.oldSnapshots[side];
        if (old === null) continue;
        if (!snapshotMatches(target, old)) throw new InstallError('TARGET_CHANGED', side + ' 在移动前已改动。');
        fx.moveNoClobber(target, dest);
        // Recovery verifies the real destination even if power fails before this write.
        if (!snapshotMatches(dest, old)) throw new InstallError('BACKUP_HASH_MISMATCH', side + ' 备份不完整。');
        tx.backupState[side].moved = true;
        writeJournal(ap.appDir, tx);
        if (_stepHook) _stepHook('BACKUP_MOVED_' + side.toUpperCase(), tx);
    }
    return tx.backupState;
}
function updateBackupMeta(app, tx) {
    const bp = backupPaths(app, tx.backupId);
    fx.safeResolve(bp.base, 'backup');
    fx.writeJsonAtomic(bp.meta, { schema: 2, appDir: app, backupId: tx.backupId,
        txId: tx.txId, present: tx.targetPresent, oldSnapshots: tx.oldSnapshots,
        newSnapshots: tx.newSnapshots, configSpec: tx.configSpec,
        configSha256After: tx.configSha256After || null, configBackupSha256: tx.configBackupSha256 || null,
        options: tx.options, releaseVersion: tx.releaseVersion });
}

function backupConfigBytes(tx, bp, planObj) {
    const cfg = planObj.configPath;
    fx.safeFile(cfg, 'config');
    const data = fs.readFileSync(cfg), hash = crypto.createHash('sha256').update(data).digest('hex');
    if (hash !== tx.configSpec.beforeHash) throw new InstallError('CONFIG_CHANGED', 'config 已并发修改，拒绝覆盖。');
    if (!fx.exists(bp.config)) fx.writeBytesAtomic(bp.config, data);
    if (fx.fileSha256(bp.config) !== hash) throw new InstallError('CONFIG_BACKUP_MISMATCH', '配置备份不匹配。');
    const bak = cfg + '.bak-' + tx.txId;
    if (!fx.exists(bak)) fs.writeFileSync(bak, data, { flag: 'wx', mode: 0o600 });
    tx.configBackupSha256 = hash;
    tx.configSha256 = hash;
    writeJournal(tx.appDir, tx);
    updateBackupMeta(tx.appDir, tx);
}

function applyConfigChange(tx, planObj) {
    const cfg = planObj.configPath;
    fx.safeFile(cfg, 'config');
    const before = fs.readFileSync(cfg), cur = crypto.createHash('sha256').update(before).digest('hex');
    if (cur !== tx.configSpec.beforeHash) throw new InstallError('CONFIG_CHANGED', 'config 在备份后被并发修改。');
    if (!tx.configSpec.enable) {
        tx.configSha256After = cur; writeJournal(tx.appDir, tx); updateBackupMeta(tx.appDir, tx);
        return { changed: false, sha256Before: cur, sha256After: cur };
    }
    const text = before.toString('utf8'), scan = scanEnableServerPlugins(text);
    if (!scan.found) throw new InstallError('CONFIG_KEY_MISSING', '缺少 enableServerPlugins，拒绝猜测。');
    if (scan.value === 'true') {
        tx.configSha256After = cur; writeJournal(tx.appDir, tx); updateBackupMeta(tx.appDir, tx);
        return { changed: false, sha256Before: cur, sha256After: cur };
    }
    const lines = text.split(/\r?\n/);
    lines[scan.lineNo] = lines[scan.lineNo].replace(/enableServerPlugins\s*:\s*false/, 'enableServerPlugins: true');
    const next = Buffer.from(lines.join('\n'), 'utf8'), after = crypto.createHash('sha256').update(next).digest('hex');
    tx.configSha256After = after;
    tx.configChange = { sha256Before: cur, sha256After: after };
    writeJournal(tx.appDir, tx); updateBackupMeta(tx.appDir, tx);
    if (_stepHook) _stepHook('CONFIG_INTENT_WRITTEN', tx);
    const tmp = cfg + '.tmp-' + crypto.randomUUID();
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, next); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
        fx.safeFile(cfg, 'config');
        if (fx.fileSha256(cfg) !== cur) throw new InstallError('CONFIG_CHANGED', 'config 在写入前被并发修改，保留用户改动。');
        fs.renameSync(tmp, cfg);
    } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
    if (_stepHook) _stepHook('CONFIG_WRITTEN', tx);
    if (fx.fileSha256(cfg) !== after) throw new InstallError('CONFIG_CHANGED', 'config 写入后不匹配。');
    return { changed: true, sha256Before: cur, sha256After: after };
}

function apply(input = {}, opts = {}, deps = {}) {
    const p = plan(input);
    if (p.action === 'noop') {
        if (!p.depsCheck.ok) throw new InstallError('DEPS_MISSING', p.depsCheck.reason);
        return { action: 'noop', appDir: p.appDir, message: '同版本且前后端内容哈希均匹配，无需重复安装。' };
    }
    if (p.action === 'rejected') throw new InstallError('REJECTED_TARGET', p.reason);
    const prepared = prepare(p, deps);
    return commit(prepared, p, opts);
}

// ───────────────────────────── recover / rollback ─────────────────────────────

/**
 * 恢复未完成事务（必须停服确认）：
 *  - PREPARED：stage 完整 → 由 commit 持锁重试提交；stage 不完整 → 阻塞并提示 --rollback。
 *  - SWITCHING：两侧均为新版且 config 符合 → 补 DONE；否则整体回到安装前状态（ROLLED_BACK）。
 *  - ROLLING_BACK：按实际完整快照继续回滚；PREPARING / FAILED 须显式 --rollback 放弃准备。
 */
function recover(appDir, opts = {}) {
    const app = path.resolve(appDir); assertValidApp(app);
    const ap = appPaths(app), initial = readJournal(app);
    if (!initial) throw new InstallError('NO_JOURNAL', '没有安装事务。');
    if (['DONE','ROLLED_BACK'].includes(initial.phase)) return { action: 'noop', message: '事务已收敛。', txId: initial.txId };
    if (!opts.stoppedConfirmed) throw new InstallError('NOT_CONFIRMED', '恢复必须先停服并关闭所有页面。');
    if (['PREPARING','FAILED'].includes(initial.phase)) throw new InstallError(initial.phase === 'FAILED' ? 'TX_ABORTED' : 'TX_PREPARING', '准备未完成，请 --rollback 放弃事务并保留 stage。');
    const cfg = trustedConfig(app, initial, opts);
    // PREPARED commit owns its lock; never acquire it twice here.
    if (initial.phase === 'PREPARED') {
        const r = commit({ txId: initial.txId, appDir: app }, Object.assign({}, opts, { configPath: cfg }));
        return { action: 'recovered', message: '已完成原准备事务。', txId: initial.txId, committed: r };
    }
    const lock = acquireRunLock(ap);
    try {
        const tx = readJournal(app);
        if (tx.txId !== initial.txId) throw new InstallError('TX_INVALID', '恢复期间事务已变化。');
        if (tx.phase === 'SWITCHING' && isFullyNew(tx, ap, { configPath: cfg }).ok) {
            updateBackupMeta(app, tx); setPhase(tx, 'DONE');
            return { action: 'recovered', message: '已校验前后端及配置并补写完成记录。', txId: tx.txId };
        }
        const rb = rollbackTx(app, tx, { configPath: cfg, reason: 'recover' });
        if (!rb.ok) throw new InstallError('ROLLBACK_INCOMPLETE', rb.errors.join('；'));
        return Object.assign({ action: 'rolled_back', message: '已恢复安装前状态。' }, rb);
    } finally { releaseRunLock(lock); }
}

function validateJournalShape(tx, app) {
    const bad = () => { throw new InstallError('JOURNAL_INVALID', 'journal 结构/路径/快照非法，保留现场并拒绝写入。'); };
    if (!tx || typeof tx !== 'object' || Array.isArray(tx) || tx.schema !== JOURNAL_SCHEMA) bad();
    if (typeof tx.appDir !== 'string' || path.resolve(tx.appDir) !== path.resolve(app)) bad();
    if (typeof tx.txId !== 'string' || typeof tx.backupId !== 'string' || !ALL_PHASES.includes(tx.phase)) bad();
    txPaths(app, tx.txId); backupPaths(app, tx.backupId);
    if (!Array.isArray(tx.steps) || !['install','rollback'].includes(tx.kind)) bad();
    if (Object.prototype.hasOwnProperty.call(tx, 'configPath')) bad();
    if (!tx.oldSnapshots || !tx.targetPresent || !tx.configSpec || !tx.options) bad();
    for (const side of SIDES) {
        if (typeof tx.targetPresent[side] !== 'boolean') bad();
        if (!validSnapshot(tx.oldSnapshots[side], true)) bad();
        if (tx.targetPresent[side] !== (tx.oldSnapshots[side] !== null)) bad();
    }
    if (typeof tx.options.takeover !== 'boolean' || typeof tx.options.noDataRoot !== 'boolean' || (tx.options.dataRoot !== null && (typeof tx.options.dataRoot !== 'string' || !path.isAbsolute(tx.options.dataRoot)))) bad();
    if (tx.rollbackCurrent) for (const side of SIDES) if (!validSnapshot(tx.rollbackCurrent[side], true)) bad();
    const c = tx.configSpec;
    if (typeof c.external !== 'boolean' || typeof c.enable !== 'boolean' || !/^[a-f0-9]{64}$/.test(c.pathHash) || !/^[a-f0-9]{64}$/.test(c.beforeHash)) bad();
    if (tx.newSnapshots) for (const side of SIDES) if (!validSnapshot(tx.newSnapshots[side], false)) bad();
    if (['PREPARED','SWITCHING','DONE'].includes(tx.phase) && tx.kind === 'install' && !tx.newSnapshots) bad();
    return true;
}
function validSnapshot(map, allowNull) {
    if (map === null) return allowNull;
    if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
    return Object.entries(map).every(([k,v]) => k && !k.split('/').some(x => !x || x === '.' || x === '..') && !k.includes('\\') && !path.isAbsolute(k) && (v === fx.SENTINEL.DIR || /^[a-f0-9]{64}$/.test(v)));
}
function snapshot(dir) {
    fx.safeResolve(dir, 'snapshot');
    if (!fx.exists(dir)) return null;
    const map = fx.dirContentMap(dir);
    if (!validSnapshot(map, false)) throw new InstallError('LINK_REJECTED', '目录含链接或特殊文件，拒绝移动。');
    return map;
}
function snapshotMatches(dir, expected) {
    const current = snapshot(dir);
    return current === null || expected === null ? current === expected : fx.mapsEqual(current, expected);
}
function pathHash(p) { return crypto.createHash('sha256').update(path.resolve(p)).digest('hex'); }
function trustedConfig(app, tx, opts = {}, originalPlan = null) {
    let cfg;
    if (tx.configSpec.external) {
        cfg = opts.configPath || (originalPlan && originalPlan.configSource === 'cli' && originalPlan.configPath);
        if (!cfg || !path.isAbsolute(cfg)) throw new InstallError('CONFIG_REQUIRED', '外置 config 的提交/恢复/回滚必须显式 --config 指定原文件。');
    } else cfg = appPaths(app).configPath;
    cfg = path.resolve(cfg);
    if (pathHash(cfg) !== tx.configSpec.pathHash) throw new InstallError('CONFIG_SOURCE_MISMATCH', 'config 路径与本次事务授权不一致。');
    fx.safeFile(cfg, 'config');
    return cfg;
}

function isFullyNew(tx, ap, planObj) {
    if (!tx.newSnapshots || !snapshotMatches(ap.backendDir, tx.newSnapshots.backend) || !snapshotMatches(ap.frontendDir, tx.newSnapshots.frontend)) return { ok: false, reason: '前后端与事务快照不符' };
    if (!tx.configSha256After) return { ok: false, reason: '配置提交尚未完成' };
    const cfg = planObj && planObj.configPath;
    if (!cfg || fx.fileSha256(cfg) !== tx.configSha256After) return { ok: false, reason: '配置与事务结果不符' };
    if (tx.configSpec.enable) return checkConfigState(cfg, { sha256After: tx.configSha256After });
    return { ok: true };
}

function rollbackTx(app, tx, opts = {}) {
    validateJournalShape(tx, app);
    const ap = appPaths(app), tp = txPaths(app, tx.txId), bp = backupPaths(app, tx.backupId);
    const cfg = trustedConfig(app, tx, opts);
    if (tx.phase !== 'ROLLING_BACK') setPhase(tx, 'ROLLING_BACK', { rollbackReason: opts.reason || 'rollback' });
    const restored = [], quarantined = Array.isArray(tx.quarantined) ? tx.quarantined : [], errors = [];
    for (const side of SIDES) {
        const target = side === 'backend' ? ap.backendDir : ap.frontendDir, old = tx.oldSnapshots[side], backup = bp[side];
        try {
            // A successful rename may not have been journalled: disk hashes are authoritative.
            if (snapshotMatches(target, old)) { restored.push(side); continue; }
            if (old !== null && !snapshotMatches(backup, old)) throw new InstallError('BACKUP_INVALID', '旧版备份缺失或完整哈希不符');
            const current = snapshot(target);
            const expectedNew = tx.newSnapshots && tx.newSnapshots[side];
            if (current !== null && (!expectedNew || !fx.mapsEqual(current, expectedNew))) {
                // An explicit historical rollback may quarantine current user changes, never delete them.
                if (tx.kind !== 'rollback' || !tx.rollbackCurrent || !snapshotMatches(target, tx.rollbackCurrent[side])) throw new InstallError('TARGET_CHANGED', '目标存在未知改动，保留并等待人工核对');
            }
            if (current !== null) {
                const q = fx.moveToQuarantine(target, tp.quarantine); if (q) quarantined.push(side + ':' + path.basename(q));
            }
            if (old !== null) fx.moveNoClobber(backup, target);
            if (!snapshotMatches(target, old)) throw new InstallError('RESTORE_HASH_MISMATCH', '恢复后完整快照不符');
            restored.push(side);
            tx.restored = restored; tx.quarantined = quarantined; writeJournal(app, tx);
            if (_stepHook) _stepHook('ROLLBACK_' + side.toUpperCase(), tx);
        } catch (e) { errors.push(side + ': ' + e.message); }
    }
    let configRestored = null;
    try {
        if (fx.exists(bp.config)) {
            fx.safeFile(bp.config, 'configBackup');
            const data = fs.readFileSync(bp.config), hash = crypto.createHash('sha256').update(data).digest('hex');
            if (hash !== tx.configSpec.beforeHash || (tx.configBackupSha256 && hash !== tx.configBackupSha256)) throw new InstallError('CONFIG_BACKUP_MISMATCH', '配置备份哈希不符');
            const cur = fx.fileSha256(cfg);
            if (cur === hash) configRestored = 'already-original';
            else if (tx.configSha256After && cur === tx.configSha256After) {
                // Recheck after any preparatory I/O; preserve all unrecognised user bytes.
                if (fx.fileSha256(cfg) !== cur) throw new InstallError('CONFIG_CHANGED', '配置回滚前已变化');
                fx.writeBytesAtomic(cfg, data); configRestored = 'restored';
            } else configRestored = 'user-modified-kept';
        }
    } catch (e) { errors.push('config: ' + e.message); }
    tx.restored = restored; tx.quarantined = quarantined; tx.configRestored = configRestored; tx.rollbackErrors = errors;
    if (errors.length) { writeJournal(app, tx); return { ok: false, errors, restored, quarantined, configRestored, txId: tx.txId }; }
    setPhase(tx, 'ROLLED_BACK', { rolledBackAt: new Date().toISOString() });
    return { ok: true, action: 'rolled_back', errors: [], restored, quarantined, configRestored, txId: tx.txId };
}

function rollback(appDir, opts = {}) {
    const app = path.resolve(appDir); assertValidApp(app);
    const ap = appPaths(app), before = readJournal(app);
    if (!opts.stoppedConfirmed) throw new InstallError('NOT_CONFIRMED', '回滚必须先停服并关闭所有页面。');
    if (before && before.phase === 'ROLLED_BACK' && (!opts.to || opts.to === before.backupId)) return { action: 'noop', message: '已回滚，无需重复。', txId: before.txId };
    const lock = acquireRunLock(ap);
    try {
        let tx = readJournal(app);
        if (tx && OPEN_PHASES.includes(tx.phase)) {
            const cfg = trustedConfig(app, tx, opts);
            const rb = rollbackTx(app, tx, { configPath: cfg, reason: 'cli-rollback' });
            if (!rb.ok) throw new InstallError('ROLLBACK_INCOMPLETE', rb.errors.join('；'));
            return rb;
        }
        const id = opts.to || (tx && tx.backupId) || latestBackupId(app);
        if (!id) throw new InstallError('NO_BACKUP', '没有可回滚备份。');
        return rollbackToBackup(app, ap, id, opts);
    } finally { releaseRunLock(lock); }
}

function rollbackToBackup(app, ap, backupId, opts = {}) {
    const bp = backupPaths(app, backupId);
    const meta = fx.readJsonStrict(bp.meta, { code: 'BACKUP_INVALID', label: '备份清单' });
    if (!meta) throw new InstallError('NO_BACKUP', '备份清单缺失。');
    const tx = {
        schema: JOURNAL_SCHEMA, kind: 'rollback', txId: fx.newId('tx'), backupId, appDir: app,
        phase: 'ROLLING_BACK', action: 'rollback', releaseVersion: meta.releaseVersion || 'rollback',
        oldSnapshots: meta.oldSnapshots, newSnapshots: meta.newSnapshots,
        targetPresent: meta.present, options: meta.options,
        configSpec: meta.configSpec, configSha256After: meta.configSha256After,
        configBackupSha256: meta.configBackupSha256, steps: [],
        rollbackCurrent: { backend: snapshot(ap.backendDir), frontend: snapshot(ap.frontendDir) },
    };
    validateJournalShape(tx, app);
    if (meta.appDir !== app || meta.backupId !== backupId) throw new InstallError('BACKUP_INVALID', '备份身份不匹配。');
    const cfg = trustedConfig(app, tx, opts);
    // Before the first mutation, persist a recoverable rollback intent.
    writeJournal(app, tx);
    const rb = rollbackTx(app, tx, { configPath: cfg, reason: 'historical-rollback' });
    if (!rb.ok) throw new InstallError('ROLLBACK_INCOMPLETE', rb.errors.join('；'));
    return Object.assign({ backupId }, rb);
}

function latestBackupId(appDir) {
    const ap = appPaths(appDir);
    let names;
    try {
        names = fs.readdirSync(ap.backups, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
        return null;
    }
    names.sort();
    return names.length ? names[names.length - 1] : null;
}

/** 列出保留的备份（供 --status/人工核对）。 */
function listBackups(appDir) {
    const ap = appPaths(appDir);
    let names;
    try {
        names = fs.readdirSync(ap.backups, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
        return [];
    }
    names.sort();
    return names.map((n) => {
        let bp = null;
        try {
            bp = backupPaths(appDir, n);
        } catch {
            return { backupId: n, dir: null, meta: null };
        }
        return { backupId: n, dir: bp.base, meta: fx.readJsonOrNull(bp.meta) };
    });
}

// ───────────────────────────── 用户级扩展遮蔽 ─────────────────────────────

/**
 * 只读扫描显式 dataRoot，检测「用户级同名扩展」（会遮蔽共享级扩展）。
 *
 * 官方（源码 src/users.js）每个用户的 `root = <dataRoot>/<handle>`，
 * 用户扩展目录 = `<root>/extensions/<name>`（**直系**），扫描目录里没有 third-party 这一层；
 * 旧版/第三方布局 `<root>/extensions/third-party/<name>` 也一并检查（兼容）。
 *
 * 安全：dataRoot 自身及其下用到的每一段祖先 + 最终节点都做 lstat，任何链接/junction 或读取错误
 * **一律 fail-closed**（记录到 hardError / 直接报错），绝不跟随链接扫描。
 */
function scanShadowExtensions(dataRoot, appDir) {
    const root = path.resolve(dataRoot);
    const found = [];
    const hardErrors = [];
    let st;
    try {
        st = fx.lstatOrNull(root);
    } catch (e) {
        return { root, ok: false, found: [], hardError: [`读取 data-root 失败: ${e.code || e.message}`], error: `data-root 不可读: ${e.message}`, appDir };
    }
    if (!st) {
        return { root, ok: false, found: [], hardError: ['data-root 不存在'], error: 'data-root 不存在（请显式指定酒管用户数据目录）', appDir };
    }
    if (st.isSymbolicLink() || fx.isLink(root)) {
        return { root, ok: false, found: [], hardError: ['data-root 是链接'], error: 'data-root 是链接/junction（拒绝跟随扫描）。', appDir };
    }
    if (!st.isDirectory()) {
        return { root, ok: false, found: [], hardError: ['data-root 不是目录'], error: 'data-root 不是目录（拒绝）。', appDir };
    }

    let users;
    try {
        users = fs.readdirSync(root, { withFileTypes: true });
    } catch (e) {
        return { root, ok: false, found: [], hardError: [`data-root 不可读: ${e.code || e.message}`], error: `data-root 不可读: ${e.message}`, appDir };
    }
    for (const user of users) {
        const userDir = path.join(root, user.name);
        try {
            if (user.isSymbolicLink()) {
                hardErrors.push(`用户目录是链接（拒绝跟随）: ${userDir}`);
                continue;
            }
            if (!user.isDirectory()) continue;
            if (fx.isLink(userDir)) {
                hardErrors.push(`用户目录是 junction/重解析点（拒绝跟随）: ${userDir}`);
                continue;
            }
            const extDir = path.join(userDir, 'extensions');
            const extSt = fx.lstatOrNull(extDir);
            if (!extSt) continue;
            if (!extSt.isDirectory() || fx.isLink(extDir)) {
                hardErrors.push(`extensions 不是真实目录（拒绝跟随）: ${extDir}`);
                continue;
            }
            const candidates = [];
            // 官方直系：<root>/extensions/<name>
            candidates.push(path.join(extDir, PLUGIN_TARGET_NAME));
            // 旧版/第三方布局：<root>/extensions/third-party/<name>
            candidates.push(path.join(extDir, 'third-party', PLUGIN_TARGET_NAME));
            for (const cand of candidates) {
                let cst;
                try {
                    cst = fx.lstatOrNull(cand);
                } catch (e) {
                    hardErrors.push(`无法读取 ${cand}（${e.code || e.message}）`);
                    continue;
                }
                if (!cst) continue;
                if (cst.isSymbolicLink()) {
                    hardErrors.push(`用户级扩展是符号链接（拒绝跟随）: ${cand}`);
                    continue;
                }
                if (fx.isLink(cand)) {
                    hardErrors.push(`用户级扩展是 junction/重解析点（拒绝跟随）: ${cand}`);
                    continue;
                }
                if (!found.includes(cand)) found.push(cand);
            }
        } catch (e) {
            hardErrors.push(`扫描 ${userDir} 失败: ${e.code || e.message}`);
        }
    }
    const blocked = found.length > 0 || hardErrors.length > 0;
    return {
        root,
        ok: !blocked,
        found,
        hardError: hardErrors,
        appDir,
        error: blocked
            ? found.length
                ? '检测到用户级同名扩展：共享级（public/...）会被用户级遮蔽。请先备份这些用户级扩展，再卸载或把目录移出 extensions 扫描目录，之后重新运行向导；仅停用仍会阻断安装。'
                : '扫描用户级扩展时遇到链接/不可读项（fail-closed）：' + hardErrors.join('；')
            : null,
    };
}

/**
 * 安装完成前再次只读检查遮蔽是否已实际移除（gate 不允许「确认过了」绕过）。
 * 返回 true=已清除；否则抛 SHADOW_EXTENSION。
 */
function assertShadowCleared(planObj) {
    if (!planObj || !planObj.dataRoot) return true;
    const s = scanShadowExtensions(planObj.dataRoot, planObj.appDir);
    if (s.found.length || s.hardError.length) {
        throw new InstallError('SHADOW_EXTENSION', s.error);
    }
    return true;
}

// ───────────────────────────── 状态 ─────────────────────────────

/** 只读状态（--status 用）。journal 损坏/不可读时如实报告，不吞。 */
function status(appDir) {
    const app = path.resolve(appDir);
    const ap = appPaths(app);
    const out = { appDir: app, work: ap.work, journal: null, journalError: null, backups: [], configSource: null };
    try {
        out.journal = readJournal(app);
    } catch (e) {
        out.journalError = { code: e.code, message: e.message };
    }
    try {
        out.configSource = readConfigSourceRecord(app);
    } catch (e) {
        out.configSource = { error: e.message };
    }
    out.backups = listBackups(app);
    return out;
}

module.exports = {
    InstallError,
    RELEASE_VERSION,
    FRONTEND_REL,
    BACKEND_REL,
    WORK_REL,
    MANIFEST_BASENAME,
    MANIFEST_SCHEMA,
    JOURNAL_SCHEMA,
    CONFIG_SOURCE_BASENAME,
    FRONTEND_FILES,
    OPEN_PHASES,
    appPaths,
    txPaths,
    backupPaths,
    assertValidApp,
    validateManifest,
    readManifest,
    contentHash,
    releaseHashes,
    releaseSourceFiles,
    inspectTargets,
    inspectDeps,
    plan,
    prepare,
    commit,
    apply,
    recover,
    rollback,
    readJournal,
    writeJournal,
    readConfigSourceRecord,
    writeConfigSourceRecord,
    resolveConfigSource,
    scanShadowExtensions,
    assertShadowCleared,
    listBackups,
    latestBackupId,
    status,
    releaseDependencies,
    discovery,
    __setReleaseForTesting,
    __resetReleaseForTesting,
    __setStepHookForTesting,
};

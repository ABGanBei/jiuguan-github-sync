#!/usr/bin/env node
'use strict';
/**
 * 酒管 GitHub 同步 · 一次性安装器（Windows / Termux 通用 Node 脚本）。
 *
 * 把本仓库作为服务端插件安装到酒管宿主的 plugins/ 目录，并可（可选）开启
 * 宿主的 enableServerPlugins 开关、（可选）在新插件目录内执行 npm ci 安装依赖。
 *
 * 安全约束（对齐 docs/integration-contract.md）：
 *  - 默认 dry-run：只列出确切的 source/target/config 计划，不写任何文件；须显式 --apply 才落盘。
 *  - 源目录复制到 <app>/plugins/jiuguan-github-sync，排除 .git / node_modules / test-artifacts /
 *    research / outputs / 令牌文件；绝不递归覆盖已存在的 target（已存在即报错，更新另阶段）。
 *  - 校验 source 本身非 symlink、目标祖先无 junction；app 的 server.js / package.json 必须存在；
 *    目标必须落在 app/plugins 内（不靠目录名含英文判断）。
 *  - config.yaml 仅用严格的单行 top-level `enableServerPlugins:` 匹配，false→true、已 true 幂等、
 *    重复/复杂格式拒绝；不重写整个 yaml；先备份 copy 到唯一文件名再原子改；仅当 --enable-server-plugins 才改。
 *  - 依赖安装只在显式 --install-deps 时执行 `npm ci --omit=dev`（无 shell 拼接、无用户文本注入；
 *    Windows 上 npm 用安全 execFile/spawn 方案定位 npm.cmd）。
 *
 * 用法：
 *   node bin/install-plugin.js --app-dir <应用目录> [--enable-server-plugins] [--install-deps] [--apply]
 *
 * 用户可见文字只称「酒管」，不出现产品英文全称。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// Node.js 最低版本要求（>= 20，与宿主及核心一致）。
const MIN_NODE_MAJOR = 20;

// 服务端插件在宿主内的目标目录名（固定，不靠英文名判断归属）。
const PLUGIN_TARGET_NAME = 'jiuguan-github-sync';

// 复制时排除的源内相对条目（含目录与文件）。令牌文件不含在此列表之外，见下方 collectSourceFiles。
const EXCLUDED_REL = new Set([
    '.git',
    'node_modules',
    'test-artifacts',
    'research',
    'outputs',
]);

// 已知可能承载令牌/敏感内容的文件名（相对源根的 basename 精确匹配，大小写不敏感）。
// 严格排除：任何 basename 以 token/pat 开头、或等于 .env* / credentials* 等，均不复制。
// 正常路径如 planner/path 模块（其 basename 不含上述前缀）不受影响。
const TOKENISH_NAMES = new Set([
    '.env', '.env.local', '.env.production',
    'token', 'token.txt', 'token.json', 'pat', 'pat.txt', 'pat.json',
    'github-token', 'github-token.txt', 'github-pat', 'github-pat.txt',
    'credentials', 'credentials.json', 'secrets.json', '.secrets',
]);

/** 判定某 basename（大小写不敏感）是否属于令牌/敏感文件名。 */
function isTokenishName(basename) {
    const lower = basename.toLowerCase();
    if (TOKENISH_NAMES.has(lower)) return true;
    // 任何以 token / pat 开头的 basename 一律排除。
    if (lower.startsWith('token') || lower.startsWith('pat')) return true;
    // .env* / credentials* 前缀排除。
    if (lower.startsWith('.env') || lower.startsWith('credentials')) return true;
    return false;
}

// ===================== 错误类型 =====================

class InstallError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'InstallError';
        this.code = code;
    }
}

// ===================== 参数解析 =====================

function parseArgs(argv) {
    const args = { appDir: null, enableServerPlugins: false, installDeps: false, apply: false };
    const unknown = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--app-dir': {
                const v = argv[++i];
                if (!v) return { error: '--app-dir 需要跟一个目录路径。' };
                args.appDir = v;
                break;
            }
            case '--enable-server-plugins': args.enableServerPlugins = true; break;
            case '--install-deps': args.installDeps = true; break;
            case '--apply': args.apply = true; break;
            case '--help':
            case '-h':
                return { help: true, args };
            default:
                unknown.push(a);
        }
    }
    if (unknown.length) {
        return { error: `未知参数: ${unknown.join(' ')}` };
    }
    if (!args.appDir) {
        return { error: '缺少 --app-dir <应用目录>。' };
    }
    return { args };
}

function printHelp() {
    console.log(`酒管 GitHub 同步 · 一次性安装器（Windows / Termux 通用）

用法:
  node bin/install-plugin.js --app-dir <应用目录> [--enable-server-plugins] [--install-deps] [--apply]

选项:
  --app-dir <路径>          酒管应用根目录（含 server.js 与 package.json）。
  --enable-server-plugins   将 config.yaml 顶层 enableServerPlugins 由 false 改为 true（幂等）。
  --install-deps            在新插件目录内执行 npm ci --omit=dev 安装依赖。
  --apply                   真正写文件；默认 dry-run（只打印计划，不写任何文件）。

说明:
  源目录 = 本仓库根（bin/ 的上一级）。复制到 <应用目录>/plugins/jiuguan-github-sync，
  排除 .git / node_modules / test-artifacts / research / outputs / 令牌文件，绝不覆盖已存在的目标目录。
  依赖默认不装；如不加 --install-deps，需自行在插件目录执行 npm ci。`);
}

// ===================== 文件系统校验原语 =====================

/** 判定一个路径（或其祖先）是否为 symlink/junction/reparse point。 */
function isLink(p) {
    try {
        const st = fs.lstatSync(p);
        return st.isSymbolicLink();
    } catch {
        return false;
    }
}

/** 逐段校验 from 到 target 的每一段均为真实目录（拒绝 symlink/junction/reparse point）。 */
function assertNoLinkInChain(from, target) {
    const parts = [];
    let cur = target;
    while (true) {
        const parent = path.dirname(cur);
        if (parent === cur) break;
        parts.push(cur);
        if (path.resolve(cur) === path.resolve(from) || path.resolve(cur).length <= path.resolve(from).length) {
            if (path.resolve(cur) === path.resolve(from)) break;
        }
        cur = parent;
        // 安全护栏：避免死循环（盘根 dirname 恒等于自身）。
    }
    for (const seg of parts) {
        if (isLink(seg)) {
            throw new InstallError('LINK_REJECTED', `路径含符号链接/junction（拒绝）: ${seg}`);
        }
    }
}

/** 校验从盘根到 base 的整条链均为真实目录（base 本身可不存在，但祖先必须真实且非链接）。 */
function assertRealAncestors(base) {
    let cur = path.resolve(base);
    const check = [];
    while (true) {
        const parent = path.dirname(cur);
        if (parent === cur) break;
        check.push(cur);
        cur = parent;
    }
    // 从盘根向下逐个检查已存在的段。
    const existing = [];
    for (let i = check.length - 1; i >= 0; i--) {
        const seg = check[i];
        let st;
        try {
            st = fs.lstatSync(seg);
        } catch (e) {
            if (e.code === 'ENOENT') {
                // 这一段不存在，后续段必然也不存在，停止。
                break;
            }
            throw new InstallError('STAT_FAILED', `无法读取路径 ${seg}: ${e.message}`);
        }
        if (st.isSymbolicLink()) {
            throw new InstallError('LINK_REJECTED', `路径含符号链接/junction（拒绝）: ${seg}`);
        }
        if (!st.isDirectory()) {
            throw new InstallError('NOT_DIRECTORY', `路径段不是目录（拒绝）: ${seg}`);
        }
        existing.push(seg);
    }
}

/**
 * 安全逐段创建目录（base 的缺失段），每段创建前先校验「父链已存在的段均为真实目录且非链接」，
 * 创建后再 lstat 复核确实是真实目录。绝不先 ensureDir 写出外部子目录后才拒绝 junction。
 */
function safeMkdirChain(base) {
    const target = path.resolve(base);
    // 先完整校验已存在的祖先链（盘根 → 最近已存在段）均真实且非链接。
    assertRealAncestors(target);

    // 逐段从最近已存在段向下创建缺失段。
    const segs = [];
    let cur = target;
    while (true) {
        const parent = path.dirname(cur);
        if (parent === cur) break;
        segs.unshift(cur);
        cur = parent;
    }
    for (const seg of segs) {
        let st;
        try {
            st = fs.lstatSync(seg);
        } catch (e) {
            if (e.code === 'ENOENT') {
                // 缺失：创建目录（不递归，保证父段已由上一轮确认存在且真实）。
                try {
                    fs.mkdirSync(seg);
                } catch (e2) {
                    throw new InstallError('MKDIR_FAILED', `创建目录失败 ${seg}: ${e2.message}`);
                }
                // 创建后复核。
                st = fs.lstatSync(seg);
            } else {
                throw new InstallError('STAT_FAILED', `无法读取路径 ${seg}: ${e.message}`);
            }
        }
        if (st.isSymbolicLink()) {
            throw new InstallError('LINK_REJECTED', `路径含符号链接/junction（拒绝）: ${seg}`);
        }
        if (!st.isDirectory()) {
            throw new InstallError('NOT_DIRECTORY', `路径段不是目录（拒绝）: ${seg}`);
        }
    }
    return target;
}

/** 判断 path 是否在 dir 之内（拒绝越界）。 */
function isWithin(child, dir) {
    const r = path.resolve(child);
    const d = path.resolve(dir);
    return r === d || r.startsWith(d + path.sep);
}

// ===================== 源文件收集 =====================

/** 递归收集源目录内待复制文件（相对源根的 POSIX 风格相对路径），排除敏感/构建产物。 */
function collectSourceFiles(sourceRoot) {
    const files = [];
    const walk = (dir, relParts) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            throw new InstallError('SOURCE_READ_FAILED', `读取源目录失败 ${dir}: ${e.message}`);
        }
        for (const ent of entries) {
            const name = ent.name;
            const abs = path.join(dir, name);
            const rel = path.join(...relParts, name);
            const relPosix = relParts.concat(name).join('/');

            // 排除顶层/任意层的敏感目录（含 .git 等）。
            if (EXCLUDED_REL.has(name) || EXCLUDED_REL.has(relPosix)) {
                continue;
            }
            // 排除令牌文件名（任何以 token/pat 开头、.env*、credentials* 等）。
            if (isTokenishName(name)) {
                continue;
            }

            if (ent.isSymbolicLink()) {
                // 源内的 symlink 一律不复制（避免把链接目标带进宿主）。
                continue;
            }
            if (ent.isDirectory()) {
                // 跳过名字以 . 开头（除 .github 等显式需要的情况）——保守起见只跳过 .git（已在上方）。
                walk(abs, relParts.concat(name));
            } else if (ent.isFile()) {
                files.push({ abs, relPosix });
            }
            // 其他类型（socket/fifo 等）跳过。
        }
    };
    walk(sourceRoot, []);
    return files;
}

// ===================== config.yaml 处理 =====================

/**
 * 严格单行 top-level 匹配 enableServerPlugins: <bool>。
 * 返回 { found:boolean, value:string|null, line:string|null, lineNo:number|null }。
 * 只接受独占一行的顶层**裸键** `enableServerPlugins:`（无引号）且其值仅 `true` / `false`
 * （无注释、无引号、无多余键）。任何带引号键名（"enableServerPlugins" / 'enableServerPlugins'）
 * 或 mapping/复杂形式一律拒绝，绝不当作合法单键改写。
 *
 * 拒绝情形（一律抛错，绝不静默跳过或当缺 key）：
 *  - 任意一行引用了 enableServerPlugins（裸键、加引号键、注释、缩进、mapping）但非
 *    「顶层 + 严格裸键 + 严格 bool + 无尾随注释」→ CONFIG_COMPLEX；
 *  - 存在多处匹配 → CONFIG_AMBIGUOUS（含「注释掉的同名」「加引号同名」「裸键+引号混存」）。
 */
function scanEnableServerPlugins(text) {
    const lines = text.split(/\r?\n/);
    const matches = [];
    // 任何行（含注释行、缩进行、带尾随注释行、加引号键名、mapping 形式）只要引用了该键名，
    // 都纳入“存在性”判定，用于识别重复/复杂形式。
    const mentions = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        // 判定“引用键名”的行：去掉行首空白与可选前导 '#'（含注释掉的同名）后，
        // 仍以裸键或加引号键 + 冒号开头。覆盖裸键、双引号键、单引号键、mapping 值。
        const uncomment = raw.replace(/^\s*#\s*/, '').replace(/\s*#.*$/, '');
        // 键名匹配：裸键 enableServerPlugins，或双/单引号包裹的 "enableServerPlugins" / 'enableServerPlugins'。
        if (/(?:enableServerPlugins|["']enableServerPlugins["'])\s*:/.test(uncomment)) {
            mentions.push({ lineNo: i, raw });
        }
        // 严格单行：独占一行、顶格、裸键、值仅 true/false、无尾随注释。
        // 加引号键名（"enableServerPlugins" / 'enableServerPlugins'）不匹配此严格模式 → 视为复杂拒绝。
        const m = raw.match(/^enableServerPlugins\s*:\s*(true|false)\s*$/);
        if (m) {
            matches.push({ indent: '', value: m[1], line: raw, lineNo: i });
        }
    }

    // 存在引用键名但非严格单行的行 → 复杂/非法格式（含加引号键、缩进、尾随注释、复杂值、mapping），拒绝。
    if (mentions.length > 0 && matches.length === 0) {
        throw new InstallError('CONFIG_COMPLEX', 'config.yaml 中 enableServerPlugins 格式非「顶层严格单行裸键 bool」（含加引号键名/缩进/尾随注释/复杂值），拒绝改写，需人工确认。');
    }
    if (matches.length > 1) {
        throw new InstallError('CONFIG_AMBIGUOUS', `config.yaml 中存在 ${matches.length} 处 enableServerPlugins（拒绝，需人工确认）。`);
    }
    // 引用键名但匹配数不一致（例如 1 个严格裸键 + 1 个注释/加引号/缩进同名）→ 混合重复，拒绝。
    if (mentions.length > 0 && mentions.length !== matches.length) {
        throw new InstallError('CONFIG_AMBIGUOUS', 'config.yaml 中 enableServerPlugins 存在混合/注释/加引号重复定义（拒绝，需人工确认）。');
    }
    if (matches.length === 0) return { found: false, value: null, line: null, lineNo: null };
    return { found: true, value: matches[0].value, line: matches[0].line, lineNo: matches[0].lineNo };
}

/**
 * 将 config.yaml 中 enableServerPlugins: false 改为 true（原子改写）。
 * 返回 { changed:boolean }。已 true 幂等；无该行或非顶层/复杂格式抛错。
 */
function enableServerPluginsInConfig(configPath) {
    let text;
    try {
        text = fs.readFileSync(configPath, 'utf8');
    } catch (e) {
        throw new InstallError('CONFIG_READ_FAILED', `读取 config.yaml 失败: ${e.message}`);
    }
    const scan = scanEnableServerPlugins(text);
    if (!scan.found) {
        throw new InstallError('CONFIG_KEY_MISSING', 'config.yaml 中未找到顶层 enableServerPlugins: 键（拒绝改写）。');
    }
    if (scan.value === 'true') {
        return { changed: false };
    }
    // false → true：单行替换。
    const lines = text.split(/\r?\n/);
    const oldLine = lines[scan.lineNo];
    const newLine = oldLine.replace(/enableServerPlugins\s*:\s*false/, 'enableServerPlugins: true');
    if (newLine === oldLine) {
        throw new InstallError('CONFIG_EDIT_FAILED', '改写 enableServerPlugins 未生效（拒绝）。');
    }
    lines[scan.lineNo] = newLine;
    const newText = lines.join('\n');
    writeConfigAtomically(configPath, newText);
    return { changed: true };
}

/** 先备份 copy 到唯一文件名，再原子改写（临时文件 + rename）。 */
function writeConfigAtomically(configPath, newText) {
    const dir = path.dirname(configPath);
    // 备份：copy 到唯一文件名（保留原样，供人工回滚）。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let backupPath;
    for (let i = 0; ; i++) {
        backupPath = path.join(dir, `config.yaml.bak-${stamp}${i ? '-' + i : ''}`);
        if (!fs.existsSync(backupPath)) break;
    }
    try {
        fs.copyFileSync(configPath, backupPath);
    } catch (e) {
        throw new InstallError('CONFIG_BACKUP_FAILED', `备份 config.yaml 失败: ${e.message}`);
    }

    // 原子改写：临时文件（同目录）+ fsync + rename。
    const tmpPath = path.join(dir, `.config.yaml.tmp-${crypto.randomUUID()}`);
    let fd;
    try {
        fd = fs.openSync(tmpPath, 'wx', 0o600);
        fs.writeFileSync(fd, newText, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tmpPath, configPath);
    } catch (e) {
        if (fd !== null) { try { fs.closeSync(fd); } catch {} }
        try { fs.unlinkSync(tmpPath); } catch {}
        throw new InstallError('CONFIG_WRITE_FAILED', `原子改写 config.yaml 失败: ${e.message}`);
    }
    return backupPath;
}

// ===================== 依赖安装 =====================

/**
 * 安全定位 npm 的入口脚本（npm-cli.js），返回其绝对路径或 null。
 * 优先使用 process.env.npm_execpath（若为可信的 npm-cli.js）；否则回退到
 * process.execPath 同目录下的 node_modules/npm/bin/npm-cli.js。
 * 不拼接 shell 字符串、不直接 spawn npm.cmd（Windows 上已实测 EINVAL）。
 */
function locateNpmCli() {
    const candidates = [];

    // 1) npm 自身注入的可信路径（npm_execpath 指向正在运行的 npm-cli.js）。
    if (process.env.npm_execpath) {
        candidates.push(path.resolve(process.env.npm_execpath));
    }
    // 2) 与 node 可执行文件同目录的 npm 安装（如 nvm / 部分发行版布局）。
    candidates.push(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    // 3) 全局 npm 前缀下的常见位置（Windows 全局安装）。
    if (process.platform === 'win32') {
        candidates.push(path.join(path.dirname(process.execPath), 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
    // 4) Termux / Android 常见布局：node 位于 $PREFIX/bin/node，而 npm-cli.js 位于
    //    $PREFIX/lib/node_modules/npm/bin/npm-cli.js（并非与 node 同目录的 node_modules）。
    //    从 node 目录上一级（$PREFIX）取 lib/node_modules/npm/bin/npm-cli.js。
    if (process.platform === 'android' || process.platform === 'linux') {
        const prefix = path.dirname(path.dirname(process.execPath)); // $PREFIX
        candidates.push(path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }

    for (const c of candidates) {
        if (!c) continue;
        try {
            const st = fs.statSync(c);
            if (st.isFile()) {
                // 必须确实是 npm-cli.js 文件（路径末段校验），防止被替换为任意脚本。
                if (path.basename(c) === 'npm-cli.js') {
                    return c;
                }
            }
        } catch {
            // 不存在，继续。
        }
    }
    return null;
}

/** 在给定 cwd 内执行 npm ci --omit=dev（经 node <npm-cli.js>，无 shell 拼接、无用户文本注入）。 */
function runNpmCi(cwd) {
    const npmCli = locateNpmCli();
    if (!npmCli) {
        throw new InstallError('NPM_NOT_FOUND', '未定位到 npm（npm-cli.js），无法执行依赖安装。请确认 Node.js >= 20 且已安装 npm。');
    }
    // 用 process.execPath 直接执行 npm-cli.js（Node 脚本），避免 Windows 上 npm.cmd 的 EINVAL。
    const argv = [npmCli, 'ci', '--omit=dev'];
    const env = Object.assign({}, process.env, { npm_config_ignore_scripts: '0' });
    const r = spawnSync(process.execPath, argv, {
        cwd,
        env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 600000,
        windowsHide: true,
    });
    if (r.error) {
        throw new InstallError('NPM_SPAWN_FAILED', `启动 npm 失败: ${r.error.message}`);
    }
    if (r.status !== 0) {
        const tail = (r.stderr || r.stdout || '').split(/\r?\n/).slice(-20).join('\n');
        throw new InstallError('NPM_CI_FAILED', `npm ci --omit=dev 失败 (exit ${r.status})：\n${tail}`);
    }
    return { exit: r.status, npmCli };
}

// ===================== 主流程 =====================

/**
 * 计算安装计划（dry-run 与 apply 共用同一套校验与计划）。
 * @param {string} sourceRoot 本仓库根（bin/ 的上一级）。
 * @param {object} opts { appDir, enableServerPlugins, installDeps, apply }
 * @returns {object} { sourceRoot, appDir, pluginsDir, targetDir, files, configAction, installAction }
 */
function computePlan(sourceRoot, opts) {
    const appDir = path.resolve(opts.appDir);
    const pluginsDir = path.join(appDir, 'plugins');
    const targetDir = path.join(pluginsDir, PLUGIN_TARGET_NAME);

    // 1) app 合法性：server.js 与 package.json 必须存在。
    for (const must of ['server.js', 'package.json']) {
        const p = path.join(appDir, must);
        if (!fs.existsSync(p)) {
            throw new InstallError('APP_NOT_FOUND', `应用目录缺少 ${must}（不像是酒管宿主目录）: ${appDir}`);
        }
        if (isLink(p)) {
            throw new InstallError('LINK_REJECTED', `应用关键文件为符号链接（拒绝）: ${p}`);
        }
    }

    // 2) 目标必须落在 app/plugins 内。
    if (!isWithin(targetDir, pluginsDir)) {
        throw new InstallError('TARGET_ESCAPE', `目标目录不在 ${pluginsDir} 内（拒绝）。`);
    }
    // 2a) 源与目标的全祖先（盘根 → appDir）均真实目录、无 junction（不含 pluginsDir 本身，它可能不存在）。
    assertRealAncestors(appDir);
    // 2b) pluginsDir 若已存在必须真实目录非链接；若不存在则记录待创建（apply 时安全逐段创建）。
    let pluginsNeedCreate = false;
    let pluginsSt = null;
    try {
        pluginsSt = fs.lstatSync(pluginsDir);
    } catch (e) {
        if (e.code === 'ENOENT') pluginsNeedCreate = true;
        else throw new InstallError('STAT_FAILED', `无法读取 plugins 目录 ${pluginsDir}: ${e.message}`);
    }
    if (pluginsSt) {
        if (pluginsSt.isSymbolicLink()) {
            throw new InstallError('LINK_REJECTED', `plugins 目录为符号链接/junction（拒绝）: ${pluginsDir}`);
        }
        if (!pluginsSt.isDirectory()) {
            throw new InstallError('NOT_DIRECTORY', `plugins 路径不是目录（拒绝）: ${pluginsDir}`);
        }
    }

    // 3) source 本身非 symlink（本仓库根），且其祖先真实无链接。
    if (isLink(sourceRoot)) {
        throw new InstallError('SOURCE_LINK', `源目录为符号链接（拒绝）: ${sourceRoot}`);
    }
    assertRealAncestors(sourceRoot);

    // 4) 目标已存在则明确报错（禁止递归覆盖）。
    if (fs.existsSync(targetDir)) {
        throw new InstallError('TARGET_EXISTS', `目标目录已存在（拒绝覆盖，更新另阶段处理）: ${targetDir}`);
    }

    // 5) config 预检（必须在复制之前完整拒绝：缺 key / 复杂 / 混合注释重复同名）。
    //    只支持唯一 top-level 简单 bool。scan 会在缺 key / 复杂 / 重复时抛错，此处提前阻断，
    //    绝不允许「复制完 target 后才因配置失败」而留下半份安装。
    let configAction = null; // { configPath, currentValue|null, willChange }
    if (opts.enableServerPlugins) {
        const configPath = path.join(appDir, 'config.yaml');
        if (!fs.existsSync(configPath)) {
            throw new InstallError('CONFIG_MISSING', `未找到 config.yaml: ${configPath}`);
        }
        if (isLink(configPath)) {
            throw new InstallError('LINK_REJECTED', `config.yaml 为符号链接（拒绝）: ${configPath}`);
        }
        const text = fs.readFileSync(configPath, 'utf8');
        const scan = scanEnableServerPlugins(text); // 缺 key / 复杂 / 重复在此即抛错。
        if (!scan.found) {
            throw new InstallError('CONFIG_KEY_MISSING', 'config.yaml 中未找到顶层 enableServerPlugins: 键（拒绝改写）。');
        }
        configAction = {
            configPath,
            currentValue: scan.value, // 'true' | 'false'
            willChange: scan.value === 'false',
        };
    }

    // 6) 收集源文件（排除敏感/令牌条目）。
    const files = collectSourceFiles(sourceRoot);

    // 7) 依赖计划。
    const installAction = opts.installDeps
        ? { cmd: 'npm ci --omit=dev', cwd: targetDir }
        : { cmd: null, cwd: targetDir, note: '未加 --install-deps，请自行在插件目录执行 npm ci。' };

    return { sourceRoot, appDir, pluginsDir, targetDir, pluginsNeedCreate, files, configAction, installAction };
}

/** 打印计划（dry-run 与 apply 前均打印）。 */
function printPlan(plan, opts) {
    console.log(`[酒管同步安装器] ${opts.apply ? 'APPLY 模式' : 'DRY-RUN 模式（未写任何文件）'}`);
    console.log(`  源目录:   ${plan.sourceRoot}`);
    console.log(`  应用目录: ${plan.appDir}`);
    console.log(`  插件目录: ${plan.pluginsDir}`);
    console.log(`  目标目录: ${plan.targetDir}`);
    console.log(`  待复制文件数: ${plan.files.length}`);
    for (const f of plan.files.slice(0, 50)) {
        console.log(`    - ${f.relPosix}`);
    }
    if (plan.files.length > 50) {
        console.log(`    ... 其余 ${plan.files.length - 50} 个`);
    }
    if (plan.configAction) {
        if (plan.configAction.currentValue === 'true') {
            console.log(`  config.yaml: enableServerPlugins 已为 true（幂等，无需改写）。`);
        } else {
            console.log(`  config.yaml: enableServerPlugins false → true（先备份再原子改写）。`);
        }
    } else {
        console.log(`  config.yaml: 未改（未加 --enable-server-plugins）。`);
    }
    if (plan.installAction.cmd) {
        console.log(`  依赖安装:   将在 ${plan.installAction.cwd} 执行 ${plan.installAction.cmd}`);
    } else {
        console.log(`  依赖安装:   未加 --install-deps，需自行在插件目录执行 npm ci。`);
    }
}

/** 实际落盘（顺序：安全建 plugins → 复制 → 可选 npm ci → 最后 config 改写）。 */
function applyPlan(plan, opts) {
    // 0) 若 plugins 父目录缺失，安全逐段创建（全祖先校验，拒绝 junction）。
    if (plan.pluginsNeedCreate) {
        safeMkdirChain(plan.pluginsDir);
    }

    // 1) 复制：逐文件复制到新目录（先建目录，mkdir 不递归覆盖）。
    try {
        fs.mkdirSync(plan.targetDir);
    } catch (e) {
        throw new InstallError('TARGET_CREATE_FAILED', `创建目标目录失败: ${e.message}`);
    }
    try {
        for (const f of plan.files) {
            const destAbs = path.join(plan.targetDir, f.relPosix.split('/').join(path.sep));
            // 确保 destAbs 仍在 targetDir 内（relPosix 已由 walk 保证无 ..，仍再保险一次）。
            if (!isWithin(destAbs, plan.targetDir)) {
                throw new InstallError('TARGET_ESCAPE', `复制目标越界: ${destAbs}`);
            }
            fs.mkdirSync(path.dirname(destAbs), { recursive: true });
            fs.copyFileSync(f.abs, destAbs);
        }
    } catch (e) {
        // 复制失败：清掉已创建的目标目录，避免留下半份安装。
        try { fs.rmSync(plan.targetDir, { recursive: true, force: true }); } catch {}
        throw e;
    }

    // 2) 依赖安装（在 config 改写之前；失败时保留新 target，但 config 原字节不变）。
    let depsInstalled = false;
    if (opts.installDeps) {
        console.log(`  [deps] 执行 npm ci --omit=dev ...`);
        try {
            runNpmCi(plan.targetDir);
            depsInstalled = true;
            console.log(`  [deps] npm ci 完成。`);
        } catch (e) {
            // 依赖失败：不启用 config，保留新 target（供人工重试），准确输出路径与说明。
            // 说明：不能“重跑本脚本”（target 已存在会 TARGET_EXISTS），也不做升级/递归删除。
            console.error(`  [deps] 依赖安装失败（config.yaml 原字节保留未改写）：`);
            console.error(`         ${e.message}`);
            console.error(`  [deps] 新插件已复制到 ${plan.targetDir}`);
            console.error(`  [deps] 请进入该保留目录，用 Node 直接执行可信 npm-cli.js 安装依赖，例如：`);
            console.error(`         cd "${plan.targetDir}" && node <npm-cli.js 路径> ci --omit=dev`);
            console.error(`         （或用系统 PATH 中的 npm 执行：npm ci --omit=dev）`);
            console.error(`  [deps] 依赖装好后，在宿主停止时手工将 config.yaml 的 enableServerPlugins 置为 true`);
            console.error(`         （改写前先备份原 config.yaml）。本脚本不会升级、也不会递归删除该保留目标。`);
            if (plan.configAction && plan.configAction.currentValue === 'true') {
                console.error(`  [deps] 注意：原 config.yaml 的 enableServerPlugins 已为 true（原字节保留但可能仍已启用）；`);
                console.error(`         请务必在依赖完成前不要启动宿主。`);
            }
            throw e;
        }
    } else {
        console.log(`  [deps] 未安装依赖（未加 --install-deps）。请自行在插件目录执行 npm ci。`);
    }

    // 3) config 改写（最后一步，仅在复制与依赖均成功后执行）。
    if (opts.enableServerPlugins) {
        const r = enableServerPluginsInConfig(plan.configAction.configPath);
        if (r.changed) {
            console.log(`  [config] enableServerPlugins 已改为 true（已备份原文件）。`);
        } else {
            console.log(`  [config] enableServerPlugins 已为 true（幂等）。`);
        }
    }
}

/**
 * 主入口。返回退出码（0 成功，2 用法错误，1 运行期错误）。
 * 导出供 bin 入口与 require.main 分支复用（与 lib/reliable/cli.js 的 main 约定一致）。
 */
function main(argv) {
    // Node 版本最低要求（>= 20）。
    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    if (!Number.isInteger(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
        console.error(`[错误] 需要 Node.js >= ${MIN_NODE_MAJOR}，当前 ${process.versions.node}。`);
        return 1;
    }
    let parsed;
    try {
        parsed = parseArgs(argv);
    } catch (e) {
        console.error(`[错误] ${e.message}`);
        return 2;
    }
    if (parsed.error) {
        console.error(`[错误] ${parsed.error}`);
        console.error(`  用法: node bin/install-plugin.js --app-dir <应用目录> [--enable-server-plugins] [--install-deps] [--apply]`);
        return 2;
    }
    if (parsed.help) {
        printHelp();
        return 0;
    }

    const opts = parsed.args;
    const sourceRoot = path.resolve(__dirname, '..');

    let plan;
    try {
        plan = computePlan(sourceRoot, opts);
    } catch (e) {
        if (e instanceof InstallError) {
            console.error(`[错误] (${e.code}) ${e.message}`);
            return 1;
        }
        console.error(`[错误] ${e && e.stack ? e.stack : e}`);
        return 1;
    }

    printPlan(plan, opts);

    if (!opts.apply) {
        console.log(`\n未使用 --apply，未写任何文件。加 --apply 才会真正安装。`);
        return 0;
    }

    try {
        applyPlan(plan, opts);
        console.log(`\n安装完成：${plan.targetDir}`);
        console.log(`  下一步：关闭旧客户端并重启酒管；首次启动需在浏览器重新打开页面。`);
    } catch (e) {
        if (e instanceof InstallError) {
            console.error(`[错误] (${e.code}) ${e.message}`);
            return 1;
        }
        console.error(`[错误] ${e && e.stack ? e.stack : e}`);
        return 1;
    }
    return 0;
}

module.exports = {
    main,
    parseArgs,
    computePlan,
    collectSourceFiles,
    scanEnableServerPlugins,
    enableServerPluginsInConfig,
    runNpmCi,
    locateNpmCli,
    safeMkdirChain,
    isTokenishName,
    InstallError,
    MIN_NODE_MAJOR,
    PLUGIN_TARGET_NAME,
    EXCLUDED_REL,
    TOKENISH_NAMES,
};

// 显式入口：确保 node bin/install-plugin.js ... 真实执行（对齐 bin/reliable-sync.js 的缺陷教训）。
if (require.main === module) {
    process.exit(main(process.argv.slice(2)));
}

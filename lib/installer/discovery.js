'use strict';
/**
 * 酒管 GitHub 同步 · 统一安装向导 —— 候选发现 / 版本识别 / 工具与依赖前置检查。
 *
 * 纯逻辑（不落盘、不发起安装），供 bin/setup.js 与 test/setup.test.js 复用。
 *
 * 安全约束：
 *  - 候选发现限定 cwd / 各级父目录 / 显式 searchRoots / 上次安装记录，**绝不全盘扫描**。
 *  - 仅接受「明确识别为 1.17.x」的宿主目录；其余版本一律拒绝，不自动升级宿主。
 *  - 工具检查只读（node >= 20 / git / npm 定位），缺工具给出官方安装指引，不自动安装。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// 复用安装器的 npm 定位与最低 Node 版本常量（不破坏旧接口，只读复用导出）。
const installer = require('../../bin/install-plugin.js');

const MIN_NODE_MAJOR = installer.MIN_NODE_MAJOR; // 20
const SUPPORTED_HOST_MAJOR_MINOR = '1.17'; // 仅明确识别 1.17.x

// 官方工具安装指引（仅提示，不自动安装）。
const TOOL_LINKS = {
    node: 'https://nodejs.org/en/download',
    git: 'https://git-scm.com/downloads',
};

/** 路径是否为 symlink/junction（含 Windows junction；委托给安装器的同一实现）。 */
function isLink(p) {
    return installer.isLink(p);
}

/** 判断 child 是否在 dir 之内（拒绝越界）。 */
function isWithin(child, dir) {
    const r = path.resolve(child);
    const d = path.resolve(dir);
    return r === d || r.startsWith(d + path.sep);
}

/** 目录自身是否为真实目录（非链接/junction）；任何读取错误都视为「不是」。 */
function isRealDir(dir) {
    try {
        const st = fs.lstatSync(dir);
        if (st.isSymbolicLink()) return false;
        if (!st.isDirectory()) return false;
        return !isLink(dir); // Windows junction：lstat 是目录但指向别处
    } catch {
        return false;
    }
}

/** 常规文件（非链接/junction）。 */
function isRealFile(p) {
    try {
        const st = fs.lstatSync(p);
        return st.isFile() && !st.isSymbolicLink() && !isLink(p);
    } catch {
        return false;
    }
}

/** 判断某目录是否「像」酒管宿主：同时含 server.js 与 package.json（且均非链接）。 */
function looksLikeHost(dir) {
    if (!isRealDir(dir)) return false;
    return isRealFile(path.join(dir, 'server.js')) && isRealFile(path.join(dir, 'package.json'));
}

/** 读取宿主 package.json 的 version（不存在/损坏返回 null，不抛）。 */
function readHostVersion(appDir) {
    const pkgPath = path.join(appDir, 'package.json');
    let raw;
    try {
        raw = fs.readFileSync(pkgPath, 'utf8');
    } catch {
        return null;
    }
    try {
        const pkg = JSON.parse(raw);
        return typeof pkg.version === 'string' ? pkg.version : null;
    } catch {
        return null;
    }
}

/**
 * 严格 1.17.x：`^1\.17\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`。
 * 拒绝 `1.17`（无补丁号）、`1.17.foo`、`1.17.0.1`、`01.17.0`、`1.170.0`、带空白/换行等一切变体；
 * 允许语义化版本常见的 `-pre` 后缀（官方发行版带后缀）。
 */
const HOST_VERSION_RE = /^1\.17\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;

function isSupportedHostVersion(version) {
    if (typeof version !== 'string') return false;
    if (version.length > 64) return false;
    return HOST_VERSION_RE.test(version);
}

/**
 * 在给定起点向上收集候选宿主目录（含起点自身）。
 * 只收集「同时含 server.js 与 package.json」的目录，去重、按「距离起点最近优先」排序。
 * 不越出 startDir 所在盘根（走到盘根即停），绝不全盘扫描。
 */
function collectCandidatesFrom(startDir) {
    const seen = new Set();
    const out = [];
    let cur = path.resolve(startDir);
    while (true) {
        if (seen.has(cur)) break;
        seen.add(cur);
        if (looksLikeHost(cur)) out.push(cur);
        const parent = path.dirname(cur);
        if (parent === cur) break; // 盘根
        cur = parent;
    }
    return out;
}

/** 在显式 searchRoots 列表内（只读一层，不递归）收集候选宿主目录。 */
function collectCandidatesFromRoots(searchRoots) {
    const out = [];
    const seen = new Set();
    for (const r of searchRoots || []) {
        const abs = path.resolve(r);
        if (seen.has(abs)) continue;
        seen.add(abs);
        if (looksLikeHost(abs)) {
            out.push(abs);
            continue;
        }
        // 只读一层子目录（不递归、不全盘）。
        let entries;
        try {
            entries = fs.readdirSync(abs, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const ent of entries) {
            if (!ent.isDirectory()) continue;
            const sub = path.join(abs, ent.name);
            if (seen.has(sub)) continue;
            seen.add(sub);
            if (!isRealDir(sub)) continue; // 链接/junction 不作为候选（绝不跟随）
            if (looksLikeHost(sub)) out.push(sub);
        }
    }
    return out;
}

/** 从「上次安装 journal」记录的 appDir 中提取候选（若仍存在）。 */
function collectCandidatesFromLastInstall(journal) {
    if (!journal || typeof journal.appDir !== 'string') return [];
    const abs = path.resolve(journal.appDir);
    if (looksLikeHost(abs)) return [abs];
    return [];
}

/**
 * 汇总候选（显式 --app-dir 优先；否则 cwd+parents、searchRoots、上次安装），去重保序。
 * 返回去重后的绝对路径数组（不排序，保持优先级）。
 */
function discoverCandidates({ appDir, searchRoots, journal } = {}) {
    const out = [];
    const seen = new Set();
    const push = (d) => {
        const abs = path.resolve(d);
        if (seen.has(abs)) return;
        seen.add(abs);
        out.push(abs);
    };
    if (appDir) {
        push(appDir);
        return out;
    }
    for (const d of collectCandidatesFrom(process.cwd())) push(d);
    for (const d of collectCandidatesFromRoots(searchRoots)) push(d);
    for (const d of collectCandidatesFromLastInstall(journal)) push(d);
    return out;
}

/** 只读推断：从简单（无宏/无 include/无行内映射）的 config 文本里找 data_root / 绝对路径型 root 键。 */
const DATA_ROOT_KEYS = ['data_root', 'dataRoot'];

/**
 * 从宿主 config 文本推断「用户数据根」候选（仅做**简单模式匹配**，不执行宿主解析器、不支持变量/宏）。
 * 返回 { candidates: string[], note }。
 *  - `<app>/data` 作为默认候选（官方默认布局，需用户确认）；
 *  - `data_root: <绝对路径>`（或引号包裹、`~` 开头）→ 追加为候选。
 * 只读：不写任何文件。
 */
function inferDataRootCandidates(appDir, configText) {
    const app = path.resolve(appDir);
    const candidates = [path.join(app, 'data')];
    const notes = [];
    const text = typeof configText === 'string' ? configText : '';
    for (const key of DATA_ROOT_KEYS) {
        // 只匹配顶层裸键、单行标量（引号可选）。复杂形式不猜。
        const re = new RegExp(`^${key}\\s*:\\s*(?:"([^"\\n]{1,512})"|'([^'\\n]{1,512})'|([^\\s#]{1,512}))\\s*(?:#.*)?$`, 'm');
        const m = text.match(re);
        if (!m) continue;
        let v = (m[1] || m[2] || m[3] || '').trim();
        if (!v || /[${}*&]/.test(v)) {
            notes.push(`${key} 的值不是简单字面量（含变量/宏），不自动采用。`);
            continue;
        }
        if (v === '~' || v.startsWith('~/') || v.startsWith('~\\')) {
            v = path.join(require('os').homedir(), v.slice(1));
        }
        if (!path.isAbsolute(v)) {
            notes.push(`${key} 的值不是绝对路径（${v}），不自动采用。`);
            continue;
        }
        const abs = path.resolve(v);
        if (!candidates.includes(abs)) candidates.push(abs);
    }
    return { candidates, note: notes.length ? notes.join(' ') : null };
}

/** 只读推断：config 中 `config.yaml` 之外可能生效的 config 候选（同目录 *.yaml/yml，排除备份/临时文件）。 */
function inferConfigCandidates(appDir) {
    const app = path.resolve(appDir);
    const out = [];
    const def = path.join(app, 'config.yaml');
    if (isRealFile(def)) out.push(def);
    let names = [];
    try {
        names = fs.readdirSync(app, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
    } catch {
        return out;
    }
    names.sort();
    for (const n of names) {
        if (!/\.(ya?ml)$/i.test(n)) continue;
        if (/\.bak|\.tmp|\.old|\.orig|^config\.yaml\./i.test(n)) continue;
        const abs = path.join(app, n);
        if (!isRealFile(abs)) continue;
        if (!out.includes(abs)) out.push(abs);
    }
    return out;
}

/** 工具前置检查（只读）。返回结构化结果，不抛错。`requireGit=false` 仅用于无 git 场景的提示。 */
function checkTools({ requireGit = true } = {}) {
    const result = { ok: true, node: null, git: null, npm: null, missing: [] };

    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    result.node = {
        version: process.versions.node,
        ok: Number.isInteger(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR,
        link: TOOL_LINKS.node,
    };
    if (!result.node.ok) {
        result.ok = false;
        result.missing.push({ tool: 'node', link: TOOL_LINKS.node, detail: `需要 Node.js >= ${MIN_NODE_MAJOR}，当前 ${process.versions.node}` });
    }

    // git 检查：只读 `git --version`（不联网、不改配置）。
    if (requireGit) {
        const g = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        const gitOk = g.status === 0 && /^git version/i.test((g.stdout || '').trim());
        result.git = { ok: gitOk, link: TOOL_LINKS.git };
        if (!gitOk) {
            result.ok = false;
            result.missing.push({ tool: 'git', link: TOOL_LINKS.git, detail: '未找到可用 git（请安装并加入 PATH）' });
        }
    }

    // npm：只读定位（不安装、不联网）。
    const npmCli = installer.locateNpmCli();
    result.npm = { ok: !!npmCli, path: npmCli || null };
    if (!npmCli) {
        // npm 随 Node 提供；Node 已通过则提示，但未必算致命（依赖可跳过）。
        result.npmMissingButNonFatal = true;
    }

    return result;
}

module.exports = {
    MIN_NODE_MAJOR,
    SUPPORTED_HOST_MAJOR_MINOR,
    HOST_VERSION_RE,
    TOOL_LINKS,
    isLink,
    isRealDir,
    isRealFile,
    isWithin,
    looksLikeHost,
    readHostVersion,
    isSupportedHostVersion,
    collectCandidatesFrom,
    collectCandidatesFromRoots,
    collectCandidatesFromLastInstall,
    discoverCandidates,
    inferDataRootCandidates,
    inferConfigCandidates,
    checkTools,
};

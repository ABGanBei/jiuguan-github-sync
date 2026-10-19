#!/usr/bin/env node
'use strict';
/**
 * 酒管 GitHub 同步 · 统一安装向导 CLI 入口。
 *
 * 两种使用方式（共用同一个 Node 实现，Windows 双击 install.cmd / Termux 运行 setup.sh 都走这里）：
 *  1) 交互（无参数双击）：向导自己询问宿主目录（多候选给编号选择）、**逐一确认实际 config 路径与
 *     用户数据根**（默认已推断但必须用户确认，可自定义；不执行宿主配置解析器）、确认计划、
 *     确认「已停服」后安装。
 *  2) 非交互：--app-dir <路径> --data-root <路径> --apply --stopped-confirmed（脚本/自动化用）。
 *
 * 权限边界：CLI 不能绕过安装决策。prepare/commit 内部都会重新跑同一个 gate
 * （拒绝 modified/unknown/incomplete/链接/遮蔽/缺依赖、未完成事务阻断、plan→commit 并发变化阻断）。
 * 用户级同名扩展必须**实际移除**后才可安装，口头确认不构成绕过。
 *
 * 用法:
 *   node bin/setup.js [--app-dir <路径>] [--search-root <路径>...] [--data-root <路径>|--no-data-root]
 *                     [--config <绝对路径>] [--no-deps] [--no-config] [--takeover]
 *                     [--apply --stopped-confirmed] [--interactive]
 *   node bin/setup.js --recover|--rollback --app-dir <路径> --stopped-confirmed [--to <backupId>] [--config <绝对路径>]
 *   node bin/setup.js --status --app-dir <路径>
 *   node bin/setup.js --help
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const setup = require('../lib/installer/setup');
const discovery = require('../lib/installer/discovery');

const { InstallError } = setup;

function usage() {
    return `酒管 GitHub 同步 · 统一安装向导

用法:
  install.cmd                                  （Windows 双击，进入交互向导）
  node bin/setup.js                            （交互向导）
  node bin/setup.js [选项]                     （非交互）

选项:
  --app-dir <路径>       酒管宿主根目录（含 server.js 与 package.json）。
  --search-root <路径>   额外候选搜索根（只读一层，可重复）。
  --data-root <路径>     酒管用户数据根（只读扫描用户级同名扩展；发现即拒绝安装）。
  --no-data-root         明确跳过用户级扩展扫描（不推荐；安装器不猜路径）。
  --config <绝对路径>    酒管实际生效的 config.yaml（外置；不指定则用 <宿主>/config.yaml）。
  --no-deps              不安装后端依赖（必须能验证目标内依赖已存在，否则失败）。
  --no-config            不改写 enableServerPlugins。
  --takeover             显式接管「无安装清单/被改动/单侧」的目标（旧目录完整备份，绝不删除）。
                         已知旧版本升级不需要它：正常确认计划即可。
  --apply --stopped-confirmed
                         非交互安装（须同时给出，并显式选择 --data-root 或 --no-data-root；
                         声明已停止酒管服务并关闭所有页面）。
  --interactive          强制交互（默认：没有 --apply 且是终端时进入交互）。
  --recover              收敛未完成事务（需 --stopped-confirmed；可加 --config 重新指定生效 config）。
  --rollback             回到安装前状态（需 --stopped-confirmed）；--to <backupId> 指定备份。
  --status               只读显示事务/备份/config 来源。
  --help, -h             本帮助。

说明:
  只支持酒管 1.17.x，不自动升级宿主。首装、升级与接管区分：
  同版本且前后端内容哈希都匹配才是 no-op；已知旧版本按升级处理（旧目录完整备份）；
  用户改动/未知来源/单侧一律拒绝（除非 --takeover）。
  备份与事务工作区在 <宿主>/.jiuguan-install/（不在插件/扩展扫描目录内），
  备份保留历次、不自动删除；新版目录在回滚后移动到 quarantine 保留。`;
}

function parseArgs(argv) {
    const o = {
        searchRoots: [],
        apply: false,
        stoppedConfirmed: false,
        takeover: false,
        enableServerPlugins: true,
        installDeps: true,
        recover: false,
        rollback: false,
        status: false,
        interactive: false,
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const need = () => {
            const v = argv[++i];
            if (v === undefined || v.startsWith('--')) throw new InstallError('USAGE', `${a} 需要一个值。`);
            return v;
        };
        switch (a) {
            case '--app-dir': o.appDir = need(); break;
            case '--search-root': o.searchRoots.push(need()); break;
            case '--data-root': o.dataRoot = need(); break;
            case '--no-data-root': o.noDataRoot = true; break;
            case '--config': o.configPath = need(); break;
            case '--to': o.to = need(); break;
            case '--no-deps': o.installDeps = false; break;
            case '--no-config': o.enableServerPlugins = false; break;
            case '--takeover': o.takeover = true; break;
            case '--apply': o.apply = true; break;
            case '--stopped-confirmed': o.stoppedConfirmed = true; break;
            case '--recover': o.recover = true; break;
            case '--rollback': o.rollback = true; break;
            case '--status': o.status = true; break;
            case '--interactive': o.interactive = true; break;
            case '--help': case '-h': o.help = true; break;
            default:
                throw new InstallError('USAGE', `未知参数: ${a}`);
        }
    }
    if (o.dataRoot && o.noDataRoot) throw new InstallError('USAGE', '--data-root 与 --no-data-root 不能同时使用。');
    return o;
}

// ───────────────────────────── 输出 ─────────────────────────────

const ACTION_TEXT = {
    install: '首次安装（前后端一起装）',
    upgrade: '升级（旧版本 → 本次发行包；旧目录完整备份，不删除）',
    takeover: '接管已有目录（旧目录会完整备份，不删除）',
    noop: '已是同一版本且内容一致（无需安装）',
    rejected: '已拒绝安装',
    incomplete: '目标不完整',
    unknown: '无法精确识别来源',
    modified: '内容被改动',
    mismatch: '前后端版本/内容不一致',
};

function printPlan(p, out = console.log) {
    out('');
    out('================ 安装计划 ================');
    out(`  宿主目录:   ${p.appDir}`);
    out(`  宿主版本:   ${p.hostVersion}（仅支持 1.17.x）`);
    out(`  发行版本:   ${p.releaseVersion}`);
    out(`  动作:       ${p.action} —— ${ACTION_TEXT[p.action] || p.action}`);
    out(`  后端目标:   ${p.backendDir}`);
    out(`  前端目标:   ${p.frontendDir}`);
    const srcText = { default: '宿主目录默认文件', cli: '--config 指定', record: '上次安装的本地记录' }[p.configSource] || p.configSource;
    if (p.enableServerPlugins) out(`  配置文件:   ${p.configPath}（${srcText}；将把 enableServerPlugins 设为 true）`);
    else out(`  配置文件:   ${p.configPath}（${srcText}；本次不改动）`);
    if (p.dataRoot) out(`  数据根:     ${p.dataRoot}（只读扫描用户级同名扩展）`);
    else out('  数据根:     未指定（未扫描用户级同名扩展；如使用用户级扩展请用 --data-root）');
    out(`  依赖安装:   ${p.installDeps ? '会执行 npm ci --omit=dev' : '跳过（--no-deps，须已验证存在）'}`);
    if (p.action === 'upgrade') out('  （旧版本在切换前会完整备份到 .jiuguan-install/backups/，可用于回滚）');
    if (p.action === 'takeover') out('  （已显式 --takeover：旧目录（含 .git 与未知内容）会原样移到备份目录，不删除）');
    if (p.inspect && (p.inspect.backend && p.inspect.backend.link || p.inspect.frontend && p.inspect.frontend.link)) {
        out('  [拒绝] 目标路径是链接（symlink/junction）。');
    }
    if (p.reason) out(`  原因:       ${p.reason}`);
    if (p.pendingTx) out(`  [阻断] 有未完成事务 ${p.pendingTx.txId}（${p.pendingTx.phase}）：请先 --recover 或 --rollback。`);
    if (p.shadow) {
        if (p.shadow.found && p.shadow.found.length) {
            out('  [遮蔽风险·阻断] 发现用户级同名扩展，会覆盖共享级安装：');
            for (const f of p.shadow.found) out(`    - ${f}`);
            out('    请先备份这些用户级扩展，再卸载或把目录移出 extensions 扫描目录；仅停用仍会阻断安装。');
        }
        if (p.shadow.hardError && p.shadow.hardError.length) {
            out('  [扫描失败·阻断] data-root 扫描遇到链接/不可读项（fail-closed）：');
            for (const e of p.shadow.hardError) out(`    - ${e}`);
        }
    }
    if (!p.depsCheck.ok) out(`  [依赖不可验证] ${p.depsCheck.reason}`);
    out('=========================================');
}

// ───────────────────────────── 交互工具 ─────────────────────────────

function createAsk() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const closed = new Promise((r) => rl.on('close', r));
    const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve((a || '').trim())));
    return { rl, ask, closed };
}

function expandHome(p) {
    let v = String(p || '').trim();
    if (!v) return v;
    if (v === '~' || v.startsWith('~/') || v.startsWith('~\\')) v = path.join(require('os').homedir(), v.slice(1));
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v;
}

function isHostLike(dir) {
    return discovery.looksLikeHost(path.resolve(dir));
}

/** 交互：确定宿主目录（多候选给编号；也接受用户输入路径）。 */
async function askAppDir(ask) {
    let cands = discovery.discoverCandidates({ searchRoots: [] });
    // 从「不含宿主」的空目录启动（例如双击安装器时 cwd 是下载目录）：
    // 只读扫描 cwd 下一层子目录，便于界面展示候选编号；不递归、不全盘扫描。
    if (cands.length === 0) {
        cands = discovery.collectCandidatesFromRoots([process.cwd()]);
    }
    if (cands.length === 1) {
        const ans = await ask(`检测到酒管目录：\n  ${cands[0]}\n使用这个目录吗？(Y/n): `);
        if (!/^n/i.test(ans)) return cands[0];
    } else if (cands.length > 1) {
        console.log('检测到多个酒管目录，请选择编号：');
        cands.forEach((c, i) => console.log(`  ${i + 1}) ${c}`));
        for (let tries = 0; tries < 5; tries++) {
            const ans = await ask('编号（直接回车取消）: ');
            if (!ans) break;
            const idx = parseInt(ans, 10);
            if (Number.isInteger(idx) && idx >= 1 && idx <= cands.length) return cands[idx - 1];
            console.log('请输入列表中的编号。');
        }
        return null;
    }
    // 没找到 / 用户否认：让用户输入路径。
    for (let tries = 0; tries < 5; tries++) {
        const raw = await ask('请输入酒管安装目录（含 server.js 和 package.json，直接回车取消）: ');
        if (!raw) return null;
        const dir = path.resolve(expandHome(raw));
        if (!isHostLike(dir)) {
            console.log(`该目录下没有同时找到 server.js 与 package.json（或关键文件是链接）：${dir}`);
            continue;
        }
        return dir;
    }
    return null;
}

function confirmWords(ask, question) {
    return ask(question).then((a) => /^y(es)?$/i.test(a));
}

/** 选择一个「必须是真实普通文件」的 config 路径：默认候选需确认，允许输入自定义路径。 */
async function askConfigPath(ask, appDir, preset) {
    const cands = preset ? [preset] : discovery.inferConfigCandidates(appDir);
    if (cands.length === 0) cands.push(path.join(path.resolve(appDir), 'config.yaml'));
    if (!preset && cands.length > 1) {
        console.log('\n找到多个可能的 config 文件（安装器不会解析宿主配置，只按文件名列出）：');
        cands.forEach((c, i) => console.log(`  ${i + 1}) ${c}`));
    }
    const def = cands[0];
    console.log('\n请确认酒管实际生效的 config.yaml。启动参数、环境变量或全局配置可能让它不在默认位置；');
    console.log('安装器不会执行宿主的配置解析器，只使用你确认的这一份。');
    for (let tries = 0; tries < 6; tries++) {
        const q =
            cands.length > 1 && !preset
                ? `生效的 config 路径（回车=${def}，或输入编号/自定义绝对路径）: `
                : `生效的 config 路径（回车=${def}，或输入自定义绝对路径）: `;
        const raw = expandHome(await ask(q));
        let chosen = def;
        if (raw) {
            const idx = parseInt(raw, 10);
            if (!preset && cands.length > 1 && String(idx) === raw && idx >= 1 && idx <= cands.length) chosen = cands[idx - 1];
            else if (path.isAbsolute(raw)) chosen = path.resolve(raw);
            else {
                const rel = path.resolve(appDir, raw);
                if (discovery.isRealFile(rel)) chosen = rel;
                else {
                    console.log('请输入绝对路径（或相对宿主目录且存在的路径），或直接回车用默认值。');
                    continue;
                }
            }
        }
        if (!discovery.isRealFile(chosen)) {
            console.log(`该路径不存在、不是普通文件，或是链接：${chosen}`);
            continue;
        }
        const yes = await confirmWords(ask, `确认使用这份 config 吗？\n  ${chosen}\n(y/N): `);
        if (yes) return chosen;
        console.log('未确认，请重新指定（或直接回车采用默认值后再确认）。');
    }
    return null;
}

/** 选择一个数据根（只读扫描用）：从简单 config 文本推断候选，但必须用户确认；可自定义。 */
async function askDataRoot(ask, appDir, preset, configPath) {
    let inferred = { candidates: [], note: null };
    if (!preset) {
        let text = '';
        try {
            const cfgCandidates = configPath ? [configPath] : discovery.inferConfigCandidates(appDir);
            if (cfgCandidates.length) text = fs.readFileSync(cfgCandidates[0], 'utf8');
        } catch {
            text = '';
        }
        inferred = discovery.inferDataRootCandidates(appDir, text);
        if (inferred.note) console.log(`\n[提示] ${inferred.note}`);
    }
    const cands = preset ? [path.resolve(expandHome(preset))] : inferred.candidates;
    if (!cands.length) cands.push(path.join(path.resolve(appDir), 'data'));
    console.log('\n请确认酒管的用户数据根目录（安装器只**只读**扫描其中的用户级同名扩展；不会写入）。');
    console.log('官方布局通常是 <宿主目录>/data，但 data_root 配置、启动参数或环境变量可能改变它。');
    cands.forEach((c, i) => console.log(`  ${i + 1}) ${c}`));
    const def = cands[0];
    for (let tries = 0; tries < 6; tries++) {
        const raw = expandHome(
            await ask(`数据根路径（回车=${def}，输入编号或自定义绝对路径；输入 - 跳过扫描）: `)
        );
        if (raw === '-') return null;
        let chosen = def;
        if (raw) {
            const idx = parseInt(raw, 10);
            if (String(idx) === raw && idx >= 1 && idx <= cands.length) chosen = cands[idx - 1];
            else if (path.isAbsolute(raw)) chosen = path.resolve(raw);
            else {
                console.log('请输入绝对路径、编号或回车。');
                continue;
            }
        }
        if (!discovery.isRealDir(chosen)) {
            console.log(`该路径不存在、不是真实目录，或是链接：${chosen}`);
            continue;
        }
        const yes = await confirmWords(ask, `确认数据根是这一处吗？\n  ${chosen}\n(y/N): `);
        if (yes) return chosen;
        console.log('未确认，请重新指定。');
    }
    throw new InstallError('USAGE', '未确认有效的数据根，已取消；只有显式输入 - 才会跳过扫描。');
}

/** 交互入口：确认 config / 数据根（两者都要求用户明确确认；也不在本机支持时允许跳过数据根扫描）。 */
async function askSourcePaths(ask, o, appDir) {
    const cfg = await askConfigPath(ask, appDir, o.configPath);
    if (!cfg) return null;
    o.configPath = cfg;
    if (o.noDataRoot) {
        o.dataRoot = null;
        return o;
    }
    const dr = await askDataRoot(ask, appDir, o.dataRoot, o.configPath);
    o.dataRoot = dr;
    o.noDataRoot = dr === null;
    return o;
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function interactive(o) {
    const { ask, rl } = createAsk();
    try {
        console.log('酒管 GitHub 同步 · 安装向导（交互模式）\n');
        console.log('尚未安装过的用户请注意：安装前请先备份酒管的 data 目录。\n');
        console.log(`当前目录: ${process.cwd()}\n`);

        let appDir = o.appDir ? path.resolve(expandHome(o.appDir)) : null;
        let chosen = null;
        let sourcePathsAsked = false;
        while (true) {
            if (!appDir) {
                appDir = await askAppDir(ask);
                if (!appDir) {
                    console.log('已取消。');
                    return 0;
                }
                sourcePathsAsked = false;
            }
            // 交互：选择宿主后逐一确认 config 路径与数据根（默认值只作提示，必须用户确认）。
            if (!sourcePathsAsked) {
                const r = await askSourcePaths(ask, o, appDir);
                if (r === null) {
                    console.log('已取消（未写任何文件）。');
                    return 1;
                }
                sourcePathsAsked = true;
            }
            let p;
            try {
                p = setup.plan(planOptions(o, appDir));
            } catch (e) {
                if (e && e.code === 'PENDING_TX') {
                    console.log(`\n[需要先处理] ${e.message}`);
                    const rec = await ask('现在停服并尝试恢复上次中断的安装吗？(y/N): ');
                    if (/^y(es)?$/i.test(rec)) {
                        try {
                            const r = setup.recover(appDir, Object.assign(planOptions(o, appDir), { stoppedConfirmed: true }));
                            console.log(`[恢复] ${r.message}${r.restored ? `（已恢复: ${r.restored.join(', ')}）` : ''}`);
                        } catch (e2) {
                            console.log(`[恢复失败] ${e2.message}`);
                        }
                        continue;
                    }
                    return 1;
                }
                if (e && (e.code === 'NO_CANDIDATE' || e.code === 'MULTIPLE_CANDIDATES')) {
                    console.log(`\n${e.message}`);
                    appDir = null;
                    continue;
                }
                if (e && (e.code === 'CONFIG_PATH_INVALID' || e.code === 'CONFIG_SOURCE_MISMATCH' || e.code === 'PATH_INVALID')) {
                    console.log(`\n[config 不可用] ${e.message}`);
                    sourcePathsAsked = false;
                    o.configPath = null;
                    continue;
                }
                throw e;
            }

            printPlan(p);
            chosen = p;

            if (p.action === 'noop') {
                console.log('\n已安装同一版本且内容一致，无需重复安装。');
                return 0;
            }
            if (p.action === 'rejected') {
                const takeoverable = ['unknown', 'modified', 'incomplete'].includes(p.inspect.state);
                if (!takeoverable) {
                    console.log('\n本安装器不会覆盖当前状态（详情见上方原因）。未写任何文件。');
                    return 1;
                }
                console.log('\n本安装器不会覆盖无法精确识别的目录。');
                const ans = await ask('如果你确认这里可以接管（旧目录会先完整备份、绝不删除），请输入 yes：');
                if (ans.toLowerCase() === 'yes') {
                    o.takeover = true;
                    continue;
                }
                console.log('已取消（未写任何文件）。');
                return 1;
            }
            if (p.shadowBlocked) {
                console.log('\n必须先实际移除上述用户级扩展（或原始扫描错误），安装器不接受口头确认。请处理完后重新运行向导。');
                return 1;
            }
            if (p.action === 'upgrade') {
                const ok = await confirmWords(
                    ask,
                    `确认把 ${p.inspect.backend && p.inspect.backend.manifest ? p.inspect.backend.manifest.version : '旧版本'} 升级到 ${p.releaseVersion} 吗？(y/N): `
                );
                if (!ok) {
                    console.log('已取消（未写任何文件）。');
                    return 0;
                }
            }
            if (!(await confirmInstall(ask))) {
                console.log('已取消（未写任何文件）。');
                return 0;
            }
            break;
        }

        console.log('\n即将停止安装前的最后一步：请先关闭所有酒管页面，并停止酒管服务。');
        if (!(await confirmWords(ask, '已经停止酒管服务了吗？(y/N): '))) {
            console.log('未确认停服，已取消。请停服后重新运行向导。');
            return 0;
        }

        // 停服后才重新计算计划（复核期间没有并发改动），此时才真正写文件。
        const p = setup.plan(planOptions(o, chosen.appDir));
        printPlan(p);
        if (p.action === 'rejected') throw new InstallError('REJECTED_TARGET', p.reason);
        // gate：遮蔽必须已实际移除（用户刚在本向导之外操作过）。
        setup.assertShadowCleared(p);
        console.log('\n[1/2] 准备新版本（复制 + 依赖）...');
        const prepared = setup.prepare(p);
        if (prepared.action === 'noop') {
            console.log(prepared.message);
            return 0;
        }
        console.log(`      后端 ${prepared.backendCount} 个文件，前端 ${prepared.frontendCount} 个文件${prepared.depsInstalled ? '，依赖已安装' : prepared.depsCopied ? '，依赖已从旧版本复制' : ''}。`);
        console.log('[2/2] 切换并改写配置...');
        const r = setup.commit(prepared, prepared.plan, Object.assign(planOptions(o, p.appDir), { stoppedConfirmed: true }));
        console.log('\n安装完成：');
        console.log(`  后端: ${r.backendDir}`);
        console.log(`  前端: ${r.frontendDir}`);
        console.log(`  配置: ${r.configPath}${r.configChanged ? '（已启用插件）' : '（无需改动）'}`);
        console.log(`  备份: ${r.backupDir}`);
        console.log('\n下一步：按你平时的方式重新启动酒管服务，然后打开一个全新页面。');
        return 0;
    } finally {
        rl.close();
    }
}

/** 交互屏显示的确认问题（计划已在上方打印）。 */
function confirmInstall(ask) {
    return confirmWords(ask, '\n按上面计划安装吗？(y/N): ');
}

function planOptions(o, appDir) {
    return {
        appDir,
        searchRoots: o.searchRoots,
        dataRoot: o.dataRoot || null,
        noDataRoot: !!o.noDataRoot,
        configPath: o.configPath || null,
        enableServerPlugins: o.enableServerPlugins,
        installDeps: o.installDeps,
        takeover: o.takeover,
    };
}

function buildPlan(o) {
    return setup.plan(planOptions(o, o.appDir));
}

function printStatus(o) {
    if (!o.appDir) throw new InstallError('USAGE', '--status 需要 --app-dir。');
    const app = path.resolve(o.appDir);
    const s = setup.status(app);
    console.log(`工作区: ${s.work}`);
    if (s.journalError) {
        console.log(`事务:   [无法读取] ${s.journalError.message}`);
    } else if (s.journal) {
        const j = s.journal;
        console.log(`事务:   ${j.txId || '(legacy)'} / ${j.phase}${j.backupId ? ' / 备份 ' + j.backupId : ''}`);
        if (Array.isArray(j.steps) && j.steps.length) console.log(`步骤:   ${j.steps.map((x) => x.step).join(' → ')}`);
        if (j.error) console.log(`错误:   ${j.error}`);
        if (Array.isArray(j.rollbackErrors) && j.rollbackErrors.length) console.log(`回滚未完成: ${j.rollbackErrors.join('；')}`);
    } else {
        console.log('事务:   无');
    }
    if (s.configSource && s.configSource.error) console.log(`配置来源: [不可用] ${s.configSource.error}`);
    else if (s.configSource) console.log(`配置来源: ${s.configSource.path}（本地受控记录）`);
    else console.log('配置来源: 宿主目录默认 config.yaml（无外置记录）');
    console.log(`备份:   ${s.backups.length} 个（保留历次，不自动删除）`);
    for (const b of s.backups.slice(-5)) console.log(`  - ${b.backupId}`);
    return 0;
}

async function main(argv) {
    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    if (!Number.isInteger(nodeMajor) || nodeMajor < discovery.MIN_NODE_MAJOR) {
        console.error(`[错误] 需要 Node.js >= ${discovery.MIN_NODE_MAJOR}，当前 ${process.versions.node}。`);
        console.error(`  请到 ${discovery.TOOL_LINKS.node} 安装。`);
        return 1;
    }

    let o;
    try {
        o = parseArgs(argv);
    } catch (e) {
        console.error(`[错误] ${e.message}`);
        console.error(usage());
        return 2;
    }
    if (o.help) {
        console.log(usage());
        return 0;
    }

    try {
        if (o.status) return printStatus(o);

        if (o.recover || o.rollback) {
            if (!o.appDir) throw new InstallError('USAGE', `--${o.recover ? 'recover' : 'rollback'} 需要 --app-dir。`);
            if (!o.stoppedConfirmed) {
                console.error(
                    `[错误] ${o.recover ? '恢复' : '回滚'}会改动宿主目录，必须先停止酒管服务并关闭所有页面，` +
                        `然后加 --stopped-confirmed 重新执行。`
                );
                return 2;
            }
            const extra = Object.assign(planOptions(o, o.appDir), { stoppedConfirmed: true });
            const r = o.recover
                ? setup.recover(o.appDir, extra)
                : setup.rollback(o.appDir, Object.assign({ to: o.to }, extra));
            if (r.action === 'rolled_back') {
                console.log(`[${o.recover ? 'recover' : 'rollback'}] 已回到安装前状态。恢复: ${(r.restored || []).join(', ') || '无'}`);
                if (r.quarantined && r.quarantined.length) console.log(`  已移动到 quarantine（保留，未删除）: ${r.quarantined.join(', ')}`);
                if (r.abandonedStage) console.log(`  已放弃的事务 stage 已移入 quarantine 保留: ${r.abandonedStage}`);
                if (r.configRestored) console.log(`  配置: ${r.configRestored}`);
            } else {
                console.log(`[${o.recover ? 'recover' : 'rollback'}] ${r.message}`);
            }
            console.log('  现在可以重新启动酒管服务。');
            return 0;
        }

        const tools = discovery.checkTools({ requireGit: true });
        if (!tools.ok) {
            console.error('[错误] 前置工具检查未通过：');
            for (const m of tools.missing) console.error(`  - ${m.detail}（${m.link}）`);
            return 1;
        }

        const wantInteractive = o.interactive || (!o.apply && !o.appDir);
        if (wantInteractive) {
            if (!process.stdin.isTTY) {
                console.error('[错误] 非交互环境（stdin 不是终端）。请使用 --app-dir <路径> --data-root <路径> --apply --stopped-confirmed。');
                return 2;
            }
            return await interactive(o);
        }

        // 非交互路径。
        if (!o.appDir) throw new InstallError('USAGE', '非交互安装需要 --app-dir <宿主目录>。');
        if (o.apply && !o.dataRoot && !o.noDataRoot) {
            throw new InstallError('USAGE', '--apply 必须显式指定 --data-root <路径>，或使用 --no-data-root 明确跳过用户级扩展扫描。');
        }
        const p = setup.plan(planOptions(o, o.appDir));
        printPlan(p);
        if (p.action === 'noop') {
            console.log('\n已安装同一版本且内容一致，无需重复安装。');
            return 0;
        }
        if (p.action === 'rejected') {
            throw new InstallError('REJECTED_TARGET', p.reason);
        }
        if (p.pendingTx) throw new InstallError('PENDING_TX', `存在未完成事务 ${p.pendingTx.txId}，请先 --recover 或 --rollback。`);
        if (p.action === 'upgrade' && !o.apply) {
            console.log('\n未使用 --apply：以上仅为计划（升级），未写任何文件。确认安装请加 --apply --stopped-confirmed。');
            return 0;
        }
        if (!o.apply) {
            console.log('\n未使用 --apply：以上仅为计划，未写任何文件。确认安装请加 --apply --stopped-confirmed。');
            return 0;
        }
        if (!o.stoppedConfirmed) {
            console.error('\n[错误] --apply 必须同时带 --stopped-confirmed（已停止酒管服务并关闭所有页面）。');
            return 2;
        }
        setup.assertShadowCleared(p);
        const prepared = setup.prepare(p);
        console.log(`  [prepare] 后端 ${prepared.backendCount} 个文件、前端 ${prepared.frontendCount} 个文件${prepared.depsInstalled ? '、依赖已装' : prepared.depsCopied ? '、依赖已从旧版复制' : ''}。`);
        const r = setup.commit(prepared, prepared.plan, Object.assign(planOptions(o, p.appDir), { stoppedConfirmed: true }));
        console.log('\n安装完成：');
        console.log(`  后端: ${r.backendDir}`);
        console.log(`  前端: ${r.frontendDir}`);
        console.log(`  备份: ${r.backupDir}`);
        console.log('  下一步：按原方式重启酒管服务，然后打开一个全新页面。');
        return 0;
    } catch (e) {
        if (e instanceof InstallError) {
            console.error(`[错误] (${e.code}) ${e.message}`);
            return e.code === 'NOT_CONFIRMED' || e.code === 'USAGE' ? 2 : 1;
        }
        console.error(`[错误] ${e && e.stack ? e.stack : e}`);
        return 1;
    }
}

module.exports = { main, parseArgs, printPlan, usage, buildPlan, isHostLike, askConfigPath, askDataRoot };

if (require.main === module) {
    main(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (e) => {
            console.error(`[错误] ${e && e.stack ? e.stack : e}`);
            process.exit(1);
        }
    );
}

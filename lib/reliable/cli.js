'use strict';
/**
 * 离线维护 CLI 入口：参数解析 + 命令分发（复用 orchestrator.run）。
 *
 * 首版交付形态（合同第 9/35 条）：独立进程入口，与在线插件 HTTP 路由彻底分离。
 * 改写聊天的命令（push/apply）要求 --offline-confirmed。
 */
const orchestrator = require('./orchestrator');

const COMMANDS = ['init', 'status', 'push', 'pull', 'apply', 'recover'];

function usage() {
    return [
        '酒管可靠同步 · 离线维护 CLI（预览）',
        '',
        '用法: node bin/reliable-sync.js <command> [options]',
        '',
        '命令:',
        '  init      本地初始化（仅本地，不写远端，要求 --offline-confirmed）',
        '  status    只读输出 B/L/R 与 pending/stage 状态（免离线确认）',
        '  push      发布本地快照到远端（要求 --offline-confirmed）',
        '  pull      拉取远端更新并暂存（不写本地聊天，要求 --offline-confirmed）',
        '  apply     应用暂存到本地聊天（要求 --offline-confirmed，可 --stage-id）',
        '  recover   恢复未完成的 push/apply（要求 --offline-confirmed）',
        '',
        '必选/通用选项:',
        '  --config <path>      JSON 配置文件（含 githubRepo/branch/commitAuthor/tokenFile）',
        '  --repo-dir <path>    本地 git 仓库副本路径',
        '  --data-root <path>   酒管数据根目录（含 chats/）',
        '  --offline-confirmed  声明已停止服务并关闭所有客户端（操作人保证，非软件证明）',
        '  --stage-id <id>      apply 时指定要应用的 stage',
        '',
        '直接参数（可替代 --config）:',
        '  --github-repo <owner/repo>   --branch <name>   --token-file <path>',
    ].join('\n');
}

function parseArgs(argv) {
    const opts = { command: null, offlineConfirmed: false };
    let i = 0;
    const positional = [];
    const valueFor = {
        '--config': 'config',
        '--repo-dir': 'repoDir',
        '--data-root': 'dataRoot',
        '--github-repo': 'githubRepo',
        '--branch': 'branch',
        '--token-file': 'tokenFile',
        '--stage-id': 'stageId',
    };
    while (i < argv.length) {
        const a = argv[i];
        if (a === '--offline-confirmed') {
            opts.offlineConfirmed = true;
            i++;
            continue;
        }
        if (a === '--help' || a === '-h') {
            opts.help = true;
            i++;
            continue;
        }
        if (valueFor[a]) {
            const v = argv[i + 1];
            if (v === undefined) throw new Error(`选项 ${a} 缺少值`);
            opts[valueFor[a]] = v;
            i += 2;
            continue;
        }
        if (a.startsWith('--')) {
            throw new Error(`未知选项: ${a}`);
        }
        positional.push(a);
        i++;
    }

    if (opts.help) {
        opts.showHelp = true;
        return opts;
    }

    if (positional.length === 0) {
        throw new Error('缺少命令。');
    }
    opts.command = positional[0];
    if (!COMMANDS.includes(opts.command)) {
        throw new Error(`未知命令: ${opts.command}`);
    }

    // 加载 config（若提供）
    if (opts.config) {
        const fs = require('fs');
        const path = require('path');
        const raw = fs.readFileSync(path.resolve(opts.config), 'utf8');
        const cfg = JSON.parse(raw);
        opts.githubRepo = opts.githubRepo || cfg.githubRepo;
        opts.branch = opts.branch || cfg.branch;
        opts.commitAuthor = opts.commitAuthor || cfg.commitAuthor;
        opts.tokenFile = opts.tokenFile || cfg.tokenFile;
    }

    return opts;
}

/**
 * 命令主入口：解析参数并分发到 orchestrator.run。
 * 返回退出码（0 成功；2 用法/离线确认类错误；1 运行期错误），**不在此函数内 process.exit**，
 * 由 bin 入口与 require.main 分支统一负责退出，保证所有错误路径都是非 0 退出码。
 * @param {string[]} argv
 * @returns {Promise<number>} 进程退出码
 */
async function main(argv) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (e) {
        console.error(usage());
        console.error('');
        console.error(`[错误] ${e.message}`);
        return 2;
    }

    if (opts.showHelp) {
        console.log(usage());
        return 0;
    }

    if (!opts.repoDir || !opts.dataRoot) {
        console.error(usage());
        console.error('');
        console.error('[错误] --repo-dir 与 --data-root 必填。');
        return 2;
    }

    // 只有 status 免离线确认；init/recover/push/pull/apply 都要求 --offline-confirmed（统一由 orchestrator 再校验一次）
    const mutating = ['init', 'recover', 'push', 'pull', 'apply'];
    if (mutating.includes(opts.command) && !opts.offlineConfirmed) {
        console.error(`[错误] ${opts.command} 需要显式声明已停止服务并关闭所有客户端：请加 --offline-confirmed。`);
        console.error('该声明由操作人负责保证，非软件证明。');
        return 2;
    }

    try {
        const result = await orchestrator.run(opts);
        console.log(JSON.stringify(result, null, 2));
        return 0;
    } catch (e) {
        console.error(`[错误] (${e.code || 'UNKNOWN'}): ${e.message}`);
        return 1;
    }
}

if (require.main === module) {
    main(process.argv.slice(2)).then(code => {
        process.exit(code);
    }).catch(err => {
        console.error('[错误] 未捕获异常:', err && err.stack ? err.stack : err);
        process.exit(1);
    });
}

module.exports = { parseArgs, usage, main };

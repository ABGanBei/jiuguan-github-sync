#!/usr/bin/env node
'use strict';
// 离线维护 CLI 入口：显式调用 main(argv)，统一错误退出码。
// 之前只 `require('../lib/reliable/cli')`，而 cli 仅在 `require.main === module` 时才执行 main，
// 导致 `node bin/reliable-sync.js ...` 静默 exit 0、所有 bin 命令无动作。此处必须显式调用。
const { main } = require('../lib/reliable/cli');

main(process.argv.slice(2)).then(code => {
    process.exit(code);
}).catch(err => {
    console.error('[错误] 未捕获异常:', err && err.stack ? err.stack : err);
    process.exit(1);
});

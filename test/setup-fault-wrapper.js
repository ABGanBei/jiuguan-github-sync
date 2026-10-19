#!/usr/bin/env node
'use strict';
/**
 * 测试辅助 · 断电子进程包装（不是产品代码，不会安装到后端运行时 payload）。
 *
 * 由 test/setup.test.js 以真实子进程启动：本文件只负责把 --spec 转成 argv 后
 * 加载 setup.test.js 的 --fault-child 分支（那里安装 fs.renameSync/copyFileSync 包装，
 * 在指定动作「真实完成之后」立即 process.exit，模拟断电，而不是抛错后被自动 rollback）。
 */
const path = require('path');

const payload = process.argv[2];
if (!payload) {
    console.error('[fault-wrapper] 缺少 spec payload');
    process.exit(2);
}
process.argv = [process.argv[0], path.join(__dirname, 'setup.test.js'), '--fault-child', `--spec=${payload}`];
require('./setup.test.js');

#!/bin/bash
# 酒管 GitHub 同步 · 统一安装向导（Termux / POSIX 入口）。
# 薄封装：定位 node 后把参数原样转交给 Node 实现（bin/setup.js）。
# 用法: bash setup.sh [--app-dir <路径>] [--apply --stopped-confirmed] ...
# 说明: 若未找到 node，打印官方安装指引并退出（不自动安装）。
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
    echo "错误：未找到 node。请先安装 Node.js（>= 20）。" >&2
    echo "  官方安装指引: https://nodejs.org/en/download" >&2
    echo "  Termux 可用: pkg install nodejs" >&2
    exit 1
fi

# 原样转交参数，正确引号，避免 shell 拆分/注入。
exec "$NODE_BIN" "$SCRIPT_DIR/bin/setup.js" "$@"

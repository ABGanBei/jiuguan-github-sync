#!/bin/bash
# 酒管 GitHub 同步 · 一次性安装器（薄封装）。
# 仅把参数原样转交给 Node 实现（bin/install-plugin.js），保证 Windows / Termux 行为一致。
# 用法: bash install.sh --app-dir /path/to/app [--enable-server-plugins] [--install-deps] [--apply]
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
    echo "错误：未找到 node。请先安装 Node.js（>= 20）。" >&2
    exit 1
fi

# 原样转交参数，正确引号，避免 shell 拆分/注入。
# 注：实现位于 bin/install-plugin.js（不是 install.sh 同级的 install-plugin.js）。
exec "$NODE_BIN" "$SCRIPT_DIR/bin/install-plugin.js" "$@"

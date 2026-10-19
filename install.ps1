# 酒管 GitHub 同步 · 统一安装向导（Windows PowerShell 入口）。
# 薄封装：定位 node 后把参数原样转交给 Node 实现（bin/setup.js）。
# 用法: .\install.ps1 [--app-dir <路径>] [--apply --stopped-confirmed] ...
# 说明: 若未找到 node，打印官方安装指引并退出（不自动安装）。

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeBin = $null

# 1) 当前进程路径
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { $NodeBin = $node.Source }

if (-not $NodeBin) {
    # 2) 常见安装位置（nvm / 官方安装器）
    $candidates = @()
    if ($env:NVM_SYMLINK) { $candidates += Join-Path $env:NVM_SYMLINK 'node.exe' }
    $candidates += Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (${env:ProgramFiles(x86)}) { $candidates += Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe' }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { $NodeBin = $c; break }
    }
}

if (-not $NodeBin) {
    Write-Host "[错误] 未找到 node。请先安装 Node.js >= 20：" -ForegroundColor Red
    Write-Host "  https://nodejs.org/en/download" -ForegroundColor Yellow
    exit 1
}

# 原样转交参数（不经 shell 拼接，杜绝注入）。
& $NodeBin (Join-Path $ScriptDir 'bin\setup.js') @args
exit $LASTEXITCODE

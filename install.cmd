@echo off
rem 酒管 GitHub 同步 · 统一安装向导（Windows 双击入口）。
rem 薄封装：调用同目录 install.ps1（它再定位 node 并转交参数给 bin/setup.js）。
rem 用法: install.cmd [--app-dir <路径>] [--apply --stopped-confirmed] ...
setlocal
chcp 65001 >nul

set "SCRIPT_DIR=%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install.ps1" %*
set "INSTALL_EXIT=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %INSTALL_EXIT%

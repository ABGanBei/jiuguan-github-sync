'use strict';
/**
 * 每用户独立存储：配置 / token / 意图（schedule-apply），根在 OS 个人目录下独立 `.jiuguan-github-sync/`。
 *
 * 安全要求（integration-contract.md 后端安全）：
 * - 存储键 = SHA256(全局 dataRoot + handle)，不同用户/不同 dataRoot 不串味；
 * - token 放独立 secrets 目录；**写前先收紧**（POSIX 目录 0700、Windows 用真正 SID icacls 收紧目录），
 *   临时文件用 `wx` 排他 + 0600 创建，fsync 后 rename —— 绝不「先落默认权限再 chmod 收紧」；
 * - PAT 不入 config / 日志 / 仓库 / URL / 进程参数；
 * - 所有存储路径拒绝 symlink/junction/越界/非普通文件（读/写/删都校验全祖先链）。
 *
 * 说明：与旧 lib/secrets.js（`~/.sillytavern-github-sync`）完全独立，不混用。
 */
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DEFAULT_STORAGE_BASE = path.join(os.homedir(), '.jiuguan-github-sync');

class StorageError extends Error {
    constructor(message, code = 'STORAGE_ERROR') {
        super(message);
        this.name = 'StorageError';
        this.code = code;
    }
}

/** 存储键：SHA256(全局 dataRoot + handle) 前 32 hex。 */
function storageKey(globalDataRoot, handle) {
    const raw = `${String(globalDataRoot || '')}|${String(handle || '')}`;
    return crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32);
}

/** 校验 handle 是安全字符串（非空、无路径分隔符/空字符/绝对路径）。 */
function assertSafeHandle(handle) {
    if (typeof handle !== 'string' || handle.length === 0) {
        throw new StorageError('handle 为空或非字符串', 'INVALID_HANDLE');
    }
    if (handle.indexOf('/') !== -1 || handle.indexOf('\\') !== -1 || handle.indexOf('\0') !== -1) {
        throw new StorageError('handle 含非法字符', 'INVALID_HANDLE');
    }
    if (handle === '.' || handle === '..') {
        throw new StorageError('handle 非法', 'INVALID_HANDLE');
    }
    return handle;
}

/**
 * 逐段 lstat 到根，校验每段是真实目录且非链接（只读，不创建）。
 * @param {string} dirAbs
 * @param {boolean} [allowMissing] 为 true 时，遇缺失（ENOENT）段返回 null 而非抛错；
 *   仅用于「读」路径（文件不存在属正常），link/EACCES/EIO 等仍抛（fail-closed）。
 * @returns {Promise<string|null>}
 */
async function assertRealDirChain(dirAbs, allowMissing = false) {
    const abs = path.resolve(dirAbs);
    const rootPart = path.parse(abs).root;
    const relSegs = abs.slice(rootPart.length).split(path.sep).filter(s => s !== '');
    let cur = rootPart;
    for (let i = 0; i < relSegs.length; i++) {
        cur = path.join(cur, relSegs[i]);
        let st;
        try {
            st = await fs.lstat(cur);
        } catch (e) {
            if (e && e.code === 'ENOENT') {
                if (allowMissing) return null;
                throw new StorageError(`目录链缺失: ${cur}`, 'PATH_UNSAFE');
            }
            // EACCES / EIO / ENOTDIR / EPERM 等一律抛，绝不当作缺失。
            throw new StorageError(`目录链 lstat 失败（非缺失）: ${cur}: ${e.message}`, 'PATH_UNSAFE');
        }
        if (st.isSymbolicLink()) throw new StorageError(`目录链含符号链接/junction: ${cur}`, 'PATH_UNSAFE');
        if (!st.isDirectory()) throw new StorageError(`目录链非目录: ${cur}`, 'PATH_UNSAFE');
    }
    return abs;
}

/**
 * 逐段安全创建目录：拒绝 symlink/junction/非目录段；缺失段逐段 mkdir 后重新 lstat 验证。
 * 读错误仅 ENOENT 视为缺失，其它错误抛出。并发 mkdir 撞 EEXIST 时重新 lstat 复核（不误判为失败）。
 */
async function safeEnsureDir(dirAbs) {
    const abs = path.resolve(dirAbs);
    const rootPart = path.parse(abs).root;
    const relSegs = abs.slice(rootPart.length).split(path.sep).filter(s => s !== '');
    let cur = rootPart;
    for (let i = 0; i < relSegs.length; i++) {
        cur = path.join(cur, relSegs[i]);
        let st;
        try {
            st = await fs.lstat(cur);
        } catch (e) {
            if (e && e.code === 'ENOENT') {
                try {
                    await fs.mkdir(cur);
                } catch (e2) {
                    // 并发已创建：复核后继续，不误判失败。
                    if (!(e2 && e2.code === 'EEXIST')) {
                        throw new StorageError(`创建目录失败: ${cur}: ${e2.message}`, 'PATH_UNSAFE');
                    }
                    st = await verifyDirAfterCreate(cur);
                }
                if (!st) st = await verifyDirAfterCreate(cur);
                continue;
            }
            throw new StorageError(`目录链 lstat 失败（非缺失）: ${cur}: ${e.message}`, 'PATH_UNSAFE');
        }
        if (st.isSymbolicLink()) throw new StorageError(`目录链含符号链接/junction: ${cur}`, 'PATH_UNSAFE');
        if (!st.isDirectory()) throw new StorageError(`目录链非目录: ${cur}`, 'PATH_UNSAFE');
    }
    return abs;
}

/** 创建/复核目录后 lstat：必须真实目录且非链接。 */
async function verifyDirAfterCreate(cur) {
    let st2;
    try {
        st2 = await fs.lstat(cur);
    } catch (e2) {
        throw new StorageError(`创建目录后 lstat 失败: ${cur}: ${e2.message}`, 'PATH_UNSAFE');
    }
    if (st2.isSymbolicLink() || !st2.isDirectory()) {
        throw new StorageError(`创建后目录是链接或非目录: ${cur}`, 'PATH_UNSAFE');
    }
    return st2;
}

/** 校验目标文件（若存在）必须是普通文件且非链接；仅 ENOENT 视为将创建。父链全祖先校验。 */
async function verifyFileForWrite(absPath) {
    const abs = path.resolve(absPath);
    await safeEnsureDir(path.dirname(abs));
    let st;
    try {
        st = await fs.lstat(abs);
    } catch (e) {
        if (e && e.code === 'ENOENT') return abs;
        throw new StorageError(`写入目标 lstat 失败（非缺失）: ${abs}: ${e.message}`, 'PATH_UNSAFE');
    }
    if (st.isSymbolicLink()) throw new StorageError(`写入目标是符号链接/junction: ${abs}`, 'PATH_UNSAFE');
    if (!st.isFile()) throw new StorageError(`写入目标不是普通文件: ${abs}`, 'PATH_UNSAFE');
    return abs;
}

/** 原子写字节（临时文件 → fsync → rename）。用于非秘密文件（config/intent）。 */
async function atomicWriteFile(absPath, buf) {
    const abs = await verifyFileForWrite(absPath);
    const dir = path.dirname(abs);
    const tmp = path.join(dir, `.${path.basename(abs)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const fh = await fs.open(tmp, 'w');
    try {
        let off = 0;
        while (off < buf.length) {
            const { bytesWritten } = await fs.write(fh, buf, off, buf.length - off, null);
            if (!bytesWritten || bytesWritten <= 0) throw new Error(`短写: ${off}/${buf.length}`);
            off += bytesWritten;
        }
        await fs.fsync(fh);
    } finally {
        await fs.close(fh);
    }
    await fs.rename(tmp, abs);
    return abs;
}

/** 读文件（若存在）：先核全祖先真实无链接，目标若存在必须普通文件且非链接；目录/文件缺失（仅 ENOENT）返回 null。 */
async function readFileIfExists(absPath) {
    const abs = path.resolve(absPath);
    // 核全祖先链（读侧也拒绝 symlink/junction 祖先，防止重定向到外部文件）。
    // allowMissing：secrets 目录尚未创建（首次尚无 token）属正常 → 视为文件缺失返回 null；
    // 但 link/EACCES/EIO 仍抛。
    const chain = await assertRealDirChain(path.dirname(abs), true);
    if (chain === null) return null;
    let st;
    try {
        st = await fs.lstat(abs);
    } catch (e) {
        if (e && e.code === 'ENOENT') return null;
        throw new StorageError(`读取 lstat 失败（非缺失）: ${abs}: ${e.message}`, 'PATH_UNSAFE');
    }
    if (st.isSymbolicLink()) throw new StorageError(`目标是符号链接，拒绝读取: ${abs}`, 'PATH_UNSAFE');
    if (!st.isFile()) throw new StorageError(`目标不是普通文件，拒绝读取: ${abs}`, 'PATH_UNSAFE');
    return fs.readFile(abs);
}

/** 删除单个文件（非递归）：先校验父链真实、目标若存在必须是普通文件且非链接；仅 ENOENT 视为已删。 */
async function removeFile(absPath) {
    await verifyFileForWrite(absPath);
    try {
        await fs.unlink(absPath);
    } catch (e) {
        if (e && e.code === 'ENOENT') return;
        throw new StorageError(`删除文件失败: ${absPath}: ${e.message}`, 'PATH_UNSAFE');
    }
}

// ============================ 秘密目录 / token ACL ============================

/**
 * 获取当前用户**真正**的 SID（Windows）。
 * 不信 USERNAME（可被环境变量伪造）；用 `whoami /user` 解析 SID，失败则用
 * PowerShell WindowsIdentity 兜底。均失败 → 抛（fail-closed，不落明文）。
 */
function resolveWindowsSid() {
    let sid = '';
    // 方式 1：whoami /user（输出含 "S-1-5-..." 形 SID）
    try {
        const out = execFileSync('whoami', ['/user'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
        const m = out.match(/S-1-\d+-\d+(?:-\d+)+/);
        if (m) sid = m[0];
    } catch { /* 兜底 */ }
    if (!sid) {
        // 方式 2：PowerShell WindowsIdentity（无 whoami 的环境）
        try {
            const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
                '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
            const m = String(out).trim().match(/S-1-\d+-\d+(?:-\d+)+/);
            if (m) sid = m[0];
        } catch { /* 兜底 */ }
    }
    if (!sid) throw new StorageError('无法确定当前 Windows 用户 SID，拒绝写入 token（ACL 无法收紧）', 'ACL_FAILED');
    return sid;
}

/**
 * 用 PowerShell 执行一段**固定**脚本（路径/SID 经环境变量传入，绝不拼进脚本字符串，
 * 因此无 shell/PowerShell 注入）。脚本以 UTF-16LE base64（-EncodedCommand）提交，避免任何引号转义。
 * 注意：此环境里 powershell.exe(5.1) 无法 autoload Microsoft.PowerShell.Security 模块
 * （Get-Acl/Set-Acl 不可用），故脚本一律用原始 .NET `[System.IO.FileInfo|DirectoryInfo]` 的
 * `GetAccessControl()`/`SetAccessControl()`，不依赖 Security cmdlet。
 */
function runPowerShellScript(script, env) {
    const buf = Buffer.from(script, 'utf16le');
    const b64 = buf.toString('base64');
    return execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', b64,
    ], {
        env: Object.assign({}, process.env, env),
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        windowsHide: true,
    });
}

const ACL_SYSTEM_SID = 'S-1-5-18';
const ACL_ADMINS_SID = 'S-1-5-32-544';

/**
 * 判断路径是文件还是目录（用于选择 FileInfo/DirectoryInfo 取 ACL）。路径必须已存在。
 */
function pathIsDirectory(absPath) {
    const st = fs.lstatSync(absPath);
    if (st.isDirectory()) return true;
    if (st.isFile()) return false;
    throw new StorageError(`目标既非目录也非普通文件，无法收紧 ACL: ${absPath}`, 'ACL_FAILED');
}

/**
 * 可靠 DACL 替换（原始 .NET FileSystemSecurity，不依赖 Get-Acl/Set-Acl cmdlet）：
 * - 关闭继承且**不保留**继承 ACE（SetAccessRuleProtection($true, $false)）；
 * - 清空全部显式 ACE（含 Everyone/Users 等宽读 ACE，这是旧 icacls grant:r 漏删的关键缺陷）；
 * - 仅授予当前用户 SID、SYSTEM、Administrators 完全控制（Allow）；
 * - 目录传 `ContainerInherit,ObjectInherit`（子容器/对象继承），文件传 `None`。
 * 失败抛（fail-closed，不落明文）。
 * @param {string} absPath 路径（literal，经环境变量传递，不入脚本字符串）
 * @param {string} sid 当前用户真正 SID
 * @param {'ContainerInherit,ObjectInherit'|'None'} inheritFlags
 */
function restrictAcl(absPath, sid, inheritFlags = 'ContainerInherit,ObjectInherit') {
    // inheritFlags 仅接受固定两种字面量，杜绝注入。
    if (inheritFlags !== 'ContainerInherit,ObjectInherit' && inheritFlags !== 'None') {
        throw new StorageError('非法继承标志（内部错误）', 'ACL_FAILED');
    }
    const isDir = pathIsDirectory(absPath);
    const script = `
$ErrorActionPreference = 'Stop'
$path = $env:JIUGUAN_ACL_PATH
$sidStr = $env:JIUGUAN_ACL_SID
$inherit = $env:JIUGUAN_ACL_INHERIT
$isDir = $env:JIUGUAN_ACL_ISDIR -eq '1'
$item = if ($isDir) { [System.IO.DirectoryInfo]::new($path) } else { [System.IO.FileInfo]::new($path) }
$acl = $item.GetAccessControl()
# 关闭继承并丢弃继承的 ACE；随后清空全部显式 ACE（覆盖 Everyone/Users/未知主体）。
$acl.SetAccessRuleProtection($true, $false)
foreach ($r in @($acl.Access)) { [void]$acl.RemoveAccessRule($r) }
foreach ($t in @($sidStr, 'S-1-5-18', 'S-1-5-32-544')) {
    $sidObj = New-Object System.Security.Principal.SecurityIdentifier($t)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sidObj, 'FullControl', $inherit, 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
$item.SetAccessControl($acl)
`;
    try {
        runPowerShellScript(script, { JIUGUAN_ACL_PATH: absPath, JIUGUAN_ACL_SID: sid, JIUGUAN_ACL_INHERIT: inheritFlags, JIUGUAN_ACL_ISDIR: isDir ? '1' : '0' });
    } catch (e) {
        throw new StorageError(`收紧 ACL 失败（DACL 替换失败，无法限制到当前用户）: ${String(e && e.message || e).split('\n')[0]}`, 'ACL_FAILED');
    }
}

/**
 * 真实枚举并验证某路径 ACL：
 * - 继承已关闭（AreAccessRulesProtected === true）且无任何继承 ACE（IsInherited === false）；
 * - 无任何 Deny ACE；
 * - 每条 ACE 的 identity SID（Translate 到 SecurityIdentifier，**真实 SID** 而非 NTAccount 名）
 *   必须是 {当前 SID, SYSTEM, Administrators} 之一，未知主体 → 拒绝；
 * - 每条均为 Allow 且 FileSystemRights **完整等于** FullControl（位掩码严格相等，非 `-band` 任一重叠位）；
 * - 继承标志：目录每条 ACE 恰为 ContainerInherit|ObjectInherit，文件每条 ACE 恰为 None。
 * 返回真实 principal 摘要（仅 SID，绝不含 token / 用户名标签）。
 * @param {string} absPath
 * @param {string} sid 当前用户真正 SID
 * @returns {{sid:string, verified:true, principals:string[]}}
 */
function verifyAcl(absPath, sid) {
    const isDir = pathIsDirectory(absPath);
    const script = `
$ErrorActionPreference = 'Stop'
$path = $env:JIUGUAN_ACL_PATH
$sidStr = $env:JIUGUAN_ACL_SID
$isDir = $env:JIUGUAN_ACL_ISDIR -eq '1'
$allowed = @{ $sidStr = $true; 'S-1-5-18' = $true; 'S-1-5-32-544' = $true }
$item = if ($isDir) { [System.IO.DirectoryInfo]::new($path) } else { [System.IO.FileInfo]::new($path) }
$acl = $item.GetAccessControl()
if ($acl.AreAccessRulesProtected -ne $true) { throw 'ACL 未受保护（继承未关闭）' }
# 期望继承标志：目录 = ContainerInherit|ObjectInherit；文件 = None。
$full = [System.Security.AccessControl.FileSystemRights]::FullControl
$expectedInherit = if ($isDir) { [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [System.Security.AccessControl.InheritanceFlags]::None }
$principals = [System.Collections.Generic.List[string]]::new()
foreach ($rule in $acl.Access) {
    $sidOfRule = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($rule.AccessControlType -ne 'Allow') { throw ("发现 Deny/非 Allow ACE: " + $sidOfRule) }
    if ($rule.IsInherited) { throw ("发现继承 ACE: " + $sidOfRule) }
    if (-not $allowed.ContainsKey($sidOfRule)) { throw ("发现未知主体: " + $sidOfRule) }
    # 完整位掩码相等（而非 -band 非零）：只允许恰好 FullControl，不接受只部分重叠位。
    if ($rule.FileSystemRights -ne $full) { throw ("主体 FileSystemRights 非完整 FullControl: " + $sidOfRule) }
    # 继承标志必须精确匹配（目录 OI|CI、文件 None）。
    if ($rule.InheritanceFlags -ne $expectedInherit) { throw ("主体继承标志不符: " + $sidOfRule) }
    $principals.Add($sidOfRule)
}
if ($principals.Count -ne 3) { throw ("主体数量异常（应为 3）: " + $principals.Count) }
($principals | Sort-Object) -join '|'
`;
    let out;
    try {
        out = runPowerShellScript(script, { JIUGUAN_ACL_PATH: absPath, JIUGUAN_ACL_SID: sid, JIUGUAN_ACL_ISDIR: isDir ? '1' : '0' });
    } catch (e) {
        throw new StorageError(`ACL 验证失败: ${String(e && e.message || e).split('\n')[0]}`, 'ACL_FAILED');
    }
    const principals = String(out || '').trim().split('|').filter(s => s && s.startsWith('S-1-'));
    if (principals.length !== 3) {
        throw new StorageError(`ACL 验证失败：主体摘要异常（${principals.length}）`, 'ACL_FAILED');
    }
    return { sid, verified: true, principals };
}

/**
 * 写秘密文件（token）：
 * - **写前**先收紧父目录（POSIX chmod 0700；Windows 可靠 DACL 替换 + 验证）；
 * - 临时文件用 `wx` 排他 + 0600 创建，**写字节前**再收紧并验证 tmp ACL（Windows），
 *   绝不「先落默认/宽权限再收紧」；
 * - 完整写入 + fsync + rename；rename 前后都验证 ACL 不可宽读；
 * - 任何失败清理临时文件/已落盘文件、不落明文、不吞失败。
 * @param {string} absPath 目标文件绝对路径
 * @param {Buffer} buf
 * @returns {Promise<string>} 目标文件绝对路径
 */
async function writeSecretFileAtomic(absPath, buf) {
    const abs = path.resolve(absPath);
    const dir = path.dirname(abs);
    await safeEnsureDir(dir);

    // 写前收紧目录（POSIX 0700 / Windows 可靠 DACL 替换 + 验证）。
    if (process.platform === 'win32') {
        const sid = resolveWindowsSid();
        restrictAcl(dir, sid, 'ContainerInherit,ObjectInherit');
        verifyAcl(dir, sid);
    } else {
        try { await fs.chmod(dir, 0o700); } catch (e) {
            throw new StorageError(`收紧目录权限失败（0700）: ${dir}: ${e.message}`, 'ACL_FAILED');
        }
    }

    const tmp = path.join(dir, `.${path.basename(abs)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    let fh;
    try {
        // wx：排他创建（防并发/抢占）+ 0600（创建即私有，无「先宽后窄」窗口）。
        fh = await fs.open(tmp, 'wx', 0o600);
    } catch (e) {
        throw new StorageError(`创建秘密临时文件失败: ${tmp}: ${e.message}`, 'ACL_FAILED');
    }

    // Windows：写字节**前**收紧并验证 tmp ACL（目录虽已收紧，仍显式收紧文件防继承残留）。
    if (process.platform === 'win32') {
        try {
            const sid = resolveWindowsSid();
            restrictAcl(tmp, sid, 'None');
            verifyAcl(tmp, sid);
        } catch (e) {
            try { await fs.close(fh); } catch { /* ignore */ }
            try { await fs.unlink(tmp); } catch { /* ignore */ }
            throw new StorageError(`收紧秘密临时文件 ACL 失败（已清理，不落明文）: ${String(e && e.message || e)}`, 'ACL_FAILED');
        }
    }

    try {
        let off = 0;
        while (off < buf.length) {
            const { bytesWritten } = await fs.write(fh, buf, off, buf.length - off, null);
            if (!bytesWritten || bytesWritten <= 0) throw new Error(`短写: ${off}/${buf.length}`);
            off += bytesWritten;
        }
        await fs.fsync(fh);
    } catch (e) {
        try { await fs.close(fh); } catch { /* ignore */ }
        try { await fs.unlink(tmp); } catch { /* ignore */ }
        throw new StorageError(`写秘密临时文件失败（已清理，不落明文）: ${e.message}`, 'ACL_FAILED');
    }
    try { await fs.close(fh); } catch (e) {
        try { await fs.unlink(tmp); } catch { /* ignore */ }
        throw new StorageError(`关闭秘密临时文件失败: ${e.message}`, 'ACL_FAILED');
    }

    // rename 前再次验证 tmp 不可宽读（目录/文件都核过；此处确证最终写入前状态）。
    if (process.platform === 'win32') {
        try { verifyAcl(tmp, resolveWindowsSid()); } catch (e) {
            try { await fs.unlink(tmp); } catch { /* ignore */ }
            throw new StorageError(`rename 前 ACL 验证失败（已清理，不落明文）: ${String(e && e.message || e)}`, 'ACL_FAILED');
        }
    }

    try {
        await fs.rename(tmp, abs);
    } catch (e) {
        try { await fs.unlink(tmp); } catch { /* ignore */ }
        throw new StorageError(`秘密文件 rename 失败（已清理，不落明文）: ${e.message}`, 'ACL_FAILED');
    }

    // rename 后对最终文件验证 ACL 仍不可宽读；失败清理已落盘文件（不落明文）。
    if (process.platform === 'win32') {
        try {
            const sid = resolveWindowsSid();
            restrictAcl(abs, sid, 'None');
            verifyAcl(abs, sid);
        } catch (e) {
            try { await fs.unlink(abs); } catch { /* ignore */ }
            throw e;
        }
    }
    return abs;
}

/**
 * 写入 token（原子 + 权限收紧，写前收紧目录）。空 token 视为清除（删除文件）。
 * @returns {Promise<string>} token 文件绝对路径（清除时返回 ''）
 */
async function writeToken(userDir, token) {
    const secretsDir = path.join(userDir, 'secrets');
    const tokenPath = path.join(secretsDir, 'token');
    const value = String(token || '').trim();
    if (!value) {
        // 清除：仅当存在时删除
        try {
            await verifyFileForWrite(tokenPath);
            await fs.unlink(tokenPath);
        } catch (e) {
            if (e && e.code === 'ENOENT') return '';
            if (e instanceof StorageError && e.code === 'PATH_UNSAFE') throw e;
        }
        return '';
    }
    return writeSecretFileAtomic(tokenPath, Buffer.from(value, 'utf8'));
}

async function readToken(userDir) {
    const tokenPath = path.join(userDir, 'secrets', 'token');
    const buf = await readFileIfExists(tokenPath);
    return buf ? buf.toString('utf8').trim() : '';
}

/**
 * 解析某用户的存储目录绝对路径并安全创建。
 * @param {string} storageBase
 * @param {string} globalDataRoot
 * @param {string} handle
 */
async function userDir(storageBase, globalDataRoot, handle) {
    assertSafeHandle(handle);
    const dir = path.join(path.resolve(storageBase), storageKey(globalDataRoot, handle));
    await safeEnsureDir(dir);
    return dir;
}

async function loadJson(absPath) {
    const buf = await readFileIfExists(absPath);
    if (buf === null) return null;
    try {
        return JSON.parse(buf.toString('utf8'));
    } catch (e) {
        throw new StorageError(`存储文件损坏（非法 JSON）: ${absPath}: ${e.message}`, 'CORRUPT_STORAGE');
    }
}

async function saveJson(absPath, data) {
    await atomicWriteFile(absPath, Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
}

/** 每用户 config 绝对路径。 */
function configPath(userDir) {
    return path.join(userDir, 'config.json');
}

/** 每用户 intent（schedule-apply）绝对路径。 */
function intentPath(userDir) {
    return path.join(userDir, 'intent.json');
}

module.exports = {
    StorageError,
    DEFAULT_STORAGE_BASE,
    storageKey,
    assertSafeHandle,
    safeEnsureDir,
    assertRealDirChain,
    atomicWriteFile,
    writeSecretFileAtomic,
    resolveWindowsSid,
    restrictAcl,
    verifyAcl,
    userDir,
    loadJson,
    saveJson,
    configPath,
    intentPath,
    writeToken,
    readToken,
    removeFile,
    readFileIfExists,
    verifyFileForWrite,
};

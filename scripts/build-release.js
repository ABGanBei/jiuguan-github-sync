#!/usr/bin/env node
'use strict';
/**
 * 酒管 GitHub 同步 · 发布打包脚本（本地；不创建远端 release、不推送）。
 *
 * 设计要点（修正上一版）：
 *  - 不依赖 git：从**当前磁盘**取固定白名单集合，未提交的新代码也会打进包里。
 *  - 快照不跟随链接：遇到 symlink 的目录/文件一律拒绝（报错退出），防止把宿主目录外的内容带进包。
 *  - 严格排除：.git / node_modules / test-artifacts / research / outputs / dist 等输出目录、
 *    令牌/密钥文件、*.log、*.tmp。
 *  - 格式：ZIP（Windows 系统 bsdtar 支持 `-a -cf` 按扩展名生成 ZIP；POSIX 优先 `zip -r`），
 *    TAR.GZ（系统 `tar -czf`）。输出文件在临时 staging 目录生成后再移入 out，绝不把自己打进包。
 *    若 out 位于源根内，递归收集时也排除该相对路径。
 *  - 打包后读回校验：必需入口（manifest.json、index.js、lib/integration/index.js、client/index.js、
 *    client/manifest.json、package.json、bin/setup.js、install.cmd、install.ps1、setup.sh）与
 *    版本一致性；并生成 SHA256。
 *
 * 用法: node scripts/build-release.js [--out <目录>] [--format zip|tar.gz]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.resolve(ROOT, '..'); // 默认输出到仓库之外，避免自包含

// 固定白名单（顶层条目，递归包含）。
const INCLUDE = ['bin', 'client', 'docs', 'lib', 'scripts', 'test', 'install.cmd', 'install.ps1', 'setup.sh', 'index.js', 'manifest.json', 'package.json', 'package-lock.json', 'README.md', 'README_EN.md', 'LICENSE'];

// 任意层级排除的目录名。
const EXCLUDE_DIRS = new Set(['node_modules', 'test-artifacts', 'research', 'outputs', 'dist', 'dist-release', '.jiuguan-install', '.idea', '.vscode']);

// 必需入口（读回校验）。
const REQUIRED = ['package.json', 'manifest.json', 'index.js', 'lib/integration/index.js', 'lib/secrets.js', 'lib/installer/fsutil.js', 'client/index.js', 'client/manifest.json', 'bin/setup.js', 'install.cmd', 'install.ps1', 'setup.sh'];

// 敏感文件名判定（basename）。
function isSensitiveName(name) {
    const lower = name.toLowerCase();
    if (lower === '.git' || lower === '.env' || lower.startsWith('.env.')) return true;
    if (lower === 'token' || lower === 'token.txt' || lower === 'token.json') return true;
    if (lower === 'pat' || lower === 'pat.txt' || lower === 'pat.json') return true;
    if (lower.startsWith('credentials')) return true;
    if (/^secrets?(?:$|[._-])/.test(lower) && lower !== 'secrets.js') return true;
    if (lower.endsWith('.pem') || lower.endsWith('.key') || lower.endsWith('.p12') || lower.endsWith('.pfx')) return true;
    if (lower.endsWith('.log') || lower.endsWith('.tmp')) return true;
    return false;
}

/**
 * 递归收集白名单内的文件（相对 ROOT 的 POSIX 路径）。
 * @param {object} opts { excludeRels?: string[] } 需排除的输出目录（源根内），以及产物文件。
 */
function collectFiles(opts = {}) {
    const files = [];
    const skippedLinks = [];
    const exclude = new Set(opts.excludeRels || []);
    const excluded = (rel) => {
        for (const e of exclude) {
            if (rel === e || rel.startsWith(e.endsWith('/') ? e : e + '/')) return true;
        }
        return false;
    };
    const walk = (abs, relParts) => {
        let entries;
        try {
            entries = fs.readdirSync(abs, { withFileTypes: true });
        } catch (e) {
            throw new Error(`读取目录失败: ${abs}: ${e.message}`);
        }
        for (const ent of entries) {
            const relParts2 = relParts.concat(ent.name);
            const rel = relParts2.join('/');
            const from = path.join(abs, ent.name);
            if (excluded(rel)) continue;
            if (ent.isSymbolicLink()) {
                // 不跟随链接：记录并拒绝（发布包必须只含仓库内真实文件）。
                skippedLinks.push(rel);
                continue;
            }
            if (ent.isDirectory()) {
                if (EXCLUDE_DIRS.has(ent.name)) continue;
                walk(from, relParts2);
            } else if (ent.isFile()) {
                if (isSensitiveName(ent.name)) continue;
                files.push(rel);
            }
        }
    };
    for (const top of INCLUDE) {
        const abs = path.join(ROOT, top);
        const st = lstatOrNull(abs);
        if (!st) continue;
        if (st.isSymbolicLink()) {
            skippedLinks.push(top);
            continue;
        }
        if (st.isDirectory()) walk(abs, [top]);
        else if (st.isFile()) files.push(top);
    }
    files.sort();
    return { files, skippedLinks };
}

function lstatOrNull(p) {
    try {
        return fs.lstatSync(p);
    } catch {
        return null;
    }
}

function readPkg() {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

/** 生成 ZIP：优先系统 bsdtar（-a 按扩展名），其次 zip -r，再退内建实现。 */
function makeZip(stageDir, names, outPath) {
    // 1) 系统 bsdtar（Windows 10+ / Termux 通常有 tar，且 Windows 的 tar 是 bsdtar 支持 -a -cf x.zip）。
    let r = spawnSync('tar', ['-a', '-cf', outPath, '-C', stageDir, ...names], { cwd: stageDir, encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && isZip(outPath)) return 'bsdtar';
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
    // 2) Info-ZIP zip（POSIX）。
    r = spawnSync('zip', ['-r', '-q', outPath, ...names], { cwd: stageDir, encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && isZip(outPath)) return 'zip';
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
    // 3) 内建 ZIP（仅 stored，不依赖外部工具）。
    writeZipStored(stageDir, names, outPath);
    return 'builtin';
}

/** 生成 TAR.GZ：系统 tar（bsdtar/ZIP 以外的 tar 可能不分大小写，命名固定）。 */
function makeTarGz(stageDir, names, outPath) {
    const r = spawnSync('tar', ['-czf', outPath, '-C', stageDir, ...names], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && fs.existsSync(outPath) && isGzip(outPath)) return 'tar';
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
    writeTarGzBuiltin(stageDir, names, outPath);
    return 'builtin-tar';
}

function isGzip(p) {
    try {
        const buf = fs.readFileSync(p);
        return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
    } catch {
        return false;
    }
}

function isZip(p) {
    try { return fs.readFileSync(p).readUInt32LE(0) === 0x04034b50; }
    catch { return false; }
}

// ── 内建 ZIP（stored）─────────────────────────────────────────────

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function writeZipStored(stageDir, names, outPath) {
    const chunks = [];
    const central = [];
    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
    let offset = 0;
    for (const name of names) {
        const data = fs.readFileSync(path.join(stageDir, name));
        const nameBuf = Buffer.from(name.split('/').join('/'), 'utf8');
        const crc = crc32(data);
        if (data.length > 0xfffffffe) throw new Error(`文件过大（内建 ZIP 限制）: ${name}`);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(dosTime, 10);
        local.writeUInt16LE(dosDate, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        chunks.push(local, nameBuf, data);
        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0);
        cen.writeUInt16LE(20, 4);
        cen.writeUInt16LE(20, 6);
        cen.writeUInt16LE(0x0800, 8);
        cen.writeUInt16LE(0, 10);
        cen.writeUInt16LE(dosTime, 12);
        cen.writeUInt16LE(dosDate, 14);
        cen.writeUInt32LE(crc, 16);
        cen.writeUInt32LE(data.length, 20);
        cen.writeUInt32LE(data.length, 24);
        cen.writeUInt16LE(nameBuf.length, 28);
        cen.writeUInt16LE(0, 30);
        cen.writeUInt16LE(0, 32);
        cen.writeUInt16LE(0, 34);
        cen.writeUInt16LE(0, 36);
        cen.writeUInt32LE(0, 38);
        cen.writeUInt32LE(offset, 42);
        central.push(cen, nameBuf);
        offset += local.length + nameBuf.length + data.length;
    }
    const cenBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(names.length, 8);
    end.writeUInt16LE(names.length, 10);
    end.writeUInt32LE(cenBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);
    fs.writeFileSync(outPath, Buffer.concat([...chunks, cenBuf, end]));
}

// ── 内建 TAR.GZ（仅当系统 tar 不可用）─────────────────────────────

function writeTarGzBuiltin(stageDir, names, outPath) {
    const blocks = [];
    for (const name of names) {
        const data = fs.readFileSync(path.join(stageDir, name));
        const h = Buffer.alloc(512);
        h.write(name, 0, 100, 'utf8');
        h.write('0000644\0', 100);
        h.write('0000000\0', 108);
        h.write('0000000\0', 116);
        h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
        h.write('00000000000\0', 136);
        h.write('        ', 148);
        h.write('0', 156);
        h.write('ustar\u000000', 257);
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += h[i];
        h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
        blocks.push(h, data);
        const pad = (512 - (data.length % 512)) % 512;
        if (pad) blocks.push(Buffer.alloc(pad));
    }
    blocks.push(Buffer.alloc(1024)); // 两个全零块表示结束
    fs.writeFileSync(outPath, require('zlib').gzipSync(Buffer.concat(blocks)));
}

/** Read ZIP entries without relying on bsdtar (GNU tar cannot read ZIP).
 * Only regular stored/deflated files are accepted; names, local headers, CRC and
 * lengths are checked before callers use any bytes. No archive paths are written.
 */
function readZipFiles(archivePath) {
    const zip = fs.readFileSync(archivePath);
    const fail = (message) => { throw new Error('ZIP 校验失败: ' + message); };
    const fits = (offset, size, limit = zip.length) => Number.isSafeInteger(offset) && Number.isSafeInteger(size) &&
        offset >= 0 && size >= 0 && offset <= limit && size <= limit - offset;
    let eocd = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
        if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) {
            eocd = i; break;
        }
    }
    if (eocd < 0) fail('缺少完整中央目录');
    const count = zip.readUInt16LE(eocd + 10);
    const centralSize = zip.readUInt32LE(eocd + 12);
    const centralOffset = zip.readUInt32LE(eocd + 16);
    if (zip.readUInt16LE(eocd + 4) || zip.readUInt16LE(eocd + 6) || zip.readUInt16LE(eocd + 8) !== count ||
        count === 65535 || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('不支持分卷或 ZIP64');
    if (!fits(centralOffset, centralSize, eocd) || centralOffset + centralSize !== eocd) fail('中央目录边界异常');
    const files = new Map();
    const normalizedNames = new Set();
    const spans = [];
    let pos = centralOffset;
    for (let i = 0; i < count; i++) {
        if (!fits(pos, 46, eocd) || zip.readUInt32LE(pos) !== 0x02014b50) fail('中央目录条目损坏');
        const flags = zip.readUInt16LE(pos + 8);
        const method = zip.readUInt16LE(pos + 10);
        const crc = zip.readUInt32LE(pos + 16);
        const compressedSize = zip.readUInt32LE(pos + 20);
        const size = zip.readUInt32LE(pos + 24);
        const nameSize = zip.readUInt16LE(pos + 28);
        const extraSize = zip.readUInt16LE(pos + 30);
        const commentSize = zip.readUInt16LE(pos + 32);
        const attributes = zip.readUInt32LE(pos + 38);
        const localOffset = zip.readUInt32LE(pos + 42);
        const entrySize = 46 + nameSize + extraSize + commentSize;
        if (!fits(pos, entrySize, eocd) || !nameSize || zip.readUInt16LE(pos + 34) ||
            size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) fail('条目边界或大小异常');
        if ((method !== 0 && method !== 8) || (flags & ~0x080e) || (method === 0 && (flags & 6))) fail('不支持加密或该压缩格式');
        const nameBytes = zip.subarray(pos + 46, pos + 46 + nameSize);
        const name = nameBytes.toString('utf8');
        if (!Buffer.from(name, 'utf8').equals(nameBytes) || (!(flags & 0x0800) && /[^\x00-\x7f]/.test(name)) ||
            /[\x00-\x1f\\:]/.test(name) || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..')) fail('文件路径不安全');
        const fileType = (attributes >>> 16) & 0xf000;
        if ((attributes & 0x10) || (fileType && fileType !== 0x8000)) fail('只允许普通文件');
        const foldedName = name.normalize('NFC').toLowerCase();
        if (normalizedNames.has(foldedName)) fail('重复文件名: ' + name);
        normalizedNames.add(foldedName);
        if (!fits(localOffset, 30, centralOffset) || zip.readUInt32LE(localOffset) !== 0x04034b50) fail('本地文件头损坏');
        const localNameSize = zip.readUInt16LE(localOffset + 26);
        const localExtraSize = zip.readUInt16LE(localOffset + 28);
        const headerSize = 30 + localNameSize + localExtraSize;
        if (!fits(localOffset, headerSize + compressedSize, centralOffset) ||
            zip.readUInt16LE(localOffset + 6) !== flags || zip.readUInt16LE(localOffset + 8) !== method ||
            localNameSize !== nameSize || !zip.subarray(localOffset + 30, localOffset + 30 + localNameSize).equals(nameBytes)) fail('本地文件头与中央目录不一致');
        if (!(flags & 8) && (zip.readUInt32LE(localOffset + 14) !== crc ||
            zip.readUInt32LE(localOffset + 18) !== compressedSize || zip.readUInt32LE(localOffset + 22) !== size)) fail('本地大小或 CRC 不一致');
        const start = localOffset + headerSize;
        const packed = zip.subarray(start, start + compressedSize);
        let data;
        try { data = method === 0 ? packed : require('zlib').inflateRawSync(packed, { maxOutputLength: Math.max(size, 1) }); }
        catch { fail('解压失败: ' + name); }
        if (data.length !== size || crc32(data) !== crc) fail('内容大小或 CRC 不一致: ' + name);
        let end = start + compressedSize;
        if (flags & 8) {
            const descriptor = fits(end, 4, centralOffset) && zip.readUInt32LE(end) === 0x08074b50 ? end + 4 : end;
            if (!fits(descriptor, 12, centralOffset) || zip.readUInt32LE(descriptor) !== crc ||
                zip.readUInt32LE(descriptor + 4) !== compressedSize || zip.readUInt32LE(descriptor + 8) !== size) fail('数据描述符不一致');
            end = descriptor + 12;
        }
        spans.push({ start: localOffset, end });
        files.set(name, data);
        pos += entrySize;
    }
    if (pos !== eocd) fail('中央目录数量或大小不一致');
    spans.sort((a, b) => a.start - b.start);
    let localEnd = 0;
    for (const span of spans) {
        if (span.start !== localEnd) fail('文件区域重叠或存在未登记内容');
        localEnd = span.end;
    }
    if (localEnd !== centralOffset) fail('中央目录前存在未登记内容');
    return files;
}

/** 读回校验：ZIP 直接核对中央目录及内容；TAR.GZ 解压到临时目录。 */
function verifyArchive(archivePath, format, expectedVersion, expectedFiles, sourceDir) {
    if (format === 'zip' && !isZip(archivePath)) throw new Error('ZIP 文件标识不正确');
    if (format === 'tar.gz' && !isGzip(archivePath)) throw new Error('gzip 文件标识不正确');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuguan-verify-'));
    try {
        const zipFiles = format === 'zip' ? readZipFiles(archivePath) : null;
        let entries;
        if (zipFiles) entries = [...zipFiles.keys()];
        else {
            const r = spawnSync('tar', ['-xf', archivePath, '-C', tmp], { encoding: 'utf8', windowsHide: true });
            if (r.status !== 0) throw new Error(`读回解压失败（tar）: ${(r.stderr || '').trim()}`);
            const list = spawnSync('tar', ['-tf', archivePath], { encoding: 'utf8', windowsHide: true });
            if (list.status !== 0) throw new Error('读取归档文件集合失败');
            entries = (list.stdout || '').split(/\r?\n/).filter(Boolean);
        }
        const readFile = rel => zipFiles ? zipFiles.get(rel) : fs.readFileSync(path.join(tmp, rel));
        const missing = REQUIRED.filter((f) => !entries.includes(f));
        if (missing.length) throw new Error(`归档缺少必需入口: ${missing.join(', ')}`);
        const pkg = JSON.parse(readFile('package.json').toString('utf8'));
        if (expectedVersion && pkg.version !== expectedVersion) {
            throw new Error(`归档内 package.json 版本 ${pkg.version} 与本次 ${expectedVersion} 不一致`);
        }
        const man = JSON.parse(readFile('manifest.json').toString('utf8'));
        if (!man || typeof man.display_name !== 'string' || typeof man.js !== 'string') {
            throw new Error('归档内 manifest.json 非法（缺 display_name/js）');
        }
        const client = JSON.parse(readFile('client/manifest.json').toString('utf8'));
        if (man.version !== pkg.version || client.version !== pkg.version) throw new Error('归档前后端版本不一致');
        if (expectedFiles && sourceDir) {
            const expected = new Set(expectedFiles);
            if (entries.length !== expected.size || entries.some(rel => !expected.has(rel))) throw new Error('归档文件集合与快照不一致');
            for (const rel of expectedFiles) {
                const packed = readFile(rel);
                const source = fs.readFileSync(path.join(sourceDir, rel));
                if (!packed.equals(source)) throw new Error('归档文件字节不一致: ' + rel);
            }
        }
        const bad = entries.filter((e) => /(^|\/)(node_modules|\.git|test-artifacts|research|outputs)\//.test(e + '/'));
        if (bad.length) throw new Error(`归档包含应排除的内容: ${bad.slice(0, 5).join(', ')}`);
        return { ok: true, entries: entries.length, format };
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
}

function usage() {
    return `酒管发布打包（本地，不创建远端 release）

用法: node scripts/build-release.js [--out <目录>] [--format zip|tar.gz]

  --out <目录>   输出目录（默认仓库的上一级目录）。
  --format <f>   zip（默认）或 tar.gz。

说明: 从当前磁盘取固定白名单文件（不依赖 git 提交），不跟随链接，
      排除 node_modules/.git/test-artifacts/research/outputs/dist 与令牌/密钥文件；
      生成后读回校验必需入口与版本，并写 .sha256 校验文件。`;
}

function main(argv) {
    let outDir = DEFAULT_OUT;
    let format = 'zip';
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case '--out': outDir = argv[++i]; break;
            case '--format': format = argv[++i]; break;
            case '--help': case '-h': console.log(usage()); return 0;
            default: console.error(`[错误] 未知参数: ${argv[i]}`); return 2;
        }
    }
    if (!outDir) { console.error('[错误] --out 需要目录。'); return 2; }
    if (format !== 'zip' && format !== 'tar.gz') {
        console.error('[错误] --format 仅支持 zip 或 tar.gz。');
        return 2;
    }
    outDir = path.resolve(outDir);
    const pkg = readPkg();
    const version = pkg.version || 'unknown';
    const base = `jiuguan-github-sync-${version}`;
    const outPath = path.join(outDir, `${base}.${format}`);
    if (outDir === ROOT) {
        console.error(`[错误] 输出目录不能是源根目录（会污染包内容）: ${outDir}`);
        return 2;
    }

    // out 是否位于源根内：收集时必须排除「输出目录本身」与产物文件，绝不把自己打进包。
    const outDirRel = path.relative(ROOT, outDir);
    const outDirInside = !!outDirRel && !outDirRel.startsWith('..') && !path.isAbsolute(outDirRel);
    const excludeRels = outDirInside ? [outDirRel.split(path.sep).join('/'), `${outDirRel.split(path.sep).join('/')}/`] : [];

    const { files, skippedLinks } = collectFiles({ excludeRels });
    if (skippedLinks.length) {
        console.error('[错误] 源内存在符号链接，发布包只允许真实文件（请移除这些链接）：');
        for (const s of skippedLinks.slice(0, 20)) console.error(`  - ${s}`);
        return 1;
    }
    if (!files.length) { console.error('[错误] 未收集到任何文件。'); return 1; }
    const missing = REQUIRED.filter((f) => !files.includes(f));
    if (missing.length) {
        console.error(`[错误] 当前磁盘缺少必需入口（无法打包）: ${missing.join(', ')}`);
        return 1;
    }

    // staging：在 out 目录内建临时子目录（同文件系统），避免部分写入。
    fs.mkdirSync(outDir, { recursive: true });
    const stageParent = fs.mkdtempSync(path.join(outDir, '.jiuguan-stage-'));
    const stageDir = path.join(stageParent, base);
    try {
        for (const rel of files) {
            const dest = path.join(stageDir, rel.split('/').join(path.sep));
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(path.join(ROOT, rel.split('/').join(path.sep)), dest);
        }
        const tmpOut = path.join(stageParent, `${base}.${format}`);
        const tool = format === 'zip' ? makeZip(stageDir, files, tmpOut) : makeTarGz(stageDir, files, tmpOut);
        if (!fs.existsSync(tmpOut)) throw new Error('生成归档失败');
        const verify = verifyArchive(tmpOut, format, version, files, stageDir);
        fs.renameSync(tmpOut, outPath);
        const digest = crypto.createHash('sha256').update(fs.readFileSync(outPath)).digest('hex');
        const shaPath = outPath + '.sha256';
        fs.writeFileSync(shaPath, `${digest}  ${path.basename(outPath)}\n`, 'utf8');
        console.log(`[build] 已生成: ${outPath}`);
        console.log(`[build] 格式/工具: ${format} / ${tool}`);
        console.log(`[build] 文件数: ${files.length}（读回校验 ${verify.entries} 项通过）`);
        console.log(`[build] SHA256: ${digest}`);
        console.log(`[build] 校验文件: ${shaPath}`);
        return 0;
    } catch (e) {
        console.error(`[build] 打包失败: ${e.message}`);
        return 1;
    } finally {
        try { fs.rmSync(stageParent, { recursive: true, force: true }); } catch {}
    }
}

if (require.main === module) {
    process.exit(main(process.argv.slice(2)));
}

module.exports = { main, collectFiles, isSensitiveName, verifyArchive, readZipFiles, crc32, INCLUDE, REQUIRED };

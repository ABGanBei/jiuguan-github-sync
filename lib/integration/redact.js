'use strict';
/**
 * 密钥/敏感信息脱敏：任何进入 API 响应或日志的错误文本，都不得回显真实 token、
 * 绝对路径或堆栈。
 *
 * 脱敏策略：
 * - 已知 token（从配置解析到的实际值）→ 替换为 `***`；
 * - 常见 token 格式（ghp_/github_pat_/gho_/ghu_/ghs_/ghr_ 等）→ 前缀保留、主体打星；
 * - URL 内嵌凭据（https://user:token@host）→ 凭据打星；
 * - 绝对路径（含盘符 / /home / /Users）→ 打星（避免泄漏部署目录）。
 */
const COMMON_TOKEN_RE = /\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g;

function redactKnownToken(knownToken, str) {
    let out = String(str == null ? '' : str);
    if (knownToken && knownToken.length > 4) {
        out = out.split(knownToken).join('***');
    }
    return out;
}

function redactCommonTokens(str) {
    let out = String(str == null ? '' : str);
    out = out.replace(COMMON_TOKEN_RE, m => m.slice(0, 4) + '***');
    return out;
}

function redactUrlCredentials(str) {
    return String(str == null ? '' : str).replace(/(https?:\/\/)[^@\s]+(@)/g, '$1***$2');
}

/** 绝对路径打星：避免把部署目录（如 C:\Users\... 或 /home/...）泄漏给前端。 */
function redactAbsolutePaths(str) {
    let out = String(str == null ? '' : str);
    // Windows 盘符路径
    out = out.replace(/[A-Za-z]:\\[^\s"']+/g, '[path]');
    // POSIX 绝对路径（含 /home /Users /tmp /var 等常见根，以及反斜杠与正斜杠混合）
    out = out.replace(/(?:\/|\\)(?:home|Users|tmp|var|opt|srv|data)\/[^\s"']+/g, '[path]');
    // 一般绝对路径兜底
    out = out.replace(/(?<![\w.])\/(?!\/)[^\s"']+/g, '[path]');
    return out;
}

/**
 * 完整脱敏：已知 token → 常见 token 格式 → URL 凭据 → 绝对路径。
 * @param {string} knownToken
 * @param {any} str
 */
function redact(knownToken, str) {
    let out = redactKnownToken(knownToken, str);
    out = redactCommonTokens(out);
    out = redactUrlCredentials(out);
    out = redactAbsolutePaths(out);
    return out;
}

/** 是否疑似泄露（含真实 token 或栈信息）。用于测试断言「secret 不输出」。 */
function containsSecret(knownToken, text) {
    const t = String(text == null ? '' : text);
    if (knownToken && knownToken.length > 4 && t.includes(knownToken)) return true;
    if (/\bat\s+.*:\d+:\d+|Error:\s/.test(t) && /\.js:\d+/.test(t)) return true; // 堆栈痕迹
    return false;
}

module.exports = {
    redact,
    redactKnownToken,
    redactCommonTokens,
    redactUrlCredentials,
    redactAbsolutePaths,
    containsSecret,
};

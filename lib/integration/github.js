'use strict';

// Fixed GitHub endpoint. Credentials are sent only in the Authorization header.
class RepositoryError extends Error {
    constructor(message, code, statusCode = 502) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
    }
}

async function inspectRepository({ repo, token, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) {
        throw new RepositoryError('请填写私有数据仓库，格式为 用户名/仓库名。', 'INVALID_CONFIG', 400);
    }
    if (!token) throw new RepositoryError('请先保存有该数据仓库权限的令牌。', 'TOKEN_REQUIRED', 400);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl('https://api.github.com/repos/' + repo.split('/').map(encodeURIComponent).join('/'), {
            method: 'GET', redirect: 'error', signal: controller.signal,
            headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token,
                'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jiuguan-github-sync' },
        });
        if (!response.ok) {
            const messages = {
                401: '令牌无效或已过期，请重新生成。',
                403: 'GitHub 拒绝访问，请检查令牌权限或稍后重试。',
                404: '找不到这个私有仓库，请检查仓库名和令牌选择的仓库。',
                429: 'GitHub 请求过多，请稍后重试。',
            };
            // Never echo a remote error body: it may contain sensitive request data.
            throw new RepositoryError(messages[response.status] || 'GitHub 验证失败，请稍后重试。', 'GITHUB_' + response.status, response.status === 404 ? 400 : 502);
        }
        const text = await response.text();
        if (text.length > 262144) throw new RepositoryError('GitHub 返回内容异常。', 'GITHUB_RESPONSE');
        let data;
        try { data = JSON.parse(text); } catch { throw new RepositoryError('GitHub 返回格式异常。', 'GITHUB_RESPONSE'); }
        if (typeof data.full_name !== 'string' || data.full_name.toLowerCase() !== repo.toLowerCase()) {
            throw new RepositoryError('仓库身份不匹配，请检查是否已转移或改名。', 'REPOSITORY_MISMATCH', 409);
        }
        if (data.private !== true) throw new RepositoryError('这是公开仓库。请改用专门存聊天的私有仓库。', 'PRIVATE_REPOSITORY_REQUIRED', 400);
        if (data.archived || data.disabled) throw new RepositoryError('仓库已归档或停用，无法用于同步。', 'REPOSITORY_READ_ONLY', 400);
        return { private: true, fullName: data.full_name,
            writePermissionHint: data.permissions && typeof data.permissions.push === 'boolean' ? data.permissions.push : null };
    } catch (e) {
        if (e instanceof RepositoryError) throw e;
        throw new RepositoryError('无法连接 GitHub 验证仓库，请检查网络后重试。', 'GITHUB_UNAVAILABLE');
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { inspectRepository, RepositoryError };

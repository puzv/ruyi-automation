const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const repository = require('@ruyi/server/src/modules/api-tokens/repository');
const sessions = require('@ruyi/server/src/modules/auth/repository');
const { guard } = require('@ruyi/server/src/modules/auth/guard');
const { auditFromRequest, sanitizeDetail } = require('@ruyi/shared/runtime/audit');

async function main() {
  const original = { ...repository };
  const originalSessions = { ...sessions };
  const secret = `ruyi_pat_${'a'.repeat(43)}`;
  const user = { id: 7, username: 'test_user', display_name: '测试用户', role: 'admin', status: 'active', must_change_password: 0 };
  let touches = 0;
  let cookieLookups = 0;
  repository.findActiveByHash = async (_db, hash) => hash === crypto.createHash('sha256').update(secret).digest('hex') ? { id: 12, user } : undefined;
  repository.touch = async (_db, id) => { assert.equal(id, 12); touches++; };
  sessions.findActiveSession = async () => { cookieLookups++; return { id: 'session-hash', user }; };
  sessions.touchSession = async () => {};
  const call = async (method, route, authorization, rawUrl = route) => {
    const request = { method, routeOptions: { url: route }, url: rawUrl, headers: {}, cookies: { ruyi_session: 'b'.repeat(43) }, sessionTokenHash: null };
    if (authorization !== undefined) request.headers.authorization = authorization;
    const reply = { statusCode: 200, code(code) { this.statusCode = code; return this; }, send(body) { this.body = body; return this; } };
    await guard.call({ db: {} }, request, reply);
    return { request, reply };
  };
  try {
    const authenticated = await call('GET', '/api/status', `Bearer ${secret}`);
    assert.equal(authenticated.reply.statusCode, 200);
    assert.equal(authenticated.request.authMethod, 'token');
    assert.equal(authenticated.request.apiTokenId, 12);
    assert.equal(authenticated.request.sessionTokenHash, null);
    assert.equal(authenticated.request.user.id, 7);
    assert.equal(touches, 1);
    assert.equal(cookieLookups, 0);
    for (const authorization of ['', 'Basic bad', `bearer ${secret}`, `Bearer ${secret} extra`, `Bearer ruyi_pat_${'c'.repeat(43)}`]) {
      const { reply } = await call('GET', '/api/status', authorization);
      assert.equal(reply.statusCode, 401);
      assert.equal(reply.body.code, 'UNAUTHENTICATED');
    }
    assert.equal(cookieLookups, 0, 'Authorization 验证失败也不得回退 Cookie');
    for (const [method, route] of [
      ['GET', '/api/admin/users'], ['GET', '/api/api-tokens'], ['POST', '/api/api-tokens'],
      ['POST', '/api/api-tokens/:id/revoke'], ['POST', '/api/auth/change-password'],
      ['POST', '/api/platform-login'], ['GET', '/api/new-business-route'],
    ]) {
      const { reply } = await call(method, route, `Bearer ${secret}`);
      assert.equal(reply.statusCode, 403);
      assert.equal(reply.body.code, 'TOKEN_FORBIDDEN');
    }
    assert.equal((await call('GET', '/api/admin/users', `Bearer ${secret}`, '/api/%61dmin/users')).reply.body.code, 'TOKEN_FORBIDDEN');
    for (const [method, route] of [['GET', '/api/auth/me'], ['GET', '/api/jobs/:id/results.zip'], ['POST', '/api/run/:task'], ['GET', '/api/auto-advance/phases']]) {
      assert.equal((await call(method, route, `Bearer ${secret}`)).reply.statusCode, 200);
    }
    user.must_change_password = 1;
    assert.equal((await call('GET', '/api/auth/me', `Bearer ${secret}`)).reply.body.code, 'PASSWORD_CHANGE_REQUIRED');
    user.must_change_password = 0;
    const session = await call('GET', '/api/status');
    assert.equal(session.request.authMethod, 'session');
    assert.equal(session.request.sessionTokenHash, 'session-hash');
    const entry = auditFromRequest(authenticated.request, { detail: { task: 'upload' } });
    assert.deepEqual(sanitizeDetail(entry.detail), { task: 'upload', via: 'api_token', credentialId: 12 });
    assert.deepEqual(auditFromRequest(authenticated.request, {}).detail, { via: 'api_token', credentialId: 12 });
    repository.findActiveByHash = async () => { throw new Error('含敏感参数的数据库异常'); };
    await assert.rejects(call('GET', '/api/status', `Bearer ${secret}`), { message: '验证令牌失败，请稍后重试' });
    console.log('API 令牌鉴权白名单、Cookie 隔离与审计标记测试通过。');
  } finally {
    Object.assign(repository, original);
    Object.assign(sessions, originalSessions);
  }
}
main().catch((error) => { console.error('API 令牌鉴权测试失败：', error); process.exitCode = 1; });

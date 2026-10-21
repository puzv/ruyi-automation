const { sql } = require('kysely');
const users = require('@ruyi/shared/runtime/repos/users');
const sessions = require('./repository');
const { hashPassword, verifyPassword, validatePasswordStrength, validateUsername } = require('./password');
const { COOKIE_NAME, cookieOptions, publicUser, startSession } = require('./session');

// 固定的 cost 12 哈希，让不存在的账号也执行相同成本的密码比较。
const DUMMY_HASH = '$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW';

async function registerAuthRoutes(app) {
  app.post('/api/auth/register', async (request, reply) => {
    const { username, displayName, password } = request.body || {};
    const error = validateUsername(username) || validatePasswordStrength(password)
      || (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 64 ? '显示名称需为 1 至 64 位字符' : null);
    if (error) return reply.code(400).send({ ok: false, message: error });
    try {
      // 权限与账号状态由服务端决定，公开注册不接受管理字段。
      const id = await users.createUser(app.db, {
        username, displayName, passwordHash: await hashPassword(password),
        role: 'user', mustChangePassword: false, createdBy: null,
      });
      request.auditUserId = id;
      return reply.code(201).send({ ok: true, message: '注册成功，请返回登录' });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return reply.code(409).send({ ok: false, message: '用户名已存在' });
      // 数据库异常可能携带含哈希的 SQL，不交给通用错误日志或响应。
      request.log.error('注册失败，请检查数据库服务');
      return reply.code(500).send({ ok: false, message: '注册失败，请稍后重试' });
    }
  });

  app.post('/api/auth/login', async (request, reply) => {
    const { username, password } = request.body || {};
    const user = typeof username === 'string' && username ? await users.findByUsername(app.db, username) : undefined;
    request.auditUserId = user?.id;
    if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
      return reply.code(400).send({ ok: false, message: '请提供用户名和密码' });
    }
    const incorrect = () => reply.code(401).send({ ok: false, message: '用户名或密码错误' });
    if (!user) {
      request.auditReason = 'unknown_user';
      await verifyPassword(password, DUMMY_HASH);
      return incorrect();
    }
    const lock = await app.db.selectFrom('ruyi_users')
      .select(sql`CEIL(TIMESTAMPDIFF(SECOND, NOW(), locked_until) / 60)`.as('minutes'))
      .where('id', '=', user.id).where('locked_until', '>', sql`NOW()`).executeTakeFirst();
    if (lock) {
      request.auditReason = 'locked';
      return reply.code(429).send({ ok: false, message: `登录失败次数过多，请 ${Math.max(1, Number(lock.minutes))} 分钟后再试` });
    }
    if (!await verifyPassword(password, user.password_hash)) {
      request.auditReason = 'wrong_password';
      await users.recordLoginFailure(app.db, user.id, { maxFailures: 5, lockMinutes: 15 });
      return incorrect();
    }
    if (user.status !== 'active') {
      request.auditReason = 'disabled';
      return reply.code(403).send({ ok: false, message: '账号已停用，请联系管理员' });
    }
    await app.db.transaction().execute(async (trx) => {
      await users.recordLoginSuccess(trx, user.id, request.ip);
      await startSession(trx, user.id, request, reply);
    });
    return { ok: true, user: publicUser(user) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await sessions.revokeSession(app.db, request.sessionTokenHash);
    reply.clearCookie(COOKIE_NAME, cookieOptions());
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => ({ ok: true, user: request.user }));

  app.post('/api/auth/change-password', async (request, reply) => {
    const { currentPassword, newPassword } = request.body || {};
    const user = await users.findById(app.db, request.user.id);
    if (typeof currentPassword !== 'string' || !await verifyPassword(currentPassword, user.password_hash)) {
      request.auditReason = 'wrong_password';
      return reply.code(400).send({ ok: false, message: '当前密码不正确' });
    }
    const error = validatePasswordStrength(newPassword);
    if (error) {
      request.auditReason = 'invalid_request';
      return reply.code(400).send({ ok: false, message: error });
    }
    // bcrypt 会截断 72 字节后的内容，需按哈希比较而不能只比较明文。
    if (await verifyPassword(newPassword, user.password_hash)) {
      request.auditReason = 'same_password';
      return reply.code(400).send({ ok: false, message: '新密码不能与当前密码相同' });
    }
    const passwordHash = await hashPassword(newPassword);
    await app.db.transaction().execute(async (trx) => {
      await users.updatePassword(trx, user.id, passwordHash, { mustChangePassword: false });
      await sessions.revokeUserSessions(trx, user.id, { exceptTokenHash: request.sessionTokenHash });
    });
    return { ok: true };
  });
}

module.exports = { registerAuthRoutes };

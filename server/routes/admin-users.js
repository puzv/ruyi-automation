const users = require('../repos/users');
const sessions = require('../repos/sessions');
const { hashPassword, validatePasswordStrength, validateUsername } = require('../auth/password');

function camelUser(user) {
  return Object.fromEntries(Object.entries(user).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
    key === 'must_change_password' ? Boolean(value) : value,
  ]));
}

async function registerAdminUsersRoutes(app) {
  app.get('/api/admin/users', async () => ({ ok: true, users: (await users.listUsers(app.db)).map(camelUser) }));

  app.post('/api/admin/users', async (request, reply) => {
    const { username, displayName, password, role } = request.body || {};
    const error = validateUsername(username) || validatePasswordStrength(password)
      || (role !== 'user' && role !== 'admin' ? '角色只能是 user 或 admin' : null)
      || (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 64 ? '显示名称需为 1 至 64 位字符' : null);
    if (error) return reply.code(400).send({ ok: false, message: error });
    try {
      const id = await users.createUser(app.db, {
        username, displayName, passwordHash: await hashPassword(password), role,
        mustChangePassword: true, createdBy: request.user.id,
      });
      return { ok: true, user: camelUser((await users.listUsers(app.db)).find((user) => user.id === id)) };
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return reply.code(409).send({ ok: false, message: '用户名已存在' });
      throw error;
    }
  });

  for (const action of ['disable', 'enable', 'reset-password']) {
    app.post(`/api/admin/users/:id/${action}`, async (request, reply) => {
      const id = Number(request.params.id);
      const user = Number.isSafeInteger(id) && id > 0 ? await users.findById(app.db, id) : undefined;
      request.auditTargetUsername = user?.username;
      if (!user) return reply.code(404).send({ ok: false, message: '用户不存在' });
      if (action === 'disable' && id === request.user.id) {
        return reply.code(400).send({ ok: false, message: '不能停用自己' });
      }
      let passwordHash;
      if (action === 'reset-password') {
        const error = validatePasswordStrength(request.body?.password);
        if (error) return reply.code(400).send({ ok: false, message: error });
        passwordHash = await hashPassword(request.body.password);
      }
      await app.db.transaction().execute(async (trx) => {
        if (action === 'reset-password') await users.updatePassword(trx, id, passwordHash, { mustChangePassword: true });
        else await users.setStatus(trx, id, action === 'disable' ? 'disabled' : 'active');
        if (action !== 'enable') await sessions.revokeUserSessions(trx, id);
      });
      return { ok: true };
    });
  }
}

module.exports = { registerAdminUsersRoutes };

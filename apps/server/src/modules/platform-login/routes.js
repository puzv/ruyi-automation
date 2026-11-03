const sessions = require('./sessions');
const { auditFromRequest } = require('@ruyi/shared/runtime/audit');

async function registerPlatformLoginRoutes(app, options) {
  app.addHook('onClose', async () => sessions.closeAllSessions());
  app.post('/api/platform-login', async (request) => {
    const session = sessions.startSession(request.user, {
      ...options, method: request.body?.method ?? 'wechat', db: app.db, keys: app.stateKeys, log: app.log,
      audit: auditFromRequest(request, {}),
    });
    return { ok: true, session: sessions.publicSession(session) };
  });
  app.get('/api/platform-login/:id', async (request, reply) => {
    const session = sessions.getSession(request.params.id, request.user.id);
    if (!session) return reply.code(404).send({ ok: false, message: '登录会话不存在' });
    return { ok: true, session: sessions.publicSession(session) };
  });
  app.get('/api/platform-login/:id/qr.png', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const session = sessions.getSession(request.params.id, request.user.id);
    if (!session || session.status !== 'waiting' || !session.qr?.image) {
      return reply.code(404).send({ ok: false, message: '二维码不可用' });
    }
    return reply.type('image/png').send(session.qr.image);
  });
  app.post('/api/platform-login/:id/method', async (request, reply) => {
    const session = await sessions.changeMethod(request.params.id, request.user.id, request.body?.method);
    if (!session) return reply.code(404).send({ ok: false, message: '登录会话不存在' });
    return { ok: true, session: sessions.publicSession(session) };
  });
  app.delete('/api/platform-login/:id', async (request, reply) => {
    if (!await sessions.cancelSession(request.params.id, request.user.id)) {
      return reply.code(404).send({ ok: false, message: '登录会话不存在' });
    }
    return { ok: true };
  });
}

module.exports = { registerPlatformLoginRoutes };

const sessions = require('./sessions');
const { auditFromRequest } = require('@ruyi/shared/runtime/audit');
const { registerVncProxy } = require('./vnc-proxy');

async function registerPlatformLoginRoutes(app, options) {
  registerVncProxy(app, options.displayConfig);
  app.addHook('onClose', async () => sessions.closeAllSessions());
  app.post('/api/platform-login', async (request) => {
    const session = sessions.startSession(request.user, {
      ...options, db: app.db, keys: app.stateKeys, log: app.log,
      audit: auditFromRequest(request, {}),
    });
    return { ok: true, session: sessions.publicSession(session) };
  });
  app.get('/api/platform-login/:id', async (request, reply) => {
    const session = sessions.getSession(request.params.id, request.user.id);
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

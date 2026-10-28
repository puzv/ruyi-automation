const { PHASES } = require('./engine')

// 自动推进的查询与开关。引擎本身不依赖 HTTP，路由只做用户范围的读写。
function registerAutoAdvanceRoutes(app, { engine }) {
  if (!engine) return
  app.get('/api/auto-advance', async (request) => ({
    ok: true,
    ...await engine.describe(request.user.id),
    intervalMs: engine.interval,
  }))
  app.post('/api/auto-advance', async (request, reply) => {
    if (typeof request.body?.enabled !== 'boolean') {
      return reply.code(400).send({ ok: false, message: 'enabled 必须是布尔值' })
    }
    return { ok: true, ...await engine.setEnabled(request.user.id, request.body.enabled), intervalMs: engine.interval }
  })
  // 手动“立即检查”与自动推进共用引擎，避免两套逻辑对同一用户同时启动浏览器。
  app.post('/api/auto-advance/check', async (request) => {
    engine.wake(request.user.id)
    return { ok: true, ...await engine.describe(request.user.id) }
  })
  app.get('/api/auto-advance/phases', async () => ({ ok: true, phases: PHASES }))
}

module.exports = { registerAutoAdvanceRoutes }

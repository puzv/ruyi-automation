const sessions = require('../repos/sessions');
const { COOKIE_NAME, hashToken, publicUser } = require('./session');

async function guard(request, reply) {
  // Fastify 会解码路径后匹配路由，鉴权必须使用同一条路由，避免编码绕过。
  const pathname = request.routeOptions.url || request.url.split('?')[0];
  if (!pathname.startsWith('/api/')) return;
  const route = `${request.method} ${pathname}`;
  if (route === 'GET /api/health' || route === 'POST /api/auth/login') return;
  const token = request.cookies[COOKIE_NAME];
  const session = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
    ? await sessions.findActiveSession(this.db, hashToken(token), { idleMinutes: 480 }) : undefined;
  if (!session) return reply.code(401).send({ ok: false, code: 'UNAUTHENTICATED', message: '请先登录' });
  request.user = publicUser(session.user);
  request.sessionTokenHash = session.id;
  await sessions.touchSession(this.db, session.id);
  if (request.user.mustChangePassword && ![
    'GET /api/auth/me', 'POST /api/auth/change-password', 'POST /api/auth/logout',
  ].includes(route)) {
    return reply.code(403).send({ ok: false, code: 'PASSWORD_CHANGE_REQUIRED', message: '请先修改密码' });
  }
  if (pathname.startsWith('/api/admin/') && request.user.role !== 'admin') {
    return reply.code(403).send({ ok: false, code: 'FORBIDDEN', message: '没有权限' });
  }
}

module.exports = { guard };

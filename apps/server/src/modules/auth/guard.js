const sessions = require('./repository');
const apiTokens = require('../api-tokens/repository');

// 令牌泄露时不能改密码、创建令牌、执行管理操作、进入远程桌面或修改全局运行模式。
const TOKEN_ROUTES = new Set([
  'GET /api/auth/me', 'GET /api/skill/ruyi-audience.zip',
  'GET /api/status', 'GET /api/login-status', 'GET /api/platform-status', 'GET /api/platform-state',
  'POST /api/import-folder', 'POST /api/run/:task',
  'GET /api/jobs', 'GET /api/jobs/active', 'GET /api/jobs/:id',
  'GET /api/jobs/:id/log', 'GET /api/jobs/:id/results', 'GET /api/jobs/:id/results.zip',
  'POST /api/jobs/:id/cancel',
  'GET /api/auto-advance', 'POST /api/auto-advance', 'POST /api/auto-advance/check',
  'GET /api/auto-advance/phases', 'GET /api/logs/mine',
]);
const { COOKIE_NAME, hashToken, publicUser } = require('./session');

async function authenticateSession(db, cookies) {
  const token = cookies[COOKIE_NAME];
  const session = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
    ? await sessions.findActiveSession(db, hashToken(token), { idleMinutes: 480 }) : undefined;
  if (session) await sessions.touchSession(db, session.id);
  return session;
}

async function authenticateBearer(db, authorization) {
  const match = /^Bearer (ruyi_pat_[A-Za-z0-9_-]{43})$/.exec(authorization);
  let credential;
  try {
    credential = match ? await apiTokens.findActiveByHash(db, hashToken(match[1])) : undefined;
    if (credential) await apiTokens.touch(db, credential.id);
  } catch (_) {
    // 数据库异常可能含查询参数，不能将凭据哈希交给通用日志处理器。
    throw new Error('验证令牌失败，请稍后重试');
  }
  return credential;
}

async function guard(request, reply) {
  // Fastify 会解码路径后匹配路由，鉴权必须使用同一条路由，避免编码绕过。
  // 未匹配路由没有 routeOptions.url，必须跳过鉴权，让 Fastify 统一返回 404。
  if (!request.routeOptions || !request.routeOptions.url) return;
  const pathname = request.routeOptions.url;
  if (!pathname.startsWith('/api/')) return;
  const route = `${request.method} ${pathname}`;
  if (route === 'POST /api/transfer/upload/:ticket' || route === 'GET /api/transfer/download/:ticket') return;
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    const credential = await authenticateBearer(this.db, authorization);
    if (!credential) return reply.code(401).send({ ok: false, code: 'UNAUTHENTICATED', message: '令牌无效或已过期' });
    request.user = publicUser(credential.user);
    request.authMethod = 'token';
    request.apiTokenId = credential.id;
    if (request.user.mustChangePassword) {
      return reply.code(403).send({ ok: false, code: 'PASSWORD_CHANGE_REQUIRED', message: '请先修改密码' });
    }
    // /api/* 兜底路由只返回 404，放行后令牌能区分“接口不存在”与“无权访问”。
    if (pathname !== '/api/*' && !TOKEN_ROUTES.has(route)) {
      return reply.code(403).send({ ok: false, code: 'TOKEN_FORBIDDEN', message: 'API 令牌无权访问该接口' });
    }
    return;
  }
  if (route === 'GET /api/health' || route === 'POST /api/auth/login' || route === 'POST /api/auth/register') return;
  const session = await authenticateSession(this.db, request.cookies);
  if (!session) return reply.code(401).send({ ok: false, code: 'UNAUTHENTICATED', message: '请先登录' });
  request.user = publicUser(session.user);
  request.sessionTokenHash = session.id;
  request.authMethod = 'session';
  if (request.user.mustChangePassword && ![
    'GET /api/auth/me', 'POST /api/auth/change-password', 'POST /api/auth/logout',
  ].includes(route)) {
    return reply.code(403).send({ ok: false, code: 'PASSWORD_CHANGE_REQUIRED', message: '请先修改密码' });
  }
  if (pathname.startsWith('/api/admin/') && request.user.role !== 'admin') {
    return reply.code(403).send({ ok: false, code: 'FORBIDDEN', message: '没有权限' });
  }
}

module.exports = { guard, authenticateSession, authenticateBearer };

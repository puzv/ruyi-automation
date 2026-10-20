const { writeLog, auditFromRequest } = require('./audit');

// 仅为列出的业务动作构造白名单字段，绝不把请求正文整体写入记录。
async function auditResponse(request, reply, payload) {
  if (!this.auditEnabled || request.method !== 'POST') return payload;
  const route = request.routeOptions.url;
  let response;
  try { response = JSON.parse(payload); } catch (_) { return payload; }
  const success = reply.statusCode < 400 && response.ok === true;
  const entry = { result: success ? 'success' : 'failure' };
  if (!success) entry.errorMessage = reply.statusCode >= 500 ? '操作失败，请查看服务日志' : response.message;
  switch (route) {
    case '/api/auth/login':
      entry.action = 'auth.login';
      entry.username = typeof request.body?.username === 'string' ? request.body.username.slice(0, 32) : null;
      entry.userId = request.auditUserId ?? null;
      if (!success) entry.detail = { reason: request.auditReason || 'invalid_request' };
      break;
    case '/api/auth/logout': entry.action = 'auth.logout'; break;
    case '/api/auth/change-password':
      entry.action = 'auth.password_change';
      if (!success) entry.detail = { reason: request.auditReason || 'invalid_request' };
      break;
    case '/api/admin/users':
      entry.action = 'admin.user_create';
      entry.targetType = 'user';
      entry.targetId = typeof request.body?.username === 'string' ? request.body.username : null;
      entry.detail = { role: typeof request.body?.role === 'string' ? request.body.role : null };
      break;
    case '/api/admin/users/:id/disable':
    case '/api/admin/users/:id/enable':
    case '/api/admin/users/:id/reset-password':
      entry.action = { disable: 'admin.user_disable', enable: 'admin.user_enable', 'reset-password': 'admin.password_reset' }[route.split('/').pop()];
      entry.targetType = 'user'; entry.targetId = request.auditTargetUsername ?? null;
      break;
    case '/api/import-folder':
      entry.action = 'file.import'; entry.targetType = 'file_batch';
      entry.detail = request.auditImport || { count: 0, skipped: 0, files: [] };
      break;
    case '/api/run/:task':
      entry.action = 'job.start'; entry.targetType = 'job'; entry.targetId = response.id;
      entry.detail = { task: request.params.task, ...(!success ? { reason: response.message } : {}) };
      break;
    case '/api/platform-state/clear': entry.action = 'platform.logout'; break;
    case '/api/runtime-mode':
      if (!success) return payload;
      entry.action = 'runtime.mode_change'; entry.detail = { headless: response.headless }; break;
    default: return payload;
  }
  await writeLog(this.db, auditFromRequest(request, entry), this.log);
  return payload;
}

module.exports = { auditResponse };

const { writeLog, auditFromRequest } = require('@ruyi/shared/runtime/audit');

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
    case '/api/auth/register':
      entry.action = 'auth.register';
      entry.username = typeof request.body?.username === 'string' ? request.body.username.slice(0, 32) : null;
      entry.userId = success ? request.auditUserId : null;
      break;
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
    case '/api/api-tokens':
      entry.action = 'token.create'; entry.targetType = 'api_token';
      entry.targetId = response.item?.id;
      entry.detail = { name: typeof request.body?.name === 'string' ? request.body.name.trim().slice(0, 64) : null, expiresInDays: [30, 90, 365].includes(request.body?.expiresInDays) ? request.body.expiresInDays : null };
      break;
    case '/api/api-tokens/:id/revoke':
      entry.action = 'token.revoke'; entry.targetType = 'api_token'; entry.targetId = request.params.id;
      break;
    case '/api/transfer/upload/:ticket':
      if (!request.user) return payload;
    case '/api/import-folder':
      entry.action = 'file.import'; entry.targetType = 'file_batch';
      entry.detail = { ...(request.auditImport || { count: 0, skipped: 0, files: [] }),
        ...(route === '/api/transfer/upload/:ticket' ? { via: 'transfer_ticket' } : {}) };
      if (!success && route === '/api/transfer/upload/:ticket') entry.errorMessage = '文件导入失败，请重新获取链接';
      break;
    case '/api/run/:task':
      entry.action = 'job.start'; entry.targetType = 'job'; entry.targetId = response.id;
      entry.detail = { task: request.params.task, ...(response.status === 'queued' ? { queued: true } : {}), ...(!success ? { reason: response.message } : {}) };
      break;
    case '/api/jobs/:id/cancel':
      entry.action = 'job.cancel'; entry.targetType = 'job'; entry.targetId = request.params.id;
      entry.detail = success ? { result: response.result } : undefined;
      break;
    case '/api/platform-state/clear': entry.action = 'platform.logout'; break;
    default: return payload;
  }
  await writeLog(this.db, auditFromRequest(request, entry), this.log);
  return payload;
}

module.exports = { auditResponse };

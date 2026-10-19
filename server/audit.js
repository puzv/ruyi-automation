const { randomUUID } = require('crypto');

function sanitizeDetail(value, ancestors = new WeakSet()) {
  if (typeof value === 'string') return value.slice(0, 500);
  if (value === null || typeof value !== 'object') return value;
  // 环状结构不能序列化，保留其余可用的记录内容。
  if (ancestors.has(value)) return null;
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.slice(0, 100).map((item) => sanitizeDetail(item, ancestors));
  } else {
    result = Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/password|token|cookie|secret|state/i.test(key))
      .map(([key, item]) => [key, sanitizeDetail(item, ancestors)]));
  }
  ancestors.delete(value);
  return result;
}

function truncate(value, length) {
  return value == null ? null : String(value).slice(0, length);
}

async function writeLog(db, entry, log) {
  if (!db) return;
  try {
    await db.insertInto('ruyi_operation_logs').values({
      user_id: entry.userId ?? null,
      username: truncate(entry.username, 32),
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: truncate(entry.targetId, 255),
      result: entry.result,
      error_message: truncate(entry.errorMessage, 1000),
      detail: entry.detail == null ? null : JSON.stringify(sanitizeDetail(entry.detail)),
      ip: entry.ip ?? null,
      user_agent: truncate(entry.userAgent, 255),
      request_id: entry.requestId ?? null,
    }).execute();
  } catch (error) {
    log?.error({ err: error }, '写入操作记录失败');
  }
}

function auditFromRequest(request, entry) {
  if (!request.auditRequestId) request.auditRequestId = randomUUID();
  return {
    userId: request.user?.id ?? null,
    username: request.user?.username ?? null,
    ...entry,
    ip: request.ip,
    userAgent: request.headers?.['user-agent'],
    requestId: entry.requestId ?? request.auditRequestId,
  };
}

module.exports = { writeLog, sanitizeDetail, auditFromRequest };

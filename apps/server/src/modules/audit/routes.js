const { writeLog, auditFromRequest } = require('@ruyi/shared/runtime/audit');

function pagination(query) {
  const parse = (value, fallback) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  };
  const page = parse(query.page, 1);
  const size = parse(query.pageSize, 20);
  if (page === null || size === null) return null;
  const pageSize = Math.min(size, 100);
  if (!Number.isSafeInteger((page - 1) * pageSize)) return null;
  return { page, pageSize };
}

function dateBound(value, nextDay = false) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  if (nextDay) date.setUTCDate(date.getUTCDate() + 1);
  // 库内 DATETIME 保存北京时间，直接比较当地日期边界，避免受进程时区影响。
  return `${date.toISOString().slice(0, 10)} 00:00:00`;
}

function publicLog(row, admin) {
  let detail = row.detail;
  if (typeof detail === 'string') {
    try { detail = JSON.parse(detail); } catch { detail = null; }
  }
  const result = {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    result: row.result,
    errorMessage: row.error_message,
    detail: detail ?? null,
    ip: row.ip,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
  if (admin) result.userAgent = row.user_agent;
  return result;
}

async function listLogs(db, query, paging, admin, userId) {
  let filtered = db.selectFrom('ruyi_operation_logs');
  if (!admin) filtered = filtered.where('user_id', '=', userId);
  if (query.action) filtered = filtered.where('action', '=', query.action);
  if (admin) {
    if (query.username) filtered = filtered.where('username', '=', query.username);
    if (query.result) filtered = filtered.where('result', '=', query.result);
    if (query.from) filtered = filtered.where('created_at', '>=', dateBound(query.from));
    if (query.to) filtered = filtered.where('created_at', '<', dateBound(query.to, true));
  }
  const count = await filtered.select(({ fn }) => fn.countAll().as('total')).executeTakeFirst();
  const rows = await filtered.selectAll().orderBy('id', 'desc')
    .limit(paging.pageSize).offset((paging.page - 1) * paging.pageSize).execute();
  return { ok: true, items: rows.map((row) => publicLog(row, admin)), total: Number(count.total), ...paging };
}

async function registerLogsRoutes(app) {
  app.get('/api/logs/mine', async (request, reply) => {
    const paging = pagination(request.query);
    if (!paging) return reply.code(400).send({ ok: false, message: '分页参数必须为正整数' });
    return listLogs(app.db, request.query, paging, false, request.user.id);
  });

  app.get('/api/admin/logs', async (request, reply) => {
    const query = request.query;
    const paging = pagination(query);
    if (!paging) return reply.code(400).send({ ok: false, message: '分页参数必须为正整数' });
    if ((query.from !== undefined && !dateBound(query.from)) || (query.to !== undefined && !dateBound(query.to))) {
      return reply.code(400).send({ ok: false, message: '日期格式必须为有效的 YYYY-MM-DD' });
    }
    if (query.from && query.to && query.from > query.to) {
      return reply.code(400).send({ ok: false, message: '开始日期不能晚于结束日期' });
    }
    if (query.result && !['success', 'failure'].includes(query.result)) {
      return reply.code(400).send({ ok: false, message: '操作结果必须为 success 或 failure' });
    }
    const result = await listLogs(app.db, query, paging, true);
    if (paging.page === 1) {
      const detail = { ...paging };
      for (const key of ['username', 'action', 'result', 'from', 'to']) {
        if (query[key]) detail[key] = query[key];
      }
      await writeLog(app.db, auditFromRequest(request, {
        action: 'admin.logs_view', targetType: 'user', targetId: query.username || null,
        result: 'success', detail,
      }), app.log);
    }
    return result;
  });
}

module.exports = { registerLogsRoutes };

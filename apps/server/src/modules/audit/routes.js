const { writeLog, auditFromRequest } = require('@ruyi/shared/runtime/audit');
const { isWaitingPlatform, isWaitingLogin } = require('@ruyi/shared/runtime/task-job-presentation');

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

function filteredLogs(db, query, admin, userId) {
  let filtered = db.selectFrom('ruyi_operation_logs');
  if (!admin) filtered = filtered.where('user_id', '=', userId);
  if (admin) {
    if (query.username) filtered = filtered.where('username', '=', query.username);
    if (query.from) filtered = filtered.where('created_at', '>=', dateBound(query.from));
    if (query.to) filtered = filtered.where('created_at', '<', dateBound(query.to, true));
  }
  return filtered;
}

async function presentRows(db, rows, admin, userId) {
  const items = rows.map((row) => publicLog(row, admin));
  const jobIds = [...new Set(items.filter((item) => item.action === 'job.finish' && item.targetType === 'job' && item.targetId)
    .map((item) => item.targetId))];
  if (jobIds.length) {
    // 分批关联历史检查的业务状态，不改写只追加的审计事实。
    let associated = db.selectFrom('ruyi_jobs').select(['id', 'user_id', 'task_id', 'task', 'status', 'exit_code',
      'exit_signal', 'state_expired', 'error_message']).where('id', 'in', jobIds);
    if (!admin) associated = associated.where('user_id', '=', userId);
    const jobs = await associated.execute();
    const byId = new Map(jobs.map((job) => [job.id, job]));
    for (const item of items) {
      if (item.action !== 'job.finish' || item.targetType !== 'job') continue;
      const job = byId.get(item.targetId);
      if (!job?.task_id || item.userId == null || String(job.user_id) !== String(item.userId)) continue;
      const facts = { taskId: job.task_id, status: job.status, exitCode: job.exit_code,
        exitSignal: job.exit_signal, stateExpired: job.state_expired, errorMessage: job.error_message };
      const waiting = isWaitingPlatform(facts), login = isWaitingLogin(facts);
      const detail = item.detail && typeof item.detail === 'object' && !Array.isArray(item.detail) ? item.detail : {};
      item.detail = { ...detail, taskId: job.task_id, task: job.task,
        stateExpired: Boolean(job.state_expired), loginRequired: login };
      if (waiting || login) {
        Object.assign(item.detail, { status: login ? 'waiting_login' : 'waiting_platform',
          outcome: login ? 'login_required' : 'not_ready', code: job.exit_code ?? null, signal: job.exit_signal ?? null });
        item.errorMessage = null;
      }
    }
  }
  return items;
}

function waitKey(item) {
  const d = item.detail || {};
  if (item.action !== 'job.finish' || !d.taskId || !d.task || item.userId == null) return null;
  const kind = d.status === 'waiting_platform' && d.outcome === 'not_ready' && d.code === 2
    && !d.signal && !d.stateExpired ? 'platform'
    : d.status === 'waiting_login' && d.outcome === 'login_required' && !d.signal ? 'login' : null;
  return kind ? JSON.stringify([String(item.userId), d.taskId, d.task, kind]) : null;
}

// 全量事实按主键分批扫描，内存只保留一个组、当前展示页及一页原始明细。
// 统计展示总数需要扫描匹配范围；不使用 MySQL 8 窗口函数或把全量日志装入内存。
async function listLogs(db, query, paging, admin, userId) {
  const filtered = filteredLogs(db, query, admin, userId);
  let cursor = null, snapshot = query.snapshot || null, group = null;
  let total = 0, rawTotal = 0, detailTotal = 0;
  const items = [], details = [];
  const offset = (paging.page - 1) * paging.pageSize;
  const visible = (item) => (!query.action || item.action === query.action)
    && (!admin || !query.result || item.result === query.result);
  const flush = () => {
    if (!group || !group.visible) return;
    if (query.groupId && String(group.item.id) === query.groupId) detailTotal = group.count;
    if (total >= offset && items.length < paging.pageSize) items.push({ ...group.item,
      waitGroup: { count: group.count, first: group.firstTime, last: group.lastTime } });
    total++;
  };
  while (true) {
    let batch = filtered.selectAll().orderBy('id', 'desc').limit(200);
    if (snapshot) batch = batch.where('id', '<=', snapshot);
    if (cursor !== null) batch = batch.where('id', '<', cursor);
    const rows = await batch.execute();
    if (!rows.length) break;
    if (!snapshot) snapshot = String(rows[0].id);
    const presented = await presentRows(db, rows, admin, userId);
    for (const item of presented) {
      const key = waitKey(item);
      if (!key || key !== group?.key || visible(item) !== group.visible) {
        flush();
        group = { item, key, count: 0, firstTime: item.createdAt, lastTime: item.createdAt, visible: visible(item) };
      }
      group.count++;
      if (new Date(item.createdAt) < new Date(group.firstTime)) group.firstTime = item.createdAt;
      if (new Date(item.createdAt) > new Date(group.lastTime)) group.lastTime = item.createdAt;
      if (visible(item)) rawTotal++;
      if (query.groupId && String(group.item.id) === query.groupId && group.visible
        && group.count > offset && details.length < paging.pageSize) details.push(item);
    }
    cursor = rows.at(-1).id;
    if (rows.length < 200) break;
  }
  flush();
  if (query.groupId) return { ok: true, items: details, total: detailTotal, snapshot, ...paging };
  return { ok: true, items, total, rawTotal, snapshot, grouped: true, ...paging };
}

function validAnchors(query) {
  return ['snapshot', 'groupId'].every((key) => query[key] === undefined
    || (typeof query[key] === 'string' && /^[1-9]\d{0,19}$/.test(query[key])));
}

async function registerLogsRoutes(app) {
  app.get('/api/logs/mine', async (request, reply) => {
    const paging = pagination(request.query);
    if (!paging || !validAnchors(request.query)) return reply.code(400).send({ ok: false, message: '分页参数必须为正整数' });
    return listLogs(app.db, request.query, paging, false, request.user.id);
  });

  app.get('/api/admin/logs', async (request, reply) => {
    const query = request.query;
    const paging = pagination(query);
    if (!paging || !validAnchors(query)) return reply.code(400).send({ ok: false, message: '分页参数必须为正整数' });
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
    if (paging.page === 1 && !query.groupId) {
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

module.exports = { registerLogsRoutes, listLogs, waitKey };

const tasks = require('@ruyi/shared/runtime/repos/tasks');
const { UUID } = require('@ruyi/shared/runtime/task-workspace');
const { createFromMultipart, taskName } = require('./import');
const { isWaitingPlatform, isWaitingLogin } = require('@ruyi/shared/runtime/task-job-presentation');

function pagination(query) {
  const parse = (value, fallback) => value === undefined ? fallback
    : typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const page = parse(query.page, 1), size = parse(query.pageSize, 20), pageSize = Math.min(size, 100);
  return page && size && Number.isSafeInteger((page - 1) * pageSize) ? { page, pageSize } : null;
}

function publicTask(row) {
  return { id: row.id, name: row.name, status: row.status, currentStep: row.current_step,
    version: row.version, queueOrder: row.queue_order == null ? null : Number(row.queue_order), createdAt: row.created_at, queuedAt: row.queued_at, startedAt: row.started_at,
    finishedAt: row.finished_at, waitingLoginAt: row.waiting_login_at, nextCheckAt: row.next_check_at,
    canResume: row.status === 'waiting_login', cancelRequested: row.status === 'running' && Boolean(row.cancel_requested), errorMessage: row.error_message };
}

function publicFile(row) {
  return { id: row.id, sequence: row.sequence, originalName: row.original_name, fileType: row.file_type,
    sizeBytes: Number(row.size_bytes), stage: row.stage, excludedAt: row.excluded_at, version: row.version,
    createdAt: row.created_at, platformName: row.platform_name, errorMessage: row.error_message };
}

function publicTaskJob(job) {
  const classification = { taskId: job.task_id, status: job.status, exitCode: job.exit_code,
    exitSignal: job.exit_signal, stateExpired: job.state_expired, errorMessage: job.error_message };
  const waiting = isWaitingPlatform(classification), login = isWaitingLogin(classification);
  return { id: job.id, taskId: job.task_id, task: job.task, status: login ? 'waiting_login' : waiting ? 'waiting_platform' : job.status,
    queuedAt: job.queued_at, startedAt: job.started_at, finishedAt: job.finished_at,
    exitCode: job.exit_code ?? null, exitSignal: job.exit_signal ?? null,
    errorMessage: waiting || login ? null : job.error_message,
    ...(waiting ? { outcome: 'not_ready', message: '本轮检查时平台尚未处理完成' } : {}),
    ...(login ? { outcome: 'login_required', message: '等待重新登录平台并恢复任务' } : {}) };
}

function safeError(reply, error) {
  if (error.statusCode === 409 && error.code === 'PLATFORM_LOGIN_REQUIRED') {
    return reply.code(409).send({ ok: false, code: error.code, message: error.message });
  }
  if (error.taskInput) return reply.code(400).send({ ok: false, message: error.message });
  if (/^FST_(?:REQ_FILE_TOO_LARGE|FILES_LIMIT|FIELDS_LIMIT|PARTS_LIMIT|INVALID_MULTIPART_CONTENT_TYPE)$/.test(error.code || '')) {
    return reply.code(413).send({ ok: false, message: '文件接收超过限制，请减少文件数量或大小后重试' });
  }
  if (error.message === 'Unexpected end of form' || error.message === 'Unexpected end of file') {
    return reply.code(400).send({ ok: false, message: '文件接收不完整，请重新选择文件' });
  }
  return reply.code(500).send({ ok: false, message: '任务操作失败，请联系管理员；请勿重复提交' });
}

async function registerTaskRoutes(api, { dataRoot, canImportFiles }) {
  const handle = (fn) => async (req, reply) => { try { return await fn(req, reply); } catch (error) { return safeError(reply, error); } };
  const notFound = (reply) => reply.code(404).send({ ok: false, message: '任务不存在' });
  const own = (req) => UUID.test(req.params.id) ? tasks.getTaskForUser(api.db, req.params.id, req.user.id) : null;
  api.post('/api/tasks', handle(async (req, reply) => {
    const item = await createFromMultipart(req, { db: api.db, root: dataRoot, canImportFiles });
    api.worker?.wake();
    return reply.code(201).send({ ok: true, item, message: '任务已创建并加入执行队列' });
  }));
  api.get('/api/tasks', handle(async (req, reply) => {
    const paging = pagination(req.query);
    if (!paging) return reply.code(400).send({ ok: false, message: '分页参数必须为正整数' });
    const result = await tasks.listTasks(api.db, { userId: req.user.id, ...paging });
    return { ok: true, ...result, items: result.items.map(publicTask), ...paging };
  }));
  api.get('/api/tasks/:id', handle(async (req, reply) => {
    const row = await own(req);
    if (!row) return notFound(reply);
    const jobs = await tasks.listTaskJobs(api.db, row.id, req.user.id);
    return { ok: true, item: publicTask(row), jobs: jobs.map(publicTaskJob) };
  }));
  api.get('/api/tasks/:id/files', handle(async (req, reply) => {
    const row = await own(req);
    if (!row) return notFound(reply);
    return { ok: true, items: (await tasks.listTaskFiles(api.db, row.id, req.user.id)).map(publicFile) };
  }));
  api.get('/api/admin/tasks', handle(async (req, reply) => {
    const paging = pagination(req.query);
    if (!paging) return reply.code(400).send({ ok: false, message: '分页参数必须为正整数' });
    if (req.query.status && !['queued', 'running', 'waiting_login', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(req.query.status)) {
      return reply.code(400).send({ ok: false, message: '任务状态无效' });
    }
    const result = await tasks.listTasksAdmin(api.db, { ...paging, username: req.query.username, status: req.query.status });
    return { ok: true, ...result, items: result.items.map((row) => ({ ...publicTask(row), username: row.username })), ...paging };
  }));
  api.get('/api/admin/tasks/:id', handle(async (req, reply) => {
    const row = await tasks.getTaskAdmin(api.db, req.params.id);
    if (!row) return notFound(reply);
    const jobs = await tasks.listTaskJobsAdmin(api.db, row.id);
    return { ok: true, item: { ...publicTask(row), username: row.username }, jobs: jobs.map(publicTaskJob) };
  }));
  api.get('/api/admin/tasks/:id/files', handle(async (req, reply) => {
    const row = await tasks.getTaskAdmin(api.db, req.params.id);
    if (!row) return notFound(reply);
    return { ok: true, items: (await tasks.listTaskFilesAdmin(api.db, row.id)).map(publicFile) };
  }));
  api.delete('/api/tasks/:id/files/:fileId', handle(async (req, reply) => {
    const row = await own(req);
    if (!row) return notFound(reply);
    const version = req.body?.version ?? req.query?.version;
    if (version !== undefined && (!/^\d+$/.test(String(version)) || Number(version) < 1)) {
      return reply.code(400).send({ ok: false, message: '任务版本必须为正整数' });
    }
    const result = await tasks.excludeTaskFile(api.db, { taskId: row.id, fileId: req.params.fileId, userId: req.user.id, version: version === undefined ? row.version : Number(version) });
    if (!result.ok) {
      if (result.reason === 'not_found') return notFound(reply);
      if (result.reason === 'task_started') return reply.code(409).send({ ok: false, code: 'TASK_ALREADY_STARTED', message: '任务已开始，无法删除文件' });
      return reply.code(409).send({ ok: false, code: 'TASK_VERSION_CONFLICT', message: '任务已被更新，请刷新后重试' });
    }
    req.auditTask = { id: row.id, fileId: req.params.fileId, excluded: true };
    return { ok: true, status: result.last ? 'cancelled' : 'updated', version: Number(result.task.version) };
  }));
  api.delete('/api/tasks/:id', handle(async (req, reply) => {
    const row = await own(req);
    if (!row) return notFound(reply);
    const version = req.body?.version ?? req.query?.version;
    if (version !== undefined && (!/^\d+$/.test(String(version)) || Number(version) < 1)) return reply.code(400).send({ ok: false, message: '任务版本必须为正整数' });
    const result = await tasks.deleteTask(api.db, { id: row.id, userId: req.user.id, version: version === undefined ? row.version : Number(version) });
    if (!result.ok) {
      if (result.reason === 'not_found') return notFound(reply);
      return reply.code(409).send({ ok: false, code: result.reason === 'version' ? 'TASK_VERSION_CONFLICT' : 'TASK_DELETE_CONFLICT', message: '任务已被更新，请刷新后重试' });
    }
    req.auditTask = { id: row.id, status: result.status };
    return { ok: true, status: result.status, version: Number(row.version) + 1 };
  }));
  api.patch('/api/tasks/:id/name', handle(async (req, reply) => {
    const row = await own(req);
    if (!row) return notFound(reply);
    let name;
    try { name = taskName(req.body?.name, row.id); } catch (error) { return reply.code(400).send({ ok: false, message: error.message }); }
    const version = req.body?.version;
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) return reply.code(400).send({ ok: false, message: '任务版本必须为正整数' });
    const expectedVersion = version ?? row.version;
    if (!await tasks.renameTask(api.db, { id: row.id, userId: req.user.id, name, version: expectedVersion })) {
      return reply.code(409).send({ ok: false, message: '任务已被更新，请刷新后重试' });
    }
    req.auditTask = { id: row.id, name };
    return { ok: true, id: row.id, name, version: expectedVersion + 1 };
  }));
  api.post('/api/tasks/:id/stop', handle(async (req, reply) => {
    const row = await own(req);
    if (!row) return notFound(reply);
    const version = req.body?.version;
    if (!Number.isSafeInteger(version) || version < 1) return reply.code(400).send({ ok: false, message: '任务版本必须为正整数' });
    if (!await tasks.requestStopTask(api.db, { id: row.id, userId: req.user.id, version })) {
      return reply.code(409).send({ ok: false, code: 'TASK_STOP_CONFLICT', message: '任务状态已变化，请刷新后重试' });
    }
    req.auditTask = { id: row.id, status: 'cancelling' };
    return { ok: true, status: 'cancelling', message: '正在停止任务，停止后将标记为已中断，可继续任务' };
  }));
  api.post('/api/tasks/:id/continue', handle(async (req, reply) => {
    const row = await own(req);
    if (!row) return notFound(reply);
    const version = req.body?.version;
    if (!Number.isSafeInteger(version) || version < 1) return reply.code(400).send({ ok: false, message: '任务版本必须为正整数' });
    if (row.status !== 'interrupted') return reply.code(409).send({ ok: false, code: 'TASK_NOT_INTERRUPTED', message: '仅已中断的任务可以继续，请刷新后重试' });
    if (!canImportFiles || !await canImportFiles(req)) {
      return reply.code(409).send({ ok: false, code: 'PLATFORM_LOGIN_REQUIRED', message: '请先完成平台登录，再继续任务' });
    }
    const result = await tasks.continueInterruptedTask(api.db, { id: row.id, userId: req.user.id, version });
    if (!result.ok) {
      if (result.reason === 'not_found') return notFound(reply);
      return reply.code(409).send({ ok: false, code: 'TASK_CONTINUE_CONFLICT', message: result.reason === 'active_job'
        ? '原任务流程仍在执行，请稍后刷新重试' : '任务状态已变化，请刷新后重试' });
    }
    if (result.status === 'queued') api.worker?.wake();
    req.auditTask = { id: row.id, status: result.status, currentStep: result.currentStep };
    return { ...result, message: result.status === 'succeeded' ? '所有流程已完成，任务已恢复为成功' : '任务已从未完成步骤重新入队，请等待执行' };
  }));
  api.post('/api/tasks/:id/resume', handle(async (req, reply) => {
    const row = await own(req);
    if (!row) return notFound(reply);
    if (row.status !== 'waiting_login') {
      return reply.code(409).send({ ok: false, code: 'TASK_NOT_WAITING_LOGIN', message: '任务当前不在等待登录状态' });
    }
    if (!canImportFiles || !await canImportFiles(req)) {
      return reply.code(409).send({ ok: false, code: 'PLATFORM_LOGIN_REQUIRED', message: '请先完成平台登录，再恢复任务' });
    }
    const count = await tasks.resumeUserWaitingLogin(api.db, { userId: req.user.id });
    api.worker?.wake();
    req.auditTask = { id: row.id, resumed: count };
    return { ok: true, resumed: count, message: '任务已重新入队，请等待执行' };
  }));
}

module.exports = { registerTaskRoutes, pagination, publicTask, publicFile, safeError };

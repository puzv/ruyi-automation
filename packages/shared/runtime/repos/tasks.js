const { sql } = require('kysely');

async function createTask(db, { id, userId, name, files }) {
  return db.transaction().execute(async (trx) => {
    await trx.insertInto('ruyi_tasks').values({ id, user_id: userId, name, status: 'queued', current_step: 'upload' }).execute();
    await trx.insertInto('ruyi_task_files').values(files.map((file) => ({
      id: file.id, task_id: id, user_id: userId, sequence: file.sequence,
      original_name: file.originalName, original_name_key: Buffer.from(file.originalName, 'utf8'),
      file_type: file.fileType, size_bytes: file.sizeBytes, content_sha256: file.sha256,
      original_path: file.relative, current_path: file.relative, stage: 'pending',
    }))).execute();
  });
}

function getTaskForUser(db, id, userId) {
  return db.selectFrom('ruyi_tasks').selectAll().where('id', '=', id).where('user_id', '=', userId)
    .where('deleted_at', 'is', null).executeTakeFirst();
}

async function listTasks(db, { userId, page, pageSize }) {
  const query = db.selectFrom('ruyi_tasks').where('user_id', '=', userId).where('deleted_at', 'is', null);
  const count = await query.select((eb) => eb.fn.countAll().as('total')).executeTakeFirstOrThrow();
  const items = await query.selectAll().orderBy('created_at', 'desc').orderBy('id', 'desc')
    .limit(pageSize).offset((page - 1) * pageSize).execute();
  return { items, total: Number(count.total) };
}

function listTaskFiles(db, id, userId) {
  return db.selectFrom('ruyi_task_files').selectAll().where('task_id', '=', id).where('user_id', '=', userId)
    .orderBy('sequence').execute();
}

function listTaskJobs(db, id, userId) {
  return db.selectFrom('ruyi_jobs').selectAll().where('task_id', '=', id).where('user_id', '=', userId)
    .orderBy('queued_at').orderBy('id').execute();
}

function listTasksAdmin(db, { page, pageSize, username, status }) {
  let query = db.selectFrom('ruyi_tasks as t').innerJoin('ruyi_users as u', 'u.id', 't.user_id')
    .where('t.deleted_at', 'is', null);
  if (username) query = query.where('u.username', '=', username);
  if (status) query = query.where('t.status', '=', status);
  return Promise.all([
    query.select(({ fn }) => fn.countAll().as('total')).executeTakeFirstOrThrow(),
    query.selectAll('t').select('u.username').orderBy('t.created_at', 'desc').orderBy('t.id', 'desc')
      .limit(pageSize).offset((page - 1) * pageSize).execute(),
  ]).then(([count, items]) => ({ items, total: Number(count.total) }));
}

function getTaskAdmin(db, id) {
  return db.selectFrom('ruyi_tasks as t').innerJoin('ruyi_users as u', 'u.id', 't.user_id')
    .selectAll('t').select('u.username').where('t.id', '=', id).where('t.deleted_at', 'is', null).executeTakeFirst();
}

function listTaskFilesAdmin(db, id) {
  return db.selectFrom('ruyi_task_files').selectAll().where('task_id', '=', id).orderBy('sequence').execute();
}

function listTaskJobsAdmin(db, id) {
  return db.selectFrom('ruyi_jobs').selectAll().where('task_id', '=', id).orderBy('queued_at').orderBy('id').execute();
}

async function claimNextTask(db, { workerId, claimToken, maxConcurrent = 2 }) {
  return db.connection().execute(async (conn) => {
    const lock = await sql`SELECT GET_LOCK('ruyi_job_claim', 5) AS acquired`.execute(conn);
    if (Number(lock.rows[0].acquired) !== 1) return null;
    try {
      const active = await conn.selectFrom('ruyi_tasks').select(({ fn }) => fn.countAll().as('n')).where('status', '=', 'running').where('deleted_at', 'is', null).executeTakeFirstOrThrow();
      const legacy = await conn.selectFrom('ruyi_jobs').select(({ fn }) => fn.countAll().as('n')).where('status', '=', 'running').where('task_id', 'is', null).executeTakeFirstOrThrow();
      if (Number(active.n) + Number(legacy.n) >= maxConcurrent) return null;
      const candidate = await conn.selectFrom('ruyi_tasks as t').select('t.id')
        .where('t.status', '=', 'queued').where('t.deleted_at', 'is', null).where('t.cancel_requested', '=', 0)
        .where(({ not, exists, selectFrom }) => not(exists(selectFrom('ruyi_tasks as r').select('r.id')
          .whereRef('r.user_id', '=', 't.user_id').where('r.deleted_at', 'is', null).where('r.status', 'in', ['running', 'waiting_login']))))
        .where(({ not, exists, selectFrom }) => not(exists(selectFrom('ruyi_jobs as j').select('j.id')
          .whereRef('j.user_id', '=', 't.user_id').where('j.task_id', 'is', null).where('j.status', 'in', ['running', 'queued']))))
        .orderBy('t.queued_at').orderBy('t.queue_order').executeTakeFirst();
      if (!candidate) return null;
      const result = await conn.updateTable('ruyi_tasks').set({ status: 'running', claim_token: claimToken,
        worker_id: workerId, started_at: sql`COALESCE(started_at, NOW(3))`, heartbeat_at: sql`NOW(3)`, version: sql`version + 1` })
        .where('id', '=', candidate.id).where('status', '=', 'queued').where('deleted_at', 'is', null).where('cancel_requested', '=', 0).executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) return null;
      return conn.selectFrom('ruyi_tasks as t').innerJoin('ruyi_users as u', 'u.id', 't.user_id')
        .selectAll('t').select('u.username').where('t.id', '=', candidate.id).executeTakeFirst();
    } finally { await sql`SELECT RELEASE_LOCK('ruyi_job_claim')`.execute(conn); }
  });
}

async function requestStopTask(db, { id, userId, version }) {
  let query = db.updateTable('ruyi_tasks').set({ cancel_requested: 1, version: sql`version + 1` })
    .where('id', '=', id).where('user_id', '=', userId).where('deleted_at', 'is', null)
    .where('status', '=', 'running').where('cancel_requested', '=', 0);
  if (version !== undefined) query = query.where('version', '=', version);
  const result = await query.executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

async function requestCancelTask(db, { id, userId }) {
  const q = await db.updateTable('ruyi_tasks').set({ status: 'cancelled', finished_at: sql`NOW(3)` }).where('id', '=', id).where('user_id', '=', userId).where('status', '=', 'queued').executeTakeFirst();
  if (Number(q.numUpdatedRows) === 1) return 'cancelled';
  const r = await db.updateTable('ruyi_tasks').set({ cancel_requested: 1 }).where('id', '=', id).where('user_id', '=', userId).where('status', '=', 'running').executeTakeFirst();
  return Number(r.numUpdatedRows) === 1 ? 'cancelling' : null;
}

async function updateTaskStep(db, { id, claimToken, currentStep, status = 'running' }) {
  const result = await db.updateTable('ruyi_tasks').set({ current_step: currentStep, status,
    heartbeat_at: sql`NOW(3)`, next_check_at: null, version: sql`version + 1` }).where('id', '=', id)
    .where('claim_token', '=', claimToken).where('status', 'in', ['running', 'waiting_login']).where('cancel_requested', '=', 0).executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

async function finishTask(db, { id, claimToken, status, errorMessage }) {
  // 停止请求可能在读取执行结果之后到达，终态必须在同一次 UPDATE 中服从已接受的停止。
  const result = await db.updateTable('ruyi_tasks').set({
    status: sql`CASE WHEN cancel_requested = 1 THEN 'interrupted' ELSE ${status} END`,
    error_message: sql`CASE WHEN cancel_requested = 1 THEN '用户停止，任务已中断，可继续任务' ELSE ${errorMessage ?? null} END`,
    finished_at: sql`NOW(3)`, heartbeat_at: null, next_check_at: null, cancel_requested: 0,
    claim_token: null, worker_id: null, version: sql`version + 1` })
    .where('id', '=', id).where('claim_token', '=', claimToken).where('status', 'in', ['running', 'waiting_login']).executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

// 平台登录失效后，使用与认领相同的命名锁一次性冻结该用户的整条任务队列。
// 这样多个 Worker 同时发现失效时不会互相覆盖新的认领或租约。
async function markUserWaitingLogin(db, { id, userId, claimToken }) {
  return db.connection().execute(async (conn) => {
    const lock = await sql`SELECT GET_LOCK('ruyi_job_claim', 5) AS acquired`.execute(conn);
    if (Number(lock.rows[0].acquired) !== 1) return false;
    try {
      if (!id || !claimToken) return false;
      return await conn.transaction().execute(async (trx) => {
        const owner = await trx.selectFrom('ruyi_tasks').select('id').where('id', '=', id)
          .where('user_id', '=', userId).where('claim_token', '=', claimToken).where('status', '=', 'running').where('cancel_requested', '=', 0)
          .where('deleted_at', 'is', null).forUpdate().executeTakeFirst();
        if (!owner) return false;
        const result = await trx.updateTable('ruyi_tasks').set({
          status: 'waiting_login', waiting_login_at: sql`NOW(3)`,
          claim_token: null, worker_id: null, heartbeat_at: null,
          cancel_requested: 0, error_message: null, next_check_at: null, version: sql`version + 1`,
        }).where('user_id', '=', userId).where('deleted_at', 'is', null)
          .where('status', 'in', ['queued', 'running']).where('cancel_requested', '=', 0)
          .executeTakeFirst();
        return Number(result.numUpdatedRows || 0) > 0;
      });
    } finally { await sql`SELECT RELEASE_LOCK('ruyi_job_claim')`.execute(conn); }
  });
}

async function resumeUserWaitingLogin(db, { userId }) {
  return db.connection().execute(async (conn) => {
    const lock = await sql`SELECT GET_LOCK('ruyi_job_claim', 5) AS acquired`.execute(conn);
    if (Number(lock.rows[0].acquired) !== 1) return 0;
    try {
      const rows = await conn.selectFrom('ruyi_tasks').select(['id']).where('user_id', '=', userId)
        .where('status', '=', 'waiting_login').where('deleted_at', 'is', null)
        .orderBy('queued_at').orderBy('queue_order').orderBy('id').execute();
      if (!rows.length) return 0;
      await conn.transaction().execute(async (trx) => {
        const resumeAt = new Date();
        for (const row of rows) {
          await trx.updateTable('ruyi_tasks').set({ status: 'queued', queued_at: resumeAt,
            waiting_login_at: null, claim_token: null, worker_id: null,
            heartbeat_at: null, cancel_requested: 0, error_message: null, next_check_at: null, version: sql`version + 1` })
            .where('id', '=', row.id).where('status', '=', 'waiting_login').executeTakeFirst();
        }
      });
      return rows.length;
    } finally { await sql`SELECT RELEASE_LOCK('ruyi_job_claim')`.execute(conn); }
  });
}
async function continueInterruptedTask(db, { id, userId, version }) {
  return db.connection().execute(async (conn) => {
    const lock = await sql`SELECT GET_LOCK('ruyi_job_claim', 5) AS acquired`.execute(conn);
    if (Number(lock.rows[0].acquired) !== 1) return { ok: false, reason: 'conflict' };
    try {
      return await conn.transaction().execute(async (trx) => {
        const task = await trx.selectFrom('ruyi_tasks').selectAll().where('id', '=', id)
          .where('user_id', '=', userId).where('deleted_at', 'is', null).forUpdate().executeTakeFirst();
        if (!task) return { ok: false, reason: 'not_found' };
        if (Number(task.version) !== version) return { ok: false, reason: 'version' };
        if (task.status !== 'interrupted') return { ok: false, reason: 'status' };
        const active = await trx.selectFrom('ruyi_jobs').select('id').where('task_id', '=', id)
          .where('status', 'in', ['running', 'queued']).executeTakeFirst();
        if (active) return { ok: false, reason: 'active_job' };
        const latest = await trx.selectFrom('ruyi_jobs').selectAll().where('task_id', '=', id)
          .where('user_id', '=', userId).where('task', '=', task.current_step)
          .orderBy('queued_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
        // 子流程成功与整任务推进之间可能发生停机，只信已持久化的成功记录。
        const next = { upload: 'create', create: 'analyse', analyse: 'download', download: null };
        const completed = latest?.status === 'succeeded';
        const step = completed ? next[task.current_step] : task.current_step;
        if (step === undefined || !Object.hasOwn(next, task.current_step)) return { ok: false, reason: 'status' };
        const status = completed && step === null ? 'succeeded' : 'queued';
        const result = await trx.updateTable('ruyi_tasks').set({ status,
          current_step: step || task.current_step, queued_at: sql`NOW(3)`,
          finished_at: status === 'succeeded' ? sql`NOW(3)` : null,
          cancel_requested: 0, claim_token: null, worker_id: null, heartbeat_at: null,
          waiting_login_at: null, next_check_at: null, error_message: null, version: sql`version + 1` })
          .where('id', '=', id).where('user_id', '=', userId).where('deleted_at', 'is', null)
          .where('status', '=', 'interrupted').where('version', '=', version).executeTakeFirst();
        if (Number(result.numUpdatedRows) !== 1) return { ok: false, reason: 'conflict' };
        return { ok: true, status, currentStep: step || task.current_step, version: version + 1 };
      });
    } finally { await sql`SELECT RELEASE_LOCK('ruyi_job_claim')`.execute(conn); }
  });
}

function heartbeatTasks(db, { workerId, taskIds }) {
  if (Array.isArray(taskIds) && !taskIds.length) return Promise.resolve({ numUpdatedRows: 0n });
  let query = db.updateTable('ruyi_tasks').set({ heartbeat_at: sql`NOW(3)` })
    .where('worker_id', '=', workerId).where('status', '=', 'running');
  if (Array.isArray(taskIds)) query = query.where('id', 'in', taskIds);
  return query.executeTakeFirst();
}

async function setTaskNextCheck(db, { id, claimToken, nextCheckAt }) {
  const result = await db.updateTable('ruyi_tasks').set({ next_check_at: nextCheckAt ?? null })
    .where('id', '=', id).where('claim_token', '=', claimToken).where('status', '=', 'running').where('cancel_requested', '=', 0).executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

async function syncTaskFiles(db, { taskId, userId, files }) {
  const stages = new Set(['pending', 'uploading', 'uploaded', 'created', 'analysed', 'downloaded', 'empty']);
  for (const file of files) {
    const stage = file.stage === 'planned' ? 'pending' : file.stage;
    if (!stages.has(stage)) continue;
    const values = { stage };
    if (typeof file.platformName === 'string' && file.platformName.length <= 30) values.platform_name = file.platformName;
    if (typeof file.currentPath === 'string' && /^execution\//.test(file.currentPath)
      && !file.currentPath.split(/[\\/]/).includes('..') && !file.currentPath.includes('\0')) values.current_path = file.currentPath;
    await db.updateTable('ruyi_task_files').set(values).where('id', '=', file.id)
      .where('task_id', '=', taskId).where('user_id', '=', userId).where('excluded_at', 'is', null).executeTakeFirst();
  }
}

async function recoverStaleTasks(db, { staleSeconds = 60 } = {}) {
  const stale = sql`DATE_SUB(NOW(3), INTERVAL ${staleSeconds} SECOND)`;
  return db.transaction().execute(async (trx) => {
    const rows = await trx.selectFrom('ruyi_tasks').selectAll().where('status', '=', 'running').where('heartbeat_at', '<', stale).forUpdate().execute();
    if (rows.length) await trx.updateTable('ruyi_tasks').set({ status: 'interrupted', error_message: '服务重启或异常退出，任务已中断', finished_at: sql`NOW(3)`,
      cancel_requested: 0, claim_token: null, worker_id: null, heartbeat_at: null, next_check_at: null, version: sql`version + 1` }).where('id', 'in', rows.map((r) => r.id)).execute();
    return rows;
  });
}

async function renameTask(db, { id, userId, name, version }) {
  let query = db.updateTable('ruyi_tasks').set({ name, version: sql`version + 1` })
    .where('id', '=', id).where('user_id', '=', userId).where('deleted_at', 'is', null);
  if (version !== undefined) query = query.where('version', '=', version);
  const result = await query.executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}


async function excludeTaskFile(db, { taskId, fileId, userId, version }) {
  return db.transaction().execute(async (trx) => {
    const task = await trx.selectFrom('ruyi_tasks').selectAll().where('id', '=', taskId).where('user_id', '=', userId).where('deleted_at', 'is', null).forUpdate().executeTakeFirst();
    if (!task) return { ok: false, reason: 'not_found' };
    if (!['queued', 'waiting_login'].includes(task.status)) return { ok: false, reason: 'task_started', task };
    const expected = version === undefined ? Number(task.version) : version;
    if (Number(task.version) !== expected) return { ok: false, reason: 'version', task };
    const file = await trx.selectFrom('ruyi_task_files').selectAll().where('id', '=', fileId).where('task_id', '=', taskId).where('user_id', '=', userId).executeTakeFirst();
    if (!file) return { ok: false, reason: 'not_found', task };
    if (file.excluded_at) return { ok: true, already: true, task, file };
    const active = await trx.selectFrom('ruyi_task_files').selectAll().where('task_id', '=', taskId).where('user_id', '=', userId).where('excluded_at', 'is', null).execute();
    const now = sql`NOW(3)`;
    const fr = await trx.updateTable('ruyi_task_files').set({ excluded_at: now, version: sql`version + 1` })
      .where('id', '=', fileId).where('task_id', '=', taskId).where('user_id', '=', userId).where('excluded_at', 'is', null).executeTakeFirst();
    if (Number(fr.numUpdatedRows) !== 1) return { ok: false, reason: 'conflict', task };
    const last = active.length <= 1;
    const tr = await trx.updateTable('ruyi_tasks').set(last ? { status: 'cancelled', finished_at: now, version: sql`version + 1` } : { version: sql`version + 1` })
      .where('id', '=', taskId).where('user_id', '=', userId).where('version', '=', expected).where('status', 'in', ['queued', 'waiting_login']).executeTakeFirst();
    if (Number(tr.numUpdatedRows) !== 1) throw new Error('任务版本冲突，文件修改已回滚');
    return { ok: true, task: { ...task, version: expected + 1, ...(last ? { status: 'cancelled' } : {}) }, file: { ...file, excluded_at: new Date() }, last };
  });
}

async function deleteTask(db, { id, userId, version }) {
  return db.transaction().execute(async (trx) => {
    const task = await trx.selectFrom('ruyi_tasks').selectAll().where('id', '=', id).where('user_id', '=', userId).where('deleted_at', 'is', null).forUpdate().executeTakeFirst();
    if (!task) return { ok: false, reason: 'not_found' };
    if (version !== undefined && Number(task.version) !== version) return { ok: false, reason: 'version', task };
    if (task.status === 'running') {
      const result = await trx.updateTable('ruyi_tasks').set({ cancel_requested: 1, version: sql`version + 1` }).where('id', '=', id).where('user_id', '=', userId).where('status', '=', 'running').where('version', '=', task.version).executeTakeFirst();
      return Number(result.numUpdatedRows) === 1 ? { ok: true, status: 'cancelling', task } : { ok: false, reason: 'conflict', task };
    }
    const result = await trx.updateTable('ruyi_tasks').set({ deleted_at: sql`NOW(3)`, version: sql`version + 1` }).where('id', '=', id).where('user_id', '=', userId).where('deleted_at', 'is', null).where('version', '=', task.version).executeTakeFirst();
    return Number(result.numUpdatedRows) === 1 ? { ok: true, status: 'deleted', task } : { ok: false, reason: 'conflict', task };
  });
}

module.exports = { createTask, getTaskForUser, listTasks, listTasksAdmin, getTaskAdmin, listTaskFilesAdmin, listTaskJobsAdmin, listTaskFiles, listTaskJobs, renameTask, excludeTaskFile, deleteTask,
  claimNextTask, updateTaskStep, finishTask, heartbeatTasks, setTaskNextCheck, syncTaskFiles, recoverStaleTasks, requestCancelTask, requestStopTask,
  markUserWaitingLogin, resumeUserWaitingLogin, continueInterruptedTask };

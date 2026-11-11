const { sql } = require('kysely');

function businessError(message, code = 'RESULT_STATE_ERROR') { return Object.assign(new Error(message), { code }); }
async function guarded(action) {
  try { return await action(); } catch (error) {
    if (['RESULT_STATE_ERROR', 'RESULT_SET_NOT_FOUND', 'RESULT_FILE_ERROR'].includes(error.code)) throw error;
    throw Object.assign(new Error('任务结果数据库操作失败，请稍后重试或联系管理员'), { code: 'TASK_DATABASE_ERROR' });
  }
}

async function ownedSet(db, jobId, context, lock = false) {
  let query = db.selectFrom('ruyi_task_result_sets').selectAll().where('job_id', '=', jobId)
    .where('task_id', '=', context.taskId).where('user_id', '=', context.userId);
  if (lock) query = query.forUpdate();
  return query.executeTakeFirst();
}

async function withWriter(db, jobId, context, action, allowStopping = false) {
  return guarded(() => db.transaction().execute(async (trx) => {
    let taskQuery = trx.selectFrom('ruyi_tasks').selectAll().where('id', '=', context.taskId)
      .where('user_id', '=', context.userId).where('status', '=', 'running')
      .where('deleted_at', 'is', null);
    if (!allowStopping) taskQuery = taskQuery.where('cancel_requested', '=', 0);
    const task = await taskQuery.forUpdate().executeTakeFirst();
    if (!task || task.claim_token !== context.taskClaimToken) throw businessError('结果任务租约已失效');
    let jobQuery = trx.selectFrom('ruyi_jobs').selectAll().where('id', '=', jobId)
      .where('task_id', '=', context.taskId).where('user_id', '=', context.userId)
      .where('task', '=', 'download').where('status', '=', 'running')
      .where('claim_token', '=', context.claimToken);
    if (!allowStopping) jobQuery = jobQuery.where('cancel_requested', '=', 0);
    const job = await jobQuery.forUpdate().executeTakeFirst();
    if (!job) throw businessError('结果任务租约已失效');
    return action(trx);
  }));
}

async function listFiles(db, jobId) {
  return db.selectFrom('ruyi_task_results').selectAll().where('job_id', '=', jobId).orderBy('created_at').orderBy('id').execute();
}

async function createSet(db, jobId, context) {
  return withWriter(db, jobId, context, async (trx) => {
    if (await ownedSet(trx, jobId, context, true)) throw businessError('结果任务归档已存在');
    await trx.insertInto('ruyi_task_result_sets').values({ job_id: jobId, task_id: context.taskId, user_id: context.userId }).execute();
  });
}

async function writableSet(trx, jobId, context) {
  const set = await ownedSet(trx, jobId, context, true);
  if (!set) throw Object.assign(new Error('结果归档不存在'), { code: 'RESULT_SET_NOT_FOUND' });
  if (set.sealed_at) throw businessError('任务结果已封存');
  return set;
}

async function addFile(db, jobId, context, file, save) {
  return withWriter(db, jobId, context, async (trx) => {
    await writableSet(trx, jobId, context);
    const owner = await trx.selectFrom('ruyi_task_files').selectAll().where('id', '=', file.file_id)
      .where('task_id', '=', context.taskId).where('user_id', '=', context.userId).where('excluded_at', 'is', null).executeTakeFirst();
    if (!owner) throw businessError('结果文件不属于本次任务或已被排除');
    if (!['analysed', 'downloaded'].includes(owner.stage)) throw businessError('结果文件尚未完成洞悉，不能登记下载结果');
    const files = await listFiles(trx, jobId);
    if (files.some((item) => item.name.normalize('NFC') === file.name.normalize('NFC') || item.file_id === file.file_id)) throw businessError('任务结果文件重名');
    try { await save(); } catch (_) { throw businessError('结果文件保存失败，文件可能已存在或不可写', 'RESULT_FILE_ERROR'); }
    await trx.insertInto('ruyi_task_results').values({ ...file, job_id: jobId }).execute();
    await trx.updateTable('ruyi_task_files').set({ stage: 'downloaded', pending_operation: null, operation_job_id: null,
      error_message: null, version: sql`version + 1` }).where('id', '=', file.file_id)
      .where('task_id', '=', context.taskId).where('user_id', '=', context.userId).where('excluded_at', 'is', null).execute();
  });
}

async function sealSet(db, jobId, context, requireFiles) {
  return withWriter(db, jobId, context, async (trx) => {
    const set = await ownedSet(trx, jobId, context, true);
    if (!set) throw businessError('结果归档不存在', 'RESULT_SET_NOT_FOUND');
    const files = await listFiles(trx, jobId);
    if (requireFiles && !files.length) throw businessError('本次任务没有可下载的结果文件');
    if (!set.sealed_at) await trx.updateTable('ruyi_task_result_sets').set({ sealed_at: sql`NOW(3)` }).where('job_id', '=', jobId).execute();
    return files.length;
  }, !requireFiles);
}

async function readSet(db, jobId, context) { return guarded(async () => {
  const task = await db.selectFrom('ruyi_tasks').select('id').where('id', '=', context.taskId)
    .where('user_id', '=', context.userId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!task) throw businessError('结果任务不存在');
  const set = await ownedSet(db, jobId, context);
  if (!set) throw Object.assign(new Error('结果归档不存在'), { code: 'RESULT_SET_NOT_FOUND' });
  return { ...set, files: await listFiles(db, jobId) };
}); }

module.exports = { createSet, addFile, sealSet, readSet, withWriter, writableSet, listFiles, guarded };

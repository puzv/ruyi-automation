const { sql } = require('kysely');

// 单批次串行模式：上传任务的完整 ID 为批次 ID，后续流程归到同用户最近的上传。
// 不读取上传文件或从八位短码反推 ID；旧记录也按同一规则聚合，无需改表。
function batchIdExpression() {
  return sql`CASE WHEN j.task = 'upload' THEN j.id ELSE COALESCE((
    SELECT u.id FROM ruyi_jobs AS u
    WHERE u.user_id = j.user_id AND u.task = 'upload'
      AND u.queued_at <= j.queued_at
    ORDER BY u.queued_at DESC, u.id DESC LIMIT 1
  ), j.id) END`;
}

function batchStatusExpression() {
  const latest = (task) => sql`SUBSTRING_INDEX(GROUP_CONCAT(
    CASE WHEN task = ${task} THEN status ELSE NULL END ORDER BY queued_at DESC, id DESC
  ), ',', 1)`;
  const states = ['upload', 'create', 'analyse', 'download'].map(latest);
  return sql`CASE
    WHEN SUM(status = 'running') > 0 THEN 'running'
    WHEN SUM(status = 'queued') > 0 THEN 'queued'
    WHEN ${sql.join(states.map((state) => sql`${state} = 'failed'`), sql` OR `)} THEN 'failed'
    WHEN ${sql.join(states.map((state) => sql`${state} = 'interrupted'`), sql` OR `)} THEN 'interrupted'
    WHEN ${sql.join(states.map((state) => sql`${state} = 'cancelled'`), sql` OR `)} THEN 'cancelled'
    WHEN ${sql.join(states.map((state) => sql`${state} = 'succeeded'`), sql` AND `)} THEN 'succeeded'
    ELSE 'waiting' END`;
}

async function listJobBatches(db, { userId, username, status, page = 1, pageSize = 20 } = {}) {
  let scoped = db.selectFrom('ruyi_jobs as j');
  if (userId != null) scoped = scoped.where('j.user_id', '=', userId);
  if (username) scoped = scoped.where('j.username', '=', username);
  const members = scoped.selectAll('j').select(batchIdExpression().as('batch_id'));
  const summary = db.selectFrom(members.as('members')).select([
    'batch_id', 'user_id', sql`MAX(queued_at)`.as('updated_at'), batchStatusExpression().as('batch_status'),
  ]).groupBy(['batch_id', 'user_id']);
  let query = db.selectFrom(summary.as('batches'));
  if (status) query = query.where('batch_status', '=', status);
  const count = await query.select((eb) => eb.fn.countAll().as('total')).executeTakeFirstOrThrow();
  const batches = await query.selectAll().orderBy('updated_at', 'desc').orderBy('batch_id', 'desc')
    .limit(pageSize).offset((page - 1) * pageSize).execute();
  if (!batches.length) return { items: [], total: Number(count.total) };
  // 先按批次分页，再读取这些批次的全部流程，避免跨页拆散和筛选后丢失上下文。
  const rows = await db.selectFrom(members.as('members')).selectAll()
    .where('batch_id', 'in', batches.map((batch) => batch.batch_id))
    .orderBy('queued_at').orderBy('id').execute();
  return { items: batches.map((batch) => ({ id: batch.batch_id,
    rows: rows.filter((row) => row.batch_id === batch.batch_id && String(row.user_id) === String(batch.user_id)),
  })), total: Number(count.total) };
}

module.exports = { listJobBatches };

const assert = require('node:assert/strict');
const { Kysely, MysqlDialect, DummyDriver } = require('kysely');
const tasks = require('../packages/shared/runtime/repos/tasks');
const jobs = require('../packages/shared/runtime/repos/jobs');

async function scenario(action, { active = 0, owner = true, activeJob = false, lock = true } = {}) {
  const queries = [];
  class Driver extends DummyDriver {
    async acquireConnection() { return { async executeQuery(query) {
      queries.push(query); const text = query.sql;
      if (text.includes('GET_LOCK')) return { rows: [{ acquired: lock ? 1 : 0 }] };
      if (text.includes('count(*)')) return { rows: [{ n: active }] };
      if (text.startsWith('select `t`.`id`')) return { rows: [{ id: 'task' }] };
      if (text.startsWith('select `id`') && text.includes('ruyi_tasks')) return { rows: owner ? [{ id: 'task' }] : [] };
      if (text.startsWith('select `id`') && text.includes('ruyi_jobs')) return { rows: activeJob ? [{ id: 'job' }] : [] };
      if (text.startsWith('select')) return { rows: [{ id: 'task', status: 'running' }] };
      return { rows: [], numAffectedRows: 1n };
    } }; }
  }
  const dialect = new MysqlDialect({ pool: {} }); dialect.createDriver = () => new Driver();
  const db = new Kysely({ dialect });
  try { return { result: await action(db), queries }; } finally { await db.destroy(); }
}
async function main() {
  const claim = (db) => tasks.claimNextTask(db, { workerId: 'worker', claimToken: 'new-lease' });
  const claimed = await scenario(claim);
  const count = claimed.queries.find((q) => q.sql.includes('count(*)') && q.sql.includes('ruyi_tasks'));
  assert.match(count.sql, /`claim_token` is not null/);
  const candidate = claimed.queries.find((q) => q.sql.startsWith('select `t`.`id`'));
  for (const pattern of [/`t`.`claim_token` is null/, /`t`.`worker_id` is null/, /`t`.`heartbeat_at` is null/,
    /`t`.`next_check_at` <= NOW\(3\)/, /`r`.`id` != `t`.`id`/, /`r`.`status` in/, /CASE WHEN t.status/]) assert.match(candidate.sql, pattern);
  const update = claimed.queries.find((q) => q.sql.startsWith('update'));
  assert.match(update.sql, /`next_check_at` = \?/); assert.match(update.sql, /`claim_token` is null/);
  assert.equal(update.sql.includes('select'), false, '认领UPDATE不得子查同表');
  assert.ok(claimed.queries.at(-1).sql.includes('RELEASE_LOCK'));
  assert.equal((await scenario(claim, { active: 2 })).result, null);
  const release = (db) => tasks.releaseTaskForPlatformWait(db, { id: 'task', claimToken: 'lease', nextCheckAt: new Date() });
  const released = await scenario(release);
  assert.equal(released.result, true);
  const park = released.queries.find((q) => q.sql.startsWith('update'));
  for (const field of ['claim_token', 'worker_id', 'heartbeat_at', 'next_check_at']) assert.match(park.sql, new RegExp('`' + field + '` = \\?'));
  assert.match(park.sql, /`claim_token` = \? and `cancel_requested` = \?/);
  assert.equal((await scenario(release, { activeJob: true })).result, false);
  assert.equal((await scenario(release, { owner: false })).result, false);
  assert.equal((await scenario(release, { lock: false })).result, false);
  const stop = await scenario((db) => tasks.requestStopTask(db, { id: 'task', userId: 1, version: 2 }));
  const stopping = stop.queries[0].sql;
  assert.equal(stop.queries.length, 1, '停止必须原子，不能两次写入间释放导致永久正在停止');
  assert.ok(stopping.indexOf('`next_check_at` = CASE') > stopping.indexOf('`error_message` = CASE'));
  const legacy = await scenario((db) => jobs.claimNextJob(db, { workerId: 'worker', claimToken: 'lease' }));
  assert.match(legacy.queries.find((q) => q.sql.includes('count(*)') && q.sql.includes('ruyi_tasks')).sql, /`claim_token` is not null/);
  const enqueue = (db) => jobs.enqueueTaskJob(db, { id: 'job', taskId: 'task', userId: 1, username: 'user', task: 'upload', workerId: 'worker', claimToken: 'job-lease', taskClaimToken: 'task-lease' });
  const stale = await scenario(enqueue, { owner: false }); assert.equal(stale.result, null);
  assert.equal(stale.queries.some((q) => q.sql.startsWith('insert')), false);
  for (const item of [claimed, released, stop, legacy, stale]) {
    for (const query of item.queries) assert.doesNotMatch(query.sql, /SKIP LOCKED|NOWAIT|\bWITH\b|OVER\s*\(/i);
  }
  console.log('等待释放调度MySQL编译测试通过：持久等待、到期认领、双重租约、停止原子性及legacy计数');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

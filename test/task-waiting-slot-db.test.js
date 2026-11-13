const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { sql } = require('kysely');
const { createDb } = require('../db');
const users = require('../packages/shared/runtime/repos/users');
const tasks = require('../packages/shared/runtime/repos/tasks');
const jobs = require('../packages/shared/runtime/repos/jobs');

// 只连接本机测试库；不迁移、不清理其他测试或用户的数据。
const db = createDb({ host: '127.0.0.1', port: 3306, user: 'ruyi', password: 'ruyi', database: 'ruyi_test' });
const prefix = `slot_${randomUUID().slice(0, 8)}`, userIds = [], taskIds = [], jobIds = [];
const token = () => randomUUID();
const stamp = new Date(Date.now() - 60000);
async function addTask(userId, queuedAt = stamp) {
  const id = randomUUID();
  await db.insertInto('ruyi_tasks').values({ id, user_id: userId, name: id, queued_at: queuedAt }).execute();
  taskIds.push(id);
  return id;
}
const claim = () => tasks.claimNextTask(db, { workerId: prefix, claimToken: token(), maxConcurrent: 2 });
async function finish(row) { return tasks.finishTask(db, { id: row.id, claimToken: row.claim_token, status: 'succeeded' }); }
async function park(row, when = new Date(Date.now() + 120000)) {
  return tasks.releaseTaskForPlatformWait(db, { id: row.id, claimToken: row.claim_token, nextCheckAt: when });
}
async function main() {
  const version = (await sql`SELECT VERSION() AS version`.execute(db)).rows[0].version;
  await db.selectFrom('ruyi_tasks').select('id').limit(0).execute();
  for (const table of ['ruyi_tasks', 'ruyi_jobs']) {
    const existing = await db.selectFrom(table).select('id').where('status', 'in', ['queued', 'running']).executeTakeFirst();
    assert.equal(existing, undefined, '测试库存在其他待执行记录，拒绝全局认领测试以保护现有数据');
  }
  for (let i = 0; i < 4; i++) userIds.push(await users.createUser(db, {
    username: `${prefix}_${i}`, displayName: '等待调度合成测试', passwordHash: 'not-a-real-login-hash',
  }));
  const a = await addTask(userIds[0]), b = await addTask(userIds[1]);
  const c = await addTask(userIds[2]), a2 = await addTask(userIds[0]);
  const initial = (await Promise.all([claim(), claim(), claim(), claim()])).filter(Boolean);
  assert.equal(initial.length, 2, '跨连接并发认领不能超过2个名额');
  assert.deepEqual(new Set(initial.map((row) => row.id)), new Set([a, b]));
  for (const row of initial) assert.equal(await park(row), true);
  const waiting = await tasks.getTaskForUser(db, a, userIds[0]);
  assert.equal(waiting.status, 'running');
  for (const field of ['claim_token', 'worker_id', 'heartbeat_at']) assert.equal(waiting[field], null);
  assert.ok(waiting.next_check_at instanceof Date);
  const third = await claim(); assert.equal(third.id, c, '等待中两任务不占名额');
  assert.equal(await finish(third), true);
  assert.equal(await claim(), null, '同用户后续任务及未到期检查不能抢跑');
  assert.equal(await tasks.updateTaskStep(db, { id: a, claimToken: initial[0].claim_token, currentStep: 'create' }), false);
  assert.equal(await finish(initial[0]), false, '释放后的旧租约不可写回');
  assert.equal(await park(initial[0]), false);
  assert.equal(await jobs.enqueueTaskJob(db, { id: randomUUID(), taskId: a, userId: userIds[0], username: `${prefix}_0`,
    task: 'upload', workerId: prefix, claimToken: token(), taskClaimToken: initial[0].claim_token }), null,
  '释放后的旧租约不可新增执行');
  assert.equal((await tasks.recoverStaleTasks(db, { staleSeconds: 0 })).length, 0, '等待状态不得被心跳回收');
  await db.updateTable('ruyi_tasks').set({ next_check_at: new Date(Date.now() - 1000) }).where('id', '=', a).execute();
  const resumed = (await Promise.all([claim(), claim(), claim()])).filter(Boolean);
  assert.equal(resumed.length, 1); assert.equal(resumed[0].id, a);
  assert.notEqual(resumed[0].claim_token, initial.find((r) => r.id === a).claim_token);
  assert.equal(resumed[0].next_check_at, null);
  const jobId = randomUUID(); jobIds.push(jobId);
  const job = await jobs.enqueueTaskJob(db, { id: jobId, taskId: a, userId: userIds[0], username: `${prefix}_0`,
    task: 'upload', workerId: prefix, claimToken: token(), taskClaimToken: resumed[0].claim_token });
  assert.ok(job); assert.equal(await park(resumed[0]), false, '真实子流程未结束不得释放名额');
  await jobs.finishJob(db, { id: jobId, claimToken: job.claim_token, status: 'failed', exitCode: 2 });
  assert.equal(await park(resumed[0]), true);
  const stopRow = await tasks.getTaskForUser(db, a, userIds[0]);
  assert.equal(await tasks.requestStopTask(db, { id: a, userId: userIds[0], version: stopRow.version }), true);
  assert.equal((await tasks.getTaskForUser(db, a, userIds[0])).status, 'interrupted');
  const next = await claim(); assert.equal(next.id, a2); await finish(next);
  const legacyId = randomUUID(); jobIds.push(legacyId);
  await jobs.enqueueJob(db, { id: legacyId, userId: userIds[3], username: `${prefix}_3`, task: 'upload' });
  const legacy = await jobs.claimNextJob(db, { workerId: prefix, claimToken: token(), maxConcurrent: 1 });
  assert.equal(legacy.id, legacyId, 'legacy调度同样不计算等待名额');
  await jobs.finishJob(db, { id: legacy.id, claimToken: legacy.claim_token, status: 'succeeded' });
  assert.equal(Number((await sql`SELECT IS_FREE_LOCK('ruyi_job_claim') AS free`.execute(db)).rows[0].free), 1);
  console.log(`等待释放名额真实MySQL ${version}测试通过：并发上限、同用户串行、到期唯一认领、旧租约、停止和legacy`);
}
main().finally(async () => {
  try {
    if (jobIds.length) await db.deleteFrom('ruyi_jobs').where('id', 'in', jobIds).execute();
    if (taskIds.length) await db.deleteFrom('ruyi_tasks').where('id', 'in', taskIds).execute();
    if (userIds.length) await db.deleteFrom('ruyi_users').where('id', 'in', userIds).execute();
  } finally { await db.destroy(); }
}).catch((error) => { console.error(error); process.exitCode = 1; });

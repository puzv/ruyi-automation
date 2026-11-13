const assert = require('node:assert/strict');
const jobs = require('../packages/shared/runtime/repos/jobs');
const tasks = require('../packages/shared/runtime/repos/tasks');
const { Kysely, MysqlDialect, DummyDriver } = require('kysely');

// 阶段 2 基础契约测试：确保整任务认领及其执行记录具备独立租约。
async function testEnqueueTaskJob() {
  const queries = [];
  class Driver extends DummyDriver {
    async acquireConnection() { return { async executeQuery(query) {
      queries.push(query);
      if (query.sql.includes('GET_LOCK')) return { rows: [{ acquired: 1 }] };
      if (query.sql.startsWith('select `id` from `ruyi_tasks`')) return { rows: [{ id: 't' }] };
      if (query.sql.startsWith('select `id` from `ruyi_jobs`')) return { rows: [] };
      if (query.sql.startsWith('select *')) return { rows: [{ task_id: 't' }] };
      return { rows: [], numAffectedRows: 1n };
    } }; }
  }
  const dialect = new MysqlDialect({ pool: {} }); dialect.createDriver = () => new Driver();
  const db = new Kysely({ dialect });
  try {
    const args = { id: 'j', taskId: 't', userId: 1, username: 'alice', task: 'upload', workerId: 'w', claimToken: 'token' };
    assert.equal(await jobs.enqueueTaskJob(db, args), null, '缺少整任务租约不能创建子流程');
    assert.equal(queries.length, 0);
    const row = await jobs.enqueueTaskJob(db, { ...args, taskClaimToken: 'parent-token' });
    const insert = queries.find((q) => q.sql.startsWith('insert'));
    for (const value of ['running', 'token', 'w']) assert.ok(insert.parameters.includes(value));
    assert.equal(row.task_id, 't');
  } finally { await db.destroy(); }
}

assert.equal(typeof tasks.claimNextTask, 'function');
assert.equal(typeof tasks.recoverStaleTasks, 'function');
testEnqueueTaskJob().then(() => console.log('阶段2任务队列契约测试通过')).catch((error) => { console.error(error); process.exitCode = 1; });

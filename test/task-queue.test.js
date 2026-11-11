const assert = require('node:assert/strict');
const jobs = require('../packages/shared/runtime/repos/jobs');
const tasks = require('../packages/shared/runtime/repos/tasks');

// 阶段 2 基础契约测试：确保整任务认领及其执行记录具备独立租约。
async function testEnqueueTaskJob() {
  let values;
  const db = {
    insertInto() { return { values(v) { values = v; return { async execute() {} }; } }; },
    selectFrom() { return { selectAll() { return { where() { return { async executeTakeFirst() { return values; } }; } }; } }; },
  };
  const row = await jobs.enqueueTaskJob(db, { id: 'j', taskId: 't', userId: 1, username: 'alice', task: 'upload', workerId: 'w', claimToken: 'token' });
  assert.equal(values.status, 'running');
  assert.equal(values.claim_token, 'token');
  assert.equal(values.worker_id, 'w');
  assert.equal(row.task_id, 't');
}

assert.equal(typeof tasks.claimNextTask, 'function');
assert.equal(typeof tasks.recoverStaleTasks, 'function');
testEnqueueTaskJob().then(() => console.log('阶段2任务队列契约测试通过')).catch((error) => { console.error(error); process.exitCode = 1; });

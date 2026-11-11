const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { buildApp } = require('../apps/server/src/app');
const { loadKeys, encryptState } = require('../packages/shared/runtime/platform-state/crypto');
const taskRepo = require('../packages/shared/runtime/repos/tasks');
require('./task-job-presentation.test');

async function main() {
  let role = 'user';
  let taskStatus = 'waiting_login', platformRow;
  const keys = loadKeys({ RUYI_STATE_KEY: randomBytes(32).toString('base64') });
  const originalContinue = taskRepo.continueInterruptedTask;
  const originalStop = taskRepo.requestStopTask;
  let stopCalls = 0;
  taskRepo.requestStopTask = async (_db, args) => {
    stopCalls++;
    assert.equal(args.userId, 71);
    return args.id === id && args.version === 1 && taskStatus === 'running';
  };
  let continueCalls = 0;
  taskRepo.continueInterruptedTask = async (_db, args) => {
    continueCalls++;
    assert.deepEqual(args, { id, userId: 71, version: 1 });
    taskStatus = 'queued';
    return { ok: true, status: 'queued', currentStep: 'analyse', version: 2 };
  };
  const id = randomUUID();
  let records = [];
  let auditRecords = [];
  const jobQueries = [];
  const db = {
    selectFrom(table) {
      const q = { conditions: [], innerJoin() { return this; }, selectAll() { return this; }, select(value) { this.count = typeof value === 'function'; return this; },
        where(...args) { this.conditions.push(args); return this; }, orderBy() { return this; }, limit() { return this; }, offset() { return this; },
        async execute() {
          if (table === 'ruyi_jobs') { jobQueries.push(this.conditions); return records; }
          return table === 'ruyi_operation_logs' ? auditRecords : [];
        }, async executeTakeFirstOrThrow() { return { total: 0 }; },
        async executeTakeFirst() {
          if (table === 'ruyi_operation_logs') return { total: auditRecords.length };
          if (table === 'ruyi_tasks' || table === 'ruyi_tasks as t') {
            if (this.conditions.some(([column, , value]) => column === 'id' && value !== id)) return undefined;
            return { id, user_id: 71, status: taskStatus, current_step: 'analyse', version: 1 };
          }
          if (table === 'ruyi_platform_states') return platformRow;
          if (table.includes('ruyi_user_sessions')) return { id: 'fake', user_id: 71, username: 'test_user', role, status: 'active', must_change_password: 0 };
          return undefined;
        } };
      return q;
    },
    updateTable() { return { set() { return this; }, where() { return this; }, async executeTakeFirst() { return { numUpdatedRows: 1n }; } }; },
    insertInto() { return { values() { return this; }, async execute() {} }; },
  };
  const app = buildApp({ db, stateKeys: keys, logger: false });
  const headers = { cookie: `ruyi_session=${'a'.repeat(43)}` };
  try {
    assert.equal((await app.inject('/api/tasks')).statusCode, 401);
    assert.equal((await app.inject('/api/logs/mine?groupId=1')).statusCode, 401);
    for (const query of ['groupId=invalid', 'snapshot=0', 'snapshot=1.5', 'groupId=-1']) {
      assert.equal((await app.inject({ url: `/api/logs/mine?${query}`, headers })).statusCode, 400);
    }
    let result = await app.inject({ url: '/api/tasks', headers });
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json().items, []);
    assert.equal((await app.inject({ url: '/api/admin/tasks', headers })).statusCode, 403);
    records = [
      { id: 'not-ready', task_id: id, task: 'analyse', status: 'failed', exit_code: 2, exit_signal: null, state_expired: 0, error_message: '平台计算中' },
      { id: 'real-failure', task_id: id, task: 'analyse', status: 'failed', exit_code: 1, error_message: '真实异常' },
      { id: 'signalled', task_id: id, task: 'analyse', status: 'failed', exit_code: 2, exit_signal: 'SIGTERM', error_message: '终止' },
      { id: 'expired', task_id: id, task: 'analyse', status: 'failed', exit_code: 2, state_expired: 1, error_message: '请登录' },
      { id: 'cancelled', task_id: id, task: 'analyse', status: 'cancelled', exit_code: 2 },
      { id: 'legacy', task_id: null, task: 'analyse', status: 'failed', exit_code: 2 },
      { id: 'login-exact', task_id: id, task: 'analyse', status: 'failed', exit_code: 2, error_message: '请先完成平台登录' },
      { id: 'login-signal', task_id: id, task: 'analyse', status: 'failed', exit_code: 2, state_expired: 1, exit_signal: 'SIGTERM' },
    ];
    result = await app.inject({ url: `/api/tasks/${id}`, headers });
    assert.equal(result.statusCode, 200, result.body);
    const publicRecords = result.json().jobs;
    assert.equal(publicRecords[0].status, 'waiting_platform');
    assert.equal(publicRecords[0].outcome, 'not_ready');
    assert.equal(publicRecords[0].exitCode, 2);
    assert.equal(publicRecords[0].errorMessage, null);
    assert.ok(publicRecords[0].message.includes('本轮检查'));
    assert.deepEqual(publicRecords.slice(1).map((job) => job.status), ['failed', 'failed', 'waiting_login', 'cancelled', 'failed', 'waiting_login', 'failed']);
    assert.equal(publicRecords[3].outcome, 'login_required');
    assert.equal(publicRecords[3].errorMessage, null);
    records.forEach((job) => { job.user_id = 71; });
    auditRecords = records.map((job, index) => ({ id: index + 1, user_id: 71, action: 'job.finish', target_type: 'job',
      target_id: job.id, result: 'failure', detail: index % 2 ? '{"task":"analyse"}' : null, error_message: job.error_message }));
    auditRecords.push({ id: 100, user_id: 99, action: 'job.finish', target_type: 'job', target_id: 'not-ready', result: 'failure', error_message: '不得关联其他用户' });
    auditRecords.push({ id: 101, user_id: 71, action: 'auth.login', target_type: 'job', target_id: 'not-ready', result: 'failure', error_message: '真实登录失败' });
    auditRecords.push({ id: 102, user_id: 71, action: 'job.finish', target_type: 'job', target_id: 'missing-job', result: 'failure', error_message: '保留缺失记录' });
    auditRecords[0].detail = { stateExpired: true, loginRequired: true };
    const queriesBeforeMine = jobQueries.length;
    result = await app.inject({ url: '/api/logs/mine', headers });
    assert.equal(result.statusCode, 200, result.body);
    const logs = result.json().items;
    assert.equal(logs[0].result, 'failure', '不回写历史审计事实，前端按业务状态展示');
    assert.equal(logs[0].detail.status, 'waiting_platform');
    assert.equal(logs[0].detail.taskId, id);
    assert.equal(logs[0].errorMessage, null);
    assert.equal(logs[0].detail.stateExpired, false, '关联 job 的事实优先于旧审计 detail');
    assert.equal(logs[0].detail.loginRequired, false);
    assert.equal(jobQueries.length - queriesBeforeMine, 1, '整页只执行一次批量关联');
    assert.ok(jobQueries.at(-1).some(([column, operator, value]) => column === 'id' && operator === 'in'
      && value.includes('not-ready') && value.includes('missing-job')));
    assert.ok(jobQueries.at(-1).some(([column, operator, value]) => column === 'user_id' && operator === '=' && value === 71));
    assert.equal(logs[1].errorMessage, '真实异常');
    assert.equal(logs[2].errorMessage, '终止');
    assert.equal(logs[3].detail.status, 'waiting_login');
    assert.equal(logs[3].errorMessage, null);
    assert.equal(logs[6].detail.status, 'waiting_login');
    assert.deepEqual(logs[5].detail, { task: 'analyse' }, '没有整任务 ID 的历史记录保持原样');
    for (const index of [8, 9, 10]) assert.equal(logs[index].detail, null, `第 ${index} 条不能被误关联`);
    role = 'admin';
    const queriesBeforeAdmin = jobQueries.length;
    result = await app.inject({ url: '/api/admin/logs', headers });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().items[0].detail.status, 'waiting_platform');
    assert.equal(jobQueries.length - queriesBeforeAdmin, 1);
    assert.equal(jobQueries.at(-1).some(([column]) => column === 'user_id'), false, '管理员允许当前页跨用户批量关联，但逐条校验所属用户');
    result = await app.inject({ url: '/api/admin/tasks', headers });
    assert.equal(result.statusCode, 200, result.body);
    result = await app.inject({ url: `/api/admin/tasks/${id}`, headers });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().jobs[0].status, 'waiting_platform');
    result = await app.inject({ method: 'POST', url: `/api/tasks/${id}/resume`, headers });
    assert.equal(result.statusCode, 409, result.body);
    assert.equal(result.json().code, 'PLATFORM_LOGIN_REQUIRED');
    role = 'user'; taskStatus = 'interrupted';
    assert.equal((await app.inject({ method: 'POST', url: `/api/tasks/${id}/continue`, payload: { version: 1 } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: `/api/tasks/${randomUUID()}/continue`, headers, payload: { version: 1 } })).statusCode, 404);
    result = await app.inject({ method: 'POST', url: `/api/tasks/${id}/continue`, headers, payload: { version: 1 } });
    assert.equal(result.statusCode, 409); assert.equal(result.json().code, 'PLATFORM_LOGIN_REQUIRED');
    assert.equal(continueCalls, 0);
    const encrypted = encryptState({ cookies: [], origins: [] }, 71, keys);
    platformRow = { status: 'valid', state_ciphertext: encrypted.ciphertext, key_version: encrypted.keyVersion, version: 1 };
    assert.equal((await app.inject({ method: 'POST', url: `/api/tasks/${id}/continue`, headers, payload: { version: '1' } })).statusCode, 400);
    result = await app.inject({ method: 'POST', url: `/api/tasks/${id}/continue`, headers, payload: { version: 1 } });
    assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().status, 'queued');
    assert.equal(result.json().currentStep, 'analyse');
    assert.equal((await app.inject({ method: 'POST', url: `/api/tasks/${id}/continue`, headers, payload: { version: 1 } })).statusCode, 409);
    assert.equal(continueCalls, 1, '重放请求不能再次恢复');
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/tasks/${id}/continue`, headers, payload: { version: 1 } })).statusCode, 404, '不提供管理员恢复入口');
    taskStatus = 'running';
    assert.equal((await app.inject({ method: 'POST', url: `/api/tasks/${id}/stop`, payload: { version: 1 } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: `/api/tasks/${randomUUID()}/stop`, headers, payload: { version: 1 } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `/api/tasks/${id}/stop`, headers, payload: { version: '1' } })).statusCode, 400);
    assert.equal(stopCalls, 0);
    assert.equal((await app.inject({ method: 'POST', url: `/api/tasks/${id}/stop`, headers, payload: { version: 2 } })).statusCode, 409);
    result = await app.inject({ method: 'POST', url: `/api/tasks/${id}/stop`, headers, payload: { version: 1 } });
    assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().status, 'cancelling');
    taskStatus = 'interrupted';
    assert.equal((await app.inject({ method: 'POST', url: `/api/tasks/${id}/stop`, headers, payload: { version: 1 } })).statusCode, 409);
    const { publicTask } = require('../apps/server/src/modules/tasks/routes');
    assert.equal(publicTask({ status: 'interrupted', cancel_requested: 1 }).cancelRequested, false, '终态旧停止标志不显示正在停止');
    assert.equal(publicTask({ status: 'running', cancel_requested: 1 }).cancelRequested, true);
    assert.equal((await app.inject({ url: '/api/not-a-route', headers })).statusCode, 404);
    console.log('真实 buildApp 任务注册、会话鉴权、管理员隔离与恢复登录校验通过');
  } finally { taskRepo.continueInterruptedTask = originalContinue; taskRepo.requestStopTask = originalStop; await app.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

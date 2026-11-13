const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const repo = require('../packages/shared/runtime/repos/tasks');
const { jobWorkspace, readJobLog } = require('../apps/server/src/modules/jobs/routes');
const { resultsFor } = require('../apps/server/src/modules/jobs/routes');

function fakeDb({ conflict = false } = {}) {
  const state = { task: { id: 'task', user_id: 1, status: 'queued', version: 1 }, file: { id: 'file', version: 1, excluded_at: null } };
  let locks = 0;
  const trx = {
    selectFrom(table) {
      return { selectAll() { return this; }, where() { return this; },
        forUpdate() { locks++; return this; },
        async executeTakeFirst() { return table === 'ruyi_tasks' ? { ...state.task } : { ...state.file }; },
        async execute() { return [{ ...state.file }]; } };
    },
    updateTable(table) {
      return { set(values) { this.values = values; return this; }, where() { return this; },
        async executeTakeFirst() {
          if (table === 'ruyi_tasks' && conflict) return { numUpdatedRows: 0n };
          if (table === 'ruyi_task_files') state.file.excluded_at = new Date();
          else Object.assign(state.task, this.values);
          return { numUpdatedRows: 1n };
        } };
    },
  };
  return { state, get locks() { return locks; }, transaction() { return { async execute(fn) {
    const before = { task: { ...state.task }, file: { ...state.file } };
    try { return await fn(trx); } catch (error) { Object.assign(state, before); throw error; }
  } }; } };
}

async function main() {
  await testStopAndFinish();
  await testContinueInterrupted();
  const db = fakeDb({ conflict: true });
  await assert.rejects(repo.excludeTaskFile(db, { taskId: 'task', fileId: 'file', userId: 1, version: 1 }), /回滚/);
  assert.equal(db.state.file.excluded_at, null, '任务状态冲突不能提交部分文件删除');
  assert.equal(db.locks, 1, '删除文件前必须锁定任务行，与认领 UPDATE 互斥');
  const last = fakeDb();
  assert.equal((await repo.excludeTaskFile(last, { taskId: 'task', fileId: 'file', userId: 1 })).last, true);
  assert.equal(last.state.task.status, 'cancelled', '删除最后一个文件取消任务');
  const deleted = fakeDb();
  assert.equal((await repo.deleteTask(deleted, { id: 'task', userId: 1 })).status, 'deleted');
  assert.equal(deleted.locks, 1, '删除任务必须锁定行，不能越过认领竞态');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruyi-task-log-'));
  const row = { id: randomUUID(), task_id: randomUUID(), username: 'test_user', status: 'succeeded' };
  row.log_path = `logs/${row.id}.log`;
  const workspace = jobWorkspace(row, root);
  assert.equal(workspace, path.join(root, 'users/test_user/tasks', row.task_id, 'execution'));
  await fs.mkdir(path.join(workspace, 'logs'), { recursive: true });
  await fs.writeFile(path.join(workspace, row.log_path), '合成任务日志\n');
  assert.equal((await readJobLog(row, root, 1024)).output, '合成任务日志\n');
  row.user_id = 1;
  const resultDir = path.join(workspace, 'job-results', row.id, 'files');
  await fs.mkdir(resultDir, { recursive: true });
  await fs.copyFile(path.join(workspace, row.log_path), path.join(resultDir, 'result.txt'));
  const resultFile = { job_id: row.id, name: 'result.txt', stored_path: 'files/result.txt', size_bytes: (await fs.stat(path.join(resultDir, 'result.txt'))).size };
  const resultDb = { selectFrom(table) { return { innerJoin() { return this; }, selectAll() { return this; }, select() { return this; }, where() { return this; }, orderBy() { return this; }, async execute() { return [resultFile]; }, async executeTakeFirst() {
    return table === 'ruyi_task_result_sets' ? { job_id: row.id, task_id: row.task_id, user_id: 1, sealed_at: new Date() } : { ...row, task: 'download' };
  } }; } };
  const reply = { code() { return this; }, send(value) { throw new Error(value.message); } };
  const archive = await resultsFor({ db: resultDb }, { params: { id: row.id }, user: { id: 1, username: row.username } }, reply, root);
  assert.equal(archive.entries.files.length, 1);
  assert.equal(archive.workspace, workspace, '下载结果必须使用任务独立归档而非用户根目录');
  assert.throws(() => jobWorkspace({ ...row, task_id: '../other' }, root), /编号无效/);
  console.log('任务删除事务回滚、认领互斥及任务日志目录测试通过');
}

async function testStopAndFinish() {
  const calls = [];
  const db = { updateTable(table) {
    const call = { table, where: [] }; calls.push(call);
    return { set(values) { call.values = values; return this; }, where(...condition) { call.where.push(condition); return this; },
        async executeTakeFirst() { return { numUpdatedRows: 1n }; } };
  } };
  assert.equal(await repo.requestStopTask(db, { id: 'task', userId: 7, version: 3 }), true);
  assert.ok(calls[0].values.cancel_requested, '停止请求应在原子写入中决定是否需要Worker退出');
  for (const condition of [['id', '=', 'task'], ['user_id', '=', 7], ['status', '=', 'running'], ['cancel_requested', '=', 0], ['version', '=', 3], ['deleted_at', 'is', null]]) {
    assert.ok(calls[0].where.some((candidate) => JSON.stringify(candidate) === JSON.stringify(condition)), `停止请求需校验${condition[0]}`);
  }
  await repo.finishTask(db, { id: 'task', claimToken: 'old-lease', status: 'interrupted' });
  const finish = calls[1];
  assert.equal(finish.values.cancel_requested, 0);
  const { Kysely, MysqlDialect, DummyDriver } = require('kysely');
  const compiled = [];
  class Driver extends DummyDriver { async acquireConnection() { return { async executeQuery(query) {
    compiled.push(query); return { rows: [], numAffectedRows: 1n };
  } }; } }
  const dialect = new MysqlDialect({ pool: {} }); dialect.createDriver = () => new Driver();
  const compilerDb = new Kysely({ dialect });
  try {
    for (const status of ['succeeded', 'failed', 'cancelled']) {
      await repo.finishTask(compilerDb, { id: 'task', claimToken: 'old-lease', status });
      const query = compiled.at(-1);
      assert.match(query.sql, /`status` = CASE WHEN cancel_requested = 1 THEN 'interrupted' ELSE \? END/);
      assert.ok(query.sql.indexOf('CASE WHEN cancel_requested') < query.sql.indexOf('`cancel_requested` = ?'), '先计算中断终态再清停止标志，兼容MySQL赋值次序');
      assert.equal(query.parameters[0], status);
    }
    await repo.updateTaskStep(compilerDb, { id: 'task', claimToken: 'old-lease', currentStep: 'download' });
    assert.match(compiled.at(-1).sql, /and `cancel_requested` = \?/);
    await repo.setTaskNextCheck(compilerDb, { id: 'task', claimToken: 'old-lease', nextCheckAt: null });
    assert.match(compiled.at(-1).sql, /and `cancel_requested` = \?/);
  } finally { await compilerDb.destroy(); }
  for (const key of ['claim_token', 'worker_id', 'heartbeat_at', 'next_check_at']) assert.equal(finish.values[key], null);
  assert.ok(finish.where.some(([column, , value]) => column === 'claim_token' && value === 'old-lease'), '旧Worker不能终结新租约');
  const staleDb = { transaction() { return { async execute(fn) { return fn({
    selectFrom() { return { selectAll() { return this; }, where() { return this; }, forUpdate() { return this; }, async execute() { return [{ id: 'stale' }]; } }; },
    updateTable() { return { set(values) { calls.push({ recovered: values }); return this; }, where() { return this; }, async execute() {} }; },
  }); } }; } };
  await repo.recoverStaleTasks(staleDb);
  const recovered = calls.at(-1).recovered;
  assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.cancel_requested, 0);
  for (const key of ['claim_token', 'worker_id', 'heartbeat_at', 'next_check_at']) assert.equal(recovered[key], null);
}

async function testContinueInterrupted() {
  const { Kysely, MysqlDialect } = require('kysely');
  const { DummyDriver } = require('kysely');
  // 使用真实 MySQL 编译器检查恢复 SQL；内存驱动只处理本测试创建的合成行。
  async function scenario({ status = 'interrupted', step = 'analyse', jobStatus = 'failed', active = false,
    deleted = false, userId = 1, version = 3, lock = true, conflict = false, throwQuery = false } = {}) {
    const row = { id: 'task', user_id: 1, status, current_step: step, version: 3, deleted_at: deleted ? new Date() : null };
    const statements = [];
    class Driver extends DummyDriver {
      async acquireConnection() { return { async executeQuery(query) {
        statements.push(query);
        const sql = query.sql;
        if (sql.includes('GET_LOCK')) return { rows: [{ acquired: lock ? 1 : 0 }] };
        if (sql.includes('RELEASE_LOCK')) return { rows: [] };
        if (sql.startsWith('select') && sql.includes('ruyi_tasks')) {
          if (throwQuery) throw new Error('合成数据库异常');
          return { rows: deleted || userId !== 1 ? [] : [{ ...row }] };
        }
        if (sql.startsWith('select `id`') && sql.includes('ruyi_jobs')) return { rows: active ? [{ id: 'active' }] : [] };
        if (sql.startsWith('select') && sql.includes('ruyi_jobs')) return { rows: jobStatus ? [{ status: jobStatus }] : [] };
        if (sql.startsWith('update')) return { rows: [], numAffectedRows: conflict ? 0n : 1n };
        return { rows: [] };
      } }; }
    }
    const dialect = new MysqlDialect({ pool: {} });
    dialect.createDriver = () => new Driver();
    const db = new Kysely({ dialect });
    try { return { result: await repo.continueInterruptedTask(db, { id: 'task', userId, version }), statements }; }
    catch (error) { return { error, statements }; }
    finally { await db.destroy(); }
  }
  const queued = await scenario();
  assert.deepEqual(queued.result, { ok: true, status: 'queued', currentStep: 'analyse', version: 4 });
  const update = queued.statements.find((q) => q.sql.startsWith('update'));
  assert.ok(update.sql.includes('`queued_at` = NOW(3)'), '继续任务应进入当前队尾');
  assert.ok(update.sql.includes('`version` = version + 1'));
  assert.ok(update.sql.includes('`status` = ? and `version` = ?'), '原状态与版本必须原子校验');
  assert.equal(update.sql.includes('started_at'), false, '保留原开始时间');
  assert.equal(update.sql.includes('queue_order'), false, '保留稳定平局次序');
  assert.equal(queued.statements.some((q) => q.sql.includes('ruyi_task_files')), false, '恢复不重置文件或stage');
  const columns = [...update.sql.matchAll(/`(\w+)` = \?/g)].slice(0, -4).map((match) => match[1]);
  const values = Object.fromEntries(columns.map((column, index) => [column, update.parameters[index]]));
  for (const column of ['finished_at', 'claim_token', 'worker_id', 'heartbeat_at', 'waiting_login_at', 'next_check_at', 'error_message']) {
    assert.equal(values[column], null, `${column}应清空`);
  }
  assert.equal(values.cancel_requested, 0);
  assert.ok(queued.statements.some((q) => q.sql.endsWith('for update')));
  assert.ok(queued.statements.at(-1).sql.includes('RELEASE_LOCK'));
  assert.equal((await scenario({ step: 'create', jobStatus: 'succeeded' })).result.currentStep, 'analyse');
  assert.equal((await scenario({ step: 'download', jobStatus: 'succeeded' })).result.status, 'succeeded');
  for (const jobStatus of ['failed', 'interrupted', null]) {
    assert.equal((await scenario({ jobStatus })).result.currentStep, 'analyse', '非成功步骤从checkpoint继续');
  }
  for (const status of ['queued', 'running', 'waiting_login', 'succeeded', 'failed', 'cancelled']) {
    const rejected = await scenario({ status }); assert.equal(rejected.result.reason, 'status');
    assert.equal(rejected.statements.some((q) => q.sql.startsWith('update')), false);
  }
  assert.equal((await scenario({ active: true })).result.reason, 'active_job');
  assert.equal((await scenario({ version: 2 })).result.reason, 'version');
  assert.equal((await scenario({ conflict: true })).result.reason, 'conflict', '并发版本失败不能成功入队');
  assert.equal((await scenario({ userId: 2 })).result.reason, 'not_found');
  assert.equal((await scenario({ deleted: true })).result.reason, 'not_found');
  const denied = await scenario({ lock: false });
  assert.equal(denied.result.reason, 'conflict'); assert.equal(denied.statements.length, 1);
  const errored = await scenario({ throwQuery: true });
  assert.match(errored.error.message, /合成数据库异常/);
  assert.ok(errored.statements.at(-1).sql.includes('RELEASE_LOCK'), '异常必须释放同连接命名锁');
  console.log('中断任务继续、已完成步骤跳过、下载收敛、版本与权限保护 SQL 测试通过');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

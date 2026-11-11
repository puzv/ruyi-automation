const assert = require('node:assert/strict');
const { listLogs } = require('../apps/server/src/modules/audit/routes');
const { auditResponse } = require('../apps/server/src/modules/audit/actions');
const { Kysely, DummyDriver, MysqlAdapter, MysqlQueryCompiler, MysqlIntrospector } = require('kysely');

async function main() {
  const wait = (id, overrides = {}) => ({ id, user_id: 7, action: 'job.finish', result: 'failure',
    created_at: `2026-11-10 10:${String(id % 60).padStart(2, '0')}:00`,
    detail: { taskId: 'task-a', task: 'analyse', status: 'waiting_platform', outcome: 'not_ready', code: 2 }, ...overrides });
  const rows = Array.from({ length: 450 }, (_, i) => wait(500 - i));
  rows.push({ id: 50, user_id: 7, action: 'task.stop', result: 'success', created_at: '2026-11-10 09:00:00' });
  rows.push(wait(49), wait(48), wait(47, { user_id: 8 }), wait(46, { detail: { taskId: 'task-a', task: 'download', status: 'waiting_platform', outcome: 'not_ready', code: 2 } }));
  const queries = [];
  const db = { selectFrom(table) {
    const q = { conditions: [], size: Infinity,
      where(...args) { return Object.assign(Object.create(this), { conditions: [...this.conditions, args] }); },
      selectAll() { return this; }, select() { return this; }, orderBy() { return this; },
      limit(size) { return Object.assign(Object.create(this), { size }); },
      async execute() {
        queries.push({ table, size: this.size, conditions: this.conditions });
        if (table === 'ruyi_jobs') return [];
        return rows.filter((row) => this.conditions.every(([col, op, value]) => op === '=' ? String(row[col]) === String(value)
          : op === '<=' ? row[col] <= Number(value) : op === '<' ? row[col] < Number(value) : true)).slice(0, this.size);
      } };
    return q;
  } };
  const paging = { page: 1, pageSize: 2 };
  let result = await listLogs(db, {}, paging, true);
  assert.equal(result.total, 5);
  assert.equal(result.rawTotal, 455);
  assert.deepEqual(result.items.map((item) => item.id), [500, 50]);
  assert.equal(result.items[0].waitGroup.count, 450, '跨越多个原始分页合成一个展示条目');
  assert.equal(result.items[0].waitGroup.first, '2026-11-10 10:00:00');
  assert.equal(result.items[0].waitGroup.last, '2026-11-10 10:59:00', '时间范围不假定主键与时间单调一致');
  assert.ok(queries.filter((q) => q.table === 'ruyi_operation_logs').every((q) => q.size === 200));
  result = await listLogs(db, { snapshot: '500' }, { page: 2, pageSize: 2 }, true);
  assert.deepEqual(result.items.map((item) => item.id), [49, 47]);
  result = await listLogs(db, { groupId: '500', snapshot: '500' }, { page: 23, pageSize: 20 }, true);
  assert.equal(result.total, 450);
  assert.equal(result.items.length, 10, '原始明细最后一页可访问，不截断大分组');
  assert.deepEqual(result.items.map((item) => item.id), Array.from({ length: 10 }, (_, i) => 60 - i));
  result = await listLogs(db, { groupId: '47' }, paging, false, 7);
  assert.equal(result.total, 0, '原始明细沿用用户权限');
  result = await listLogs(db, { action: 'job.finish' }, { page: 1, pageSize: 20 }, true);
  assert.equal(result.total, 4, '被筛选隐藏的停止记录仍打断连续分组');
  assert.equal(result.items[0].waitGroup.count, 450);
  assert.equal(result.items[1].waitGroup.count, 2);
  rows.unshift(wait(501));
  result = await listLogs(db, { snapshot: '500' }, paging, true);
  assert.equal(result.items[0].waitGroup.count, 450, '新增记录不改变已有浏览快照');
  let audit;
  const auditApp = { auditEnabled: true, db: { insertInto(table) {
    assert.equal(table, 'ruyi_operation_logs');
    return { values(value) { audit = value; return this; }, async execute() {} };
  } } };
  const request = { method: 'POST', routeOptions: { url: '/api/transfer/upload/:ticket' },
    user: { id: 7, username: '测试用户' }, params: { ticket: 'never-record-ticket' },
    auditTask: { id: 'new-task', name: '任务名', count: 1, skipped: 0, files: ['example_oaid.txt'], secret: 'never-record-secret' } };
  await auditResponse.call(auditApp, request, { statusCode: 200 }, JSON.stringify({ ok: true }));
  assert.equal(audit.action, 'task.create'); assert.equal(audit.target_type, 'task'); assert.equal(audit.target_id, 'new-task');
  assert.deepEqual(JSON.parse(audit.detail), { name: '任务名', count: 1, skipped: 0, files: ['example_oaid.txt'], via: 'transfer_ticket' });
  assert.ok(!JSON.stringify(audit).includes('never-record'));
  await auditResponse.call(auditApp, { ...request, auditTask: undefined }, { statusCode: 500 }, JSON.stringify({ ok: false, message: 'never-record-secret' }));
  assert.equal(audit.result, 'failure'); assert.equal(audit.error_message, '任务创建失败，请重新获取链接');
  const compiled = [];
  class CaptureDriver extends DummyDriver {
    async acquireConnection() { return { async executeQuery(query) { compiled.push(query); return { rows: [] }; } }; }
  }
  const sqlDb = new Kysely({ dialect: {
    createDriver: () => new CaptureDriver(), createAdapter: () => new MysqlAdapter(),
    createQueryCompiler: () => new MysqlQueryCompiler(), createIntrospector: (database) => new MysqlIntrospector(database),
  } });
  try {
    await listLogs(sqlDb, { snapshot: '500', username: 'alice', from: '2026-11-10', to: '2026-11-10' }, paging, true);
    assert.equal(compiled.length, 1);
    assert.match(compiled[0].sql, /order by `id` desc limit \?/);
    assert.match(compiled[0].sql, /`id` <= \?/);
    assert.deepEqual(compiled[0].parameters, ['alice', '2026-11-10 00:00:00', '2026-11-11 00:00:00', '500', 200]);
    assert.ok(!/\b(with|over|skip locked|nowait)\b/i.test(compiled[0].sql), '生成 SQL 兼容 MySQL 5.7');
  } finally { await sqlDb.destroy(); }
  console.log('操作记录先分组再分页、跨扫描批次聚合、全部原始明细分页和权限测试通过');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

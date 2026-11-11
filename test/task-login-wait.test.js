const assert = require('node:assert/strict');
const repo = require('../packages/shared/runtime/repos/tasks');

function fakeDb(initial) {
  const tables = { ruyi_tasks: initial.map((row) => ({ deleted_at: null, cancel_requested: 0, ...row })) };
  const matches = (row, conditions) => conditions.every(([field, op, value]) => op === '=' ? row[field] === value
    : op === 'is' ? (value === null ? row[field] == null : row[field] != null)
      : op === 'in' ? value.includes(row[field]) : true);
  class Query {
    constructor(table, kind) { this.table = table; this.kind = kind; this.conditions = []; this.values = {}; this.orders = []; }
    selectAll() { return this; } forUpdate() { return this; } select(value) { if (typeof value === 'function') this.aggregate = value({ fn: { max: (field) => ({ __max: field, as() { return this; } }) } }); return this; }
    where(field, op, value) { this.conditions.push([field, op, value]); return this; }
    orderBy(field, direction) { this.orders.push([field, direction]); return this; }
    set(values) { this.values = values; return this; }
    rows() { let rows = tables[this.table].filter((r) => matches(r, this.conditions));
      for (const [field, direction] of this.orders) rows.sort((a, b) => (a[field] ?? 0) > (b[field] ?? 0) ? (direction === 'desc' ? -1 : 1) : (direction === 'desc' ? 1 : -1));
      return rows; }
    async execute() { if (this.kind === 'update') { const rows = this.rows(); for (const row of rows) Object.assign(row, Object.fromEntries(Object.entries(this.values).map(([k, v]) => [k, (k === 'queued_at' && typeof v !== 'object') ? v : k === 'queued_at' ? new Date() : v] ))); return { numUpdatedRows: BigInt(rows.length) }; } return this.rows(); }
    async executeTakeFirst() { const result = await this.execute(); if (this.aggregate?.__max) return { maxOrder: Math.max(...tables[this.table].map((r) => Number(r[this.aggregate.__max] || 0))) }; return this.kind === 'update' ? result : result[0]; }
  }
  const conn = { getExecutor() { return { transformQuery: (q) => q, compileQuery: (q) => q, executeQuery: async () => ({ rows: [{ acquired: 1 }], numAffectedRows: 1n }) }; }, executeQuery: async () => ({ rows: [{ acquired: 1 }], numAffectedRows: 1n }),
    selectFrom: (table) => new Query(table, 'select'), updateTable: (table) => new Query(table, 'update'),
    transaction: () => ({ execute: (fn) => fn(conn) }) };
  return { tables, connection: () => ({ execute: (fn) => fn(conn) }) };
}

async function main() {
  const db = fakeDb([
    { id: 'a', user_id: 1, status: 'running', claim_token: 'claim', queue_order: 1 },
    { id: 'b', user_id: 1, status: 'queued', queue_order: 2 },
    { id: 'c', user_id: 1, status: 'waiting_login', waiting_login_at: new Date(1), queue_order: 3 },
    { id: 'd', user_id: 1, status: 'succeeded', queue_order: 4 },
    { id: 'x', user_id: 2, status: 'queued', queue_order: 5 },
  ]);
  assert.equal(await repo.markUserWaitingLogin(db, { id: 'a', userId: 1, claimToken: 'expired-token' }), false);
  assert.equal(db.tables.ruyi_tasks[1].status, 'queued', '失效租约不能冻结其他任务');
  await repo.markUserWaitingLogin(db, { id: 'a', userId: 1, claimToken: 'claim' });
  assert.deepEqual(db.tables.ruyi_tasks.map((r) => r.status), ['waiting_login', 'waiting_login', 'waiting_login', 'succeeded', 'queued']);
  assert.equal(db.tables.ruyi_tasks[3].status, 'succeeded', '终态不能被登录失效覆盖');
  const before = db.tables.ruyi_tasks.filter((r) => r.user_id === 1).map((r) => r.queue_order);
  assert.deepEqual(before, [1, 2, 3, 4]);
  const resumed = await repo.resumeUserWaitingLogin(db, { userId: 1 });
  assert.equal(resumed, 3);
  assert.deepEqual(db.tables.ruyi_tasks.map((r) => r.status), ['queued', 'queued', 'queued', 'succeeded', 'queued']);
  assert.ok(db.tables.ruyi_tasks.filter((r) => r.user_id === 1 && r.status === 'queued').every((r) => r.waiting_login_at == null));
  assert.ok(new Set(db.tables.ruyi_tasks.map((r) => r.queue_order)).size === 5, '恢复保留唯一队列序号，避免与并发创建的自增值冲突');
  assert.equal(db.tables.ruyi_tasks.find((r) => r.id === 'x').status, 'queued', '跨用户任务不受影响');
  console.log('阶段3登录失效冻结、同用户队列恢复、终态保护与跨用户隔离测试通过。');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

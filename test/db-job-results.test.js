const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const results = require('../packages/shared/runtime/db-job-results');

function memoryDb(tables) {
  function query(table, mode) {
    const predicates = [];
    let values;
    const q = {
      selectAll() { return q; }, select() { return q; }, forUpdate() { return q; }, orderBy() { return q; },
      where(key, operator, value) { predicates.push((row) => operator === 'is' ? row[key] == value : row[key] === value); return q; },
      values(value) { values = value; return q; }, set(value) { values = value; return q; },
      async execute() {
        const rows = tables[table] || (tables[table] = []);
        if (mode === 'insert') {
          if (db.failInsert === table) throw new Error('模拟数据库写入失败');
          rows.push({ sealed_at: null, ...values }); return [];
        }
        const matches = rows.filter((row) => predicates.every((predicate) => predicate(row)));
        if (mode === 'update') { for (const row of matches) Object.assign(row, values); return [{ numUpdatedRows: matches.length }]; }
        return matches.map((row) => ({ ...row }));
      },
      async executeTakeFirst() { return (await q.execute())[0]; },
    };
    return q;
  }
  const db = {
    selectFrom: (table) => query(table, 'select'), insertInto: (table) => query(table, 'insert'), updateTable: (table) => query(table, 'update'),
    transaction: () => ({ execute: async (action) => {
      const snapshot = structuredClone(tables);
      try { return await action(db); } catch (error) { for (const key of Object.keys(tables)) tables[key] = snapshot[key] || []; throw error; }
    } }),
  };
  return db;
}

async function main() {
  await testMigrationSql();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-db-results-'));
  const workspace = path.join(root, 'execution');
  fs.mkdirSync(workspace);
  const taskId = randomUUID(), first = randomUUID(), second = randomUUID(), fileId = randomUUID();
  const claimToken = randomUUID(), taskClaimToken = randomUUID();
  const tables = {
    ruyi_tasks: [{ id: taskId, user_id: 1, status: 'running', deleted_at: null, cancel_requested: 0, claim_token: taskClaimToken }],
    ruyi_jobs: [first, second].map((id) => ({ id, task_id: taskId, user_id: 1, task: 'download', status: 'running', cancel_requested: 0, claim_token: claimToken })),
    ruyi_task_files: [{ id: fileId, task_id: taskId, user_id: 1, excluded_at: null, stage: 'analysed' }],
    ruyi_task_result_sets: [], ruyi_task_results: [],
  };
  const db = memoryDb(tables), context = { db, taskId, userId: 1, claimToken, taskClaimToken, fileId };
  const source = path.join(root, '结果.xlsx');
  fs.writeFileSync(source, 'fake-result');
  try {
    await results.beginResults(workspace, first, context);
    await assert.rejects(results.resultEntries(workspace, first, context), /没有可下载/);
    await assert.rejects(results.recordResult(workspace, first, source, '结果.xlsx', { ...context, taskClaimToken: randomUUID() }), /租约/);
    await assert.rejects(results.recordResult(workspace, first, source, '结果.xlsx', { ...context, claimToken: randomUUID() }), /租约/);
    await assert.rejects(results.recordResult(workspace, first, source, '../逃逸.xlsx', context), /文件名/);
    db.failInsert = 'ruyi_task_results';
    await assert.rejects(results.recordResult(workspace, first, source, '结果.xlsx', context), (error) => error.code === 'TASK_DATABASE_ERROR' && !error.message.includes('模拟'));
    assert.equal(fs.existsSync(path.join(workspace, 'job-results', first, 'files', '结果.xlsx')), false, '数据库回滚时删除新建副本');
    db.failInsert = null;
    assert.equal(tables.ruyi_task_files[0].stage, 'analysed', '失败事务不能推进文件阶段');
    await results.recordResult(workspace, first, source, '结果.xlsx', context);
    assert.equal(tables.ruyi_task_files[0].stage, 'downloaded', '结果索引与下载完成阶段应原子提交');
    await assert.rejects(results.recordResult(workspace, first, source, '结果.xlsx', context), /重名/);
    assert.equal(await results.finishResults(workspace, first, context), 1);
    assert.equal(await results.sealResults(workspace, first, context), 1);
    await assert.rejects(results.recordResult(workspace, first, source, '另一个.xlsx', context), /封存/);
    const entries = await results.resultEntries(workspace, first, context);
    assert.equal(entries.files[0].fileId, fileId);
    const chunks = [];
    for await (const chunk of results.zipStream(workspace, first, entries)) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).length, entries.size);
    assert.equal(fs.existsSync(path.join(workspace, 'job-results', first, 'manifest.json')), false, '不得产生 JSON 结果索引');
    await assert.rejects(results.resultEntries(workspace, first, { ...context, userId: 2 }), /不存在/);
    await results.beginResults(workspace, second, context);
    tables.ruyi_jobs[0].status = 'interrupted';
    assert.equal(await results.carryResults(workspace, second, [first], context), 1);
    await results.finishResults(workspace, second, context);
    assert.equal((await results.resultEntries(workspace, second, context)).files.length, 1);
    const stopped = randomUUID();
    tables.ruyi_jobs.push({ ...tables.ruyi_jobs[1], id: stopped });
    await results.beginResults(workspace, stopped, context);
    await results.recordResult(workspace, stopped, source, '停止前.xlsx', context);
    tables.ruyi_tasks[0].cancel_requested = 1;
    tables.ruyi_jobs[2].cancel_requested = 1;
    await assert.rejects(results.recordResult(workspace, stopped, source, '不可追加.xlsx', context), /租约/);
    assert.equal(await results.sealResults(workspace, stopped, context), 1, '仍持有双租约的停止任务可封存部分成果');
    tables.ruyi_tasks[0].cancel_requested = 0;
    tables.ruyi_jobs[2].status = 'interrupted';
    tables.ruyi_task_result_sets[2].sealed_at = null;
    const resumed = randomUUID();
    tables.ruyi_jobs.push({ ...tables.ruyi_jobs[1], id: resumed });
    await results.beginResults(workspace, resumed, context);
    assert.equal(await results.carryResults(workspace, resumed, [stopped, randomUUID()], context), 1, '崩溃未封存但已提交的完整结果也应恢复，旧无索引轮次跳过');
    tables.ruyi_tasks[0].deleted_at = new Date();
    await assert.rejects(results.resultEntries(workspace, first, context), /不存在/);
    tables.ruyi_tasks[0].deleted_at = null;
    tables.ruyi_task_results[0].stored_path = '../逃逸.xlsx';
    await assert.rejects(results.resultEntries(workspace, first, context), /清单无效/);
    console.log('数据库结果索引、租约校验、封存、跨轮次恢复、ZIP 与归属测试通过');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testMigrationSql() {
  const { Kysely, MysqlDialect, DummyDriver } = require('kysely');
  const queries = [];
  class Driver extends DummyDriver {
    async acquireConnection() { return { async executeQuery(query) { queries.push(query.sql); return { rows: [] }; } }; }
  }
  const dialect = new MysqlDialect({ pool: {} });
  dialect.createDriver = () => new Driver();
  const db = new Kysely({ dialect });
  try {
    await require('../db/migrations/20261110_010_create_task_results').up(db);
    assert.equal(queries.length, 2);
    for (const query of queries) {
      assert.match(query, /DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci/);
      assert.doesNotMatch(query, /SKIP LOCKED|NOWAIT|WITH\s|0900_ai/);
    }
    assert.match(queries[1], /file_id CHAR\(36\) NOT NULL/);
    assert.match(queries[1], /UNIQUE KEY uk_ruyi_result_name/);
  } finally { await db.destroy(); }
}
module.exports = main();
module.exports.catch((error) => { console.error(error); process.exitCode = 1; });

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Kysely, DummyDriver, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler } = require('kysely');
const { summarizeBatch } = require('@ruyi/shared/runtime/job-batches');
const batches = require('@ruyi/shared/runtime/repos/job-batches');
const jobs = require('@ruyi/shared/runtime/repos/jobs');

function recordingDb(responses, queries) {
  class Driver extends DummyDriver {
    async acquireConnection() {
      return { async executeQuery(query) { queries.push(query); return { rows: responses.shift() || [] }; } };
    }
  }
  return new Kysely({ dialect: {
    createAdapter: () => new MysqlAdapter(), createDriver: () => new Driver(),
    createIntrospector: (db) => new MysqlIntrospector(db), createQueryCompiler: () => new MysqlQueryCompiler(),
  } });
}

async function main() {
  const record = (id, task, status = 'succeeded', extra = {}) => ({ id, task, status, username: 'alice', queuedAt: id, ...extra });
  const upload = record('upload-a', 'upload');
  const create = record('create-a', 'create');
  const analyse = record('analyse-a', 'analyse');
  const download = record('download-a', 'download');
  const summary = summarizeBatch(upload.id, [upload, create, analyse, download]);
  assert.equal(summary.shortId, createHash('sha256').update(upload.id).digest('hex').slice(0, 8));
  assert.equal(summary.status, 'succeeded');
  assert.equal(summary.completedSteps, 4);
  assert.equal(summary.legacy, false);
  assert.equal(summarizeBatch(upload.id, [upload]).status, 'waiting');
  assert.equal(summarizeBatch('old', [create]).legacy, true);
  for (const status of ['running', 'queued', 'failed', 'cancelled', 'interrupted']) {
    assert.equal(summarizeBatch(upload.id, [upload, { ...create, status }]).status, status);
  }
  const retried = summarizeBatch(upload.id, [upload, { ...create, status: 'failed' }, { ...create, id: 'retry' }]);
  assert.equal(retried.status, 'waiting');
  assert.equal(retried.steps[1].id, 'retry');
  assert.equal(retried.records.length, 3);
  assert.equal(retried.steps[2].status, 'pending');

  const queries = [];
  const db = recordingDb([[{ total: '21' }], [{ batch_id: 'u2', user_id: 7 }], [
    { id: 'u2', task: 'upload', batch_id: 'u2', user_id: 7 },
    { id: 'c2', task: 'create', batch_id: 'u2', user_id: 7 },
  ]], queries);
  try {
    const result = await batches.listJobBatches(db, { userId: 7, status: 'waiting', page: 2, pageSize: 20 });
    assert.equal(result.total, 21);
    assert.deepEqual(result.items[0].rows.map((row) => row.id), ['u2', 'c2']);
    assert.equal(queries.length, 3);
    for (const query of queries) {
      assert.match(query.sql, /u\.user_id = j\.user_id/);
      assert.match(query.sql, /u\.queued_at <= j\.queued_at/);
      assert.match(query.sql, /`j`\.`user_id` = \?/);
      assert.ok(query.parameters.includes(7));
      assert.doesNotMatch(query.sql, /SKIP LOCKED|NOWAIT|\bWITH\b|OVER\s*\(/i);
    }
    assert.match(queries[0].sql, /`batch_status` = \?/);
    assert.ok(queries[0].parameters.includes('waiting'));
    assert.match(queries[1].sql, /limit \? offset \?/);
    assert.deepEqual(queries[1].parameters.slice(-2), [20, 20]);
    assert.doesNotMatch(queries[2].sql, /limit \?|batch_status/i, '批次详情不可分页或按流程状态截断');
    assert.ok(queries[2].parameters.includes('u2'));
  } finally { await db.destroy(); }
  const emptyDb = recordingDb([[{ total: 0 }], []], []);
  try { assert.deepEqual(await batches.listJobBatches(emptyDb), { items: [], total: 0 }); }
  finally { await emptyDb.destroy(); }

  const originalList = batches.listJobBatches, originalGet = jobs.getJob;
  const calls = [], routes = new Map();
  batches.listJobBatches = async (_db, options) => {
    calls.push(options);
    return { items: [{ id: 'upload-a', rows: [{ id: 'upload-a', task: 'upload', status: 'succeeded', username: 'alice' },
      { id: 'create-a', task: 'create', status: 'failed', username: 'alice' }] }], total: 1 };
  };
  jobs.getJob = async () => null;
  const modulePath = require.resolve('@ruyi/server/src/modules/jobs/routes');
  delete require.cache[modulePath];
  try {
    const { registerJobRoutes } = require(modulePath);
    await registerJobRoutes({ db: {}, get(url, handler) { routes.set(url, handler); }, post() {} }, {});
    const reply = { code(value) { this.status = value; return this; }, send(value) { return value; } };
    const mine = await routes.get('/api/jobs')({ query: { grouped: '1', page: '1' }, user: { id: 7 } }, reply);
    assert.equal(calls[0].userId, 7);
    assert.equal(mine.total, 1);
    assert.equal(mine.items[0].records.length, 2);
    assert.equal(mine.items[0].status, 'failed');
    await routes.get('/api/admin/jobs')({ query: { grouped: '1', username: 'alice', status: 'waiting' } }, reply);
    assert.equal(calls[1].username, 'alice');
    assert.equal(calls[1].status, 'waiting');
    assert.equal(calls[1].userId, undefined);
    await routes.get('/api/jobs')({ query: { page: '0', grouped: '1' } }, reply);
    assert.equal(reply.status, 400);
    await routes.get('/api/admin/jobs')({ query: { grouped: '1', status: 'invalid' } }, reply);
    assert.equal(reply.status, 400);
    await routes.get('/api/admin/jobs/:id/log')({ params: { id: 'missing' } }, reply);
    assert.equal(reply.status, 404);
  } finally {
    batches.listJobBatches = originalList; jobs.getJob = originalGet;
    delete require.cache[modulePath];
  }
  console.log('批次进度、重试、分页 SQL、用户隔离与分组接口测试通过。');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

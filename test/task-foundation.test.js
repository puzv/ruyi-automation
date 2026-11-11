const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { createRequire } = require('node:module');
const { Kysely, MysqlDialect, DummyDriver } = require('kysely');
const Fastify = createRequire(require.resolve('@ruyi/server/package.json'))('fastify');
const { registerRoutes } = require('@ruyi/server/src/modules/files/routes');
const { createFromMultipart } = require('@ruyi/server/src/modules/tasks/import');
const { loadKeys, encryptState } = require('@ruyi/shared/runtime/platform-state/crypto');
const { getWorkspaceStatus } = require('@ruyi/shared/runtime/workspace');
const taskWorkspace = require('@ruyi/shared/runtime/task-workspace');
const repo = require('@ruyi/shared/runtime/repos/tasks');

function fakeDb() {
  const tables = { ruyi_tasks: [], ruyi_task_files: [], ruyi_jobs: [] };
  let failFiles = false;
  const db = {
    tables,
    set failFiles(value) { failFiles = value; },
    selectFrom(table) { return query(table); },
    insertInto(table) { return { values(rows) { this.rows = Array.isArray(rows) ? rows : [rows]; return this; }, async execute() {
      if (table === 'ruyi_task_files' && failFiles) { const error = new Error('sensitive SQL'); error.code = 'ER_TEST'; throw error; }
      tables[table].push(...this.rows.map((row) => ({ version: 1, deleted_at: null, excluded_at: null,
        created_at: new Date(), queued_at: new Date(), ...row }))); return [];
    } }; },
    updateTable(table) { return query(table); },
    transaction() { return { async execute(fn) {
      const before = Object.fromEntries(Object.entries(tables).map(([key, rows]) => [key, rows.map((row) => ({ ...row }))]));
      try { return await fn(db); } catch (error) { for (const key of Object.keys(tables)) tables[key] = before[key]; throw error; }
    } }; },
  };
  function query(table) {
    const conditions = []; let count = false, offset = 0, limit = Infinity, values;
    const orders = [];
    const q = {
      select(value) { if (typeof value === 'function') count = true; return q; }, selectAll() { return q; },
      where(key, op, value) { conditions.push((row) => op === 'is' ? row[key] == null : row[key] === value); return q; },
      orderBy(key, direction) { orders.push([key, direction]); return q; },
      limit(value) { limit = value; return q; }, offset(value) { offset = value; return q; },
      set(value) { values = value; return q; },
      async execute() {
        let rows = (tables[table] || []).filter((row) => conditions.every((test) => test(row)));
        if (count) return [{ total: rows.length }];
        rows = [...rows].sort((a, b) => {
          for (const [key, direction] of orders) { if (a[key] < b[key]) return direction === 'desc' ? 1 : -1; if (a[key] > b[key]) return direction === 'desc' ? -1 : 1; }
          return 0;
        });
        return rows.slice(offset, offset + limit);
      },
      async executeTakeFirst() {
        if (values) {
          const rows = tables[table].filter((row) => conditions.every((test) => test(row)));
          for (const row of rows) { row.name = values.name; row.version++; }
          return { numUpdatedRows: BigInt(rows.length) };
        }
        return (await q.execute())[0];
      }, async executeTakeFirstOrThrow() { const result = await q.executeTakeFirst(); assert.ok(result); return result; },
    };
    return q;
  }
  return db;
}

function multipart(files, name) {
  const boundary = 'task-foundation-boundary';
  let payload = name === undefined ? '' : `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n`;
  for (const file of files) payload += `--${boundary}\r\nContent-Disposition: form-data; name="${file.field || 'files'}"; filename="${file.name}"\r\nContent-Type: text/plain\r\n\r\n${file.content || 'fake-data'}\r\n`;
  payload += `--${boundary}--\r\n`;
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload };
}

async function routeTests() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-task-foundation-'));
  const db = fakeDb(), keys = loadKeys({ RUYI_STATE_KEY: randomBytes(32).toString('base64') });
  let user = { id: 71, username: 'task_alice', role: 'user' }, loggedIn = false, stateReads = 0, expireAtRead;
  const encrypted = encryptState({ cookies: [], origins: [] }, user.id, keys);
  const originalSelect = db.selectFrom;
  db.selectFrom = (table) => table !== 'ruyi_platform_states' ? originalSelect(table) : {
    selectAll() { return this; }, where() { return this; }, async executeTakeFirst() {
      stateReads++;
      return loggedIn && stateReads !== expireAtRead ? { status: 'valid', state_ciphertext: encrypted.ciphertext,
        key_version: encrypted.keyVersion, version: 1 } : undefined;
    },
  };
  const app = Fastify({ logger: false });
  app.decorate('db', db); app.decorate('stateKeys', keys); app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => { req.user = user; });
  app.register(registerRoutes, { auth: true, uploadRoot: root });
  const upload = (files = [{ name: 'same_oaid.txt' }], name) => app.inject({ method: 'POST', url: '/api/tasks', ...multipart(files, name) });
  try {
    let result = await upload();
    assert.equal(result.statusCode, 409); assert.equal(result.json().code, 'PLATFORM_LOGIN_REQUIRED');
    assert.deepEqual(fs.readdirSync(root), []);
    loggedIn = true;
    result = await upload(); assert.equal(result.statusCode, 201, result.body);
    const first = result.json().item;
    assert.equal(first.name, first.id); assert.equal(first.status, 'queued'); assert.equal(first.fileCount, 1);
    const file = db.tables.ruyi_task_files[0];
    assert.equal(file.original_name, 'same_oaid.txt'); assert.equal(file.original_name_key.toString(), 'same_oaid.txt');
    assert.equal(file.file_type, 'oaid'); assert.equal(file.size_bytes, 9); assert.match(file.content_sha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.statSync(path.join(root, 'users/task_alice/tasks', first.id, file.current_path)).mode & 0o777, 0o600);
    assert.equal(db.tables.ruyi_jobs.length, 0);
    assert.equal(getWorkspaceStatus(path.join(root, 'users/task_alice')).rawCount, 0, '旧状态统计不得扫描任务文件');
    result = await upload(undefined, '自定义任务'); assert.equal(result.statusCode, 201);
    assert.equal(result.json().item.name, '自定义任务'); assert.notEqual(result.json().item.id, first.id);
    assert.equal(db.tables.ruyi_task_files.length, 2, '不同任务允许同名文件');
    const parallel = await Promise.all(['first-content', 'second-content'].map((content) => upload([{ name: 'parallel_pn.txt', content }])));
    for (const [index, response] of parallel.entries()) {
      assert.equal(response.statusCode, 201, response.body);
      const record = db.tables.ruyi_task_files.find((row) => row.task_id === response.json().item.id);
      assert.equal(fs.readFileSync(path.join(root, 'users/task_alice/tasks', record.task_id, record.current_path), 'utf8'), ['first-content', 'second-content'][index]);
    }
    const lateName = multipart([{ name: 'late_pn.txt' }]);
    lateName.payload = lateName.payload.replace('--task-foundation-boundary--\r\n', '--task-foundation-boundary\r\nContent-Disposition: form-data; name="name"\r\n\r\n文件后的名称\r\n--task-foundation-boundary--\r\n');
    result = await app.inject({ method: 'POST', url: '/api/tasks', ...lateName });
    assert.equal(result.statusCode, 201, result.body); assert.equal(result.json().item.name, '文件后的名称');
    const initialCount = db.tables.ruyi_tasks.length;
    for (const names of [['duplicate_pn.txt', 'duplicate_pn.txt'], ['café_oaid.txt', 'café_oaid.txt']]) {
      result = await upload(names.map((name) => ({ name })));
      assert.equal(result.statusCode, 400, result.body); assert.match(result.json().message, /重名/);
    }
    result = await upload([{ name: 'same_pn.txt' }, { name: 'same_pn.csv' }]);
    assert.equal(result.statusCode, 400); assert.match(result.json().message, /下载结果会重名/);
    result = await upload([{ name: 'unrecognized.txt' }]); assert.equal(result.statusCode, 400);
    result = await upload(undefined, 'x'.repeat(129)); assert.equal(result.statusCode, 400);
    result = await upload([{ name: 'fake_pn.txt', field: 'wrong' }]); assert.equal(result.statusCode, 400);
    assert.equal(db.tables.ruyi_tasks.length, initialCount);
    expireAtRead = stateReads + 2;
    result = await upload(); assert.equal(result.statusCode, 409); assert.equal(db.tables.ruyi_tasks.length, initialCount);
    expireAtRead = undefined;
    db.failFiles = true;
    result = await upload(); assert.equal(result.statusCode, 500); assert.ok(!result.body.includes('SQL'));
    assert.equal(db.tables.ruyi_tasks.length, initialCount, '文件插入失败必须回滚任务'); db.failFiles = false;
    result = await app.inject({ url: '/api/tasks?page=0' }); assert.equal(result.statusCode, 400);
    result = await app.inject({ url: '/api/tasks?pageSize=1' }); assert.equal(result.json().items.length, 1); assert.equal(result.json().total, 5);
    result = await app.inject({ url: `/api/tasks/${first.id}/files` }); assert.equal(result.json().items[0].originalName, 'same_oaid.txt');
    for (const secret of ['original_path', 'current_path', 'claim_token', 'worker_id', 'state_ciphertext']) assert.ok(!result.body.includes(secret));
    db.tables.ruyi_jobs.push({ id: randomUUID(), task_id: first.id, user_id: user.id, task: 'upload', status: 'succeeded' },
      { id: randomUUID(), task_id: null, user_id: user.id, task: 'upload' });
    result = await app.inject({ url: `/api/tasks/${first.id}` }); assert.equal(result.json().jobs.length, 1);
    result = await app.inject({ method: 'PATCH', url: `/api/tasks/${first.id}/name`, payload: { name: '重命名', version: 1 } });
    assert.equal(result.statusCode, 200); assert.equal(result.json().version, 2);
    result = await app.inject({ method: 'PATCH', url: `/api/tasks/${first.id}/name`, payload: { name: '冲突', version: 1 } }); assert.equal(result.statusCode, 409);
    result = await app.inject({ method: 'PATCH', url: `/api/tasks/${first.id}/name`, payload: { name: ' ' } }); assert.equal(result.json().name, first.id);
    user = { id: 72, username: 'task_bob', role: 'user' };
    for (const suffix of ['', '/files']) assert.equal((await app.inject({ url: `/api/tasks/${first.id}${suffix}` })).statusCode, 404);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/tasks/${first.id}/name`, payload: { name: '越权' } })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/tasks' })).json().total, 0);
    const original = db.selectFrom;
    db.selectFrom = () => { throw new Error('sensitive no-code internal SQL /disk/private'); };
    for (const url of ['/api/tasks', `/api/tasks/${first.id}`, `/api/tasks/${first.id}/files`]) {
      result = await app.inject({ url }); assert.equal(result.statusCode, 500); assert.ok(!result.body.includes('sensitive'));
    }
    result = await app.inject({ method: 'PATCH', url: `/api/tasks/${first.id}/name`, payload: { name: 'rename' } });
    assert.equal(result.statusCode, 500); assert.ok(!result.body.includes('sensitive')); db.selectFrom = original;
    user = { id: 71, username: 'task_alice', role: 'user' };
    const tooManyFields = multipart([], 'one');
    tooManyFields.payload = tooManyFields.payload.replace('--task-foundation-boundary--\r\n', '--task-foundation-boundary\r\nContent-Disposition: form-data; name="name"\r\n\r\ntwo\r\n--task-foundation-boundary--\r\n');
    result = await app.inject({ method: 'POST', url: '/api/tasks', ...tooManyFields }); assert.equal(result.statusCode, 413, result.body);
  } finally { await app.close(); }
}

async function boundaryTests() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-task-boundaries-'));
  const user = { id: 1, username: 'task_user' }, db = fakeDb();
  await assert.rejects(createFromMultipart({ user, isMultipart() { throw new Error('不得读取'); } },
    { db, root, canImportFiles: async () => false }), (error) => error.code === 'PLATFORM_LOGIN_REQUIRED');
  function request(filename, chunks = ['fake'], extra = {}) {
    const { Readable } = require('node:stream');
    return { user, isMultipart: () => true, async *parts() {
      const file = Readable.from(chunks.map((chunk) => Buffer.from(chunk))); Object.assign(file, extra);
      yield { file, filename, fieldname: 'files' };
    } };
  }
  const options = { db, root, canImportFiles: async () => true };
  await assert.rejects(createFromMultipart(request('../evil_pn.txt'), options), /非法路径/);
  await assert.rejects(createFromMultipart(request('oversize_pn.txt'), { ...options, maxTotalBytes: 2 }), /总大小/);
  await assert.rejects(createFromMultipart(request('unknown.txt'), { ...options, maxTotalBytes: 2 }), /总大小/);
  await assert.rejects(createFromMultipart(request('truncated_pn.txt', ['fake'], { truncated: true }), options), /1GB/);
  await assert.rejects(createFromMultipart(request('publish_pn.txt'), { ...options,
    io: { ...taskWorkspace, async publishWorkspace() { throw new Error('模拟发布失败'); } } }), /模拟发布失败/);
  assert.equal(db.tables.ruyi_tasks.length, 0);
  await assert.rejects(createFromMultipart(request('write_pn.txt'), { ...options,
    io: { ...taskWorkspace, async createIncomingFile() { throw new Error('模拟写盘失败'); } } }), /模拟写盘失败/);
  assert.equal(db.tables.ruyi_tasks.length, 0);
  const unsafeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-task-symlink-'));
  fs.mkdirSync(path.join(unsafeRoot, 'users')); fs.mkdirSync(path.join(unsafeRoot, 'users/task_user'));
  fs.symlinkSync(root, path.join(unsafeRoot, 'users/task_user/tasks'));
  await assert.rejects(taskWorkspace.createIncomingWorkspace(user, unsafeRoot, randomUUID()), /不安全/);
  await assert.rejects(taskWorkspace.createIncomingWorkspace(user, root, '../bad'), /编号无效/);
}

async function guardAuditTests() {
  const serverRequire = createRequire(require.resolve('@ruyi/server/package.json'));
  const { guard } = require('@ruyi/server/src/modules/auth/guard');
  const { auditResponse } = require('@ruyi/server/src/modules/audit/actions');
  const db = fakeDb(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-task-guard-'));
  const keys = loadKeys({ RUYI_STATE_KEY: randomBytes(32).toString('base64') });
  const encrypted = encryptState({ cookies: [], origins: [] }, 71, keys);
  const audits = [];
  const select = db.selectFrom, update = db.updateTable, insert = db.insertInto;
  db.selectFrom = (table) => {
    if (table === 'ruyi_platform_states') return { selectAll() { return this; }, where() { return this; },
      async executeTakeFirst() { return { status: 'valid', state_ciphertext: encrypted.ciphertext, key_version: encrypted.keyVersion, version: 1 }; } };
    if (!table.includes(' as ')) return select(table);
    return { innerJoin() { return this; }, select() { return this; }, selectAll() { return this; }, where() { return this; },
      async executeTakeFirst() { return { id: 'fake', user_id: 71, username: 'task_alice', role: 'user', status: 'active', must_change_password: 0 }; } };
  };
  db.updateTable = (table) => ['ruyi_api_tokens', 'ruyi_user_sessions'].includes(table) ? {
    set() { return this; }, where() { return this; }, async executeTakeFirst() { return { numUpdatedRows: 1n }; },
  } : update(table);
  db.insertInto = (table) => table === 'ruyi_operation_logs' ? { values(value) { audits.push(value); return this; }, async execute() {} } : insert(table);
  const app = Fastify({ logger: false });
  app.decorate('db', db); app.decorate('stateKeys', keys); app.decorate('auditEnabled', true);
  app.decorateRequest('user', null); app.decorateRequest('authMethod', null); app.decorateRequest('apiTokenId', null); app.decorateRequest('sessionTokenHash', null);
  app.register(serverRequire('@fastify/cookie'));
  app.addHook('onRequest', guard); app.addHook('onSend', auditResponse);
  app.register(registerRoutes, { auth: true, uploadRoot: root });
  try {
    let result = await app.inject({ method: 'POST', url: '/api/tasks', ...multipart([{ name: 'fake_pn.txt' }]) });
    assert.equal(result.statusCode, 401); assert.deepEqual(fs.readdirSync(root), []);
    result = await app.inject({ url: '/api/tasks', headers: { authorization: `Bearer ruyi_pat_${'a'.repeat(43)}` } });
    assert.equal(result.statusCode, 200); assert.ok(Array.isArray(result.json().items));
    const cookie = `ruyi_session=${'a'.repeat(43)}`;
    const body = multipart([{ name: 'fake_pn.txt' }]); body.headers.cookie = cookie;
    result = await app.inject({ method: 'POST', url: '/api/tasks', ...body });
    assert.equal(result.statusCode, 201, result.body); const id = result.json().item.id;
    const headers = { cookie };
    result = await app.inject({ method: 'PATCH', url: `/api/tasks/${id}/name`, headers, payload: { name: '更名' } }); assert.equal(result.statusCode, 200);
    result = await app.inject({ method: 'PATCH', url: `/api/tasks/${id}/name`, headers, payload: { name: 'a'.repeat(129) } }); assert.equal(result.statusCode, 400);
    const bad = multipart([{ name: 'bad.txt' }]); bad.headers.cookie = cookie;
    result = await app.inject({ method: 'POST', url: '/api/tasks', ...bad }); assert.equal(result.statusCode, 400);
    for (const action of ['task.create', 'task.rename']) {
      assert.ok(audits.some((entry) => entry.action === action && entry.result === 'success'));
      assert.ok(audits.some((entry) => entry.action === action && entry.result === 'failure'));
    }
    assert.ok(!JSON.stringify(audits).includes('fake-data')); assert.ok(!JSON.stringify(audits).includes('state_ciphertext'));
  } finally { await app.close(); }
}

async function sqlTests() {
  const statements = [];
  const dialect = new MysqlDialect({ pool: {} });
  dialect.createDriver = () => new DummyDriver();
  const compiler = new Kysely({ dialect });
  // 真正的 Kysely 查询构造与编译，执行替换为离线记录，不连接或改变测试表结构。
  const compiledDb = compiler.withPlugin({ transformQuery: ({ node }) => node, transformResult: async ({ result }) => result });
  const executor = compiledDb.getExecutor();
  const originalExecute = executor.executeQuery.bind(executor);
  executor.executeQuery = async (query) => { statements.push(query); return { rows: [{ total: 0 }], numAffectedRows: 1n, numUpdatedOrDeletedRows: 1n }; };
  // Transaction wrapper keeps the same SQL builder; transaction atomicity is tested by fakeDb above.
  const adapter = { selectFrom: (...args) => compiledDb.selectFrom(...args), updateTable: (...args) => compiledDb.updateTable(...args),
    insertInto: (...args) => compiledDb.insertInto(...args), transaction: () => ({ execute: (fn) => fn(adapter) }) };
  try {
    const id = randomUUID();
    await repo.createTask(adapter, { id, userId: 1, name: id, files: [{ id: randomUUID(), sequence: 1, originalName: 'fake_pn.txt', fileType: 'pn', sizeBytes: 4, relative: 'raw/1/file.txt', sha256: 'a'.repeat(64) }] });
    await repo.getTaskForUser(adapter, id, 1); await repo.listTasks(adapter, { userId: 1, page: 1, pageSize: 20 });
    await repo.listTaskFiles(adapter, id, 1); await repo.listTaskJobs(adapter, id, 1);
    await repo.renameTask(adapter, { id, userId: 1, name: '名称', version: 1 });
    const allSql = statements.map((item) => item.sql).join('\n');
    assert.match(allSql, /insert into `ruyi_tasks`/); assert.match(allSql, /insert into `ruyi_task_files`/);
    assert.match(allSql, /`deleted_at` is null/); assert.match(allSql, /`task_id` = \? and `user_id` = \?/);
    assert.match(allSql, /`version` = version \+ 1/); assert.ok(!/SKIP LOCKED|NOWAIT|WITH /i.test(allSql));
  } finally { executor.executeQuery = originalExecute; await compiler.destroy(); }
}

async function main() {
  await routeTests(); await boundaryTests(); await guardAuditTests(); await sqlTests();
  console.log('任务基础接口、原始文件清单、登录拦截、跨任务隔离、事务失败、路径和 SQL 编译测试通过。');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

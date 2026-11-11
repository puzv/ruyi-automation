const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Fastify = require('fastify');
const multipart = require('@fastify/multipart');
const { registerTransferRoutes } = require('../apps/server/src/modules/transfer/routes');
const { createTicket } = require('../apps/server/src/modules/transfer/repository');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-mcp-task-transfer-'));
  const tables = { ruyi_transfer_tickets: [], ruyi_tasks: [], ruyi_task_files: [], ruyi_operation_logs: [], ruyi_task_result_sets: [], ruyi_task_results: [] };
  let active = true, loggedIn = true, wakes = 0, reads = 0, expireAfterRead = false;
  const childId = '11111111-1111-4111-8111-111111111111';
  let jobUser = 7, jobStatus = 'succeeded', jobTask = 'download';
  const db = {
    insertInto(table) { return { values(value) { this.value = value; return this; }, async execute() { tables[table].push(...[].concat(this.value)); } }; },
    transaction() { return { execute: async (fn) => fn(db) }; },
    updateTable() {
      const filters = [];
      return { set() { return this; }, where(...value) { filters.push(value); return this; }, async executeTakeFirst() {
        const row = tables.ruyi_transfer_tickets.find((ticket) => ticket.secret_hash === filters[0][2] && ticket.purpose === filters[1][2] && !ticket.used_at && ticket.expires_at > new Date());
        if (row) row.used_at = new Date();
        return { numUpdatedRows: row ? 1n : 0n };
      } };
    },
    selectFrom(table) {
      const filters = [];
      return { innerJoin() { return this; }, select() { return this; }, selectAll() { return this; }, orderBy() { return this; }, where(...value) { filters.push(value); return this; },
        async execute() { return (tables[table] || []).filter((row) => filters.every(([key, operator, value]) => operator === 'is' ? row[key] == value : row[key] === value)); },
        async executeTakeFirst() {
          if (table === 'ruyi_transfer_tickets as t') {
            const ticket = tables.ruyi_transfer_tickets.find((row) => row.secret_hash === filters[0][2]);
            return active && ticket ? { id: ticket.user_id, username: 'transfer_fixture', role: 'user', job_id: ticket.job_id } : undefined;
          }
          if (table === 'ruyi_tasks') return tables.ruyi_tasks.find((row) => row.id === filters[0][2] && row.user_id === filters[1][2] && !row.deleted_at);
          if (table === 'ruyi_jobs') return filters[0][2] === childId && filters[1][2] === jobUser ? { id: childId, task_id: tables.ruyi_tasks[0].id, user_id: jobUser, username: 'transfer_fixture', task: jobTask, status: jobStatus } : undefined;
          return (await this.execute())[0];
        },
      };
    },
  };
  const app = Fastify({ logger: false });
  app.decorate('db', db); app.decorate('worker', { wake() { wakes++; } });
  app.register(multipart);
  await registerTransferRoutes(app, { dataRoot: root, canImportFiles: async () => loggedIn && (!expireAfterRead || ++reads === 1) });
  const issue = async () => (await createTicket(db, { userId: 7, purpose: 'upload' })).secret;
  const upload = (secret, name = 'same_pn.txt') => app.inject({
    method: 'POST', url: '/api/transfer/upload/' + secret,
    headers: { 'content-type': 'multipart/form-data; boundary=fixture' },
    payload: '--fixture\r\nContent-Disposition: form-data; name="files"; filename="' + name + '"\r\nContent-Type: text/plain\r\n\r\nfake-fixture\r\n--fixture--\r\n',
  });
  try {
    loggedIn = false;
    let secret = await issue();
    assert.equal((await upload(secret)).statusCode, 409);
    assert.equal(tables.ruyi_tasks.length, 0);
    assert.equal((await upload(secret)).statusCode, 404);
    loggedIn = true;
    expireAfterRead = true; reads = 0;
    assert.equal((await upload(await issue())).statusCode, 409, '接收后登录失效不发布任务');
    assert.equal(tables.ruyi_tasks.length, 0);
    expireAfterRead = false;
    for (let index = 0; index < 2; index++) {
      secret = await issue();
      const result = await upload(secret);
      assert.equal(result.statusCode, 201, result.body);
      assert.equal(result.json().taskId, result.json().item.id);
      assert.equal(result.json().item.fileCount, 1);
      assert.equal((await upload(secret)).statusCode, 404);
    }
    assert.equal(tables.ruyi_tasks.length, 2);
    assert.notEqual(tables.ruyi_tasks[0].id, tables.ruyi_tasks[1].id);
    assert.equal(tables.ruyi_task_files[0].original_name, tables.ruyi_task_files[1].original_name);
    assert.equal(wakes, 2);
    assert.ok(!fs.existsSync(path.join(root, 'users/transfer_fixture/raw')), 'MCP 不写入旧公共工作区');
    active = false;
    assert.equal((await upload(await issue())).statusCode, 404);
    active = true;
    secret = await issue();
    const row = tables.ruyi_transfer_tickets.find((value) => value.secret_hash === createHash('sha256').update(secret).digest('hex'));
    row.expires_at = new Date(0);
    assert.equal((await upload(secret)).statusCode, 404);
    const downloadTicket = async (userId = 7) => (await createTicket(db, { userId, purpose: 'download', jobId: childId })).secret;
    const fetchZip = async (ticket) => app.inject('/api/transfer/download/' + ticket);
    tables.ruyi_tasks[0].status = 'succeeded';
    const execution = path.join(root, 'users/transfer_fixture/tasks', tables.ruyi_tasks[0].id, 'execution');
    fs.mkdirSync(execution, { recursive: true });
    const source = path.join(root, 'fake-result.csv');
    fs.writeFileSync(source, 'synthetic-result');
    const resultDir = path.join(execution, 'job-results', childId, 'files');
    fs.mkdirSync(resultDir, { recursive: true });
    fs.copyFileSync(source, path.join(resultDir, 'fake-result.csv'));
    tables.ruyi_task_result_sets.push({ job_id: childId, task_id: tables.ruyi_tasks[0].id, user_id: 7, sealed_at: new Date() });
    tables.ruyi_task_results.push({ id: 'result', job_id: childId, file_id: tables.ruyi_task_files[0].id, name: 'fake-result.csv', stored_path: 'files/fake-result.csv', size_bytes: fs.statSync(source).size });
    secret = await downloadTicket();
    const zip = await fetchZip(secret);
    assert.equal(zip.statusCode, 200, zip.body);
    assert.equal(zip.rawPayload.subarray(0, 2).toString(), 'PK');
    assert.equal(zip.headers['content-type'], 'application/zip');
    assert.equal((await fetchZip(secret)).statusCode, 404);
    assert.equal((await fetchZip(await downloadTicket(8))).statusCode, 404, '不能跨用户下载');
    tables.ruyi_tasks[0].status = 'running';
    assert.equal((await fetchZip(await downloadTicket())).statusCode, 404);
    tables.ruyi_tasks[0].status = 'succeeded'; jobStatus = 'failed';
    assert.equal((await fetchZip(await downloadTicket())).statusCode, 404);
    jobStatus = 'succeeded'; jobTask = 'analyse';
    assert.equal((await fetchZip(await downloadTicket())).statusCode, 404);
    jobTask = 'download';
    tables.ruyi_tasks[0].deleted_at = new Date();
    assert.equal((await fetchZip(await downloadTicket())).statusCode, 404, '已删除任务不能使用旧下载票据');
    console.log('MCP 上传真实 multipart、整任务隔离、同名跨批、失效票据与删除任务下载拒绝通过（临时目录与内存仓储）。');
  } finally { await app.close(); }
}
module.exports = main();
module.exports.catch((error) => { console.error(error); process.exitCode = 1; });

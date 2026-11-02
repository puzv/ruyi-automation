const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sql } = require('kysely');
const { createDb, readDbConfig } = require('../db');
const users = require('@ruyi/shared/runtime/repos/users');
const { hashPassword } = require('@ruyi/server/src/modules/auth/password');
const { loadKeys } = require('@ruyi/shared/runtime/platform-state/crypto');
const { storeCapturedState } = require('@ruyi/shared/runtime/platform-state');
const { resolveWorkspace, ensureWorkspace } = require('@ruyi/shared/runtime/workspace');
const { beginResults, recordResult, finishResults } = require('@ruyi/shared/runtime/job-results');
const { createTicket } = require('@ruyi/server/src/modules/transfer/repository');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-transfer-'));
const previousRoot = process.env.RUYI_UPLOAD_DIR;
const previousPublic = process.env.RUYI_PUBLIC_URL;
process.env.RUYI_UPLOAD_DIR = root;
const browser = require('@ruyi/automation/lib/browser');
const childProcess = require('node:child_process');
const originalBrowser = browser.launchBrowser;
const methods = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const originals = Object.fromEntries(methods.map((key) => [key, childProcess[key]]));
let unexpectedCalls = 0;
function forbidden() { unexpectedCalls++; throw new Error('测试不得启动浏览器或脚本'); }
browser.launchBrowser = forbidden;
for (const key of methods) childProcess[key] = forbidden;
const { buildApp } = require('@ruyi/server/src/app');
const names = ['mcp_transfer_a', 'mcp_transfer_b'];
const detailOf = (row) => typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail;
async function clean(db) {
  const rows = await db.selectFrom('ruyi_users').select('id').where('username', 'in', names).execute();
  if (!rows.length) return;
  const ids = rows.map((row) => row.id);
  for (const table of ['ruyi_transfer_tickets', 'ruyi_api_tokens', 'ruyi_jobs', 'ruyi_auto_advance', 'ruyi_user_sessions', 'ruyi_platform_states', 'ruyi_operation_logs']) {
    await db.deleteFrom(table).where('user_id', 'in', ids).execute();
  }
  await db.deleteFrom('ruyi_users').where('id', 'in', ids).execute();
}
async function main() {
  if (process.env.RUYI_DB_NAME !== 'ruyi_test') throw new Error('数据库测试只允许使用 ruyi_test 库');
  const config = readDbConfig();
  assert.deepEqual([config.host, config.port, config.user, config.password], ['127.0.0.1', 3306, 'ruyi', 'ruyi']);
  const db = createDb(config), clients = [], logs = [], secrets = [];
  let connected = false, app;
  try {
    await sql`SELECT 1`.execute(db); connected = true; await clean(db);
    const password = 'TransferTest123', passwordHash = await hashPassword(password);
    const ids = [];
    for (const username of names) ids.push(await users.createUser(db, { username, displayName: username, passwordHash, role: 'user', mustChangePassword: false }));
    const keys = loadKeys({ RUYI_STATE_KEY: crypto.randomBytes(32).toString('base64') });
    app = buildApp({ db, uploadRoot: root, stateKeys: keys, webDist: path.join(root, 'missing'),
      logger: { level: 'info', stream: { write: (line) => logs.push(line) } },
      autoAdvance: { describe: async () => ({ enabled: false, phase: 'idle', message: '' }), stop: async () => {} } });
    const tokens = [];
    for (const username of names) {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
      assert.equal(login.statusCode, 200);
      const cookie = [].concat(login.headers['set-cookie']).find((value) => value.startsWith('ruyi_session=')).split(';')[0];
      const issued = await app.inject({ method: 'POST', url: '/api/api-tokens', headers: { cookie }, payload: { name: '传输测试', expiresInDays: 30 } });
      assert.equal(issued.statusCode, 200); tokens.push(issued.json().token);
    }
    const base = await app.listen({ port: 0, host: '127.0.0.1' }); process.env.RUYI_PUBLIC_URL = base;
    for (const token of tokens) {
      const client = new Client({ name: 'transfer-test', version: '1.0.0' }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    }
    const call = (index, name, args = {}) => clients[index].callTool({ name, arguments: args });
    const listed = (await clients[0].listTools()).tools; assert.equal(listed.length, 10);
    for (const [name, expected] of Object.entries({ prepare_upload: [false, false, false], run_task: [false, false, false], cancel_job: [false, true, false], set_auto_advance: [false, false, true], prepare_download: [false, false, false] })) {
      const annotation = listed.find((tool) => tool.name === name).annotations;
      assert.deepEqual([annotation.readOnlyHint, annotation.destructiveHint, annotation.idempotentHint], expected);
    }
    assert.equal(listed.find((tool) => tool.name === 'run_task').annotations.openWorldHint, true);
    const prepare = async (index = 0) => {
      const result = await call(index, 'prepare_upload'); assert.ok(!result.isError, JSON.stringify(result));
      const value = result.structuredContent; secrets.push(new URL(value.uploadUrl).pathname.split('/').pop()); return value.uploadUrl;
    };
    const upload = (url, files = [['a_idfa.txt', '伪造ID'], ['ignore.txt', '忽略']]) => {
      const body = new FormData(); for (const [name, value] of files) body.append('files', new Blob([value]), name);
      return fetch(url, { method: 'POST', body });
    };
    const workspace = ensureWorkspace(resolveWorkspace({ username: names[0] }, root));
    const otherWorkspace = ensureWorkspace(resolveWorkspace({ username: names[1] }, root));
    const address = await prepare(), otherAddress = await prepare(1);
    const imported = await upload(address); assert.equal(imported.status, 200);
    const summary = await imported.json(); assert.equal(summary.count, 1); assert.equal(summary.skipped, 1); assert.deepEqual(summary.files, ['a_idfa.txt']);
    const findFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? findFiles(path.join(dir, entry.name)) : [entry.name]);
    assert.deepEqual(findFiles(path.join(workspace, 'raw')), ['a_idfa.txt']);
    assert.ok(!findFiles(otherWorkspace).includes('a_idfa.txt'));
    assert.equal((await upload(address)).status, 404);
    assert.equal((await upload(otherAddress, [['b_pn.csv', '伪造号码']])).status, 200);
    assert.ok(findFiles(otherWorkspace).includes('b_pn.csv'));
    const expired = await prepare();
    await db.updateTable('ruyi_transfer_tickets').set({ expires_at: new Date(Date.now() - 60000) }).where('secret_hash', '=', crypto.createHash('sha256').update(secrets.at(-1)).digest('hex')).execute();
    assert.equal((await upload(expired)).status, 404);
    const wrong = await createTicket(db, { userId: ids[0], purpose: 'download', jobId: crypto.randomUUID() }); secrets.push(wrong.secret);
    assert.equal((await upload(`${base}/api/transfer/upload/${wrong.secret}`)).status, 404);
    assert.equal((await upload(`${base}/api/transfer/upload/bad-ticket`)).status, 404);
    const disabledAddress = await prepare(1);
    await db.updateTable('ruyi_users').set({ status: 'disabled' }).where('id', '=', ids[1]).execute();
    assert.equal((await upload(disabledAddress)).status, 404);
    await db.updateTable('ruyi_users').set({ status: 'active' }).where('id', '=', ids[1]).execute();
    const race = await prepare(), busyId = crypto.randomUUID();
    await db.insertInto('ruyi_jobs').values({ id: busyId, user_id: ids[0], username: names[0], task: 'upload', status: 'running' }).execute();
    assert.equal((await call(0, 'prepare_upload')).isError, true);
    assert.equal((await upload(race)).status, 409); assert.equal((await upload(race)).status, 404);
    await db.updateTable('ruyi_jobs').set({ status: 'succeeded' }).where('id', '=', busyId).execute();
    const invalidTask = await call(0, 'run_task', { task: 'invalid' }); assert.equal(invalidTask.isError, true);
    await storeCapturedState(db, ids[0], { cookies: [], origins: [] }, keys);
    const started = await call(0, 'run_task', { task: 'upload' }); assert.ok(!started.isError, JSON.stringify(started));
    const queued = await db.selectFrom('ruyi_jobs').selectAll().where('id', '=', started.structuredContent.jobId).executeTakeFirstOrThrow(); assert.equal(queued.status, 'queued');
    const startLog = await db.selectFrom('ruyi_operation_logs').selectAll().where('user_id', '=', ids[0]).where('action', '=', 'job.start').orderBy('id', 'desc').executeTakeFirstOrThrow();
    assert.equal(detailOf(startLog).via, 'api_token'); assert.match(startLog.user_agent, /^ruyi-mcp\//);
    assert.equal((await call(0, 'prepare_download', { jobId: busyId })).isError, true);
    const downloadId = crypto.randomUUID();
    await db.insertInto('ruyi_jobs').values({ id: downloadId, user_id: ids[0], username: names[0], task: 'download', status: 'running' }).execute();
    assert.equal((await call(0, 'prepare_download', { jobId: downloadId })).isError, true);
    beginResults(workspace, downloadId); const resultFile = path.join(workspace, '测试结果.csv'); fs.writeFileSync(resultFile, '伪造结果'); recordResult(workspace, downloadId, resultFile); finishResults(workspace, downloadId);
    await db.updateTable('ruyi_jobs').set({ status: 'succeeded' }).where('id', '=', downloadId).execute();
    assert.equal((await call(1, 'prepare_download', { jobId: downloadId })).isError, true);
    const ready = await call(0, 'prepare_download', { jobId: downloadId }); assert.ok(!ready.isError, JSON.stringify(ready)); assert.equal(ready.structuredContent.fileCount, 1);
    const downloadUrl = ready.structuredContent.downloadUrl; secrets.push(new URL(downloadUrl).pathname.split('/').pop());
    const zip = await fetch(downloadUrl); assert.equal(zip.status, 200); assert.match(zip.headers.get('content-disposition'), new RegExp(downloadId));
    assert.equal(Buffer.from(await zip.arrayBuffer()).subarray(0, 2).toString(), 'PK'); assert.equal((await fetch(downloadUrl)).status, 404);
    const importedLogs = await db.selectFrom('ruyi_operation_logs').selectAll().where('user_id', '=', ids[0]).where('action', '=', 'file.import').execute();
    assert.ok(importedLogs.some((row) => row.result === 'success' && detailOf(row).via === 'transfer_ticket'));
    assert.ok(importedLogs.some((row) => row.result === 'failure' && detailOf(row).via === 'transfer_ticket'));
    const downloadLog = await db.selectFrom('ruyi_operation_logs').selectAll().where('user_id', '=', ids[0]).where('action', '=', 'job.results_download').executeTakeFirstOrThrow();
    assert.equal(downloadLog.target_id, downloadId); assert.equal(downloadLog.username, names[0]);
    for (const secret of secrets) assert.ok(!logs.join('').includes(secret), '服务日志不得包含票据明文');
    assert.equal(unexpectedCalls, 0); console.log('MCP 写工具、一次性传输、用户隔离、审计和日志脱敏测试通过。');
  } finally {
    try { for (const client of clients) await client.close(); if (app) await app.close(); }
    finally { try { if (connected) await clean(db); } finally { await db.destroy(); } }
  }
}
main().catch((error) => { console.error('MCP 传输数据库测试失败：', error); process.exitCode = 1; }).finally(() => {
  browser.launchBrowser = originalBrowser; for (const key of methods) childProcess[key] = originals[key];
  if (previousRoot === undefined) delete process.env.RUYI_UPLOAD_DIR; else process.env.RUYI_UPLOAD_DIR = previousRoot;
  if (previousPublic === undefined) delete process.env.RUYI_PUBLIC_URL; else process.env.RUYI_PUBLIC_URL = previousPublic;
});

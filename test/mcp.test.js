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
const { resolveWorkspace, ensureWorkspace } = require('@ruyi/shared/runtime/workspace');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-mcp-'));
const previousUploadDir = process.env.RUYI_UPLOAD_DIR;
process.env.RUYI_UPLOAD_DIR = tempDir;
const browser = require('@ruyi/automation/lib/browser');
const childProcess = require('node:child_process');
const originalBrowser = browser.launchBrowser;
const processMethods = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const originalMethods = Object.fromEntries(processMethods.map((name) => [name, childProcess[name]]));
let browserCalls = 0;
const unexpected = () => { browserCalls++; throw new Error('测试不得启动浏览器或脚本'); };
browser.launchBrowser = unexpected;
for (const name of processMethods) childProcess[name] = unexpected;
const { buildApp } = require('@ruyi/server/src/app');
const usernames = ['mcp_user_a', 'mcp_user_b'];

async function clean(db) {
  const rows = await db.selectFrom('ruyi_users').select('id').where('username', 'in', usernames).execute();
  if (!rows.length) return;
  const ids = rows.map((row) => row.id);
  for (const table of ['ruyi_transfer_tickets', 'ruyi_api_tokens', 'ruyi_jobs', 'ruyi_auto_advance', 'ruyi_user_sessions', 'ruyi_platform_states', 'ruyi_operation_logs']) {
    await db.deleteFrom(table).where('user_id', 'in', ids).execute();
  }
  await db.deleteFrom('ruyi_users').where('id', 'in', ids).execute();
}

async function main() {
  if (process.env.RUYI_DB_NAME !== 'ruyi_test') throw new Error('数据库测试只允许使用 ruyi_test 库。');
  const config = readDbConfig();
  if (config.host !== '127.0.0.1' || config.port !== 3306 || config.user !== 'ruyi' || config.password !== 'ruyi') {
    throw new Error('数据库测试只允许连接本机 Docker 的测试数据库。');
  }
  const db = createDb(config);
  let connected = false, app, client;
  try {
    await sql`SELECT 1`.execute(db);
    connected = true;
    await clean(db);
    const password = 'McpTest123';
    const passwordHash = await hashPassword(password);
    const ids = [];
    for (const username of usernames) ids.push(await users.createUser(db, {
      username, displayName: username, passwordHash, role: 'user', mustChangePassword: false,
    }));
    app = buildApp({ db, logger: false, uploadRoot: tempDir,
      autoAdvance: { describe: async () => ({ enabled: false, phase: 'idle', message: '' }), stop: async () => {} },
      stateKeys: loadKeys({ RUYI_STATE_KEY: crypto.randomBytes(32).toString('base64') }),
      webDist: path.join(tempDir, 'missing-dist') });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: usernames[0], password } });
    assert.equal(login.statusCode, 200);
    const cookie = [].concat(login.headers['set-cookie']).find((value) => value.startsWith('ruyi_session=')).split(';')[0];
    const issue = async () => {
      const response = await app.inject({ method: 'POST', url: '/api/api-tokens', headers: { cookie }, payload: { name: 'MCP 测试', expiresInDays: 30 } });
      assert.equal(response.statusCode, 200);
      return response.json();
    };
    const { token } = await issue();
    const revoked = await issue();
    await app.inject({ method: 'POST', url: `/api/api-tokens/${revoked.item.id}/revoke`, headers: { cookie } });
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    for (const headers of [{}, { authorization: 'Bearer invalid' }, { cookie }, { authorization: `Bearer ${revoked.token}` }]) {
      const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('www-authenticate'), 'Bearer realm="ruyi"');
      assert.deepEqual(await response.json(), { ok: false, code: 'UNAUTHENTICATED', message: '需要有效的 API 令牌' });
    }
    assert.equal((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${token}` } })).status, 405);
    assert.equal((await fetch(`${base}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status, 405);
    for (const suffix of ['oauth-protected-resource', 'oauth-authorization-server', 'oauth-protected-resource/mcp', 'oauth-authorization-server/mcp']) {
      const response = await fetch(`${base}/.well-known/${suffix}`);
      assert.equal(response.status, 404);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.equal((await response.json()).ok, false);
    }
    await db.updateTable('ruyi_users').set({ must_change_password: 1 }).where('id', '=', ids[0]).execute();
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })).status, 403);
    await db.updateTable('ruyi_users').set({ must_change_password: 0 }).where('id', '=', ids[0]).execute();
    const injected = [];
    const originalInject = app.inject.bind(app);
    app.inject = (options, ...args) => { injected.push(options); return originalInject(options, ...args); };
    client = new Client({ name: 'ruyi-mcp-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}`, 'user-agent': 'mcp-test-client' } } }));
    const instructions = client.getInstructions();
    for (const text of ['平台登录', 'wait_for_job', '不要读取', 'cat、head、python、解压后打开', '读取、预览或统计人群包文件和下载的结果文件的内容', '除非用户明确要求查看结果', '下载完成后只报告保存路径与文件大小']) {
      assert.ok(instructions.includes(text), `服务说明缺少：${text}`);
    }
    const tools = (await client.listTools()).tools;
    assert.ok(tools.find((tool) => tool.name === 'prepare_download').description.includes('下载后不要解压或打开查看，只报告路径和大小'));
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['get_overview', 'check_platform', 'list_jobs', 'get_job', 'wait_for_job', 'prepare_upload', 'run_task', 'cancel_job', 'set_auto_advance', 'prepare_download'].sort());
    assert.ok(tools.filter((tool) => ['get_overview', 'check_platform', 'list_jobs', 'get_job', 'wait_for_job'].includes(tool.name)).every((tool) => tool.annotations.readOnlyHint === true));
    assert.equal(tools.find((tool) => tool.name === 'check_platform').annotations.openWorldHint, true);
    const workspace = ensureWorkspace(resolveWorkspace({ username: usernames[0] }, tempDir));
    const secretFilename = 'mcp_private_oaid.txt';
    fs.writeFileSync(path.join(workspace, 'oaid', secretFilename), '伪造测试数据');
    const overview = await client.callTool({ name: 'get_overview', arguments: {} });
    assert.equal(overview.structuredContent.workspace.pendingUpload, 1);
    assert.equal(overview.structuredContent.nextStep.action, 'login');
    assert.ok(!JSON.stringify(overview).includes(secretFilename));
    assert.ok(!JSON.stringify(overview).includes('createNames'));
    assert.ok(injected.some((options) => options.url === '/api/status' && options.headers.authorization === `Bearer ${token}` && options.headers['user-agent'].startsWith('ruyi-mcp/')));
    const ownId = crypto.randomUUID(), otherId = crypto.randomUUID();
    for (const [id, index] of [[ownId, 0], [otherId, 1]]) await db.insertInto('ruyi_jobs').values({ id, user_id: ids[index], username: usernames[index], task: 'upload', status: 'running', log_path: `logs/${id}.log` }).execute();
    const denied = await client.callTool({ name: 'get_job', arguments: { jobId: otherId } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /任务不存在/);
    fs.mkdirSync(path.join(workspace, 'logs'), { recursive: true });
    const output = `${'旧'.repeat(9000)}\n${workspace}/example\n${'x'.repeat(5000)}结束`;
    fs.writeFileSync(path.join(workspace, 'logs', `${ownId}.log`), output);
    const detail = await client.callTool({ name: 'get_job', arguments: { jobId: ownId } });
    assert.ok(Buffer.byteLength(detail.structuredContent.logTail) <= 8192);
    assert.ok(detail.structuredContent.logTail.endsWith('结束'));
    assert.ok(detail.structuredContent.logTail.includes('<工作区>'));
    assert.ok(!detail.structuredContent.logTail.includes(tempDir));
    const listed = await client.callTool({ name: 'list_jobs', arguments: {} });
    assert.equal(listed.structuredContent.items.length, 1);
    assert.equal(listed.structuredContent.items[0].id, ownId);
    assert.ok(!('cancelRequested' in listed.structuredContent.items[0]));
    const updateTimer = setTimeout(() => { db.updateTable('ruyi_jobs').set({ status: 'succeeded' }).where('id', '=', ownId).execute().catch((error) => { console.error(error); process.exitCode = 1; }); }, 250);
    try {
      const waited = await client.callTool({ name: 'wait_for_job', arguments: { jobId: ownId, timeoutSeconds: 5 } });
      assert.equal(waited.structuredContent.status, 'succeeded');
      assert.equal(waited.structuredContent.timedOut, false);
    } finally { clearTimeout(updateTimer); }
    await db.updateTable('ruyi_jobs').set({ status: 'running' }).where('id', '=', ownId).execute();
    const started = Date.now();
    const timedOut = await client.callTool({ name: 'wait_for_job', arguments: { jobId: ownId, timeoutSeconds: 5 } });
    assert.equal(timedOut.structuredContent.timedOut, true);
    assert.ok(Date.now() - started >= 4800);
    const platform = await client.callTool({ name: 'check_platform', arguments: {} });
    assert.equal(platform.isError, true);
    assert.match(platform.content[0].text, /#\/platform-login/);
    assert.equal(browserCalls, 0);
    console.log('MCP 真实 SDK、令牌鉴权、用户隔离、日志、轮询和平台登录提示测试通过。');
  } finally {
    try { if (client) await client.close(); if (app) await app.close(); }
    finally { try { if (connected) await clean(db); } finally { await db.destroy(); } }
  }
}
main().catch((error) => { console.error('MCP 数据库测试失败：', error); process.exitCode = 1; }).finally(() => {
  browser.launchBrowser = originalBrowser;
  for (const name of processMethods) childProcess[name] = originalMethods[name];
  if (previousUploadDir === undefined) delete process.env.RUYI_UPLOAD_DIR;
  else process.env.RUYI_UPLOAD_DIR = previousUploadDir;
});

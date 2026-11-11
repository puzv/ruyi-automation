const assert = require('node:assert/strict');
const Fastify = require('fastify');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { registerMcpRoutes } = require('../apps/server/src/modules/mcp/routes');
const { registerTaskRoutes } = require('../apps/server/src/modules/tasks/routes');
const { guard } = require('../apps/server/src/modules/auth/guard');
const tokens = require('../apps/server/src/modules/api-tokens/repository');
const tasks = require('../packages/shared/runtime/repos/tasks');

async function main() {
  const token = 'ruyi_pat_' + 'a'.repeat(43), other = 'ruyi_pat_' + 'b'.repeat(43);
  const id = '11111111-1111-4111-8111-111111111111';
  const originals = { tokens: { ...tokens }, tasks: { ...tasks } };
  let status = 'running', mutations = 0, login = 'valid';
  const rows = () => [{ id, user_id: 7, name: 'SDK task', status, current_step: 'analyse', version: 3 }];
  tokens.findActiveByHash = async (_db, hash) => {
    const crypto = require('node:crypto');
    const who = hash === crypto.createHash('sha256').update(token).digest('hex') ? 7
      : hash === crypto.createHash('sha256').update(other).digest('hex') ? 8 : null;
    return who ? { id: who, user: { id: who, username: 'sdk_' + who, role: 'user', must_change_password: 0 } } : undefined;
  };
  tokens.touch = async () => {};
  tasks.listTasks = async (_db, { userId }) => ({ items: userId === 7 ? rows() : [], total: userId === 7 ? 1 : 0 });
  tasks.getTaskForUser = async (_db, taskId, userId) => taskId === id && userId === 7 ? rows()[0] : undefined;
  tasks.listTaskJobs = async () => [];
  tasks.listTaskFiles = async () => [];
  tasks.requestStopTask = async (_db, { userId, version }) => { mutations++; return userId === 7 && version === 3; };
  const app = Fastify({ logger: false });
  app.decorate('db', {});
  app.decorateRequest('user', null);
  app.addHook('onRequest', guard);
  app.get('/api/platform-state', async () => ({ status: login }));
  await registerTaskRoutes(app, { canImportFiles: async () => login === 'valid' });
  await registerMcpRoutes(app, {});
  const clients = [];
  try {
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    assert.equal((await app.inject({ method: 'POST', url: '/mcp', payload: {} })).statusCode, 401);
    for (const secret of [token, other]) {
      const client = new Client({ name: 'unified-test', version: '1.0.0' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + secret } } }));
    }
    const tools = (await clients[0].listTools()).tools;
    for (const name of ['list_tasks', 'get_task', 'wait_for_task', 'stop_task', 'continue_task', 'resume_task']) assert.ok(tools.find((tool) => tool.name === name));
    assert.equal(tools.find((tool) => tool.name === 'stop_task').annotations.destructiveHint, true);
    assert.equal(tools.find((tool) => tool.name === 'get_task').annotations.readOnlyHint, true);
    const call = (index, name, args = {}) => clients[index].callTool({ name, arguments: args });
    assert.equal((await call(0, 'list_tasks')).structuredContent.total, 1);
    assert.equal((await call(1, 'list_tasks')).structuredContent.total, 0);
    assert.equal((await call(1, 'get_task', { taskId: id })).isError, true);
    assert.equal((await call(0, 'get_task', { taskId: id })).structuredContent.status, 'running');
    assert.equal((await call(0, 'get_task', { taskId: 'bad' })).isError, true);
    assert.equal((await call(0, 'prepare_download', {})).isError, true);
    assert.equal((await call(0, 'prepare_download', { taskId: id, jobId: '22222222-2222-4222-8222-222222222222' })).isError, true);
    assert.equal((await call(0, 'wait_for_task', { taskId: id, timeoutSeconds: 60 })).isError, true);
    for (const terminal of ['waiting_login', 'interrupted', 'failed', 'cancelled', 'succeeded']) {
      status = terminal;
      const result = await call(0, 'wait_for_task', { taskId: id, timeoutSeconds: 5 });
      assert.equal(result.structuredContent.status, terminal);
      assert.equal(result.structuredContent.timedOut, false);
    }
    status = 'running';
    const timer = setTimeout(() => { status = 'succeeded'; }, 50);
    try { assert.equal((await call(0, 'wait_for_task', { taskId: id, timeoutSeconds: 5 })).structuredContent.status, 'succeeded'); }
    finally { clearTimeout(timer); }
    status = 'running';
    const timeout = await call(0, 'wait_for_task', { taskId: id, timeoutSeconds: 5 });
    assert.equal(timeout.structuredContent.timedOut, true);
    assert.ok(!(await call(0, 'stop_task', { taskId: id, version: 3 })).isError);
    assert.equal(mutations, 1);
    assert.equal((await call(1, 'stop_task', { taskId: id, version: 3 })).isError, true);
    assert.equal(mutations, 1);
    login = 'missing';
    assert.equal((await call(0, 'prepare_upload')).isError, true);
    assert.equal((await call(0, 'run_task', { task: 'upload' })).isError, true);
    assert.equal((await call(0, 'set_auto_advance', { enabled: true })).isError, true);
    console.log('MCP 真实 SDK tools/list、schema、整任务归属、停止与等待通过（内存仓储，不改数据库）。');
  } finally {
    for (const client of clients) await client.close();
    await app.close();
    Object.assign(tokens, originals.tokens);
    Object.assign(tasks, originals.tasks);
  }
}
module.exports = main();
module.exports.catch((error) => { console.error(error); process.exitCode = 1; });

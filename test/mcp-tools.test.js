const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTools } = require('@ruyi/server/src/modules/mcp/tools');

async function main() {
  const calls = [], tickets = [];
  let status = 'running', platform = 'valid', blocked = false;
  const id = '11111111-1111-4111-8111-111111111111', child = '22222222-2222-4222-8222-222222222222';
  const app = { inject: async (input) => {
    calls.push(input);
    assert.equal(input.headers.authorization, 'Bearer fake');
    assert.match(input.headers['user-agent'], /^ruyi-mcp\//);
    let data;
    if (input.url === '/api/platform-state') data = { status: platform };
    else if (input.url.startsWith('/api/tasks?')) data = { items: [{ id, status }], total: 1 };
    else if (input.url === '/api/tasks/' + id) {
      if (blocked) return { statusCode: 404, json: () => ({ message: '任务不存在' }) };
      data = { item: { id, status, version: 7 }, jobs: [{ id: child, task: 'download', status: 'succeeded' }] };
    } else if (input.url === '/api/jobs/' + child + '/results') data = { count: 2, size: 100 };
    else if (input.url === '/api/jobs/' + child) data = { job: { output: 'x'.repeat(9000) + '\nBearer sensitive\nruyi_pat_abcdef' } };
    else if (input.url.endsWith('/files')) data = { items: [{ originalName: 'a_pn.txt' }] };
    else if (/\/api\/tasks\//.test(input.url)) data = { ok: true };
    else throw new Error('不得访问旧入口：' + input.url);
    return { statusCode: 200, json: () => data };
  } };
  const reply = { raw: new EventEmitter() };
  const tools = createTools(app, { user: { id: 7 }, headers: { authorization: 'Bearer fake' }, protocol: 'https', host: 'example.test', ip: '127.0.0.1' }, reply, {
    createTicket: async (_db, input) => { tickets.push(input); return { secret: 'fixture', expiresAt: '2030-01-01' }; },
  });
  assert.ok(!(await tools.prepare_upload({})).isError, '运行中也允许新任务排队');
  platform = 'missing';
  assert.equal((await tools.prepare_upload({})).isError, true);
  assert.equal((await tools.get_overview({})).structuredContent.nextStep.action, 'login');
  platform = 'valid';
  await tools.get_overview({});
  await tools.check_platform({});
  assert.equal((await tools.list_tasks({})).structuredContent.total, 1);
  assert.equal((await tools.list_jobs({})).structuredContent.total, 1);
  assert.equal((await tools.get_job({ jobId: id })).structuredContent.id, id);
  const logs = (await tools.get_task({ taskId: id })).structuredContent.logTail;
  assert.ok(Buffer.byteLength(logs) <= 8192);
  assert.ok(!logs.includes('sensitive'));
  assert.equal((await tools.prepare_download({ taskId: id })).isError, true);
  status = 'succeeded';
  const download = await tools.prepare_download({ taskId: id });
  assert.equal(download.structuredContent.taskId, id);
  assert.equal(tickets.at(-1).jobId, child);
  assert.equal(download.structuredContent.fileCount, 2);
  for (const stopped of ['waiting_login', 'interrupted', 'failed', 'cancelled', 'succeeded']) {
    status = stopped;
    const result = await tools.wait_for_task({ taskId: id, timeoutSeconds: 5 });
    assert.equal(result.structuredContent.status, stopped);
    assert.equal(result.structuredContent.timedOut, false);
  }
  status = 'running';
  assert.equal((await tools.wait_for_task({ taskId: id, timeoutSeconds: 0 })).structuredContent.timedOut, true);
  await tools.stop_task({ taskId: id, version: 6 });
  assert.deepEqual(calls.at(-1).payload, { version: 6 });
  assert.ok(calls.at(-1).url.endsWith('/stop'));
  await tools.continue_task({ taskId: id });
  assert.deepEqual(calls.at(-1).payload, { version: 7 });
  assert.equal((await tools.resume_task({ taskId: id })).isError, true);
  await tools.resume_task({ taskId: id, confirm: true });
  assert.ok(calls.at(-1).url.endsWith('/resume'));
  assert.equal((await tools.delete_task({ taskId: id })).isError, true);
  status = 'interrupted';
  await tools.delete_task({ taskId: id });
  assert.equal(calls.at(-1).method, 'DELETE');
  await tools.list_task_files({ taskId: id });
  await tools.rename_task({ taskId: id, name: '测试' });
  assert.equal(calls.at(-1).method, 'PATCH');
  const before = calls.length;
  assert.equal((await tools.run_task({ task: 'upload' })).isError, true);
  assert.equal((await tools.set_auto_advance({ enabled: true })).isError, true);
  assert.equal(calls.length, before);
  blocked = true;
  assert.equal((await tools.get_task({ taskId: id })).isError, true);
  blocked = false;
  status = 'running';
  const pending = tools.wait_for_task({ taskId: id, timeoutSeconds: 5 });
  setTimeout(() => reply.raw.emit('close'), 10);
  assert.equal((await pending).isError, true);
  console.log('MCP 整任务映射、下载绑定、登录检查、恢复和等待测试通过。');
}
module.exports = main();
module.exports.catch((error) => { console.error(error); process.exitCode = 1; });
module.exports.then(() => require('./mcp.test')).then(() => require('./mcp-transfer.test')).catch((error) => { console.error(error); process.exitCode = 1; });

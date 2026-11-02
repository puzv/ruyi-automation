const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTools, decideNextStep } = require('@ruyi/server/src/modules/mcp/tools');

async function main() {
  const baseWorkspace = { pendingUpload: 0, createCount: 0, analyseCount: 0, doneCount: 0 };
  const platform = { status: 'valid' };
  const active = { job: null };
  const auto = { enabled: false, phase: 'idle' };
  const branches = [
    ['login', { status: 'missing' }, active, auto],
    ['wait_job', platform, { job: {} }, auto],
    ['run_upload', platform, active, auto, { pendingUpload: 1 }],
    ['wait_platform_files', platform, active, auto, { createCount: 1 }],
    ['wait_audience', platform, active, auto, { analyseCount: 1 }],
    ['wait_results', platform, active, auto, { doneCount: 1 }],
    ['run_download', platform, active, { enabled: false, phase: 'resultsReady' }, { doneCount: 1 }],
  ];
  for (const [expected, p, a, au, changes = {}] of branches) {
    assert.equal(decideNextStep({ ...baseWorkspace, ...changes }, p, a, au).action, expected);
  }
  const originalPublicUrl = process.env.RUYI_PUBLIC_URL;
  process.env.RUYI_PUBLIC_URL = 'https://ruyi.example///';
  try {
    const calls = [];
    const state = {
      '/api/status': { workspaceStatus: '等待操作', rawCount: 0, createCount: 0, createNames: ['不可泄露'], analyseCount: 0, doneCount: 0 },
      '/api/platform-state': { status: 'valid' },
      '/api/jobs/active': { job: null },
      '/api/jobs?page=1&pageSize=20': { items: [] },
      '/api/auto-advance': { enabled: false, phase: 'idle', message: '' },
      '/api/platform-status': { idfaPending: 0, oaidPending: 0, pnPending: 0, insightPending: 0, resultPending: 0 },
    };
    let responseStatus = 200;
    const app = { inject: async (options) => {
      assert.ok(['GET', 'POST'].includes(options.method));
      calls.push(options);
      const data = state[options.url];
      assert.ok(data, `未预期的 API 地址：${options.url}`);
      return { statusCode: options.url === '/api/platform-status' || responseStatus === 500 ? responseStatus : 200, json: () => data, body: JSON.stringify(data) };
    } };
    const request = { user: { id: 7 }, headers: { authorization: 'Bearer fake', 'user-agent': 'x'.repeat(1000) }, protocol: 'http', host: 'localhost:3000', ip: '127.0.0.9' };
    const reply = { raw: new EventEmitter() };
    const tools = createTools(app, request, reply, { uploadRoot: '/tmp/mcp-fixture', createTicket: async (_db, input) => { assert.equal(input.userId, 7); return { secret: 'fake-transfer', expiresAt: '2030-01-01' }; } });
    const overview = () => tools.get_overview({});
    const next = async (action) => {
      const result = await overview();
      assert.equal(result.structuredContent.nextStep.action, action);
      assert.ok(!JSON.stringify(result).includes('不可泄露'));
      assert.ok(!JSON.stringify(result).includes('createNames'));
      assert.ok(result.content[0].text.includes('\n'));
    };
    await next('import_files');
    state['/api/jobs?page=1&pageSize=20'].items = [{ id: 'download', task: 'download', status: 'succeeded', resultFiles: 1 }];
    await next('prepare_download');
    state['/api/jobs?page=1&pageSize=20'].items = [];
    const upload = await tools.prepare_upload({});
    assert.match(upload.structuredContent.uploadUrl, /^https:\/\/ruyi.example\/api\/transfer\/upload\//);
    assert.match(upload.content[0].text, /不要读取文件内容/);
    state['/api/jobs/active'].job = { id: 'busy' };
    assert.equal((await tools.prepare_upload({})).isError, true);
    state['/api/jobs/active'].job = null;
    state['/api/run/upload'] = { id: 'queued', status: 'queued', position: 1 };
    assert.equal((await tools.run_task({ task: 'upload' })).structuredContent.jobId, 'queued');
    assert.equal(calls.at(-1).method, 'POST');
    state['/api/jobs/result/results'] = { count: 2, size: 100 };
    const download = await tools.prepare_download({ jobId: 'result' });
    assert.equal(download.structuredContent.fileCount, 2);
    assert.match(download.structuredContent.curlExample, /curl -sS -fL/);
    assert.match(download.content[0].text, /下载后不要解压或打开查看，只报告路径和大小/);
    assert.match(download.content[0].text, /除非用户明确要求查看结果/);
    state['/api/jobs/result/cancel'] = { result: 'cancelled' };
    assert.ok(!(await tools.cancel_job({ jobId: 'result' })).isError);
    assert.ok(!(await tools.set_auto_advance({ enabled: false })).isError);
    assert.deepEqual(calls.at(-1).payload, { enabled: false });
    state['/api/status'].doneCount = 1;
    await next('wait_results');
    state['/api/auto-advance'].phase = 'resultsReady';
    await next('run_download');
    state['/api/status'].analyseCount = 1;
    await next('wait_audience');
    state['/api/status'].createCount = 1;
    await next('wait_platform_files');
    state['/api/status'].rawCount = 2;
    await next('run_upload');
    state['/api/jobs/active'].job = { id: 'active', status: 'running' };
    await next('wait_job');
    state['/api/platform-state'].status = 'missing';
    await next('login');
    assert.equal((await overview()).structuredContent.platformLogin.loginUrl, 'https://ruyi.example/#/platform-login');
    for (const options of calls) {
      assert.equal(options.headers.authorization, 'Bearer fake');
      assert.match(options.headers['user-agent'], /^ruyi-mcp\//);
      assert.ok(options.headers['user-agent'].length < 1000);
      assert.equal(options.remoteAddress, '127.0.0.9');
    }
    state['/api/platform-state'].status = 'valid';
    state['/api/platform-status'].oaidPending = 1;
    const platform = await tools.check_platform({});
    assert.equal(platform.structuredContent.ready.create, false);
    assert.equal(platform.structuredContent.ready.analyse, true);
    assert.equal(platform.structuredContent.ready.download, true);
    state['/api/platform-status'].oaidPending = 0;
    assert.equal((await tools.check_platform({})).structuredContent.ready.create, true);
    responseStatus = 409;
    state['/api/platform-status'] = { code: 'PLATFORM_LOGIN_REQUIRED', message: '登录已失效' };
    let error = await tools.check_platform({});
    assert.equal(error.isError, true);
    assert.match(error.content[0].text, /https:\/\/ruyi\.example\/#\/platform-login/);
    assert.match(error.content[0].text, /不要重试/);
    state['/api/platform-status'] = { message: '锁已占用' };
    error = await tools.check_platform({});
    assert.equal(error.isError, true);
    assert.match(error.content[0].text, /平台检查正在进行.*1 分钟/);
    responseStatus = 500;
    state['/api/jobs/active'] = { message: '不应暴露的内部错误' };
    error = await overview();
    assert.equal(error.isError, true);
    assert.match(error.content[0].text, /平台服务出错，请稍后重试/);
    assert.ok(!error.content[0].text.includes('不应暴露'));
    console.log('MCP 非数据库工具映射、进度优先级、请求上下文和错误提示测试通过。');
  } finally {
    if (originalPublicUrl === undefined) delete process.env.RUYI_PUBLIC_URL;
    else process.env.RUYI_PUBLIC_URL = originalPublicUrl;
  }
}
main().catch((error) => { console.error('MCP 非数据库测试失败：', error); process.exitCode = 1; });

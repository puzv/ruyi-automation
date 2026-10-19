const assert = require('assert');
const { pathToFileURL } = require('url');
const path = require('path');

async function main() {
  const { apiFetch, requestJson, AUTH_EVENTS } = await import(pathToFileURL(path.join(__dirname, '../web/src/api.js')));
  const { formatTime, logDescription, logTarget, actionLabels } = await import(pathToFileURL(path.join(__dirname, '../web/src/labels.js')));
  const originalFetch = global.fetch;
  const originalWindow = global.window;
  const events = [];
  global.window = { dispatchEvent: (event) => events.push(event.type) };
  let request;
  let response = { ok: true };
  let status = 200;
  global.fetch = async (url, options) => {
    request = { url, ...options };
    return new Response(JSON.stringify(response), { status });
  };
  try {
    await requestJson('/api/example', { method: 'POST', credentials: 'omit', body: { name: '测试' } });
    assert.strictEqual(request.credentials, 'same-origin');
    assert.strictEqual(request.headers.get('content-type'), 'application/json');
    assert.deepStrictEqual(JSON.parse(request.body), { name: '测试' });
    const form = new FormData();
    form.append('name', '测试');
    await apiFetch('/api/import-folder', { method: 'POST', body: form });
    assert.strictEqual(request.body, form);
    assert.strictEqual(request.headers.has('content-type'), false);
    response = { ok: false, code: 'UNAUTHENTICATED', message: '请先登录' }; status = 401;
    const unauthenticated = await apiFetch('/api/auth/me');
    assert.deepStrictEqual(await unauthenticated.json(), response);
    assert.deepStrictEqual(events, [AUTH_EVENTS.unauthenticated]);
    response = { ok: false, message: '用户名或密码错误' };
    await assert.rejects(requestJson('/api/auth/login'), /用户名或密码错误/);
    assert.strictEqual(events.length, 1);
    status = 403; response = { ok: false, code: 'PASSWORD_CHANGE_REQUIRED', message: '请先修改密码' };
    await apiFetch('/api/status');
    assert.strictEqual(events[1], AUTH_EVENTS.passwordChangeRequired);
    response.code = 'FORBIDDEN';
    await apiFetch('/api/admin/users');
    assert.strictEqual(events.length, 2);
    global.fetch = async () => { throw new Error('network'); };
    await assert.rejects(requestJson('/api/auth/me'), /无法连接服务/);
    assert.strictEqual(formatTime('2026-10-19T16:05:06.000Z'), '2026-10-20 00:05:06');
    assert.strictEqual(formatTime(null), '—');
    assert.strictEqual(formatTime('invalid'), '—');
    assert.strictEqual(actionLabels['job.start'], '启动任务');
    assert.strictEqual(logDescription({ action: 'file.import', detail: { count: 3, skipped: 2 } }), '导入 3 个，跳过 2 个');
    assert.strictEqual(logDescription({ action: 'job.finish', detail: { task: 'analyse', durationMs: 1250, code: 0 } }), '人群洞悉，耗时 1.25 秒，退出码 0');
    assert.strictEqual(logDescription({ action: 'auth.login', result: 'failure', errorMessage: '用户名或密码错误', detail: { reason: 'unknown_user' } }), '用户名或密码错误；用户名不存在');
    assert.strictEqual(logDescription({ action: 'job.start', detail: { task: 'upload' } }), '上传文件');
    assert.strictEqual(logDescription({ action: 'job.start', result: 'failure', errorMessage: '任务启动失败' }), '任务启动失败');
    assert.strictEqual(logTarget({ targetType: 'job', targetId: 3 }), '任务 · 3');
    assert.strictEqual(logTarget({}), '—');
  } finally {
    global.fetch = originalFetch;
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
  }
  console.log('前端请求封装与操作记录格式测试通过');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

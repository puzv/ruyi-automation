const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-routes-test-'));
const previousUploadDir = process.env.RUYI_UPLOAD_DIR;
process.env.RUYI_UPLOAD_DIR = tempDir;

// 互斥分支一旦失效就立即失败，避免测试意外启动浏览器或真实任务。
const browser = require('../lib/browser');
const preflight = require('../lib/preflight');
const childProcess = require('node:child_process');
const originals = { ...browser, forceReleaseProfile: preflight.forceReleaseProfile, spawn: childProcess.spawn };
const unexpectedOperation = () => { throw new Error('测试不得启动浏览器、释放真实 Profile 或运行脚本'); };
browser.launchBrowser = unexpectedOperation;
browser.closeBrowserContext = async (context) => context.close();
preflight.forceReleaseProfile = unexpectedOperation;
childProcess.spawn = unexpectedOperation;
const { buildApp } = require('../server/app');
const state = require('../server/state');
const { trackContext } = require('../server/platform');

function multipart(files) {
  const boundary = 'ruyi-test-boundary';
  const chunks = [];
  for (const { filename, content, field = 'files' } of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    chunks.push(Buffer.from(content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(chunks) };
}

async function main() {
  const app = buildApp({ auth: false, logger: false, webDist: path.join(tempDir, 'missing-dist') });
  try {
    fs.mkdirSync(path.join(tempDir, 'raw'));
    fs.mkdirSync(path.join(tempDir, 'oaid', 'done'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'raw', 'a_idfa.txt'), 'a');
    fs.writeFileSync(path.join(tempDir, 'oaid', 'b_oaid.txt'), 'b');
    fs.writeFileSync(path.join(tempDir, 'oaid', 'done', 'c_oaid.txt'), 'c');
    fs.writeFileSync(path.join(tempDir, 'createGroupToDoList.json'), '["x_pn.txt"]');
    fs.writeFileSync(path.join(tempDir, 'done.json'), '["y"]');
    const status = await app.inject({ method: 'GET', url: '/api/status' });
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.json(), {
      ok: true, rawCount: 2, createCount: 1, createNames: ['x_pn.txt'],
      doneCount: 1, analyseCount: 0, workspaceStatus: '等待创建人群包',
    });

    const runtime = await app.inject('/api/runtime-mode');
    assert.equal(typeof runtime.json().headless, 'boolean');
    const updated = await app.inject({ method: 'POST', url: '/api/runtime-mode', payload: { headless: false } });
    assert.deepEqual(updated.json(), { ok: true, headless: false });
    assert.equal((await app.inject('/api/runtime-mode')).json().headless, false);
    const invalidMode = await app.inject({ method: 'POST', url: '/api/runtime-mode', payload: { headless: 'x' } });
    assert.equal(invalidMode.statusCode, 400);
    assert.deepEqual(invalidMode.json(), { ok: false, message: 'headless 必须是布尔值' });

    state.profileReleaseRunning = true;
    const emptyJson = await app.inject({ method: 'POST', url: '/api/profile-release', headers: { 'content-type': 'application/json' } });
    assert.equal(emptyJson.statusCode, 409);
    assert.deepEqual(emptyJson.json(), { ok: false, message: 'Profile 释放正在进行，请稍候。' });
    state.profileReleaseRunning = false;

    state.profileProbeRunning = true;
    for (const [method, url, message] of [
      ['GET', '/api/login-status', '登录状态检查正在进行，请稍后重试。'],
      ['GET', '/api/platform-status', '平台状态检查正在进行，请稍后重试。'],
      ['POST', '/api/login-open', '浏览器 Profile 正在执行其他操作，请稍后重试。'],
    ]) {
      const response = await app.inject({ method, url });
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json(), { ok: false, message });
    }
    state.profileProbeRunning = false;

    const content = '测试文件内容\nabc';
    const upload = await app.inject({ method: 'POST', url: '/api/import-folder', ...multipart([
      { filename: '测试_idfa.txt', content }, { filename: 'notes.md', content: '忽略' },
    ]) });
    assert.equal(upload.statusCode, 200);
    assert.deepEqual(upload.json(), { ok: true, count: 1, skipped: 1 });
    assert.equal(fs.readFileSync(path.join(tempDir, 'raw', '测试_idfa.txt'), 'utf8'), content);
    const duplicate = await app.inject({ method: 'POST', url: '/api/import-folder', ...multipart([{ filename: '测试_idfa.txt', content: '不覆盖' }]) });
    assert.equal(duplicate.statusCode, 400);
    assert.match(duplicate.json().message, /文件已存在/);
    assert.equal(fs.readFileSync(path.join(tempDir, 'raw', '测试_idfa.txt'), 'utf8'), content);

    const rawDir = path.join(tempDir, 'raw');
    const beforeTraversal = fs.readdirSync(rawDir).sort();
    const originalWriteFile = fs.writeFileSync;
    const writtenPaths = [];
    try {
      // 在写入发生前检查目标，避免回归时真的在临时目录外生成文件。
      fs.writeFileSync = (filename, ...args) => {
        const target = path.resolve(filename);
        assert.equal(target, path.join(rawDir, 'evil_idfa.txt'));
        writtenPaths.push(target);
        return originalWriteFile(filename, ...args);
      };
      const traversal = await app.inject({ method: 'POST', url: '/api/import-folder', ...multipart([
        { filename: '../../etc/evil_idfa.txt', content: '路径穿越测试' },
      ]) });
      assert.equal(traversal.statusCode, 200);
      assert.deepEqual(traversal.json(), { ok: true, count: 1, skipped: 0 });
    } finally {
      fs.writeFileSync = originalWriteFile;
    }
    assert.deepEqual(writtenPaths, [path.join(rawDir, 'evil_idfa.txt')]);
    assert.deepEqual(fs.readdirSync(rawDir).sort(), [...beforeTraversal, 'evil_idfa.txt'].sort());
    assert.equal(fs.readFileSync(path.join(rawDir, 'evil_idfa.txt'), 'utf8'), '路径穿越测试');

    for (const [filename, savedName] of [
      ['sub/dir/z_oaid.csv', 'z_oaid.csv'],
      [Buffer.from('测试_pn.txt', 'utf8').toString('latin1'), '测试_pn.txt'],
    ]) {
      const before = fs.readdirSync(rawDir).sort();
      const response = await app.inject({ method: 'POST', url: '/api/import-folder', ...multipart([
        { filename, content: '文件名测试' },
      ]) });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { ok: true, count: 1, skipped: 0 });
      assert.deepEqual(fs.readdirSync(rawDir).sort(), [...before, savedName].sort());
      assert.equal(fs.readFileSync(path.join(rawDir, savedName), 'utf8'), '文件名测试');
    }

    const beforeSkipped = fs.readdirSync(rawDir).sort();
    const skipped = await app.inject({ method: 'POST', url: '/api/import-folder', ...multipart(
      ['.hidden_idfa.txt', 'a_idfa.xlsx', 'readme.txt'].map((filename) => ({ filename, content: '应忽略' }))
    ) });
    assert.equal(skipped.statusCode, 200);
    assert.deepEqual(skipped.json(), { ok: true, count: 0, skipped: 3 });
    assert.deepEqual(fs.readdirSync(rawDir).sort(), beforeSkipped);

    const nonMultipart = await app.inject({ method: 'POST', url: '/api/import-folder', payload: { files: [] } });
    assert.equal(nonMultipart.statusCode, 200);
    assert.deepEqual(nonMultipart.json(), { ok: true, count: 0, skipped: 0 });
    assert.deepEqual(fs.readdirSync(rawDir).sort(), beforeSkipped);

    // 大于 multipart 默认的 1MB 和 JSON 的 2MB，验证文件上传未沿用小上限。
    const largeContent = 'x'.repeat(3 * 1024 * 1024);
    const largeUpload = await app.inject({ method: 'POST', url: '/api/import-folder', ...multipart([{ filename: 'large_oaid.txt', content: largeContent }]) });
    assert.equal(largeUpload.statusCode, 200);
    assert.equal(fs.statSync(path.join(tempDir, 'raw', 'large_oaid.txt')).size, largeContent.length);
    const badField = await app.inject({ method: 'POST', url: '/api/import-folder', ...multipart([{ filename: 'bad_pn.txt', content: 'x', field: 'other' }]) });
    assert.equal(badField.statusCode, 400);
    assert.equal(badField.json().ok, false);

    for (const [method, url, message] of [
      ['POST', '/api/run/unknown', '未知操作'],
      ['GET', '/api/jobs/不存在', '任务不存在'],
      ['GET', '/api/unregistered', '接口不存在'],
    ]) {
      const response = await app.inject({ method, url });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { ok: false, message });
    }
    state.jobs.set('fake', { running: true });
    const busy = await app.inject({ method: 'POST', url: '/api/run/upload' });
    assert.equal(busy.statusCode, 409);
    assert.deepEqual(busy.json(), { ok: false, message: '已有脚本正在运行，请等待完成' });
    const job = await app.inject('/api/jobs/fake');
    assert.equal(job.statusCode, 200);
    assert.deepEqual(job.json(), { running: true });

    // 暂时移除运行中任务，确保每个 409 都来自指定的互斥条件。
    const runningJob = state.jobs.get('fake');
    state.jobs.delete('fake');
    try {
      for (const [key, value, message] of [
        ['profileReleaseRunning', true, 'Profile 资源释放正在进行，请稍后重试'],
        ['profileProbeRunning', true, '登录或平台状态检查正在进行，请稍后重试'],
        ['loginFlow', {}, '登录窗口仍在使用 Profile，请完成登录并关闭窗口后再运行任务'],
      ]) {
        const previous = state[key];
        try {
          state[key] = value;
          const response = await app.inject({ method: 'POST', url: '/api/run/upload' });
          assert.equal(response.statusCode, 409);
          assert.deepEqual(response.json(), { ok: false, message });
        } finally {
          state[key] = previous;
        }
      }
    } finally {
      state.jobs.set('fake', runningJob);
    }

    const completedJob = { id: 't1', task: 'upload', running: false, output: 'hello', code: 0 };
    Object.defineProperty(completedJob, 'child', { value: { pid: 123 }, enumerable: false });
    state.jobs.set('t1', completedJob);
    try {
      const response = await app.inject('/api/jobs/t1');
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.deepEqual(body, { id: 't1', task: 'upload', running: false, output: 'hello', code: 0 });
      assert.equal(Object.hasOwn(body, 'child'), false);
    } finally {
      state.jobs.delete('t1');
    }

    const badJson = await app.inject({ method: 'POST', url: '/api/runtime-mode', headers: { 'content-type': 'application/json' }, payload: '{bad' });
    assert.equal(badJson.statusCode, 400);
    assert.equal(badJson.json().ok, false);
    const oversizedJson = await app.inject({ method: 'POST', url: '/api/runtime-mode', payload: { headless: true, padding: largeContent } });
    assert.equal(oversizedJson.statusCode, 413);
    assert.equal(oversizedJson.json().ok, false);
    const allowedPayload = { headless: true, padding: 'x'.repeat(1024 * 1024 - 128) };
    assert.ok(Buffer.byteLength(JSON.stringify(allowedPayload)) < 1024 * 1024);
    const allowedJson = await app.inject({ method: 'POST', url: '/api/runtime-mode', payload: allowedPayload });
    assert.equal(allowedJson.statusCode, 200);
    assert.deepEqual(allowedJson.json(), { ok: true, headless: true });
    assert.equal((await app.inject('/api/runtime-mode')).json().headless, true);

    const webDist = path.join(tempDir, 'dist');
    const indexHtml = '<!doctype html><html><body>接口回退测试</body></html>';
    fs.mkdirSync(webDist);
    fs.writeFileSync(path.join(webDist, 'index.html'), indexHtml);
    const builtApp = buildApp({ auth: false, logger: false, webDist });
    try {
      for (const method of ['GET', 'POST']) {
        const response = await builtApp.inject({ method, url: '/api/nope' });
        assert.equal(response.statusCode, 404);
        assert.match(response.headers['content-type'], /application\/json/);
        assert.deepEqual(response.json(), { ok: false, message: '接口不存在' });
      }
      const page = await builtApp.inject('/nope');
      assert.equal(page.statusCode, 200);
      assert.match(page.headers['content-type'], /text\/html/);
      assert.equal(page.body, indexHtml);
    } finally {
      await builtApp.close();
    }

    const logs = [];
    const loggingApp = buildApp({ auth: false,
      logger: { level: 'info', stream: { write: (line) => logs.push(JSON.parse(line)) } },
      webDist,
    });
    loggingApp.get('/api/test-redirect', (_request, reply) => reply.redirect('/api/status'));
    loggingApp.get('/api/test-error', () => { throw new Error('模拟日志异常'); });
    try {
      for (const url of ['/api/status', '/', '/index.html', '/api/test-redirect']) {
        const response = await loggingApp.inject(url);
        assert.ok(response.statusCode < 400);
        assert.deepEqual(logs, []);
      }
      for (const [method, url, statusCode] of [
        ['POST', '/api/run/unknown', 404],
        ['GET', '/api/jobs/missing-job', 404],
        ['POST', '/api/runtime-mode', 200],
      ]) {
        logs.length = 0;
        const response = await loggingApp.inject({ method, url, ...(statusCode === 200 ? { payload: { headless: true } } : {}) });
        assert.equal(response.statusCode, statusCode);
        assert.equal(logs.length, 1);
        assert.equal(logs[0].level, 30);
        assert.ok(logs[0].msg.startsWith(`${method} ${url} ${statusCode} `));
        assert.match(logs[0].msg, / \d+ms$/);
      }
      logs.length = 0;
      assert.equal((await loggingApp.inject({ method: 'POST', url: '/missing-page' })).statusCode, 404);
      assert.deepEqual(logs, []);

      assert.equal((await loggingApp.inject('/api/test-error')).statusCode, 500);
      assert.equal(logs.length, 2);
      assert.equal(logs[0].level, 50);
      assert.equal(logs[0].err.message, '模拟日志异常');
      assert.match(logs[0].err.stack, /server-routes\.test\.js/);
      assert.match(logs[1].msg, /^GET \/api\/test-error 500 \d+ms$/);
    } finally {
      await loggingApp.close();
    }

    const readableApp = buildApp({ auth: false, webDist });
    readableApp.get('/api/test-error', () => { throw new Error('模拟易读日志异常'); });
    const output = [];
    const originalStdoutWrite = process.stdout.write;
    try {
      process.stdout.write = (line) => { output.push(String(line)); return true; };
      readableApp.log.debug('不应输出调试日志');
      // 启动提示与普通应用日志使用同一输出通道，无需监听端口。
      readableApp.log.info('Server listening at http://127.0.0.1:5173');
      assert.equal((await readableApp.inject('/api/status')).statusCode, 200);
      assert.equal((await readableApp.inject({ method: 'POST', url: '/api/run/unknown' })).statusCode, 404);
      assert.equal((await readableApp.inject('/api/test-error')).statusCode, 500);
    } finally {
      process.stdout.write = originalStdoutWrite;
      await readableApp.close();
    }
    assert.equal(output.length, 4);
    assert.match(output[0], /^\d{2}:\d{2}:\d{2} INFO Server listening at http:\/\/127\.0\.0\.1:5173\n$/);
    assert.match(output[1], /^\d{2}:\d{2}:\d{2} INFO POST \/api\/run\/unknown 404 \d+ms\n$/);
    assert.match(output[2], /^\d{2}:\d{2}:\d{2} ERROR 模拟易读日志异常\nError: 模拟易读日志异常\n/);
    assert.match(output[2], /server-routes\.test\.js/);
    assert.match(output[3], /^\d{2}:\d{2}:\d{2} INFO GET \/api\/test-error 500 \d+ms\n$/);

    // 文件系统异常也必须返回统一 API JSON，不能泄露 Fastify 默认格式。
    const rawPath = path.join(tempDir, 'raw');
    const originalReaddir = fs.readdirSync;
    try {
      fs.readdirSync = (folder, ...args) => {
        if (folder === rawPath) throw new Error('模拟目录读取失败');
        return originalReaddir(folder, ...args);
      };
      const failure = await app.inject('/api/status');
      assert.equal(failure.statusCode, 500);
      assert.deepEqual(failure.json(), { ok: false, message: '模拟目录读取失败' });
    } finally {
      fs.readdirSync = originalReaddir;
    }

    const context = new EventEmitter();
    let closed = false;
    context.close = async () => { closed = true; context.emit('close'); };
    trackContext(context);
    state.loginContexts.add(context);
    await app.close();
    assert.equal(closed, true);
    assert.equal(state.activeContexts.size, 0);
    assert.equal(state.loginContexts.size, 0);
    assert.equal(state.jobs.get('fake').running, true);
  } finally {
    await app.close();
    state.jobs.clear();
    state.profileProbeRunning = false;
    state.profileReleaseRunning = false;
    browser.launchBrowser = originals.launchBrowser;
    browser.closeBrowserContext = originals.closeBrowserContext;
    preflight.forceReleaseProfile = originals.forceReleaseProfile;
    childProcess.spawn = originals.spawn;
    if (previousUploadDir === undefined) delete process.env.RUYI_UPLOAD_DIR;
    else process.env.RUYI_UPLOAD_DIR = previousUploadDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('后端接口迁移测试通过');
}

main().catch((error) => {
  console.error('后端接口迁移测试失败：', error);
  process.exitCode = 1;
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { loadKeys, encryptState } = require('@ruyi/shared/runtime/platform-state/crypto');
const keys = loadKeys({ RUYI_STATE_KEY: crypto.randomBytes(32).toString('base64') });

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-isolation-test-'));
const previousUploadDir = process.env.RUYI_UPLOAD_DIR;
process.env.RUYI_UPLOAD_DIR = path.join(tempDir, 'legacy');
const childProcess = require('node:child_process');
const browser = require('@ruyi/automation/lib/browser');
const originals = { spawn: childProcess.spawn, kill: process.kill, launchBrowser: browser.launchBrowser,
  closeBrowserContext: browser.closeBrowserContext };
const children = [];
const signals = [];
childProcess.spawn = (command, args, options) => {
  const child = new EventEmitter();
  child.pid = 900000 + children.length;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  children.push({ child, command, args, options });
  return child;
};
process.kill = (pid, signal) => { signals.push({ pid, signal }); return true; };
browser.launchBrowser = () => { throw new Error('隔离测试不得启动真实浏览器'); };
browser.closeBrowserContext = async (context) => context.close();
const platform = require('@ruyi/server/src/modules/files/platform');
const platformOriginals = { inspectPlatformFiles: platform.inspectPlatformFiles,
  inspectAnalyseAudience: platform.inspectAnalyseAudience, inspectInsightResults: platform.inspectInsightResults };
const inspections = [];
platform.inspectPlatformFiles = async (type, names) => { inspections.push({ type, names }); return { missingCount: names.length }; };
platform.inspectAnalyseAudience = async (names) => { inspections.push({ type: 'analyse', names }); return names.length; };
platform.inspectInsightResults = async (names) => { inspections.push({ type: 'result', names }); return names.length; };
const { buildApp } = require('@ruyi/server/src/app');
const { startJob } = require('@ruyi/server/src/modules/jobs/memory');
const state = require('@ruyi/server/src/state');
const { resolveWorkspace, getWorkspaceStatus } = require('@ruyi/shared/runtime/workspace');
const { createPlatformName } = require('@ruyi/automation/lib/file-manifest');

const users = { alice: { id: 1, username: 'alice', role: 'user' },
  bob: { id: 2, username: 'bob', role: 'user' }, admin: { id: 3, username: 'admin', role: 'admin' } };
const dataRoot = path.join(tempDir, 'data');

function multipart(files) {
  const boundary = 'isolation-test-boundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(files.flatMap(({ name, content }) => [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n`),
      Buffer.from(content), Buffer.from('\r\n'),
    ]).concat(Buffer.from(`--${boundary}--\r\n`))),
  };
}

function rawFiles(workspace) {
  const result = [];
  function walk(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) result.push(file);
    }
  }
  walk(path.join(workspace, 'raw'));
  return result;
}

async function main() {
  const entries = [];
  const fakeDb = { selectFrom(table) {
    assert.equal(table, 'ruyi_platform_states');
    return { selectAll() { return this; }, where(_column, _op, userId) {
      return { async executeTakeFirst() { return { status: 'valid', version: 1, key_version: 1,
        state_ciphertext: encryptState({ cookies: [], origins: [] }, userId, keys).ciphertext }; } };
    } };
  }, insertInto(table) {
    assert.equal(table, 'ruyi_operation_logs');
    return { values(value) { return { async execute() { entries.push(value); } }; } };
  } };
  const app = buildApp({ auth: false, stateKeys: keys, uploadRoot: dataRoot, logger: false, webDist: path.join(tempDir, 'missing') });
  app.auditEnabled = true;
  app.decorate('db', fakeDb);
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => { req.user = users[req.headers['x-test-user']] || null; });
  const request = (who, method, url, extra = {}) => app.inject({ method, url, ...extra,
    headers: { ...extra.headers, 'x-test-user': who } });
  try {
    const alice = resolveWorkspace(users.alice, dataRoot);
    const bob = resolveWorkspace(users.bob, dataRoot);
    assert.equal(alice, path.join(dataRoot, 'users', 'alice'));
    assert.throws(() => resolveWorkspace({ username: '../bob' }, dataRoot), /用户工作区无效/);
    assert.equal((await request('alice', 'GET', '/api/status')).json().rawCount, 0);
    const imported = await request('alice', 'POST', '/api/import-folder', multipart([
      { name: '样本_pn.txt', content: 'first' }, { name: '样本_pn.txt', content: 'second' },
    ]));
    assert.equal(imported.statusCode, 200);
    assert.equal(imported.json().count, 2);
    assert.equal((await request('alice', 'POST', '/api/import-folder', multipart([{ name: '样本_pn.txt', content: 'third' }]))).statusCode, 200);
    const files = rawFiles(alice);
    assert.equal(files.length, 3);
    assert.equal(new Set(files).size, 3);
    assert.deepEqual(files.map((file) => fs.readFileSync(file, 'utf8')).sort(), ['first', 'second', 'third']);
    assert.ok(files.every((file) => /^raw\/[^/]+\/\d+\/样本_pn\.txt$/.test(path.relative(alice, file))));
    assert.equal((await request('bob', 'POST', '/api/import-folder', multipart([{ name: 'bob_oaid.txt', content: 'bob' }]))).statusCode, 200);
    assert.equal((await request('bob', 'GET', `/api/status?uploadDir=${encodeURIComponent(alice)}`)).json().rawCount, 1);
    assert.equal((await request('alice', 'GET', '/api/status')).json().rawCount, 3);

    const originalWriteFile = fs.writeFileSync;
    try {
      fs.writeFileSync = () => {
        const error = new Error(`模拟写入失败：${alice}`);
        error.code = 'EACCES';
        throw error;
      };
      const failedImport = await request('alice', 'POST', '/api/import-folder', multipart([{ name: 'failed_pn.txt', content: 'failure' }]));
      assert.equal(failedImport.statusCode, 400);
      assert.deepEqual(failedImport.json(), { ok: false, message: '文件导入失败，请联系管理员' });
      assert.equal(failedImport.body.includes(alice), false);
    } finally {
      fs.writeFileSync = originalWriteFile;
    }

    fs.mkdirSync(path.join(alice, 'idfa', 'done'), { recursive: true });
    fs.mkdirSync(path.join(alice, 'idfa', 'nested'));
    fs.writeFileSync(path.join(alice, 'idfa', 'pending_without_type.txt'), 'pending');
    fs.writeFileSync(path.join(alice, 'idfa', 'done', 'done_idfa.txt'), 'done');
    fs.writeFileSync(path.join(alice, 'idfa', 'nested', 'nested_idfa.txt'), 'nested');
    fs.symlinkSync(path.join(bob, 'raw'), path.join(alice, 'raw', 'linked-dir'));
    fs.symlinkSync(rawFiles(bob)[0], path.join(alice, 'raw', 'linked_oaid.txt'));
    fs.symlinkSync(path.join(tempDir, 'missing-target'), path.join(alice, 'raw', 'broken_pn.txt'));
    assert.equal(getWorkspaceStatus(alice).rawCount, 4);
    fs.symlinkSync(alice, path.join(dataRoot, 'users', 'sym'));
    assert.throws(() => resolveWorkspace({ username: 'sym' }, dataRoot), /工作区目录不安全/);

    const uploadJobId = 'manifest-upload-job';
    const platformName = createPlatformName({ username: 'pnalice', type: 'idfa', jobId: uploadJobId, sequence: 1 });
    fs.writeFileSync(path.join(alice, 'createGroupToDoList.json'), JSON.stringify([platformName]));
    fs.writeFileSync(path.join(alice, 'analyseToDoList.json'), JSON.stringify(['alice_analyse']));
    fs.writeFileSync(path.join(alice, 'done.json'), JSON.stringify(['alice_result']));
    fs.writeFileSync(path.join(alice, 'file-manifest.json'), JSON.stringify({ version: 1,
      files: [{ platformName, originalName: 'original_idfa.txt', type: 'idfa', jobId: uploadJobId,
        sequence: 1, originalPath: 'raw/batch/1/original_idfa.txt', currentPath: `idfa/${platformName}.txt`, stage: 'uploaded' }] }));
    const platformStatus = await request('alice', 'GET', '/api/platform-status');
    assert.equal(platformStatus.statusCode, 200);
    assert.equal(platformStatus.json().idfaPending, 1);
    assert.equal(platformStatus.json().pnPending, 0);
    assert.deepEqual(inspections, [ { type: 'idfa', names: [platformName] },
      { type: 'analyse', names: ['alice_analyse'] }, { type: 'result', names: ['alice_result'] } ]);
    inspections.length = 0;
    assert.equal((await request('bob', 'GET', '/api/platform-status')).statusCode, 200);
    assert.deepEqual(inspections, []);
    fs.symlinkSync(path.join(alice, 'done.json'), path.join(bob, 'done.json'));
    assert.equal((await request('bob', 'GET', '/api/status')).json().doneCount, 0);
    assert.equal((await request('bob', 'GET', '/api/status')).json().createCount, 0);

    const started = await request('alice', 'POST', '/api/run/upload');
    assert.equal(started.statusCode, 200);
    const id = started.json().id;
    assert.match(id, /^[a-f0-9-]{36}$/);
    assert.equal(state.jobs.get(id).userId, 1);
    assert.equal(state.jobs.get(id).username, 'alice');
    const spawned = children.at(-1);
    assert.equal(spawned.options.env.RUYI_UPLOAD_DIR, alice);
    assert.equal(spawned.options.env.RUYI_USER, 'alice');
    assert.equal(spawned.options.env.RUYI_JOB_ID, id);
    assert.equal(spawned.options.cwd, require('@ruyi/shared/config').projectRoot);
    for (const folder of ['raw', 'idfa', 'oaid', 'pn', 'result']) assert.ok(fs.statSync(path.join(alice, folder)).isDirectory());
    spawned.child.stdout.emit('data', Buffer.from('任务输出'));
    const ownJob = (await request('alice', 'GET', `/api/jobs/${id}`)).json();
    assert.equal(ownJob.output, '任务输出');
    assert.equal(Object.hasOwn(ownJob, 'child'), false);
    assert.equal(Object.hasOwn(ownJob, 'userId'), false);
    assert.equal((await request('bob', 'GET', `/api/jobs/${id}`)).statusCode, 404);
    assert.equal((await request('admin', 'GET', `/api/jobs/${id}`)).statusCode, 404);
    const ownBusy = await request('alice', 'POST', '/api/run/analyse');
    assert.equal(ownBusy.statusCode, 409);
    assert.match(ownBusy.json().message, /当前用户已有任务/);
    const concurrent = await request('bob', 'POST', '/api/run/upload');
    assert.equal(concurrent.statusCode, 200, '不同用户使用独立登录态可同时运行');
    children.at(-1).child.emit('close', 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await request('alice', 'POST', '/api/import-folder', multipart([{ name: 'late_pn.txt', content: 'late' }]))).statusCode, 409);
    assert.equal(rawFiles(alice).length, 3);
    assert.equal((await request('bob', 'POST', '/api/import-folder', multipart([{ name: 'next_pn.txt', content: 'allowed' }]))).statusCode, 200);
    assert.equal((await request('bob', 'GET', '/api/login-status')).statusCode, 404);
    for (const who of ['bob', 'admin']) {
      for (const url of ['/api/login-open', '/api/profile-release']) {
        const removed = await request(who, 'POST', url);
        assert.equal(removed.statusCode, 404);
        assert.deepEqual(removed.json(), { ok: false, message: '接口不存在' });
      }
    }
    assert.deepEqual(signals, [], '已删除接口不得终止其他用户的任务');
    assert.equal(state.jobs.get(id).running, true);
    spawned.child.emit('close', 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    const startEntry = entries.find((entry) => entry.action === 'job.start' && entry.result === 'success');
    const finishEntry = entries.find((entry) => entry.action === 'job.finish' && entry.target_id === id);
    assert.equal(finishEntry.user_id, 1);
    assert.equal(finishEntry.request_id, startEntry.request_id);
    assert.equal(finishEntry.target_id, id);
    assert.equal(JSON.stringify(entries).includes(dataRoot), false);
    assert.equal(JSON.stringify(entries).includes('RUYI_'), false);
    assert.equal(state.jobs.get(id).running, false);

    const freshStart = await request('admin', 'POST', '/api/run/analyse');
    assert.equal(freshStart.statusCode, 200);
    const adminWorkspace = resolveWorkspace(users.admin, dataRoot);
    for (const folder of ['raw', 'idfa', 'oaid', 'pn', 'result']) assert.ok(fs.statSync(path.join(adminWorkspace, folder)).isDirectory());
    children.at(-1).child.emit('close', 0);

    const ownStarted = await request('bob', 'POST', '/api/run/create');
    const ownId = ownStarted.json().id;
    const ownRelease = await request('bob', 'POST', '/api/profile-release');
    assert.equal(ownRelease.statusCode, 404);
    assert.equal(state.jobs.get(ownId).running, true);
    assert.deepEqual(signals, []);
    children.at(-1).child.emit('close', 0);

    let callbackCount = 0;
    let callbackJob;
    const directId = startJob('analyse', 'analyseAll.js', { user: users.alice, uploadDir: alice,
      onFinish(job) { callbackCount += 1; callbackJob = job; } });
    const directChild = children.at(-1).child;
    directChild.emit('error', new Error('模拟进程启动错误'));
    directChild.emit('close', -2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(callbackCount, 1);
    assert.equal(callbackJob.id, directId);
    assert.equal(callbackJob.code, 1);
    assert.equal(state.jobs.get(directId).running, false);
  } finally {
    await app.close();
    state.jobs.clear();
    childProcess.spawn = originals.spawn;
    process.kill = originals.kill;
    browser.launchBrowser = originals.launchBrowser;
    browser.closeBrowserContext = originals.closeBrowserContext;
    Object.assign(platform, platformOriginals);
    if (previousUploadDir === undefined) delete process.env.RUYI_UPLOAD_DIR;
    else process.env.RUYI_UPLOAD_DIR = previousUploadDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('用户工作区、导入、平台状态、任务归属和旧接口下线测试通过');
}

main().catch((error) => { console.error('用户隔离测试失败：', error); process.exitCode = 1; });

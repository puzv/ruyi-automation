const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createDb, readDbConfig } = require('../db');
const users = require('@ruyi/shared/runtime/repos/users');
const sessions = require('@ruyi/server/src/modules/auth/repository');
const states = require('@ruyi/shared/runtime/repos/platform-states');
const { hashToken } = require('@ruyi/server/src/modules/auth/session');
const { loadKeys } = require('@ruyi/shared/runtime/platform-state/crypto');
const { loadUserState, storeCapturedState } = require('@ruyi/shared/runtime/platform-state/index');
const { sanitizeDetail } = require('@ruyi/shared/runtime/audit');

const marker = 'JOB_STATE_FAKE_COOKIE_42';
const storageState = { cookies: [{ name: 'dn_token', value: marker, domain: '.datanexus.qq.com',
  path: '/', expires: Math.floor(Date.now() / 1000) + 86400, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] };
const refreshedState = { cookies: [], origins: [] };
const keys = loadKeys({ RUYI_STATE_KEY: crypto.randomBytes(32).toString('base64') });
const usernames = ['js_state_a', 'js_state_b', 'js_state_c'];
const detailOf = (row) => typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail;
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));

async function eventually(get, message) {
  for (let i = 0; i < 200; i++) {
    const value = await get();
    if (value) return value;
    await pause();
  }
  assert.fail(message);
}

async function testBrowser(tempDir) {
  const file = path.join(tempDir, 'browser-state.json');
  const source = fs.readFileSync(path.join(__dirname, '../packages/automation/lib/browser.js'), 'utf8');
  let writes = 0, contextClosed = 0, browserClosed = 0, launchOptions, contextOptions;
  const context = {
    pages: () => [{ isClosed: () => false, url: () => 'https://sso.e.qq.com/login' }],
    async storageState() { assert.fail('内存登录态不应回写'); },
    async close() { contextClosed++; },
    browser: () => fakeBrowser,
  };
  const fakeBrowser = {
    async newContext(options) { contextOptions = options; return context; },
    async close() { browserClosed++; },
  };
  const sandbox = { module: { exports: {} }, process, URL, console,
    require(name) {
      if (name === 'fs') return fs;
      if (name === 'path') return path;
      if (name === '@ruyi/shared/playwright-env') return {};
      if (name === 'playwright') return { chromium: {
        async launch(options) { launchOptions = options; return fakeBrowser; },
        launchPersistentContext() { assert.fail('不应启动共享 Profile'); },
      } };
      if (name === '@ruyi/shared/config') return { stateFile: file, browserHeadless: true };
      if (name === './preflight') return { waitForProfileRelease() { assert.fail('不应检查 Profile'); } };
      if (name === './storage-state') return require('@ruyi/automation/lib/storage-state');
      throw new Error('浏览器测试出现未预期依赖');
    },
  };
  vm.runInNewContext(source, sandbox);
  const { launchBrowser, closeBrowserContext, saveRefreshedState } = sandbox.module.exports;
  // 即使配置的文件不存在，也必须优先使用传入对象。
  const launched = await launchBrowser({ storageState, headless: false });
  assert.equal(contextOptions.storageState, storageState);
  assert.equal(launchOptions.headless, false);
  await saveRefreshedState(launched, file);
  await closeBrowserContext(launched);
  assert.equal(contextClosed, 1); assert.equal(browserClosed, 1);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.logged-out`), false);

  const original = JSON.stringify(storageState);
  const fakeContext = (urls) => ({
    pages: () => urls.map((url) => ({ url: () => url, isClosed: () => false })),
    async storageState({ path: output }) {
      assert.equal(fs.statSync(output).mode & 0o777, 0o600, '写入明文前临时文件权限已经受限');
      writes++;
      fs.writeFileSync(output, JSON.stringify(refreshedState));
    },
  });
  fs.writeFileSync(file, original, { mode: 0o600 });
  await saveRefreshedState(fakeContext(['https://ruyi.qq.com/audience']), file);
  assert.equal(writes, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), refreshedState);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${file}.logged-out`), false);
  for (const urls of [['https://sso.e.qq.com/'], ['https://ruyi.qq.com/login/'],
    ['https://ruyi.qq.com/audience', 'https://sso.e.qq.com/login']]) {
    fs.writeFileSync(file, original);
    await saveRefreshedState(fakeContext(urls), file);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(fs.statSync(`${file}.logged-out`).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(`${file}.logged-out`, 'utf8'), '');
    fs.rmSync(`${file}.logged-out`);
  }
  for (const urls of [[], ['about:blank']]) {
    await saveRefreshedState(fakeContext(urls), file);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(fs.existsSync(`${file}.logged-out`), false);
  }
  await saveRefreshedState({ ...fakeContext([]), pages: () => [
    { isClosed: () => true, url: () => 'https://sso.e.qq.com/login' },
  ] }, file);
  assert.equal(fs.existsSync(`${file}.logged-out`), false);
  assert.equal(writes, 1);
  assert.deepEqual(sanitizeDetail({ stateRefreshed: true, stateExpired: false, state: storageState }),
    { stateRefreshed: true, stateExpired: false });
  assert.deepEqual(sanitizeDetail({ stateRefreshed: marker, stateExpired: storageState }), {});
}

async function clearTestData(db) {
  const rows = await db.selectFrom('ruyi_users').select('id').where('username', 'in', usernames).execute();
  if (!rows.length) return;
  const ids = rows.map((row) => row.id);
  for (const table of ['ruyi_jobs', 'ruyi_user_sessions', 'ruyi_platform_states', 'ruyi_operation_logs']) {
    await db.deleteFrom(table).where('user_id', 'in', ids).execute();
  }
  await db.deleteFrom('ruyi_users').where('id', 'in', ids).execute();
}

async function main() {
  const config = readDbConfig();
  if (config.database !== 'ruyi_test' || config.host !== '127.0.0.1' || config.port !== 3306 ||
    config.user !== 'ruyi' || config.password !== 'ruyi') {
    throw new Error('数据库测试只允许连接本机 Docker 的 ruyi_test 测试数据库。');
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-job-state-test-'));
  const previousEnv = { upload: process.env.RUYI_UPLOAD_DIR, max: process.env.RUYI_MAX_CONCURRENT_JOBS };
  process.env.RUYI_UPLOAD_DIR = tempDir;
  process.env.RUYI_MAX_CONCURRENT_JOBS = '2';
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const originalKill = process.kill;
  process.kill = (pid) => {
    const entry = spawned.find((item) => item.child?.pid === -pid);
    if (entry) setImmediate(() => entry.child.emit('close', null, 'SIGTERM'));
    return true;
  };
  const spawned = [];
  let throwOnSpawn = false;
  childProcess.spawn = (command, args, options) => {
    spawned.push({ command, args, options });
    if (throwOnSpawn) throw new Error('模拟同步启动失败');
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 900000 + spawned.length;
    spawned.at(-1).child = child;
    return child;
  };
  const browser = require('@ruyi/automation/lib/browser');
  const originalLaunch = browser.launchBrowser;
  browser.launchBrowser = () => { throw new Error('任务登录态测试不得启动真实浏览器'); };
  const platform = require('@ruyi/server/src/modules/files/platform');
  const originals = { inspectPlatformFiles: platform.inspectPlatformFiles,
    inspectAnalyseAudience: platform.inspectAnalyseAudience, inspectInsightResults: platform.inspectInsightResults };
  let probeGate = null, probeStarted = 0;
  const inspected = [];
  platform.inspectPlatformFiles = async (type, names, providedState) => {
    inspected.push({ type, names, providedState }); probeStarted++;
    if (probeGate) await probeGate;
    return { missingCount: names.length };
  };
  platform.inspectAnalyseAudience = async (names, providedState) => {
    inspected.push({ names, providedState }); return names.length;
  };
  platform.inspectInsightResults = platform.inspectAnalyseAudience;
  const { buildApp } = require('@ruyi/server/src/app');
  const { createWorker } = require('@ruyi/worker/src/index');
  const jobs = require('@ruyi/shared/runtime/repos/jobs');
  const runtime = require('@ruyi/server/src/state');
  const { resolveWorkspace, ensureWorkspace } = require('@ruyi/shared/runtime/workspace');
  const db = createDb(config);
  let app;
  try {
    await testBrowser(tempDir);
    await clearTestData(db);
    const identities = [];
    for (const username of usernames) {
      const id = await users.createUser(db, { username, displayName: '任务登录态测试用户',
        passwordHash: '伪造密码摘要', mustChangePassword: false });
      const token = crypto.randomBytes(32).toString('base64url');
      await sessions.createSession(db, { tokenHash: hashToken(token), userId: id, expiresAt: new Date(Date.now() + 3600000) });
      identities.push({ id, username, cookie: `ruyi_session=${token}` });
    }
    const [a, b, c] = identities;
    app = buildApp({ db, stateKeys: keys, uploadRoot: tempDir, logger: false, webDist: path.join(tempDir, 'missing') });
    app.worker = createWorker({ db, keys, dataRoot: tempDir, maxConcurrent: 2, pollMs: 10 });
    await app.worker.start();
    const request = (user, method, url) => app.inject({ method, url, headers: { cookie: user.cookie } });
    const run = (user = a) => request(user, 'POST', '/api/run/upload');
    const save = (user = a, value = storageState) => storeCapturedState(db, user.id, value, keys);
    const read = (user = a) => states.getStateRow(db, user.id);
    const logs = (action, user = a) => db.selectFrom('ruyi_operation_logs').selectAll()
      .where('user_id', '=', user.id).where('action', '=', action).orderBy('id').execute();
    const start = async (user = a) => {
      const response = await run(user);
      assert.equal(response.statusCode, 200, response.body);
      const id = response.json().id;
      assert.equal(response.json().status, 'queued');
      const entry = await eventually(() => spawned.find((item) => item.options.env.RUYI_JOB_ID === id), '任务未被 Worker 认领');
      return { id, ...entry, dir: path.dirname(entry.options.env.RUYI_STATE_FILE), file: entry.options.env.RUYI_STATE_FILE };
    };
    const finish = async (job, code = 0, user = a, error = false) => {
      if (error) job.child.emit('error', new Error('模拟子进程错误'));
      job.child.emit('close', code, null);
      const row = await eventually(async () => (await logs('job.finish', user)).find((entry) => entry.target_id === job.id), '任务结束记录未写入');
      assert.equal(fs.existsSync(job.dir), false, '结束记录写入前必须清理目录');
      assert.notEqual((await jobs.getJob(db, job.id)).status, 'running');
      return detailOf(row);
    };
    const assertLoginRequired = (response) => {
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json(), { ok: false, code: 'PLATFORM_LOGIN_REQUIRED', message: '请先完成平台登录' });
    };
    assertLoginRequired(await run());
    assert.equal(spawned.length, 0);
    assert.equal((await logs('job.start')).at(-1).result, 'failure');
    assertLoginRequired(await request(a, 'GET', '/api/platform-status'));
    assert.equal(runtime.platformProbes.has(a.id), false);
    await save();
    await states.markExpired(db, { userId: a.id, expectedVersion: (await read()).version });
    assertLoginRequired(await run());
    await save();
    await db.updateTable('ruyi_platform_states').set({ state_ciphertext: Buffer.alloc(10) }).where('user_id', '=', a.id).execute();
    assertLoginRequired(await run());
    assertLoginRequired(await request(a, 'GET', '/api/platform-status'));
    assert.equal(spawned.length, 0);

    await save();
    const version = (await read()).version;
    let job = await start();
    assert.equal(fs.statSync(job.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(job.dir).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(fs.readFileSync(job.file, 'utf8')), storageState);
    assert.equal(Object.entries(job.options.env).some(([key, value]) => key !== 'RUYI_STATE_FILE' && String(value).includes(marker)), false);
    assert.equal(runtime.jobs.has(job.id), false, '认证任务不再进入内存 Map');
    const visibleJob = await request(a, 'GET', `/api/jobs/${job.id}`);
    assert.equal(visibleJob.statusCode, 200);
    for (const secret of ['RUYI_STATE_FILE', job.dir, marker]) assert.equal(visibleJob.body.includes(secret), false);
    assert.equal((await request(b, 'GET', `/api/jobs/${job.id}`)).statusCode, 404);
    assert.deepEqual(await finish(job), { task: 'upload', code: 0, signal: null,
      status: 'succeeded', queuedMs: detailOf((await logs('job.finish')).at(-1)).queuedMs,
      durationMs: detailOf((await logs('job.finish')).at(-1)).durationMs, stateRefreshed: false, stateExpired: false });
    assert.equal((await read()).version, version);

    job = await start();
    fs.writeFileSync(job.file, JSON.stringify(refreshedState));
    assert.equal((await finish(job)).stateRefreshed, true);
    assert.equal((await read()).version, version + 1);
    assert.deepEqual((await loadUserState(db, a.id, keys)).state, refreshedState);

    job = await start();
    fs.writeFileSync(`${job.file}.logged-out`, '', { mode: 0o600 });
    fs.writeFileSync(job.file, JSON.stringify(storageState));
    const expired = await finish(job);
    assert.equal(expired.stateExpired, true); assert.equal(expired.stateRefreshed, false);
    assert.equal((await read()).status, 'expired');
    assert.equal((await request(a, 'GET', '/api/platform-state')).json().status, 'expired');
    const expiredLog = (await logs('platform.state_expired')).at(-1);
    assert.equal(expiredLog.result, 'success'); assert.equal(detailOf(expiredLog).jobId, job.id);

    for (const logout of [false, true]) {
      await save();
      job = await start();
      if (logout) fs.writeFileSync(`${job.file}.logged-out`, '', { mode: 0o600 });
      else fs.writeFileSync(job.file, JSON.stringify(refreshedState));
      await save(a, { cookies: [], origins: [{ origin: 'https://ruyi.qq.com', localStorage: [{ name: 'fake', value: 'new-login' }] }] });
      const newer = await read();
      const result = await finish(job);
      assert.equal(result.stateRefreshed, false); assert.equal(result.stateExpired, false);
      assert.deepEqual(await read(), newer, '版本变化时回写和过期标记都不能覆盖重新登录的状态');
    }
    assert.equal((await logs('platform.state_expired')).length, 1);

    for (const error of [false, true]) {
      job = await start();
      await finish(job, error ? -2 : 2, a, error);
      assert.equal((await jobs.getJob(db, job.id)).exit_code, error ? 1 : 2);
      assert.equal((await logs('job.finish')).filter((row) => row.target_id === job.id).length, 1);
    }
    for (const missing of [false, true]) {
      job = await start();
      if (missing) fs.rmSync(job.file);
      else fs.writeFileSync(job.file, 'INVALID_FAKE_JSON');
      const before = await read();
      const result = await finish(job);
      assert.equal(result.stateRefreshed, false); assert.equal(result.stateExpired, false);
      assert.deepEqual(await read(), before);
    }
    throwOnSpawn = true;
    const failed = await run();
    assert.equal(failed.statusCode, 200);
    await eventually(async () => (await jobs.getJob(db, failed.json().id)).status === 'failed', '启动失败没有持久化');
    assert.equal(fs.existsSync(path.dirname(spawned.at(-1).options.env.RUYI_STATE_FILE)), false);
    throwOnSpawn = false;

    await save(); await save(b); await save(c);
    const concurrent = await Promise.all([run(a), run(b)]);
    assert.deepEqual(concurrent.map((response) => response.statusCode), [200, 200]);
    // 异步加载登录态后启动的顺序可能与请求顺序不同，按任务 ID 关联进程。
    await eventually(() => concurrent.every((response) => spawned.some((item) => item.options.env.RUYI_JOB_ID === response.json().id)), '并发任务尚未启动');
    const running = concurrent.map((response) => {
      const id = response.json().id;
      const entry = spawned.find((item) => item.options.env.RUYI_JOB_ID === id);
      assert.ok(entry, '任务应有对应的子进程');
      return { ...entry, id, file: entry.options.env.RUYI_STATE_FILE, dir: path.dirname(entry.options.env.RUYI_STATE_FILE) };
    });
    assert.notEqual(running[0].dir, running[1].dir);
    const ownBusy = await run(a);
    assert.equal(ownBusy.statusCode, 200); assert.equal(ownBusy.json().status, 'queued');
    await jobs.requestCancel(db, { id: ownBusy.json().id, userId: a.id });
    const globalBusy = await run(c);
    assert.equal(globalBusy.statusCode, 200); assert.equal(globalBusy.json().status, 'queued');
    await jobs.requestCancel(db, { id: globalBusy.json().id, userId: c.id });
    const importBusy = await request(a, 'POST', '/api/import-folder');
    assert.equal(importBusy.statusCode, 409); assert.match(importBusy.json().message, /当前用户有任务/);

    // 检查与其他用户的任务互不影响；同一用户的两个检查互斥。
    const workA = ensureWorkspace(resolveWorkspace(a, tempDir));
    const workB = ensureWorkspace(resolveWorkspace(b, tempDir));
    for (const work of [workA, workB]) {
      fs.writeFileSync(path.join(work, 'createGroupToDoList.json'), '["test_idfa.txt"]');
      fs.writeFileSync(path.join(work, 'analyseToDoList.json'), '["test-audience"]');
      fs.writeFileSync(path.join(work, 'done.json'), '["test-result"]');
    }
    let releaseProbe;
    probeGate = new Promise((resolve) => { releaseProbe = resolve; });
    const firstProbe = request(a, 'GET', '/api/platform-status');
    const probePromise = firstProbe.then((response) => response);
    await eventually(() => probeStarted > 0, '平台状态检查未启动');
    const duplicateProbe = await request(a, 'GET', '/api/platform-status');
    assert.equal(duplicateProbe.statusCode, 409);
    assert.equal(duplicateProbe.json().message, '平台状态检查正在进行，请稍后重试');
    const secondProbe = request(b, 'GET', '/api/platform-status').then((response) => response);
    await eventually(() => probeStarted > 1, '其他用户检查应可并发');
    releaseProbe(); probeGate = null;
    assert.deepEqual((await Promise.all([probePromise, secondProbe])).map((response) => response.statusCode), [200, 200]);
    assert.equal(inspected.length, 6);
    assert.ok(inspected.every((entry) => JSON.stringify(entry.providedState) === JSON.stringify(storageState)));
    assert.equal(runtime.platformProbes.size, 0);
    await finish(running[0], 0, a); await finish(running[1], 0, b);

    const sameUserRace = await Promise.all([run(a), run(a)]);
    assert.deepEqual(sameUserRace.map((response) => response.statusCode), [200, 200], '同用户并发请求应该排队');
    const raceIds = sameUserRace.map((response) => response.json().id);
    await eventually(() => spawned.some((item) => raceIds.includes(item.options.env.RUYI_JOB_ID)), '排队任务未启动');
    for (const id of raceIds) await jobs.requestCancel(db, { id, userId: a.id });
    await eventually(async () => (await Promise.all(raceIds.map((id) => jobs.getJob(db, id)))).every((job) => job.status === 'cancelled'), '取消任务未结束');

    const allLogs = JSON.stringify(await db.selectFrom('ruyi_operation_logs').selectAll().where('user_id', 'in', identities.map((user) => user.id)).execute());
    assert.equal(allLogs.includes(marker), false); assert.equal(allLogs.includes('ruyi-state-'), false);
    const active = await start();
    await app.close(); app = null;
    assert.equal(fs.existsSync(active.dir), false, '服务关闭必须删除仍在运行任务的临时目录');
    console.log('任务登录态生命周期、过期审计、版本冲突、并发及用户检查隔离测试通过。');
  } finally {
    try {
      if (app) await app.close();
    } finally {
      runtime.jobs.clear(); runtime.platformProbes.clear();
      childProcess.spawn = originalSpawn; process.kill = originalKill; browser.launchBrowser = originalLaunch;
      Object.assign(platform, originals);
      try { await clearTestData(db); } finally {
        await db.destroy();
        for (const [name, value] of [['RUYI_UPLOAD_DIR', previousEnv.upload], ['RUYI_MAX_CONCURRENT_JOBS', previousEnv.max]]) {
          if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }
}

main().catch((error) => { console.error('任务登录态并发测试失败：', error); process.exitCode = 1; });

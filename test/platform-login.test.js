const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createDb, readDbConfig } = require('../db');
const users = require('@ruyi/shared/runtime/repos/users');
const authSessions = require('@ruyi/server/src/modules/auth/repository');
const states = require('@ruyi/shared/runtime/repos/platform-states');
const { hashToken } = require('@ruyi/server/src/modules/auth/session');
const { loadKeys } = require('@ruyi/shared/runtime/platform-state/crypto');
const { loadUserState, storeCapturedState } = require('@ruyi/shared/runtime/platform-state/index');
const { loginTargets } = require('@ruyi/automation/lib/storage-state');
const sessions = require('@ruyi/server/src/modules/platform-login/sessions');

const marker = 'PLATFORM_LOGIN_FAKE_COOKIE_43';
const captured = { cookies: [{ name: 'dn_token', value: marker, domain: '.datanexus.qq.com', path: '/',
  expires: Math.floor(Date.now() / 1000) + 86400, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] };
const keys = loadKeys({ RUYI_STATE_KEY: crypto.randomBytes(32).toString('base64') });
const usernames = ['pl_session_a', 'pl_session_b', 'pl_session_c'];
const detailOf = (row) => typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail;
const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const gates = [];
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  const gate = { promise, resolve };
  gates.push(gate);
  return gate;
};

async function eventually(get, message) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = await get();
    if (value) return value;
    await sleep();
  }
  assert.fail(message);
}

function fakeBrowser(options = {}) {
  const plan = {
    ready: { ruyi: false, datanexus: false }, sequences: {}, probes: [], checked: [], pages: [],
    closeCount: 0, contextOptions: null, storageOptions: null, ...options,
  };
  const context = new EventEmitter();
  context.pages = () => plan.pages.filter((page) => !page.isClosed());
  context.newPage = async () => {
    const page = new EventEmitter();
    page.closed = false;
    page.isClosed = () => page.closed;
    page.url = () => page.address || 'about:blank';
    page.goto = async (url) => { page.address = url; return { status: () => 200 }; };
    page.close = async () => { page.closed = true; page.emit('close'); };
    plan.pages.push(page);
    context.emit('page', page);
    return page;
  };
  context.storageState = async (options) => {
    plan.storageOptions = options;
    if (plan.storageGate) await plan.storageGate.promise;
    if (plan.storageError) throw new Error(`${marker}: cookies 原始错误堆栈`);
    return captured;
  };
  const browser = new EventEmitter();
  browser.newContext = async (options) => {
    plan.contextOptions = options;
    if (plan.contextGate) await plan.contextGate.promise;
    return context;
  };
  browser.close = async () => {
    plan.closeCount++;
    for (const page of context.pages()) await page.close();
    context.emit('close');
    browser.emit('disconnected');
  };
  plan.browser = browser;
  plan.context = context;
  return plan;
}

async function clearTestData(db) {
  const rows = await db.selectFrom('ruyi_users').select('id').where('username', 'in', usernames).execute();
  if (!rows.length) return;
  const ids = rows.map((row) => row.id);
  // 仅清理本测试写入的数据；业务代码的操作记录仍然只追加。
  for (const table of ['ruyi_user_sessions', 'ruyi_platform_states', 'ruyi_operation_logs']) {
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
  const previous = { max: process.env.RUYI_MAX_LOGIN_SESSIONS, timeout: process.env.RUYI_LOGIN_SESSION_TIMEOUT_MS };
  process.env.RUYI_MAX_LOGIN_SESSIONS = '2';
  process.env.RUYI_LOGIN_SESSION_TIMEOUT_MS = '900000';
  const { chromium } = require('playwright');
  const legacyBrowser = require('@ruyi/automation/lib/browser');
  const originalLaunch = chromium.launch;
  const originalLegacyLaunch = legacyBrowser.launchBrowser;
  chromium.launch = legacyBrowser.launchBrowser = () => { assert.fail('登录会话测试不得启动真实浏览器'); };
  const { buildApp } = require('@ruyi/server/src/app');
  const db = createDb(config);
  const queue = [];
  const launched = [];
  const checks = {
    async pageLooksLoggedIn(page, target) {
      const plan = launched.find((item) => item.pages.includes(page));
      const key = target === loginTargets.ruyi ? 'ruyi' : 'datanexus';
      if (page.isClosed() || page.url() !== target.url) return false;
      plan.checked.push(key);
      return plan.sequences[key]?.length ? plan.sequences[key].shift() : plan.ready[key];
    },
    async probeSite(context, target) {
      const plan = launched.find((item) => item.context === context);
      const key = target === loginTargets.ruyi ? 'ruyi' : 'datanexus';
      plan.probes.push(key);
      const page = await context.newPage();
      await page.goto(target.url);
      const ok = plan.probe ? await plan.probe(key, plan) : true;
      await page.close();
      return { ok, url: target.url };
    },
  };
  const launch = async (options) => {
    assert.equal(options.headless, false);
    assert.equal(typeof options.executablePath, 'string');
    assert.ok(Array.isArray(options.args));
    const plan = queue.shift();
    assert.ok(plan, '每次启动都应使用明确指定的假浏览器');
    launched.push(plan);
    if (plan.launchGate) await plan.launchGate.promise;
    if (plan.launchError) throw new Error(`${marker}: 启动失败`);
    return plan.browser;
  };
  let app;
  const managers = [];
  try {
    await clearTestData(db);
    const identities = [];
    for (const username of usernames) {
      const id = await users.createUser(db, { username, displayName: '登录会话测试用户',
        passwordHash: '伪造密码摘要', mustChangePassword: false });
      const token = crypto.randomBytes(32).toString('base64url');
      await authSessions.createSession(db, { tokenHash: hashToken(token), userId: id, expiresAt: new Date(Date.now() + 3600000) });
      identities.push({ id, username, cookie: `ruyi_session=${token}` });
    }
    const [a, b, c] = identities;
    const missingDir = path.join(os.tmpdir(), `ruyi-platform-login-${crypto.randomUUID()}`);
    app = buildApp({ db, stateKeys: keys, logger: false, uploadRoot: missingDir, webDist: missingDir,
      platformLogin: { launch, checks, pollMs: 5 } });
    const request = async (user, method, url) => {
      const response = await app.inject({ method, url, ...(user ? { headers: { cookie: user.cookie } } : {}) });
      for (const forbidden of ['cookies', marker, 'state_ciphertext', 'storageState', 'context', 'browser']) {
        assert.equal(response.body.includes(forbidden), false, `接口泄露 ${forbidden}`);
      }
      return response;
    };
    const get = (user, id) => request(user, 'GET', `/api/platform-login/${id}`);
    const logs = (action, user = a) => db.selectFrom('ruyi_operation_logs').selectAll()
      .where('user_id', '=', user.id).where('action', '=', action).orderBy('id').execute();
    const read = (user = a) => states.getStateRow(db, user.id);
    const start = async (plan, user = a) => {
      queue.push(plan);
      const response = await request(user, 'POST', '/api/platform-login');
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().session.status, 'starting');
      return response.json().session.id;
    };
    const status = (id, user = a) => sessions.getSession(id, user.id)?.status;
    const waitStatus = (id, expected, user = a) => eventually(() => status(id, user) === expected, `未进入 ${expected}`);
    const waitEndLog = async (id, expected, user = a) => {
      const row = await eventually(async () => (await logs('platform.login', user))
        .find((item) => detailOf(item).sessionId === id), '会话结束审计未写入');
      assert.equal(row.result, expected === 'succeeded' ? 'success' : 'failure');
      assert.equal(detailOf(row).status, expected);
      return row;
    };

    for (const [method, url] of [['POST', '/api/platform-login'], ['GET', '/api/platform-login/missing'],
      ['DELETE', '/api/platform-login/missing'], ['POST', '/api/platform-state/clear']]) {
      assert.equal((await request(null, method, url)).statusCode, 401);
    }

    const initial = (await request(a, 'GET', '/api/login-status')).json();
    assert.equal(initial.state.status, 'none');
    assert.equal(initial.loggedIn, false);
    assert.deepEqual(initial.sites, { ruyi: false, datanexus: false });
    assert.equal(launched.length, 0);

    const normal = fakeBrowser({ storageGate: deferred() });
    const normalId = await start(normal);
    await waitStatus(normalId, 'waiting');
    assert.deepEqual(normal.contextOptions.viewport, { width: 1280, height: 800 });
    assert.equal(Object.hasOwn(normal.contextOptions, 'storageState'), false);
    assert.ok(normal.checked.includes('ruyi'));
    assert.equal(normal.checked.includes('datanexus'), false, '必须先完成如翼登录');
    normal.ready.ruyi = true;
    await eventually(() => sessions.getSession(normalId, a.id).sites.ruyi, '如翼未完成登录');
    await eventually(() => normal.checked.includes('datanexus'), '未开始 DataNexus 登录');
    const partial = (await get(a, normalId)).json().session;
    assert.deepEqual(partial.sites, { ruyi: true, datanexus: false });
    assert.deepEqual(Object.keys(partial).sort(), ['id', 'status', 'sites', 'message', 'createdAt', 'expiresAt', 'display'].sort());
    assert.equal(partial.display, 'local');
    assert.equal(new Date(partial.expiresAt) - new Date(partial.createdAt), 15 * 60 * 1000);
    normal.ready.datanexus = true;
    await waitStatus(normalId, 'saving');
    assert.deepEqual(normal.storageOptions, { indexedDB: true });
    normal.storageGate.resolve();
    await waitStatus(normalId, 'succeeded');
    const normalEnd = await waitEndLog(normalId, 'succeeded');
    assert.equal(normal.closeCount, 1);
    assert.deepEqual(normal.probes, ['ruyi', 'datanexus']);
    assert.equal((await read()).status, 'valid');
    assert.deepEqual((await loadUserState(db, a.id, keys)).state, captured);
    const normalStart = (await logs('platform.login_start')).find((row) => detailOf(row).sessionId === normalId);
    assert.equal(normalStart.result, 'success');
    assert.equal(normalStart.request_id, normalEnd.request_id);
    assert.equal(normalEnd.username, a.username);
    assert.ok(normalStart.request_id);

    // 兼容接口只查询当前用户数据库登录态，不得打开浏览器。
    const summary = (await request(a, 'GET', '/api/login-status')).json();
    assert.equal(summary.state.status, 'valid');
    assert.equal(summary.loggedIn, true);
    assert.deepEqual(summary.sites, { ruyi: true, datanexus: true });
    assert.equal(launched.length, 1);
    for (const user of [a, b]) {
      for (const url of ['/api/login-open', '/api/profile-release']) {
        assert.equal((await request(user, 'POST', url)).statusCode, 404);
      }
    }
    assert.equal((await request(b, 'GET', '/api/login-status')).json().state.status, 'none');

    const flashing = fakeBrowser({ sequences: { ruyi: [true, true, false, true, false] } });
    const flashingId = await start(flashing);
    await eventually(() => flashing.checked.length >= 8, '未完成闪现检查');
    assert.equal(sessions.getSession(flashingId, a.id).sites.ruyi, false);
    assert.equal(status(flashingId), 'waiting');
    assert.deepEqual(flashing.contextOptions.storageState, captured, '有效登录态应在内存中用于初始化');

    const launchCount = launched.length;
    const duplicates = await Promise.all(Array.from({ length: 3 }, () => request(a, 'POST', '/api/platform-login')));
    assert.ok(duplicates.every((response) => response.json().session.id === flashingId));
    assert.equal(launched.length, launchCount);
    assert.equal((await logs('platform.login_start')).filter((row) => detailOf(row).sessionId === flashingId).length, 1);
    const second = fakeBrowser();
    const secondId = await start(second, b);
    const limit = await request(c, 'POST', '/api/platform-login');
    assert.equal(limit.statusCode, 409);
    assert.equal(limit.json().message, '登录排队中：当前已有 2 人正在登录，请稍后再试');
    for (const method of ['GET', 'DELETE']) {
      assert.equal((await request(b, method, `/api/platform-login/${flashingId}`)).statusCode, 404);
    }
    assert.equal(status(flashingId), 'waiting');
    assert.equal((await request(a, 'DELETE', `/api/platform-login/${flashingId}`)).statusCode, 200);
    await waitEndLog(flashingId, 'cancelled');
    assert.equal(flashing.closeCount, 1);
    assert.equal(status(flashingId), 'cancelled');
    assert.equal((await get(a, flashingId)).json().session.status, 'cancelled');
    await request(a, 'DELETE', `/api/platform-login/${flashingId}`);
    assert.equal((await logs('platform.login')).filter((row) => detailOf(row).sessionId === flashingId).length, 1);
    await request(b, 'DELETE', `/api/platform-login/${secondId}`);
    await waitEndLog(secondId, 'cancelled', b);

    const retry = fakeBrowser({ ready: { ruyi: true, datanexus: true }, probe: (key, plan) => {
      if (plan.probes.length === 1 && key === 'ruyi') { plan.ready.ruyi = false; return false; }
      return true;
    } });
    const retryId = await start(retry);
    await eventually(() => retry.probes.length === 2 && !sessions.getSession(retryId, a.id).sites.ruyi, '复查失败未回到等待');
    assert.equal(status(retryId), 'waiting');
    retry.ready.ruyi = true;
    await waitStatus(retryId, 'succeeded');
    await waitEndLog(retryId, 'succeeded');
    assert.deepEqual(retry.probes, ['ruyi', 'datanexus', 'ruyi', 'datanexus']);

    const alwaysFail = fakeBrowser({ ready: { ruyi: true, datanexus: true }, probe: () => false });
    const alwaysFailId = await start(alwaysFail, c);
    await waitStatus(alwaysFailId, 'failed', c);
    await waitEndLog(alwaysFailId, 'failed', c);
    assert.equal(alwaysFail.probes.length, 6, '复查最多三轮');
    assert.equal(await read(c), undefined);

    const failure = fakeBrowser({ ready: { ruyi: true, datanexus: true }, storageError: true });
    const failureId = await start(failure, c);
    await waitStatus(failureId, 'failed', c);
    await waitEndLog(failureId, 'failed', c);
    assert.equal((await get(c, failureId)).json().session.message, '平台登录失败，请重新尝试');
    assert.equal(failure.closeCount, 1);
    assert.equal(await read(c), undefined);

    const timeout = fakeBrowser();
    process.env.RUYI_LOGIN_SESSION_TIMEOUT_MS = '60';
    const timeoutId = await start(timeout, b);
    process.env.RUYI_LOGIN_SESSION_TIMEOUT_MS = '900000';
    await waitStatus(timeoutId, 'expired', b);
    await waitEndLog(timeoutId, 'expired', b);
    assert.equal(timeout.closeCount, 1);

    const closed = fakeBrowser();
    const closedId = await start(closed, b);
    await eventually(() => closed.pages.length, '没有打开页面');
    await closed.pages[0].close();
    await waitStatus(closedId, 'cancelled', b);
    await waitEndLog(closedId, 'cancelled', b);
    assert.equal(closed.closeCount, 1);
    const disconnected = fakeBrowser();
    const disconnectedId = await start(disconnected, b);
    await waitStatus(disconnectedId, 'waiting', b);
    disconnected.browser.emit('disconnected');
    await waitStatus(disconnectedId, 'cancelled', b);
    await waitEndLog(disconnectedId, 'cancelled', b);

    const late = fakeBrowser({ launchGate: deferred() });
    const lateId = await start(late, c);
    await eventually(() => launched.includes(late), '未进入启动阶段');
    await request(c, 'DELETE', `/api/platform-login/${lateId}`);
    late.launchGate.resolve();
    await eventually(() => late.closeCount === 1, '取消后迟到的浏览器没有关闭');
    await waitEndLog(lateId, 'cancelled', c);
    assert.equal(await read(c), undefined);

    const savingCancel = fakeBrowser({ ready: { ruyi: true, datanexus: true }, storageGate: deferred() });
    const savingId = await start(savingCancel, c);
    await waitStatus(savingId, 'saving', c);
    await request(c, 'DELETE', `/api/platform-login/${savingId}`);
    savingCancel.storageGate.resolve();
    await sessions.getSession(savingId, c.id).task;
    assert.equal(status(savingId, c), 'cancelled');
    assert.equal(await read(c), undefined, '取消后不得保存迟到的登录态');

    const beforeClear = await read();
    assert.equal((await request(b, 'POST', '/api/platform-state/clear')).statusCode, 200);
    assert.deepEqual(await read(), beforeClear, '清除只能作用于自己的登录态');
    assert.deepEqual((await request(a, 'POST', '/api/platform-state/clear')).json(), { ok: true });
    assert.equal((await read()).status, 'expired');
    assert.equal((await read()).state_ciphertext, null);
    assert.equal((await request(a, 'GET', '/api/platform-state')).json().status, 'expired');
    assert.equal((await request(a, 'GET', '/api/login-status')).json().loggedIn, false);
    assert.equal((await logs('platform.logout')).at(-1).result, 'success');

    // 假时钟覆盖启动中的超时和结束态保留时间，定时检查不依赖轮询进度。
    let now = Date.now();
    const manager = sessions.createSessionManager({ now: () => now, sweepMs: 5 });
    managers.push(manager);
    const stuck = fakeBrowser({ launchGate: deferred() });
    const stuckSession = manager.startSession(c, { db, keys, launch: async () => {
      await stuck.launchGate.promise; return stuck.browser;
    }, timeoutMs: 100, checks, pollMs: 5 });
    await sleep(15);
    now += 101;
    await eventually(() => stuckSession.status === 'expired', '启动中的会话没有超时');
    stuck.launchGate.resolve();
    await stuckSession.task;
    await stuckSession.finishPromise;
    assert.equal(stuck.closeCount, 1);
    now += 10 * 60 * 1000 - 1;
    assert.equal(manager.getSession(stuckSession.id, c.id), stuckSession);
    now += 1;
    assert.equal(manager.getSession(stuckSession.id, c.id), null);

    // 新标签页可以完成登录；页面检查必须扫描整个上下文。
    const popup = fakeBrowser();
    const popupId = await start(popup, b);
    await waitStatus(popupId, 'waiting', b);
    popup.pages[0].address = 'https://sso.e.qq.com/login';
    const popupPage = await popup.context.newPage();
    await popupPage.goto(loginTargets.ruyi.url);
    popup.ready = { ruyi: true, datanexus: true };
    await waitStatus(popupId, 'succeeded', b);
    await waitEndLog(popupId, 'succeeded', b);

    const shutdown = fakeBrowser();
    const shutdownId = await start(shutdown);
    await waitStatus(shutdownId, 'waiting');
    await app.close();
    assert.equal(shutdown.closeCount, 1);
    assert.equal(status(shutdownId), 'cancelled');
    await waitEndLog(shutdownId, 'cancelled');
    const allLogs = await db.selectFrom('ruyi_operation_logs').selectAll().where('user_id', 'in', identities.map((user) => user.id)).execute();
    assert.equal(JSON.stringify(allLogs).includes(marker), false);
    assert.equal(JSON.stringify(allLogs).includes('cookies'), false);
    console.log('平台登录会话、隔离、稳定检查、复查、审计和登录状态接口测试通过。');
  } finally {
    try {
      for (const gate of gates) gate.resolve();
      if (app) await app.close();
      await sessions.closeAllSessions();
      for (const manager of managers) await manager.closeAllSessions();
    } finally {
      try { await clearTestData(db); } finally { await db.destroy(); }
      chromium.launch = originalLaunch;
      legacyBrowser.launchBrowser = originalLegacyLaunch;
      for (const [name, value] of [['RUYI_MAX_LOGIN_SESSIONS', previous.max], ['RUYI_LOGIN_SESSION_TIMEOUT_MS', previous.timeout]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }
}

main().catch((error) => { console.error('平台登录会话测试失败：', error); process.exitCode = 1; });

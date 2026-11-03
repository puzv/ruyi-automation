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

async function eventually(get, message, attempts = 3000) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await get();
    if (value) return value;
    await sleep();
  }
  assert.fail(message);
}

function fakeBrowser(options = {}) {
  const plan = {
    ready: { ruyi: false, datanexus: false }, sequences: {}, probes: [], checked: [], pages: [],
    closeCount: 0, contextOptions: null, storageOptions: null,
    methods: [], refreshes: 0, headerClicks: 0, rejectDatanexus: true,
    png: Buffer.from('FAKE_QR_PNG_ONLY'),
    qrResult: { state: 'waiting', image: Buffer.from('FAKE_QR_PNG_ONLY') }, ...options,
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
    return plan.captured || captured;
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
  for (const table of ['ruyi_api_tokens', 'ruyi_user_sessions', 'ruyi_platform_states', 'ruyi_operation_logs']) {
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
      if (plan.advanceClock) plan.clock += key === 'datanexus' ? 10000 : 1000;
      return plan.sequences[key]?.length ? plan.sequences[key].shift() : plan.ready[key];
    },
    qrOperations: {
      // 假页面地址始终是目标地址，未登录即视为停留在统一登录页。
      async isLoginPage() { return true; },
      async selectMethod(page, method) {
        const plan = launched.find((item) => item.pages.includes(page));
        plan.methods.push(method);
      },
      async readQr(page) {
        const plan = launched.find((item) => item.pages.includes(page));
        return plan.qrResult;
      },
      async refreshQr(page) {
        const plan = launched.find((item) => item.pages.includes(page));
        plan.refreshes++;
        if (!plan.alwaysExpired) plan.qrResult = { state: 'waiting', image: plan.png };
      },
      async clickHeaderLogin(page) {
        const plan = launched.find((item) => item.pages.includes(page));
        plan.headerClicks++;
        if (!plan.rejectDatanexus) plan.ready.datanexus = true;
        return true;
      },
    },
    async probeSite(context, target) {
      const plan = launched.find((item) => item.context === context);
      const key = target === loginTargets.ruyi ? 'ruyi' : 'datanexus';
      plan.probes.push(key);
      const page = await context.newPage();
      await page.goto(target.url);
      const ok = plan.probe ? await plan.probe(key, plan) : true;
      await page.close();
      return { ok, url: plan.probeUrl || target.url };
    },
  };
  const launch = async (options) => {
    assert.equal(options.headless, true);
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
    const request = async (user, method, url, payload) => {
      const response = await app.inject({ method, url, ...(payload ? { payload } : {}), ...(user ? { headers: { cookie: user.cookie } } : {}) });
      for (const forbidden of ['cookies', marker, 'state_ciphertext', 'storageState', 'context', 'browser']) {
        assert.equal(response.body.includes(forbidden), false, `接口泄露 ${forbidden}`);
      }
      return response;
    };
    const get = (user, id) => request(user, 'GET', `/api/platform-login/${id}`);
    const logs = (action, user = a) => db.selectFrom('ruyi_operation_logs').selectAll()
      .where('user_id', '=', user.id).where('action', '=', action).orderBy('id').execute();
    const read = (user = a) => states.getStateRow(db, user.id);
    const start = async (plan, user = a, payload = {}) => {
      queue.push(plan);
      const response = await request(user, 'POST', '/api/platform-login', payload);
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
      ['DELETE', '/api/platform-login/missing'], ['GET', '/api/platform-login/missing/qr.png'],
      ['POST', '/api/platform-login/missing/method'], ['POST', '/api/platform-state/clear']]) {
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
    assert.deepEqual(Object.keys(partial).sort(), ['id', 'status', 'sites', 'message', 'createdAt', 'expiresAt', 'qr'].sort());
    assert.equal(Object.hasOwn(partial, 'display'), false);
    assert.equal(Object.hasOwn(partial, 'mode'), false);
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
    assert.equal(Object.hasOwn(detailOf(normalStart), 'mode'), false);
    assert.equal(detailOf(normalStart).method, 'wechat');
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
    assert.equal(Object.hasOwn(flashing.contextOptions, 'storageState'), false, '扫码始终使用全新上下文');

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
    // 三轮复查、每站稳定 3 秒，真实时钟下约 18 秒。
    await eventually(() => status(alwaysFailId, c) === 'failed', '未进入 failed', 6000);
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

    // 二维码和登录态均使用内存假数据，整个测试不启动真实浏览器。
    const qrPlan = (options = {}) => {
      const png = Buffer.from('FAKE_QR_PNG_ONLY');
      return fakeBrowser({ rejectDatanexus: false, methods: [], refreshes: 0, headerClicks: 0,
        png, qrResult: { state: 'waiting', image: png }, ...options });
    };
    await storeCapturedState(db, a.id, captured, keys);
    const oldQrState = await read();
    const replacement = { cookies: [], origins: [] };
    const qrCancel = qrPlan();
    const qrCancelId = await start(qrCancel, a, {});
    await eventually(() => sessions.getSession(qrCancelId, a.id)?.qr?.image, '已有登录态时二维码未生成');
    assert.equal(Object.hasOwn(qrCancel.contextOptions, 'storageState'), false);
    await request(a, 'DELETE', `/api/platform-login/${qrCancelId}`);
    await waitEndLog(qrCancelId, 'cancelled');
    assert.equal((await read()).version, oldQrState.version);
    assert.deepEqual((await read()).state_ciphertext, oldQrState.state_ciphertext);

    const wrongKeys = loadKeys({ RUYI_STATE_KEY: crypto.randomBytes(32).toString('base64') });
    const badKeyPlan = qrPlan();
    const badKeyManager = sessions.createSessionManager();
    managers.push(badKeyManager);
    launched.push(badKeyPlan);
    const badKeySession = badKeyManager.startSession(a, { db, keys: wrongKeys, checks, pollMs: 5,
      launch: async () => badKeyPlan.browser });
    await eventually(() => badKeySession.qr?.image, '旧登录态无法解密时二维码未生成');
    await badKeyManager.cancelSession(badKeySession.id, a.id);
    await badKeySession.task;
    assert.equal((await read()).version, oldQrState.version);
    assert.deepEqual((await read()).state_ciphertext, oldQrState.state_ciphertext);

    const qr = qrPlan({ captured: replacement, storageGate: deferred(), probeUrl: 'https://ruyi.qq.com/auth?code=FAKE_OAUTH_CODE' });
    const qrId = await start(qr, a, {});
    await eventually(() => sessions.getSession(qrId, a.id)?.qr?.image, '二维码未生成');
    assert.deepEqual(qr.methods, ['wechat']);
    const qrPublic = (await get(a, qrId)).json().session;
    assert.equal(Object.hasOwn(qrPublic, 'mode'), false);
    assert.equal(Object.hasOwn(qrPublic, 'display'), false);
    assert.equal(qrPublic.qr.method, 'wechat');
    assert.equal(Object.hasOwn(qrPublic.qr, 'image'), false);
    const imageUrl = `/api/platform-login/${qrId}/qr.png`;
    const image = await request(a, 'GET', imageUrl);
    assert.equal(image.statusCode, 200);
    assert.equal(image.headers['cache-control'], 'no-store');
    assert.deepEqual(image.rawPayload, qr.png);
    assert.equal((await request(b, 'GET', imageUrl)).statusCode, 404);
    const methodUrl = `/api/platform-login/${qrId}/method`;
    assert.equal((await request(b, 'POST', methodUrl, { method: 'qq' })).statusCode, 404);
    assert.equal((await request(a, 'POST', methodUrl, { method: 'bad' })).statusCode, 400);
    assert.equal((await request(a, 'POST', methodUrl, { method: 'qq' })).statusCode, 200);
    assert.deepEqual(qr.methods, ['wechat', 'qq']);
    qr.qrResult = { state: 'expired' };
    await eventually(() => qr.refreshes === 1, '失效二维码未自动刷新');
    qr.qrResult = { state: 'scanned' };
    await eventually(() => sessions.getSession(qrId, a.id)?.qr?.state === 'scanned', '扫码状态未更新');
    assert.equal((await request(a, 'POST', methodUrl, { method: 'wechat' })).statusCode, 409);
    qr.qrResult = { state: 'confirmed' };
    await eventually(() => sessions.getSession(qrId, a.id)?.qr?.state === 'confirmed', '确认状态未更新');
    assert.equal((await request(a, 'POST', methodUrl, { method: 'wechat' })).statusCode, 409);
    qr.ready.ruyi = true;
    await waitStatus(qrId, 'saving');
    assert.equal(qr.headerClicks, 1, 'DataNexus 应自动点击页面头部登录按钮');
    assert.equal((await request(a, 'GET', imageUrl)).statusCode, 404);
    assert.equal((await request(a, 'POST', methodUrl, { method: 'wechat' })).statusCode, 409);
    qr.storageGate.resolve();
    await waitStatus(qrId, 'succeeded');
    assert.ok((await read()).version > oldQrState.version);
    assert.notDeepEqual((await read()).state_ciphertext, oldQrState.state_ciphertext);
    assert.deepEqual((await loadUserState(db, a.id, keys)).state, replacement);
    const qrLog = detailOf(await waitEndLog(qrId, 'succeeded'));
    assert.equal(Object.hasOwn(qrLog, 'mode'), false);
    assert.equal(qrLog.method, 'qq');
    assert.equal(sessions.getSession(qrId, a.id).qr, null);
    assert.equal((await request(a, 'GET', imageUrl)).statusCode, 404);
    assert.equal((await request(a, 'POST', methodUrl, { method: 'wechat' })).statusCode, 409);
    assert.equal(JSON.stringify(qrLog).includes(qr.png.toString()), false);
    assert.equal(JSON.stringify(qrLog).includes('?'), false);
    assert.equal(JSON.stringify(await logs('platform.login')).includes('FAKE_OAUTH_CODE'), false);

    // 假时钟推进二维码刷新和 DataNexus 超时，避免依赖实际等待时间。
    await storeCapturedState(db, c.id, captured, keys);
    const beforeQrFailures = await read(c);
    for (const scenario of ['expired', 'datanexus']) {
      const plan = qrPlan({ clock: Date.now(), alwaysExpired: scenario === 'expired',
        rejectDatanexus: scenario === 'datanexus', advanceClock: scenario === 'datanexus' });
      if (scenario === 'expired') plan.qrResult = { state: 'expired' };
      else plan.ready.ruyi = true;
      const manager = sessions.createSessionManager({ now: () => plan.clock, sweepMs: 5 });
      managers.push(manager);
      launched.push(plan);
      const originalRead = checks.qrOperations.readQr;
      const scenarioChecks = { ...checks, qrOperations: { ...checks.qrOperations,
        async readQr(page, method) { plan.clock += 2000; return originalRead(page, method); } } };
      const session = manager.startSession(c, { db, keys, checks: scenarioChecks,
        launch: async (options) => { assert.equal(options.headless, true); return plan.browser; }, pollMs: 5 });
      if (scenario === 'expired') {
        // 读取间隔由会话时钟控制，每轮检查也推进到下一次刷新。
        const advance = setInterval(() => { plan.clock += 2000; }, 5);
        try { await eventually(() => session.status === 'expired', '反复失效未结束会话'); }
        finally { clearInterval(advance); }
        assert.equal(plan.refreshes, 5);
        assert.equal(session.message, '二维码多次过期，请重新开始');
      } else {
        await eventually(() => session.status === 'failed', 'DataNexus 超时未失败');
        assert.equal(plan.headerClicks, 1);
        assert.equal(session.message, 'DataNexus 自动登录失败，请稍后重新扫码');
        assert.equal(plan.pages.filter((page) => page.address === loginTargets.datanexus.url).length, 1);
      }
      await session.task;
      await session.finishPromise;
      assert.equal(session.qr, null);
      assert.equal((await read(c)).version, beforeQrFailures.version);
      assert.deepEqual((await read(c)).state_ciphertext, beforeQrFailures.state_ciphertext);
    }

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

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { sql } = require('kysely');
const { WebSocket } = require('ws');
const { createDb, readDbConfig } = require('../db');
const users = require('@ruyi/shared/runtime/repos/users');
const authSessions = require('@ruyi/server/src/modules/auth/repository');
const { hashToken } = require('@ruyi/server/src/modules/auth/session');
const { loadKeys } = require('@ruyi/shared/runtime/platform-state/crypto');
const { readDisplayConfig } = require('@ruyi/server/src/modules/platform-login/display');
const sessions = require('@ruyi/server/src/modules/platform-login/sessions');
const { buildApp } = require('@ruyi/server/src/app');

const usernames = ['vnc_test_a', 'vnc_test_b'];
const prefix = Buffer.from('假VNC回显:');
const marker = Buffer.from('VNC_BINARY_DATA_44\0\xff');
const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(check, message) {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (await check()) return;
    await sleep();
  }
  assert.fail(message);
}

function waitEvent(emitter, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.removeListener(event, done); reject(new Error(`等待 ${event} 超时`)); }, 4000);
    function done(...args) { clearTimeout(timer); resolve(args); }
    emitter.once(event, done);
  });
}

function fakeBrowser() {
  const plan = { ready: false, pages: [], closed: 0 };
  const context = new EventEmitter();
  context.pages = () => plan.pages;
  context.newPage = async () => {
    const page = new EventEmitter();
    page.isClosed = () => false;
    page.goto = async () => {};
    plan.pages.push(page);
    context.emit('page', page);
    return page;
  };
  context.storageState = async () => ({ cookies: [], origins: [] });
  const browser = new EventEmitter();
  browser.newContext = async (options) => { plan.contextOptions = options; return context; };
  browser.close = async () => { plan.closed++; browser.emit('disconnected'); };
  return Object.assign(plan, { browser, context });
}

async function clearTestData(db) {
  const rows = await db.selectFrom('ruyi_users').select('id').where('username', 'in', usernames).execute();
  if (!rows.length) return;
  const ids = rows.map((row) => row.id);
  // 测试仅清理自己的记录；生产代码仍保持操作记录只追加。
  for (const table of ['ruyi_user_sessions', 'ruyi_platform_states', 'ruyi_operation_logs']) {
    await db.deleteFrom(table).where('user_id', 'in', ids).execute();
  }
  await db.deleteFrom('ruyi_users').where('id', 'in', ids).execute();
}

async function main() {
  const config = readDbConfig();
  assert.deepEqual(config, { host: '127.0.0.1', port: 3306, user: 'ruyi', password: 'ruyi', database: 'ruyi_test' },
    '数据库测试只允许连接本机 Docker 的 ruyi_test 测试数据库');
  assert.deepEqual(readDisplayConfig({}), { mode: 'local', host: '127.0.0.1', port: 5900 });
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    assert.equal(readDisplayConfig({ RUYI_LOGIN_DISPLAY: 'vnc', RUYI_VNC_HOST: host }).host, host);
  }
  for (const port of ['0', '65536', '1.5', 'invalid']) {
    assert.throws(() => readDisplayConfig({ RUYI_LOGIN_DISPLAY: 'vnc', RUYI_VNC_PORT: port }), /端口/);
  }
  assert.throws(() => readDisplayConfig({ RUYI_LOGIN_DISPLAY: 'unknown' }), /只允许/);

  const names = ['RUYI_LOGIN_DISPLAY', 'RUYI_VNC_HOST', 'RUYI_VNC_PORT', 'RUYI_MAX_LOGIN_SESSIONS', 'DISPLAY'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const db = createDb(config);
  const keys = loadKeys({ RUYI_STATE_KEY: crypto.randomBytes(32).toString('base64') });
  const tcpConnections = new Set();
  const clients = new Set();
  const serviceLogs = [];
  const launched = [];
  const fakeVnc = net.createServer((socket) => {
    tcpConnections.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => tcpConnections.delete(socket));
    socket.on('data', (data) => socket.write(Buffer.concat([prefix, data])));
  });
  const { chromium } = require('playwright');
  const originalLaunch = chromium.launch;
  chromium.launch = () => assert.fail('远程桌面测试不得启动真实浏览器');
  let app;
  try {
    await clearTestData(db);
    await new Promise((resolve) => fakeVnc.listen(0, '127.0.0.1', resolve));
    process.env.RUYI_LOGIN_DISPLAY = 'vnc';
    process.env.RUYI_VNC_HOST = '10.0.0.1';
    assert.throws(() => buildApp({ db, stateKeys: keys }), /VNC 地址只允许/);
    process.env.RUYI_VNC_HOST = '127.0.0.1';
    process.env.RUYI_VNC_PORT = String(fakeVnc.address().port);
    process.env.RUYI_MAX_LOGIN_SESSIONS = '8';
    delete process.env.DISPLAY;

    const identities = [];
    for (const username of usernames) {
      const id = await users.createUser(db, { username, displayName: '远程桌面测试用户',
        passwordHash: '伪造密码摘要', mustChangePassword: false });
      const token = crypto.randomBytes(32).toString('base64url');
      await authSessions.createSession(db, { tokenHash: hashToken(token), userId: id,
        expiresAt: new Date(Date.now() + 3600000) });
      identities.push({ id, username, tokenHash: hashToken(token), cookie: `ruyi_session=${token}` });
    }
    const [a, b] = identities;
    const missingDir = path.join(os.tmpdir(), `ruyi-vnc-${crypto.randomUUID()}`);
    app = buildApp({ db, stateKeys: keys, uploadRoot: missingDir, webDist: missingDir,
      logger: { level: 'info', stream: { write: (line) => serviceLogs.push(JSON.parse(line)) } },
      platformLogin: {
        launch: async (options) => {
          const fake = fakeBrowser();
          fake.launchOptions = options;
          launched.push(fake);
          return fake.browser;
        },
        checks: { pageLooksLoggedIn: async (page) => launched.find((fake) => fake.pages.includes(page)).ready,
          probeSite: async () => ({ ok: true }) },
        pollMs: 5, timeoutMs: 61000,
      },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    let origin = `http://127.0.0.1:${app.server.address().port}`;
    const request = (user, method, url) => app.inject({ method, url, headers: { cookie: user.cookie } });
    const start = async (user = a) => {
      const response = await request(user, 'POST', '/api/platform-login');
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().session.display, 'vnc');
      const id = response.json().session.id;
      await eventually(() => sessions.getSession(id, user.id)?.status === 'waiting', '假会话没有进入等待状态');
      return id;
    };
    const client = (id, { cookie = a.cookie, requestOrigin = origin, route, protocols = ['binary'] } = {}) => {
      const headers = {};
      if (cookie !== null) headers.Cookie = cookie;
      if (requestOrigin !== null) headers.Origin = requestOrigin;
      const ws = new WebSocket(`${origin.replace('http:', 'ws:')}${route || `/api/platform-login/${id}/vnc`}`, protocols,
        { headers, handshakeTimeout: 3000 });
      ws.on('error', () => {});
      clients.add(ws);
      return ws;
    };
    const connect = async (id, options) => {
      const ws = client(id, options);
      await waitEvent(ws, 'open');
      assert.equal(ws.protocol, 'binary');
      return ws;
    };
    const reject = async (id, status, options) => {
      const ws = client(id, options);
      await new Promise((resolve, rejectPromise) => {
        ws.once('open', () => rejectPromise(new Error('不应允许此连接')));
        ws.once('unexpected-response', (_, response) => {
          try { assert.equal(response.statusCode, status); resolve(); } catch (error) { rejectPromise(error); }
          finally { response.destroy(); ws.terminate(); }
        });
        ws.once('error', rejectPromise);
      });
    };
    const noTcp = () => eventually(() => tcpConnections.size === 0, '假 VNC 的 TCP 连接未关闭');
    const echo = async (ws) => {
      const response = waitEvent(ws, 'message');
      ws.send(marker, { binary: true });
      const [data, binary] = await response;
      assert.equal(binary, true);
      assert.deepEqual(data, Buffer.concat([prefix, marker]));
    };

    const id = await start();
    assert.equal((await request(a, 'POST', '/api/platform-login')).json().session.id, id);
    const busy = await request(b, 'POST', '/api/platform-login');
    assert.equal(busy.statusCode, 409);
    assert.equal(busy.json().message, '有其他用户正在登录平台，请稍后再试（约 2 分钟）');
    assert.deepEqual(launched[0].launchOptions.args, ['--start-maximized', '--window-position=0,0', '--window-size=1280,800']);
    assert.equal(launched[0].launchOptions.headless, false);
    assert.equal(launched[0].launchOptions.env.DISPLAY, ':99');
    assert.deepEqual(launched[0].contextOptions.viewport, { width: 1280, height: 800 });
    assert.equal(Object.hasOwn(launched[0].contextOptions, 'storageState'), false);

    await reject(id, 401, { cookie: null });
    await reject(id, 401, { cookie: 'ruyi_session=fake' });
    await reject(id, 401, { cookie: `ruyi_session=${crypto.randomBytes(32).toString('base64url')}` });
    await reject(id, 403, { requestOrigin: null });
    await reject(id, 403, { requestOrigin: 'https://other.example' });
    await reject(id, 403, { requestOrigin: `${origin}.evil.example` });
    await reject(id, 403, { requestOrigin: 'null' });
    await reject(id, 403, { requestOrigin: `${origin}/path` });
    await reject(id, 403, { protocols: [] });
    await reject(id, 404, { cookie: b.cookie });
    await reject('missing', 404);
    for (const patch of [
      { expires_at: sql`DATE_SUB(NOW(), INTERVAL 1 SECOND)` },
      { revoked_at: sql`NOW()` },
      { last_seen_at: sql`DATE_SUB(NOW(), INTERVAL 481 MINUTE)` },
    ]) {
      await db.updateTable('ruyi_user_sessions').set(patch).where('id', '=', a.tokenHash).execute();
      await reject(id, 401);
      await db.updateTable('ruyi_user_sessions').set({ expires_at: new Date(Date.now() + 3600000),
        revoked_at: null, last_seen_at: sql`NOW()` }).where('id', '=', a.tokenHash).execute();
    }
    await users.setStatus(db, a.id, 'disabled');
    await reject(id, 401);
    await users.setStatus(db, a.id, 'active');
    await db.updateTable('ruyi_users').set({ must_change_password: 1 }).where('id', '=', a.id).execute();
    await reject(id, 403);
    await db.updateTable('ruyi_users').set({ must_change_password: 0 }).where('id', '=', a.id).execute();
    assert.equal(tcpConnections.size, 0, '握手失败不得创建 TCP 连接');

    const first = await connect(id);
    await echo(first);
    const logsBeforeTraffic = await db.selectFrom('ruyi_operation_logs').selectAll().where('user_id', '=', a.id).execute();
    await echo(first);
    assert.deepEqual(await db.selectFrom('ruyi_operation_logs').selectAll().where('user_id', '=', a.id).execute(), logsBeforeTraffic);
    const firstClosed = waitEvent(first, 'close');
    const second = await connect(id);
    await firstClosed;
    await eventually(() => tcpConnections.size === 1, '替换连接没有释放旧 TCP');
    await echo(second);
    const cancelled = waitEvent(second, 'close');
    assert.equal((await request(a, 'DELETE', `/api/platform-login/${id}`)).statusCode, 200);
    await cancelled;
    await noTcp();
    await reject(id, 409);

    // 终态统一触发关闭通知；成功和失败通过 4.3 的假浏览器注入到达。
    for (const status of ['succeeded', 'failed', 'expired']) {
      const current = await start();
      const ws = await connect(current);
      await echo(ws);
      const closed = waitEvent(ws, 'close');
      const session = sessions.getSession(current, a.id);
      if (status === 'expired') session.expiresAt = new Date(0);
      else if (status === 'failed') launched.at(-1).context.newPage = async () => { throw new Error('假浏览器失败'); };
      if (status !== 'expired') launched.at(-1).ready = true;
      sessions.getSession(current, a.id);
      await eventually(() => session.status === status, `会话没有进入 ${status}`);
      await closed;
      await noTcp();
      await session.task;
      await session.finishPromise;
      await reject(current, 409);
    }

    const limitsId = await start();
    const tooLarge = await connect(limitsId);
    const oversizedClosed = waitEvent(tooLarge, 'close');
    tooLarge.send(Buffer.alloc(4 * 1024 * 1024 + 1));
    assert.equal((await oversizedClosed)[0], 1009);
    await noTcp();
    const text = await connect(limitsId);
    const textClosed = waitEvent(text, 'close');
    text.send('不允许文本数据');
    assert.equal((await textClosed)[0], 1003);
    await noTcp();
    const tcpEnded = await connect(limitsId);
    await echo(tcpEnded);
    const tcpClosed = waitEvent(tcpEnded, 'close');
    for (const socket of tcpConnections) socket.destroy();
    await tcpClosed;
    await noTcp();
    const browserEnded = await connect(limitsId);
    await echo(browserEnded);
    const browserClosed = waitEvent(browserEnded, 'close');
    browserEnded.close();
    await browserClosed;
    await noTcp();
    await request(a, 'DELETE', `/api/platform-login/${limitsId}`);

    const other = client('unused', { route: '/api/status' });
    await waitEvent(other, 'close');
    assert.notEqual(other.readyState, WebSocket.OPEN);

    await app.close();
    // 被取消但启动尚未返回的浏览器仍占用桌面，不能因终态保留期到期而释放。
    let now = Date.now();
    let release;
    let launchBegan = false;
    const launchGate = new Promise((resolve) => { release = resolve; });
    const lateManager = sessions.createSessionManager({ now: () => now, sweepMs: 5 });
    const lateBrowser = fakeBrowser();
    const late = lateManager.startSession(a, { db, keys, launch: async () => {
      launchBegan = true;
      await launchGate;
      return lateBrowser.browser;
    } });
    try {
      await eventually(() => launchBegan, '没有进入迟到的启动');
      await lateManager.cancelSession(late.id, a.id);
      now += 11 * 60000;
      assert.throws(() => lateManager.startSession(b, { db, keys }), (error) => error.statusCode === 409);
      release();
      await late.task;
      assert.equal(lateBrowser.closed, 1);
      const next = lateManager.startSession(b, { db, keys, launch: async () => fakeBrowser().browser,
        checks: { pageLooksLoggedIn: async () => false }, pollMs: 5 });
      assert.equal(next.display, 'vnc');
    } finally {
      release();
      await lateManager.closeAllSessions();
    }

    // local 模式保持多人登录，且不开放远程桌面。
    process.env.RUYI_LOGIN_DISPLAY = 'local';
    app = buildApp({ db, stateKeys: keys, logger: false, uploadRoot: missingDir, webDist: missingDir,
      platformLogin: { launch: async (options) => {
        assert.deepEqual(options.args, ['--disable-dev-shm-usage']);
        assert.equal(Object.hasOwn(options, 'env'), false);
        return fakeBrowser().browser;
      }, checks: { pageLooksLoggedIn: async () => false }, pollMs: 5 } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    origin = `http://127.0.0.1:${app.server.address().port}`;
    for (const user of [a, b]) {
      const response = await request(user, 'POST', '/api/platform-login');
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().session.display, 'local');
      await reject(response.json().session.id, 409, { cookie: user.cookie });
    }
    await app.close();

    process.env.RUYI_LOGIN_DISPLAY = 'vnc';
    process.env.DISPLAY = ':123';
    app = buildApp({ db, stateKeys: keys, logger: false, uploadRoot: missingDir, webDist: missingDir,
      platformLogin: { launch: async (options) => {
        assert.equal(options.env.DISPLAY, ':123');
        return fakeBrowser().browser;
      }, checks: { pageLooksLoggedIn: async () => false }, pollMs: 5 } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const shutdownResponse = await request(a, 'POST', '/api/platform-login');
    const shutdownId = shutdownResponse.json().session.id;
    await eventually(() => sessions.getSession(shutdownId, a.id)?.status === 'waiting', '关闭测试未开始等待');
    const shutdown = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/api/platform-login/${shutdownId}/vnc`, ['binary'],
      { headers: { Cookie: a.cookie, Origin: `http://127.0.0.1:${app.server.address().port}` } });
    clients.add(shutdown);
    shutdown.on('error', () => {});
    await waitEvent(shutdown, 'open');
    await echo(shutdown);
    const shutdownClosed = waitEvent(shutdown, 'close');
    await app.close();
    await shutdownClosed;
    await noTcp();
    const logText = JSON.stringify(serviceLogs);
    assert.equal(logText.includes(marker.toString()), false);
    for (const user of identities) assert.equal(logText.includes(user.cookie), false);
    const connectionLogs = serviceLogs.filter((row) => row.msg === '远程桌面连接已建立');
    const disconnectLogs = serviceLogs.filter((row) => row.msg === '远程桌面连接已断开');
    assert.ok(connectionLogs.length > 0);
    assert.equal(connectionLogs.length, disconnectLogs.length);
    assert.equal(app.server.listening, false);
    console.log('远程桌面鉴权、二进制转发、会话隔离、连接替换与资源清理测试通过。');
  } finally {
    try {
      for (const ws of clients) ws.terminate();
      if (app) await app.close();
      await sessions.closeAllSessions();
      for (const socket of tcpConnections) socket.destroy();
      await new Promise((resolve) => fakeVnc.close(resolve));
    } finally {
      try { await clearTestData(db); } finally { await db.destroy(); }
      chromium.launch = originalLaunch;
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }
}

main().catch((error) => { console.error('远程桌面测试失败：', error); process.exitCode = 1; });

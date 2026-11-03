const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const serverRequire = createRequire(require.resolve('@ruyi/server/package.json'));
const Fastify = serverRequire('fastify');
const sessions = require('@ruyi/server/src/modules/platform-login/sessions');
const { registerPlatformLoginRoutes } = require('@ruyi/server/src/modules/platform-login/routes');

async function testSessionCapacity() {
  const { createSessionManager } = sessions;
  const manager = createSessionManager();
  const pending = [];
  const launched = [];
  const logs = [];
  const db = {
    selectFrom() { return { selectAll() { return this; }, where() { return this; }, async executeTakeFirst() {} }; },
    insertInto() { return { values(value) { logs.push(value); return this; }, async execute() {} }; },
  };
  const options = { db, launch: (config) => {
    launched.push(config);
    return new Promise((resolve) => pending.push(() => resolve({ close: async () => {} })));
  } };
  const previousMax = process.env.RUYI_MAX_LOGIN_SESSIONS;
  process.env.RUYI_MAX_LOGIN_SESSIONS = '2';
  try {
    const first = manager.startSession({ id: 1 }, options);
    const second = manager.startSession({ id: 2 }, options);
    assert.equal(manager.getSession(first.id, 2), null);
    assert.equal(await manager.cancelSession(first.id, 2), false);
    assert.equal(manager.startSession({ id: 1 }, options), first);
    assert.equal(Object.hasOwn(sessions.publicSession(first), 'mode'), false);
    assert.equal(Object.hasOwn(sessions.publicSession(first), 'display'), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(launched.every((config) => config.headless && config.args.includes('--disable-dev-shm-usage')));
    assert.throws(() => manager.startSession({ id: 3 }, options), (error) => error.statusCode === 409);
    await manager.cancelSession(first.id, 1);
    const replacement = manager.startSession({ id: 3 }, options);
    assert.throws(() => manager.startSession({ id: 4 }, options), (error) => error.statusCode === 409);
    await manager.cancelSession(second.id, 2);
    const next = manager.startSession({ id: 4 }, options);
    await manager.cancelSession(replacement.id, 3);
    await manager.cancelSession(next.id, 4);
    await new Promise((resolve) => setImmediate(resolve));
    for (const resolve of pending) resolve();
    assert.ok(logs.every((row) => !row.detail.includes('image')));
    assert.ok(logs.every((row) => !Object.hasOwn(JSON.parse(row.detail), 'mode')));
    assert.ok(logs.every((row) => JSON.parse(row.detail).method === 'wechat'));
  } finally {
    for (const resolve of pending) resolve();
    await manager.closeAllSessions();
    if (previousMax === undefined) delete process.env.RUYI_MAX_LOGIN_SESSIONS;
    else process.env.RUYI_MAX_LOGIN_SESSIONS = previousMax;
  }
}

async function main() {
  const originals = { ...sessions };
  const image = Buffer.from('fake-png');
  const session = { id: 'qr-test', userId: 1, status: 'waiting', method: 'wechat',
    sites: {}, qr: { method: 'wechat', state: 'waiting', updatedAt: 1, image } };
  let startOptions;
  sessions.startSession = (_, options) => { startOptions = options; return session; };
  sessions.getSession = (id, userId) => id === session.id && userId === session.userId ? session : null;
  sessions.changeMethod = async (id, userId, method) => {
    const owned = sessions.getSession(id, userId);
    if (!owned) return null;
    if (owned.status !== 'waiting') { const error = new Error('当前阶段不能切换扫码方式'); error.statusCode = 409; throw error; }
    owned.qr.method = method;
    return owned;
  };
  sessions.closeAllSessions = async () => {};
  const app = Fastify();
  app.addHook('onRequest', async (request) => { request.user = { id: Number(request.headers['x-user'] || 1) }; });
  app.register(registerPlatformLoginRoutes);
  try {
    const request = (method, url, payload, user = 1) => app.inject({ method, url, payload, headers: { 'x-user': user } });
    let response = await request('POST', '/api/platform-login');
    assert.equal(response.statusCode, 200);
    assert.equal(Object.hasOwn(startOptions, 'mode'), false);
    assert.equal(Object.hasOwn(response.json().session, 'mode'), false);
    assert.equal(Object.hasOwn(response.json().session, 'display'), false);
    assert.equal(startOptions.method, 'wechat');
    assert.equal('image' in response.json().session.qr, false);
    await request('POST', '/api/platform-login', { mode: 'desktop', method: 'qq' });
    assert.equal(Object.hasOwn(startOptions, 'mode'), false);
    assert.equal(startOptions.method, 'qq');
    await request('POST', '/api/platform-login', { mode: 'obsolete' });
    assert.equal(Object.hasOwn(startOptions, 'mode'), false);
    response = await request('GET', '/api/platform-login/qr-test/qr.png');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.rawPayload, image);
    assert.equal((await request('GET', '/api/platform-login/qr-test/qr.png', undefined, 2)).statusCode, 404);
    assert.equal((await request('POST', '/api/platform-login/qr-test/method', { method: 'qq' }, 2)).statusCode, 404);
    response = await request('POST', '/api/platform-login/qr-test/method', { method: 'qq' });
    assert.equal(response.json().session.qr.method, 'qq');
    assert.equal('image' in response.json().session.qr, false);
    for (const status of ['starting', 'saving', 'succeeded', 'cancelled', 'failed', 'expired']) {
      session.status = status;
      assert.equal((await request('GET', '/api/platform-login/qr-test/qr.png')).statusCode, 404);
      assert.equal((await request('POST', '/api/platform-login/qr-test/method', { method: 'wechat' })).statusCode, 409);
    }
    session.status = 'waiting';
    session.qr.image = null;
    assert.equal((await request('GET', '/api/platform-login/qr-test/qr.png')).statusCode, 404);
    console.log('扫码登录接口参数、图片权限、缓存和公开响应测试通过。');
  } finally {
    await app.close();
    Object.assign(sessions, originals);
  }
}
main().then(testSessionCapacity).catch((error) => { console.error(error); process.exitCode = 1; });

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sql } = require('kysely');
const { createDb, readDbConfig } = require('../db');
const users = require('../server/repos/users');
const { hashPassword, verifyPassword } = require('../server/auth/password');
const { loadKeys } = require('../server/platform-state/crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-auth-test-'));
const previousUploadDir = process.env.RUYI_UPLOAD_DIR;
process.env.RUYI_UPLOAD_DIR = tempDir;

// 在加载路由前封住真实操作，鉴权回归也不能启动浏览器或脚本。
const browser = require('../lib/browser');
const childProcess = require('node:child_process');
const originals = { ...browser };
const processMethods = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const originalProcessMethods = Object.fromEntries(processMethods.map((name) => [name, childProcess[name]]));
const unexpectedOperation = () => { throw new Error('测试不得启动浏览器、运行脚本'); };
browser.launchBrowser = unexpectedOperation;
browser.closeBrowserContext = async (context) => context.close();
for (const name of processMethods) childProcess[name] = unexpectedOperation;
const { buildApp } = require('../server/app');

const password = 'AuthTest123';
const nextPassword = 'ChangedTest123';
const hashCookie = (cookie) => crypto.createHash('sha256').update(decodeURIComponent(cookie.split('=')[1])).digest('hex');

function sessionCookie(response) {
  const header = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header : [header];
  const value = values.find((item) => item && item.startsWith('ruyi_session='));
  assert.ok(value, '登录应设置会话 Cookie');
  return value.split(';')[0];
}

async function clearTestData(db) {
  // 仅清理明确授权的测试库；业务操作记录仍然只追加。
  for (const table of ['ruyi_user_sessions', 'ruyi_platform_states', 'ruyi_operation_logs', 'ruyi_users']) {
    await db.deleteFrom(table).execute();
  }
}

async function main() {
  if (process.env.RUYI_DB_NAME !== 'ruyi_test') throw new Error('数据库测试只允许使用 ruyi_test 库。');
  const config = readDbConfig();
  if (config.host !== '127.0.0.1' || config.port !== 3306 || config.user !== 'ruyi' || config.password !== 'ruyi') {
    throw new Error('数据库测试只允许连接本机 Docker 的测试数据库。');
  }
  assert.throws(() => buildApp({ auth: true, logger: false }));
  assert.throws(() => buildApp({ logger: false }));
  const db = createDb(config);
  let app;
  try {
    await clearTestData(db);
    const passwordHash = await hashPassword(password);
    const adminId = await users.createUser(db, {
      username: 'auth_admin', displayName: '认证管理员', passwordHash, role: 'admin', mustChangePassword: false,
    });
    const userId = await users.createUser(db, {
      username: 'auth_user', displayName: '认证用户', passwordHash, mustChangePassword: false,
    });
    // 模拟已有超长用户名，登录与改密不应受新建用户限制影响。
    const requiredId = await users.createUser(db, {
      username: 'auth_required', displayName: '首次登录用户', passwordHash,
    });
    const stateKeys = loadKeys({ RUYI_STATE_KEY: crypto.randomBytes(32).toString('base64') });
    app = buildApp({ db, stateKeys, logger: false, webDist: path.join(tempDir, 'missing-dist') });
    const request = (method, url, cookie, payload) => app.inject({
      method, url, ...(cookie ? { headers: { cookie } } : {}), ...(payload === undefined ? {} : { payload }),
    });
    const login = (username, suppliedPassword = password, headers = {}) => app.inject({
      method: 'POST', url: '/api/auth/login', payload: { username, password: suppliedPassword }, headers,
    });
    const expectUnauthenticated = async (cookie) => {
      const response = await request('GET', '/api/status', cookie);
      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), { ok: false, code: 'UNAUTHENTICATED', message: '请先登录' });
    };

    await expectUnauthenticated();
    assert.equal((await request('GET', '/api/health')).statusCode, 200);
    for (const url of ['/%61pi/admin/users', '/api/%61dmin/users', '/%61pi/status']) {
      assert.equal((await request('GET', url)).statusCode, 401);
    }
    assert.equal((await request('GET', '/')).statusCode, 503);
    for (const payload of [{}, { username: 'auth_user' }, { password }, { username: 123, password }, { username: 'auth_user', password: 123 }]) {
      assert.equal((await request('POST', '/api/auth/login', undefined, payload)).statusCode, 400);
    }

    const loggedIn = await login('auth_user', password, { 'user-agent': '测'.repeat(300) });
    assert.equal(loggedIn.statusCode, 200);
    const userCookie = sessionCookie(loggedIn);
    const cookieHeader = [].concat(loggedIn.headers['set-cookie']).join(';');
    assert.match(cookieHeader, /HttpOnly/i);
    assert.match(cookieHeader, /SameSite=Lax/i);
    assert.match(cookieHeader, /Path=\//i);
    assert.match(cookieHeader, /Max-Age=604800/i);
    assert.equal(/; Secure(?:;|$)/i.test(cookieHeader), process.env.RUYI_COOKIE_SECURE === '1');
    const expectedUser = { id: userId, username: 'auth_user', displayName: '认证用户', role: 'user', mustChangePassword: false };
    assert.deepEqual(loggedIn.json(), { ok: true, user: expectedUser });
    assert.equal((await request('GET', '/api/status', userCookie)).statusCode, 200);
    assert.deepEqual((await request('GET', '/api/auth/me', userCookie)).json(), { ok: true, user: expectedUser });
    const session = await db.selectFrom('ruyi_user_sessions').selectAll().where('id', '=', hashCookie(userCookie)).executeTakeFirstOrThrow();
    assert.match(session.id, /^[a-f0-9]{64}$/);
    assert.notEqual(session.id, userCookie.slice('ruyi_session='.length));
    assert.equal(session.ip, '127.0.0.1');
    assert.equal(session.user_agent, '测'.repeat(255));
    assert.ok(Math.abs(session.expires_at - session.created_at - 7 * 24 * 60 * 60 * 1000) < 2000);

    const absent = await login('auth_missing');
    const incorrect = await login('auth_user', 'WrongPassword123');
    assert.equal(absent.statusCode, 401);
    assert.equal(incorrect.statusCode, absent.statusCode);
    assert.deepEqual(incorrect.json(), absent.json());
    assert.equal(absent.json().message, '用户名或密码错误');
    await users.recordLoginSuccess(db, userId, '127.0.0.1');
    for (let attempt = 0; attempt < 5; attempt++) assert.equal((await login('auth_user', 'WrongPassword123')).statusCode, 401);
    const lockedBefore = await users.findById(db, userId);
    const locked = await login('auth_user');
    assert.equal(locked.statusCode, 429);
    assert.match(locked.json().message, /^登录失败次数过多，请 \d+ 分钟后再试$/);
    assert.equal((await login('auth_user', 'WrongPassword123')).statusCode, 429);
    const lockedAfter = await users.findById(db, userId);
    assert.equal(lockedAfter.failed_login_count, lockedBefore.failed_login_count);
    assert.equal(lockedAfter.locked_until.getTime(), lockedBefore.locked_until.getTime());
    await db.updateTable('ruyi_users').set({ locked_until: sql`DATE_SUB(NOW(), INTERVAL 1 MINUTE)` }).where('id', '=', userId).execute();
    assert.equal((await login('auth_user')).statusCode, 200);
    assert.equal((await users.findById(db, userId)).locked_until, null);

    const ordinaryAdmin = await request('GET', '/api/admin/users', userCookie);
    assert.equal(ordinaryAdmin.statusCode, 403);
    assert.deepEqual(ordinaryAdmin.json(), { ok: false, code: 'FORBIDDEN', message: '没有权限' });
    for (const url of ['/%61pi/admin/users', '/api/%61dmin/users']) {
      const response = await request('GET', url, userCookie);
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().code, 'FORBIDDEN');
    }
    const adminCookie = sessionCookie(await login('auth_admin'));
    const adminRequest = (method, url, payload) => request(method, url, adminCookie, payload);
    const createPayload = { username: 'auth_created', displayName: '管理员创建', password, role: 'user' };
    const created = await adminRequest('POST', '/api/admin/users', createPayload);
    assert.equal(created.statusCode, 200);
    assert.equal(createPayload.username.length, 12);
    const createdUser = await users.findByUsername(db, createPayload.username);
    assert.equal(createdUser.created_by, adminId);
    assert.equal(createdUser.must_change_password, 1);
    assert.equal(await verifyPassword(password, createdUser.password_hash), true);
    const duplicate = await adminRequest('POST', '/api/admin/users', createPayload);
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().message, '用户名已存在');
    const longUsername = 'a'.repeat(13);
    const tooLong = await adminRequest('POST', '/api/admin/users', { ...createPayload, username: longUsername });
    assert.equal(tooLong.statusCode, 400);
    assert.equal(tooLong.json().message, '用户名需为 3 至 12 位小写字母、数字或下划线');
    assert.equal(await users.findByUsername(db, longUsername), undefined);
    for (const payload of [
      { ...createPayload, username: 'INVALID' }, { ...createPayload, username: 'auth_weak', password: 'short' },
      { ...createPayload, username: 'auth_role', role: 'root' }, { ...createPayload, username: 'auth_long', password: '中'.repeat(25) },
    ]) assert.equal((await adminRequest('POST', '/api/admin/users', payload)).statusCode, 400);
    const listed = await adminRequest('GET', '/api/admin/users');
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().ok, true);
    assert.ok(listed.json().users.some((user) => user.id === createdUser.id && user.displayName === '管理员创建'));
    for (const user of listed.json().users) {
      assert.equal(Object.hasOwn(user, 'passwordHash'), false);
      assert.equal(Object.hasOwn(user, 'password_hash'), false);
      assert.ok(Object.keys(user).every((key) => !key.includes('_')));
    }
    assert.equal((await adminRequest('POST', `/api/admin/users/${adminId}/disable`)).statusCode, 400);
    for (const action of ['disable', 'enable', 'reset-password']) {
      assert.equal((await adminRequest('POST', `/api/admin/users/2147483647/${action}`, action === 'reset-password' ? { password } : undefined)).statusCode, 404);
    }

    const disabledCookie = sessionCookie(await login('auth_created'));
    assert.equal((await adminRequest('POST', `/api/admin/users/${createdUser.id}/disable`)).statusCode, 200);
    const disabled = await login('auth_created');
    assert.equal(disabled.statusCode, 403);
    assert.equal(disabled.json().message, '账号已停用，请联系管理员');
    await expectUnauthenticated(disabledCookie);
    assert.equal((await adminRequest('POST', `/api/admin/users/${createdUser.id}/enable`)).statusCode, 200);
    await expectUnauthenticated(disabledCookie);
    const beforeResetCookie = sessionCookie(await login('auth_created'));
    assert.equal((await adminRequest('POST', `/api/admin/users/${createdUser.id}/reset-password`, { password: 'short' })).statusCode, 400);
    assert.equal((await adminRequest('POST', `/api/admin/users/${createdUser.id}/reset-password`, { password: nextPassword })).statusCode, 200);
    await expectUnauthenticated(beforeResetCookie);
    assert.equal((await login('auth_created')).statusCode, 401);
    const resetLogin = await login('auth_created', nextPassword);
    assert.equal(resetLogin.statusCode, 200);
    assert.equal(resetLogin.json().user.mustChangePassword, true);

    const requiredCookie = sessionCookie(await login('auth_required'));
    const otherCookie = sessionCookie(await login('auth_required'));
    assert.equal((await request('GET', '/api/auth/me', requiredCookie)).json().user.mustChangePassword, true);
    for (const [method, url, payload] of [
      ['GET', '/api/status'], ['GET', '/api/admin/users'], ['GET', '/%61pi/status'], ['GET', '/api/%61dmin/users'], ['POST', '/api/runtime-mode', { headless: true }],
    ]) {
      const response = await request(method, url, requiredCookie, payload);
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.json(), { ok: false, code: 'PASSWORD_CHANGE_REQUIRED', message: '请先修改密码' });
    }
    const incorrectCurrent = await request('POST', '/api/auth/change-password', requiredCookie, { currentPassword: 'WrongPassword123', newPassword: nextPassword });
    assert.equal(incorrectCurrent.statusCode, 400);
    assert.equal(incorrectCurrent.json().message, '当前密码不正确');
    assert.equal((await users.findById(db, requiredId)).failed_login_count, 0);
    for (const newPassword of [password, 'short', '中'.repeat(25)]) {
      assert.equal((await request('POST', '/api/auth/change-password', requiredCookie, { currentPassword: password, newPassword })).statusCode, 400);
    }
    assert.equal((await request('POST', '/api/auth/change-password', requiredCookie, { currentPassword: password, newPassword: nextPassword })).statusCode, 200);
    assert.equal((await users.findById(db, requiredId)).must_change_password, 0);
    assert.equal((await request('GET', '/api/auth/me', requiredCookie)).json().user.mustChangePassword, false);
    assert.equal((await request('GET', '/api/status', requiredCookie)).statusCode, 200);
    await expectUnauthenticated(otherCookie);
    assert.equal((await login('auth_required')).statusCode, 401);
    assert.equal((await login('auth_required', nextPassword)).statusCode, 200);
    const forcedLogout = await request('POST', '/api/auth/logout', sessionCookie(resetLogin));
    assert.equal(forcedLogout.statusCode, 200);
    assert.deepEqual(forcedLogout.json(), { ok: true });
    await expectUnauthenticated(sessionCookie(resetLogin));

    const loggedOut = await request('POST', '/api/auth/logout', userCookie);
    assert.equal(loggedOut.statusCode, 200);
    assert.deepEqual(loggedOut.json(), { ok: true });
    assert.match([].concat(loggedOut.headers['set-cookie']).join(';'), /ruyi_session=;/);
    await expectUnauthenticated(userCookie);
    await expectUnauthenticated('ruyi_session=forged-cookie');
    for (const fields of [
      { expires_at: sql`DATE_SUB(NOW(), INTERVAL 1 SECOND)` },
      { last_seen_at: sql`DATE_SUB(NOW(), INTERVAL 9 HOUR)` },
    ]) {
      const cookie = sessionCookie(await login('auth_user'));
      await db.updateTable('ruyi_user_sessions').set(fields).where('id', '=', hashCookie(cookie)).execute();
      await expectUnauthenticated(cookie);
    }
    const boundaryPassword = 'a'.repeat(72);
    await users.updatePassword(db, requiredId, await hashPassword(boundaryPassword), { mustChangePassword: true });
    const boundaryCookie = sessionCookie(await login('auth_required', boundaryPassword + 'suffix'));
    const samePassword = await request('POST', '/api/auth/change-password', boundaryCookie, {
      currentPassword: boundaryPassword + 'suffix', newPassword: boundaryPassword,
    });
    assert.equal(samePassword.statusCode, 400);
    assert.equal(samePassword.json().message, '新密码不能与当前密码相同');
    assert.equal((await users.findById(db, requiredId)).must_change_password, 1);
    assert.ok((await db.selectFrom('ruyi_operation_logs').selectAll().execute()).length > 0);
    console.log('认证接口、权限与会话数据库测试通过。');
  } finally {
    try {
      if (app) await app.close();
    } finally {
      try { await clearTestData(db); } finally { await db.destroy(); }
    }
  }
}

main().catch((error) => {
  console.error('认证接口数据库测试失败：', error);
  process.exitCode = 1;
}).finally(() => {
  browser.launchBrowser = originals.launchBrowser;
  browser.closeBrowserContext = originals.closeBrowserContext;
  for (const name of processMethods) childProcess[name] = originalProcessMethods[name];
  if (previousUploadDir === undefined) delete process.env.RUYI_UPLOAD_DIR;
  else process.env.RUYI_UPLOAD_DIR = previousUploadDir;
});

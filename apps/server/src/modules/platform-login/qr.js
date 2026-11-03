const { loginTargets } = require('@ruyi/automation/lib/storage-state');

const switchable = new Set(['waiting', 'expired', 'risk']);
function conflict() {
  const error = new Error('当前阶段不能切换扫码方式');
  error.statusCode = 409;
  return error;
}
function qrPreparing() {
  const error = new Error('二维码准备中，请稍后再切换');
  error.statusCode = 409;
  return error;
}
function exclusive(session, operation) {
  const task = (session.qrOperation || Promise.resolve()).catch(() => {}).then(operation);
  session.qrOperation = task.catch(() => {});
  return task;
}
async function visible(locator) {
  return Boolean(locator && await locator.isVisible().catch(() => false));
}
async function qrImage(locator) {
  try { return { image: await locator.screenshot({ type: 'png', timeout: 3000 }) }; }
  catch (_) { return {}; }
}
function qqFrame(page) {
  return page.frames().find((frame) => { try { return new URL(frame.url()).hostname === 'xui.ptlogin2.qq.com'; } catch (_) { return false; } });
}
const operations = {
  async isLoginPage(page) {
    if (typeof page.url !== 'function') return true;
    try { return new URL(page.url()).hostname === 'sso.e.qq.com'; } catch (_) { return true; }
  },
  async selectMethod(page, method) {
    await page.getByText(method === 'qq' ? 'QQ账号登录' : '微信账号登录', { exact: true }).click({ timeout: 10000 });
  },
  async readQr(page, method) {
    if (method === 'qq') {
      const frame = qqFrame(page);
      if (!frame) return null;
      for (const [selector, state] of [['#qlogin_tips_2', 'risk'], ['#qr_invalid', 'expired'], ['#qrlogin_step3', 'confirmed'], ['#qrlogin_step2', 'scanned']]) {
        if (await visible(frame.locator(selector))) return { state };
      }
      const area = frame.locator('#qrlogin_img');
      return await visible(area) ? { state: 'waiting', ...await qrImage(area) } : null;
    }
    const iframe = page.locator('iframe[src*="open.weixin.qq.com/connect/qrconnect"]').first();
    if (!await visible(iframe)) return null;
    const frame = page.frames().find((item) => { try { return new URL(item.url()).hostname === 'open.weixin.qq.com'; } catch (_) { return false; } });
    if (!frame) return null;
    if (await visible(frame.getByText(/二维码.*(过期|失效)|刷新/).first())) return { state: 'expired' };
    // 只截二维码本身：iframe 里还有说明文字和页面底色。
    const area = frame.locator('img.qrcode').first();
    return await visible(area) ? { state: 'waiting', ...await qrImage(area) } : null;
  },
  async refreshQr(page, method) {
    if (method === 'qq') {
      const frame = qqFrame(page);
      if (frame) await frame.locator('#qr_invalid').click({ timeout: 3000 });
    } else {
      await page.goto(loginTargets.ruyi.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await operations.selectMethod(page, method);
    }
  },
  async clickHeaderLogin(page) {
    for (const selector of ['button', 'a, [role="button"]']) {
      const candidates = page.locator(selector);
      for (let index = 0; index < await candidates.count(); index++) {
        const candidate = candidates.nth(index);
        if (!await visible(candidate)) continue;
        const eligible = await candidate.evaluate((element) => element.textContent.trim() === '登录'
          && element.getBoundingClientRect().y >= 0 && element.getBoundingClientRect().y < 120
          && Boolean(element.closest('header, [role="banner"]')));
        if (eligible) { await candidate.click({ timeout: 5000 }); return true; }
      }
    }
    return false;
  },
};

async function switchMethod(session, method) {
  if (!['wechat', 'qq'].includes(method)) {
    const error = new Error('请选择微信或 QQ 扫码登录'); error.statusCode = 400; throw error;
  }
  return exclusive(session, async () => {
    if (session.status !== 'waiting' || !session.qrPage) throw qrPreparing();
    if (!session.qr || !switchable.has(session.qr.state)) throw conflict();
    // 手机确认与切换请求可能同时到达，点击前再读取一次页面状态。
    const page = session.qrPage;
    const ops = session.qrOps;
    const current = await ops.readQr(page, session.qr.method);
    if (session.status !== 'waiting' || session.qrPage !== page || !session.qr || !current || !switchable.has(current.state)) throw conflict();
    await ops.selectMethod(page, method);
    if (session.status !== 'waiting' || session.qrPage !== page || !session.qr) throw conflict();
    session.method = method;
    session.qr = { method, state: 'waiting', image: null, updatedAt: session.qrNow() };
    session.message = method === 'qq' ? '请使用 QQ 扫描二维码' : '请使用微信扫描二维码';
    session.wake?.();
    return session;
  });
}

async function waitForQrLogin(session, key, { checks, pollMs, alive, pause, finish, now = Date.now }) {
  if (!alive(session)) return false;
  session.status = 'waiting';
  const page = await session.context.newPage();
  if (!alive(session)) return false;
  await page.goto(loginTargets[key].url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  if (!alive(session)) return false;
  const ops = { ...operations, ...checks.qrOperations };
  if (key === 'datanexus') {
    session.qr = null;
    session.qrPage = null;
    session.message = '如翼已登录，正在登录 DataNexus';
    let clicked = false;
    if (!await checks.pageLooksLoggedIn(page, loginTargets[key])) clicked = await ops.clickHeaderLogin(page);
    const deadline = now() + 30000;
    let streak = 0;
    let stableSince = null;
    while (alive(session) && now() < deadline) {
      streak = await checks.pageLooksLoggedIn(page, loginTargets[key]) ? streak + 1 : 0;
      stableSince = streak ? (stableSince ?? now()) : null;
      if (!streak && !clicked && alive(session)) clicked = await ops.clickHeaderLogin(page);
      if (streak >= 3 && now() - stableSince >= 3000) { session.sites[key] = true; return true; }
      await pause(session, pollMs);
    }
    if (!alive(session)) return false;
    await page.goto(loginTargets[key].url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    streak = 0;
    stableSince = null;
    // 按时间而不是次数限定复查：轮询间隔很短时次数上限会远超会话时限。
    const recheckDeadline = now() + 15000;
    while (alive(session) && now() < recheckDeadline) {
      streak = await checks.pageLooksLoggedIn(page, loginTargets[key]) ? streak + 1 : 0;
      stableSince = streak ? (stableSince ?? now()) : null;
      if (streak >= 3 && now() - stableSince >= 3000) { session.sites[key] = true; return true; }
      await pause(session, pollMs);
    }
    if (alive(session)) await finish(session, 'failed', 'DataNexus 自动登录失败，请稍后重新扫码');
    return false;
  }
  session.qrPage = page;
  session.qrOps = ops;
  session.qrNow = now;
  const method = session.method || 'wechat';
  session.qr = null;
  session.message = '正在准备登录二维码';
  // 等待页面跳转稳定后再选择扫码方式。
  let stableSince = null;
  let loginPage = false;
  const firstDeadline = now() + 20000;
  while (alive(session) && now() < firstDeadline) {
    if (await checks.pageLooksLoggedIn(page, loginTargets[key])) {
      stableSince ??= now();
      if (now() - stableSince >= 3000) { session.sites[key] = true; return true; }
    } else {
      stableSince = null;
      loginPage = await ops.isLoginPage(page);
      if (loginPage) break;
    }
    await pause(session, pollMs);
  }
  if (!alive(session)) return false;
  if (!loginPage) {
    await page.goto(loginTargets[key].url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    loginPage = await ops.isLoginPage(page);
  }
  if (!loginPage) {
    await finish(session, 'failed', '无法打开平台登录页，请稍后重新扫码');
    return false;
  }
  let selectFailures = 0;
  while (alive(session) && selectFailures < 10) {
    try {
      await exclusive(session, () => ops.selectMethod(page, method));
      break;
    } catch (_) {
      selectFailures++;
      if (selectFailures >= 10) {
        await finish(session, 'failed', '无法打开平台登录页，请稍后重新扫码');
        return false;
      }
      await pause(session, pollMs);
    }
  }
  let streak = 0;
  stableSince = null;
  let refreshAt = -Infinity;
  session.qrExpiredCount ??= 0;
  while (alive(session)) {
    await exclusive(session, async () => {
      if (!alive(session)) return;
      const loggedIn = await checks.pageLooksLoggedIn(page, loginTargets[key]);
      streak = loggedIn ? streak + 1 : 0;
      stableSince = loggedIn ? (stableSince ?? now()) : null;
      if (loggedIn) { session.qr = null; return; }
      if (now() - refreshAt < 1500) return;
      refreshAt = now();
      if (!await ops.isLoginPage(page) || !alive(session)) return;
      const result = await ops.readQr(page, session.qr?.method || method);
      if (!alive(session)) return;
      if (!result) {
        if (!await ops.isLoginPage(page)) session.qr = null;
        return;
      }
      // 失效状态没有图片，也必须继续走刷新和计数，否则会一直等到会话超时。
      if (!session.qr && !result.image && result.state !== 'expired') return;
      session.qr = { method: session.qr?.method || method, ...session.qr, ...result, updatedAt: now() };
      if (result.state === 'expired') {
        session.qrExpiredCount++;
        session.qr.image = null;
        session.message = '二维码已过期，正在刷新';
        if (session.qrExpiredCount > 5) { await finish(session, 'expired', '二维码多次过期，请重新开始'); return; }
        await ops.refreshQr(page, session.qr.method);
      } else {
        session.message = ({ waiting: session.qr.method === 'qq' ? '请使用 QQ 扫描二维码' : '请使用微信扫描二维码',
          scanned: '已扫码，请在手机上确认', confirmed: '已确认，正在登录', risk: '登录环境异常，请稍后重新扫码' })[result.state];
      }
    });
    if (!alive(session)) return false;
    if (streak >= 3 && now() - stableSince >= 3000) { session.qr = null; session.qrPage = null; session.sites[key] = true; return true; }
    await pause(session, pollMs);
  }
  return false;
}

module.exports = { waitForQrLogin, switchMethod, operations };

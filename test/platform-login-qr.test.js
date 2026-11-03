const assert = require('node:assert/strict');
const { waitForQrLogin, switchMethod, operations } = require('../apps/server/src/modules/platform-login/qr');

async function scenario({ key = 'ruyi', states = ['waiting'], loggedAfter = Infinity, clickWorks = false } = {}) {
  let clock = 0;
  let reads = 0;
  const calls = [];
  const page = { goto: async () => calls.push('goto') };
  const session = { status: 'waiting', method: 'qq', sites: {}, context: { newPage: async () => page } };
  const options = {
    now: () => clock, pollMs: 1000,
    alive: () => session.status === 'waiting',
    pause: async () => { clock += 1000; if (clock > 60000) session.status = 'cancelled'; },
    finish: async (_, status, message) => { session.status = status; session.message = message; session.qr = null; },
    checks: {
      pageLooksLoggedIn: async () => (key === 'ruyi' ? reads >= loggedAfter : clickWorks && calls.includes('click')),
      qrOperations: {
        selectMethod: async (_, method) => calls.push(method),
        readQr: async () => {
          const state = states[Math.min(reads++, states.length - 1)];
          return state ? { state, image: Buffer.from('fake') } : null;
        },
        refreshQr: async () => calls.push('refresh'),
        clickHeaderLogin: async () => { calls.push('click'); return true; },
      },
    },
  };
  const result = await waitForQrLogin(session, key, options);
  return { result, session, calls };
}

(async () => {
  let result = await scenario({ states: ['waiting', 'expired', 'scanned', 'confirmed'], loggedAfter: 4 });
  assert.equal(result.result, true);
  assert.equal(result.session.sites.ruyi, true);
  assert.equal(result.session.qr, null);
  assert.equal(result.calls.filter((value) => value === 'refresh').length, 1);
  result = await scenario({ states: [null, null, 'waiting', 'scanned'], loggedAfter: 4 });
  assert.equal(result.result, true, '登录 iframe 尚未出现时应继续取图');
  result = await scenario({ states: ['expired'] });
  assert.equal(result.result, false);
  assert.equal(result.session.status, 'expired');
  assert.equal(result.session.message, '二维码多次过期，请重新开始');
  assert.equal(result.calls.filter((value) => value === 'refresh').length, 5);
  result = await scenario({ key: 'datanexus', clickWorks: true });
  assert.equal(result.result, true);
  assert.equal(result.session.sites.datanexus, true);
  result = await scenario({ key: 'datanexus' });
  assert.equal(result.session.status, 'failed');
  assert.equal(result.session.message, 'DataNexus 自动登录失败，请稍后重新扫码');
  assert.equal(result.calls.filter((value) => value === 'goto').length, 2);

  const switched = [];
  const session = { status: 'waiting', method: 'qq', qr: { method: 'qq', state: 'waiting' }, qrPage: {}, qrNow: () => 123,
    qrOps: { readQr: async () => ({ state: 'waiting' }), selectMethod: async (_, method) => switched.push(method) } };
  await switchMethod(session, 'wechat');
  assert.equal(session.method, 'wechat');
  assert.equal(session.qr.image, null);
  assert.deepEqual(switched, ['wechat']);
  for (const state of ['scanned', 'confirmed']) {
    session.qr.state = state;
    await assert.rejects(switchMethod(session, 'qq'), (error) => error.statusCode === 409);
  }
  session.qr.state = 'waiting';
  session.qrOps.readQr = async () => ({ state: 'scanned' });
  await assert.rejects(switchMethod(session, 'qq'), (error) => error.statusCode === 409);
  await assert.rejects(switchMethod(session, 'bad'), (error) => error.statusCode === 400);

  let releaseRead;
  session.qrOps.readQr = () => new Promise((resolve) => { releaseRead = resolve; });
  const pendingSwitch = switchMethod(session, 'qq');
  await new Promise((resolve) => setImmediate(resolve));
  session.status = 'cancelled';
  session.qr = null;
  session.qrPage = null;
  releaseRead({ state: 'waiting' });
  await assert.rejects(pendingSwitch, (error) => error.statusCode === 409);
  assert.equal(session.qr, null, '取消后迟到的切换不得恢复二维码');

  // 默认实现只截图二维码元素，不允许使用 page.screenshot。
  let screenshotCount = 0;
  const area = { isVisible: async () => true, screenshot: async () => { screenshotCount++; return Buffer.from('png'); } };
  const hidden = { isVisible: async () => false };
  const fakeFrame = { url: () => 'https://xui.ptlogin2.qq.com/test?secret=hidden', locator: (selector) => selector === '#qrlogin_img' ? area : hidden };
  const qr = await operations.readQr({ frames: () => [fakeFrame] }, 'qq');
  assert.equal(qr.state, 'waiting');
  assert.equal(screenshotCount, 1);
  area.screenshot = async () => { throw new Error('页面正在跳转'); };
  const transient = await operations.readQr({ frames: () => [fakeFrame] }, 'qq');
  assert.equal(transient.state, 'waiting');
  assert.equal(transient.image, undefined);
  console.log('platform-login-qr 测试通过');
})().catch((error) => { console.error(error); process.exitCode = 1; });

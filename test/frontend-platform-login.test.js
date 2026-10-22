const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const webRequire = createRequire(require.resolve('@ruyi/web/package.json'));
const vue = webRequire('vue');
const { parse, compileScript, compileTemplate } = webRequire('@vue/compiler-sfc');

const filename = path.resolve(__dirname, '../apps/web/src/views/PlatformLoginView.vue');
const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename });
// 同时检查真实 SFC 的编译，逻辑测试直接执行 script setup，不复制组件实现。
compileScript(descriptor, { id: 'platform-login-test' });
assert.deepEqual(compileTemplate({ filename, id: 'platform-login-test', source: descriptor.template.content }).errors, []);
const source = descriptor.scriptSetup.content.replace(/^import .*$/gm, '');
const names = ['summary', 'summaryError', 'session', 'error', 'busy', 'restoring', 'active', 'expiryLabel',
  'expiryHours', 'countdown', 'startLogin', 'cancelLogin', 'clearState', 'refreshSummary'];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function mount({ storage = new Map(), userId = 7, api } = {}) {
  const calls = [];
  const events = [];
  const timeouts = new Map();
  const intervals = new Map();
  let serial = 0;
  let mounted;
  let unmounted;
  let time = Date.now();
  let confirmResult = true;
  let confirms = 0;
  const location = { hash: '#/platform-login' };
  const apiFetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    const result = await api(url, options.method || 'GET');
    const status = result.status || 200;
    // 响应按网络序列化，避免测试对象与组件响应共享可变引用。
    const data = JSON.parse(JSON.stringify(result.data));
    return { ok: status < 400, status, async json() { return data; } };
  };
  const sandbox = {
    ...vue, defineProps: () => ({ currentUser: { id: userId } }), defineEmits: () => (event) => events.push(event),
    onMounted: (fn) => { mounted = fn; }, onBeforeUnmount: (fn) => { unmounted = fn; },
    Date: class extends Date { static now() { return time; } }, location,
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    window: {
      setTimeout(fn, delay) { const id = ++serial; timeouts.set(id, { fn, delay }); return id; },
      clearTimeout(id) { timeouts.delete(id); },
      setInterval(fn, delay) { const id = ++serial; intervals.set(id, { fn, delay }); return id; },
      clearInterval(id) { intervals.delete(id); },
      confirm() { confirms++; return confirmResult; },
    }, apiFetch,
    async requestJson(url, options) {
      const response = await apiFetch(url, options);
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.message || '请求失败');
      return data;
    },
  };
  const component = vm.runInNewContext(`${source}\n;({ ${names.join(', ')} })`, sandbox, { filename });
  return { component, calls, events, storage, location, timeouts, intervals, start: () => mounted(),
    unmount: () => unmounted(), confirm: (value) => { confirmResult = value; }, confirms: () => confirms,
    async tick(delay) {
      time += delay;
      for (const timer of intervals.values()) timer.fn();
      const pending = [...timeouts.entries()].filter(([, timer]) => timer.delay === delay);
      for (const [id, timer] of pending) { timeouts.delete(id); await timer.fn(); }
      await flush();
    },
  };
}

async function testRemoteDesktop() {
  const desktopFile = path.resolve(__dirname, '../apps/web/src/components/RemoteDesktop.vue');
  const { descriptor: desktop } = parse(fs.readFileSync(desktopFile, 'utf8'), { filename: desktopFile });
  compileScript(desktop, { id: 'remote-desktop-test' });
  assert.deepEqual(compileTemplate({ filename: desktopFile, id: 'remote-desktop-test', source: desktop.template.content }).errors, []);
  const script = desktop.scriptSetup.content.replace(/^import .*$/gm, '');
  for (const [protocol, websocketProtocol] of [['http:', 'ws'], ['https:', 'wss']]) {
    const props = vue.reactive({ sessionId: 'session /?#中文' });
    const screen = {};
    const clients = [];
    let mounted;
    let unmounted;
    const scope = vue.effectScope();
    const component = scope.run(() => vm.runInNewContext(`${script}\n;({ screen, status, connect })`, {
      ...vue, defineProps: () => props,
      onMounted: (fn) => { mounted = fn; }, onBeforeUnmount: (fn) => { unmounted = fn; },
      location: { protocol, host: 'localhost:5174' },
      RFB: class {
        constructor(target, url, options) {
          this.target = target; this.url = url; this.options = options;
          this.events = {}; this.disconnected = false;
          clients.push(this);
        }
        addEventListener(event, fn) { this.events[event] = fn; }
        disconnect() { this.disconnected = true; }
      },
    }, { filename: desktopFile }));
    const checkConnection = (client, sessionId) => {
      assert.equal(client.target, component.screen.value);
      assert.equal(client.url, `${websocketProtocol}://localhost:5174/api/platform-login/${encodeURIComponent(sessionId)}/vnc`);
      assert.deepEqual(Array.from(client.options.wsProtocols), ['binary']);
    };
    try {
      component.screen.value = screen;
      mounted();
      assert.equal(clients.length, 1);
      checkConnection(clients[0], props.sessionId);
      clients[0].events.connect();
      assert.equal(component.status.value, '已连接');
      clients[0].events.disconnect();
      assert.equal(component.status.value, '已断开');
      component.connect();
      assert.equal(clients.length, 2);
      assert.equal(clients[0].disconnected, true);
      checkConnection(clients[1], props.sessionId);
      props.sessionId = 'another-session';
      await vue.nextTick();
      assert.equal(clients.length, 3);
      assert.equal(clients[1].disconnected, true);
      checkConnection(clients[2], props.sessionId);
    } finally {
      unmounted();
      scope.stop();
    }
    assert.equal(clients[2].disconnected, true);
  }
}

async function testWorkbench() {
  const workbenchFile = path.resolve(__dirname, '../apps/web/src/views/WorkbenchView.vue');
  const { descriptor: workbench } = parse(fs.readFileSync(workbenchFile, 'utf8'), { filename: workbenchFile });
  compileScript(workbench, { id: 'workbench-test' });
  assert.deepEqual(compileTemplate({ filename: workbenchFile, id: 'workbench-test', source: workbench.template.content }).errors, []);
  const icons = workbench.scriptSetup.content.match(/import \{([\s\S]*?)\} from 'lucide-vue-next'/)[1].split(',').map((name) => name.trim()).filter(Boolean);
  const calls = [];
  let status = 'none';
  let required = true;
  const sandbox = { ...vue, ...await import('../apps/web/src/labels.js'), ...Object.fromEntries(icons.map((name) => [name, {}])),
    async observeResultJob() { return ''; }, async downloadJobResults() { return ''; },
    onMounted() {}, onBeforeUnmount() {}, window: { clearTimeout() {} }, defineProps: () => ({ currentUser: { id: 7 }, page: '/' }), defineEmits() {}, defineExpose() {},
    async apiFetch(url) {
      calls.push(url);
      const data = url === '/api/platform-state' ? { ok: true, status }
        : url.startsWith('/api/run/') ? required ? { ok: false, code: 'PLATFORM_LOGIN_REQUIRED', message: '服务端原始提示' } : { ok: true, id: 'job-1', status: 'queued' }
        : url.startsWith('/api/jobs/') ? { ok: true, job: { id: 'job-1', task: 'download', status: 'failed', output: '模拟任务结束' } }
        : { ok: true, workspaceStatus: '等待操作' };
      return { ok: true, async json() { return data; } };
    },
  };
  const script = workbench.scriptSetup.content.replace(/^import[\s\S]*?from '[^']+'\n/gm, '');
  const view = vm.runInNewContext(`${script}\n;({ refreshPlatformState, platformState, runTask, running, notice, platformLoginRequired })`, sandbox, { filename: workbenchFile });
  for (status of ['none', 'valid', 'expired']) {
    await view.refreshPlatformState();
    assert.equal(view.platformState.value.status, status);
  }
  await view.runTask('下载结果');
  assert.equal(view.platformLoginRequired.value, true);
  assert.equal(view.notice.value, '请先完成平台登录');
  assert.equal(view.running.value, '');
  required = false;
  const before = calls.filter((url) => url === '/api/platform-state').length;
  await view.runTask('下载结果');
  await flush();
  assert.equal(view.platformLoginRequired.value, false);
  assert.equal(view.running.value, '');
  assert.equal(calls.filter((url) => url === '/api/platform-state').length, before + 1);
  assert.equal(calls.some((url) => /login-status|login-open|profile-release/.test(url)), false);
}

async function main() {
  const storage = new Map();
  let state = { status: 'none' };
  let current;
  let startError = '';
  let pollError = false;
  let cancelError = '';
  let display = 'local';
  let sequence = 0;
  let getGate;
  let startGate;
  const api = async (url, method) => {
    if (url === '/api/platform-state') return { data: { ok: true, ...state } };
    if (url === '/api/platform-state/clear') { state = { status: 'none' }; return { data: { ok: true } }; }
    if (url === '/api/platform-login') {
      if (startGate) await startGate.promise;
      if (startError) return { status: 409, data: { ok: false, message: startError } };
      current = { id: `session-${++sequence}`, status: 'waiting', display, sites: { ruyi: false, datanexus: false },
        message: '请登录如翼', expiresAt: new Date(Date.now() + 15 * 60000).toISOString() };
      return { data: { ok: true, session: current } };
    }
    if (method === 'DELETE') {
      if (cancelError) return { status: 409, data: { ok: false, message: cancelError } };
      current.status = 'cancelled'; current.message = '平台登录已取消'; return { data: { ok: true } };
    }
    if (getGate) return getGate.promise;
    if (!current) return { status: 404, data: { ok: false, message: '登录会话不存在' } };
    if (pollError) return { status: 503, data: { ok: false, message: '临时无法获取进度' } };
    return { data: { ok: true, session: current } };
  };
  let page = mount({ storage, api });
  let view = page.component;
  await page.start();
  assert.equal(view.summary.value.status, 'none');
  assert.equal(view.restoring.value, false);
  await view.startLogin();
  assert.equal(view.active.value, true);
  assert.equal(view.session.value.display, 'local');
  assert.equal(storage.get('platform-login-session:7'), current.id);
  assert.deepEqual([...page.timeouts.values()].map((timer) => timer.delay), [1500]);
  const countdown = view.countdown.value;
  current.sites.ruyi = true;
  await page.tick(1500);
  assert.equal(view.session.value.sites.ruyi, true);
  assert.equal(view.session.value.sites.datanexus, false);
  assert.notEqual(view.countdown.value, countdown);
  pollError = true;
  await page.tick(1500);
  assert.equal(view.error.value, '临时无法获取进度');
  assert.equal(page.timeouts.size, 1);
  pollError = false;
  await page.tick(1500);
  assert.equal(view.error.value, '');

  page.unmount();
  assert.equal(page.timeouts.size, 0);
  assert.equal(page.intervals.size, 0);
  assert.equal(page.calls.some((call) => call.method === 'DELETE'), false);
  page = mount({ storage, api }); view = page.component;
  await page.start();
  assert.equal(view.session.value.id, current.id);
  assert.equal(view.session.value.sites.ruyi, true);
  cancelError = '会话正在处理，请稍后重试';
  await view.cancelLogin();
  assert.equal(view.error.value, cancelError);
  assert.equal(view.active.value, true);
  cancelError = '';
  await view.cancelLogin();
  assert.equal(view.session.value.status, 'cancelled');
  assert.equal(view.active.value, false);
  assert.equal(storage.has('platform-login-session:7'), false);
  assert.equal(page.timeouts.size, 0);

  startError = '其他用户正在登录，请稍后重试';
  await view.startLogin();
  assert.equal(view.error.value, startError);
  startError = ''; display = 'vnc';
  for (const status of ['failed', 'expired']) {
    await view.startLogin();
    assert.equal(view.session.value.display, 'vnc');
    current.status = status; current.message = `会话结束：${status}`;
    await page.tick(1500);
    assert.equal(view.session.value.status, status);
    assert.equal(view.session.value.message, current.message);
    assert.equal(page.timeouts.size, 0);
    assert.equal(view.active.value, false);
    assert.equal(storage.has('platform-login-session:7'), false);
  }
  await view.startLogin();
  current.status = 'succeeded'; current.sites = { ruyi: true, datanexus: true };
  state = { status: 'valid', capturedAt: '2026-10-19T00:00:00Z', expiresHintAt: new Date(Date.now() + 3 * 3600000).toISOString() };
  await page.tick(1500);
  assert.equal(view.session.value.status, 'succeeded');
  assert.equal(page.location.hash, '#/platform-login');
  await page.tick(2000);
  assert.equal(view.summary.value.status, 'valid');
  assert.equal(page.location.hash, '#/');
  assert.equal(storage.has('platform-login-session:7'), false);
  assert.ok(view.expiryHours.value < 6);
  assert.match(view.expiryLabel.value, /约 3 小时后过期/);
  assert.ok(page.events.includes('state-changed'));
  page.confirm(false);
  await view.clearState();
  assert.equal(state.status, 'valid');
  page.confirm(true);
  await view.clearState();
  assert.equal(page.confirms(), 2);
  assert.equal(view.summary.value.status, 'none');
  assert.equal(page.calls.filter((call) => call.url === '/api/platform-state/clear').length, 1);

  await view.startLogin();
  page.unmount();
  // 其他账号不会恢复当前用户的 ID。
  const otherPage = mount({ storage, userId: 8, api });
  await otherPage.start();
  assert.equal(otherPage.component.session.value, null);
  otherPage.unmount();
  page = mount({ storage, api }); view = page.component;
  current = null;
  await page.start();
  assert.equal(view.error.value, '登录会话不存在');
  assert.equal(view.session.value, null);
  assert.equal(view.active.value, false);
  assert.equal(storage.size, 0);

  // 请求尚未完成时离开页面，返回的 ID 仍应保存，且不能恢复计时器。
  startGate = deferred();
  const starting = view.startLogin();
  page.unmount();
  startGate.resolve();
  await starting; startGate = null;
  assert.equal(storage.get('platform-login-session:7'), current.id);
  assert.equal(page.timeouts.size, 0);

  page = mount({ storage, api }); view = page.component;
  await page.start();
  const pollGate = deferred();
  getGate = pollGate;
  const staleSession = JSON.parse(JSON.stringify(current));
  const polling = page.tick(1500);
  await flush();
  getGate = null;
  await view.cancelLogin();
  assert.equal(view.session.value.status, 'cancelled');
  // 取消前发出的旧响应不能覆盖终态或重建轮询。
  pollGate.resolve({ data: { ok: true, session: staleSession } });
  await polling;
  assert.equal(view.session.value.status, 'cancelled');
  assert.equal(page.timeouts.size, 0);
  await view.startLogin();
  current.status = 'succeeded';
  await page.tick(1500);
  assert.equal(page.timeouts.size, 1);
  page.unmount();
  assert.equal(page.timeouts.size, 0);

  const failingPage = mount({ api: async () => { throw new Error('无法连接服务'); } });
  await failingPage.start();
  assert.equal(failingPage.component.summaryError.value, '无法连接服务');
  assert.equal(failingPage.component.restoring.value, false);
  failingPage.unmount();
  await testRemoteDesktop();
  await testWorkbench();
  await require('./frontend-jobs.test')();
}

main().then(() => console.log('平台登录组件编译、轮询、会话恢复、错误处理及清理测试通过。')).catch((error) => {
  console.error('平台登录前端测试失败：', error);
  process.exitCode = 1;
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const webRequire = createRequire(require.resolve('@ruyi/web/package.json'));
const vue = webRequire('vue');
const { parse, compileScript, compileTemplate } = webRequire('@vue/compiler-sfc');

const filename = path.resolve(__dirname, '../apps/web/src/views/LoginView.vue');
const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename });
compileScript(descriptor, { id: 'registration-test' });
assert.deepEqual(compileTemplate({ filename, id: 'registration-test', source: descriptor.template.content }).errors, []);
const source = descriptor.scriptSetup.content.replace(/^import .*$/gm, '');
const names = ['username', 'displayName', 'password', 'confirmPassword', 'registering', 'busy', 'error', 'success', 'switchMode', 'register', 'login'];

function mount(api) {
  const calls = [];
  const events = [];
  const view = vm.runInNewContext(`${source}\n;({ ${names.join(', ')} })`, {
    ...vue, defineEmits: () => (...args) => events.push(args),
    async requestJson(url, options) {
      const body = JSON.parse(JSON.stringify(options.body));
      calls.push({ url, body });
      return api(url, body);
    },
  }, { filename });
  return { view, calls, events };
}

async function main() {
  let reject = true;
  let release;
  let gate;
  const user = { username: 'new_user', role: 'user', mustChangePassword: true };
  const page = mount(async (url) => {
    if (gate) await gate;
    if (url.endsWith('/login')) return { ok: true, user };
    if (reject) throw new Error('用户名已存在');
    return { ok: true, message: '注册成功，请返回登录' };
  });
  const { view } = page;
  assert.equal(view.registering.value, false);
  view.username.value = 'new_user';
  view.password.value = 'OldPassword';
  view.error.value = '旧错误';
  view.success.value = '旧提示';
  view.switchMode();
  assert.equal(view.registering.value, true);
  assert.equal(view.username.value, 'new_user');
  assert.equal(view.password.value, '');
  assert.equal(view.error.value, '');
  assert.equal(view.success.value, '');
  view.displayName.value = '新用户';
  view.password.value = 'Registration123';
  view.confirmPassword.value = 'WrongPassword';
  await view.register();
  assert.equal(view.error.value, '两次输入的密码不一致');
  assert.equal(page.calls.length, 0);
  assert.equal(view.busy.value, false);
  view.confirmPassword.value = view.password.value;
  await view.register();
  assert.equal(view.error.value, '用户名已存在');
  assert.equal(view.registering.value, true);
  assert.equal(view.busy.value, false);
  assert.equal(view.password.value, 'Registration123');
  assert.equal(page.events.length, 0);
  reject = false;
  gate = new Promise((resolve) => { release = resolve; });
  const pending = view.register();
  assert.equal(view.busy.value, true);
  await view.register();
  view.switchMode();
  await view.login();
  assert.equal(view.registering.value, true);
  assert.equal(page.calls.length, 2, '提交期间禁止重复请求与切换');
  release();
  await pending;
  gate = null;
  assert.deepEqual(page.calls[1], { url: '/api/auth/register', body: { username: 'new_user', displayName: '新用户', password: 'Registration123' } });
  assert.equal(view.registering.value, false);
  assert.equal(view.username.value, 'new_user');
  assert.equal(view.displayName.value, '');
  assert.equal(view.password.value, '');
  assert.equal(view.confirmPassword.value, '');
  assert.equal(view.error.value, '');
  assert.equal(view.success.value, '注册成功，请返回登录');
  assert.equal(view.busy.value, false);
  assert.equal(page.events.length, 0, '注册成功不自动登录');
  view.password.value = 'Registration123';
  await view.login();
  assert.deepEqual(page.events, [['logged-in', user]], '保留登录成功事件和首次改密标记');
  assert.equal(view.password.value, '');
  assert.equal(view.success.value, '');
  view.switchMode();
  view.password.value = 'ClearMe123';
  view.confirmPassword.value = 'ClearMe123';
  view.switchMode();
  assert.equal(view.password.value, '');
  assert.equal(view.confirmPassword.value, '');
  assert.equal((await import('../apps/web/src/labels.js')).actionLabels['auth.register'], '注册账号');
  console.log('注册前端组件切换、校验、失败重试、提交防重复和成功清理测试通过。');
}
main().catch((error) => { console.error('注册前端组件测试失败：', error); process.exitCode = 1; });

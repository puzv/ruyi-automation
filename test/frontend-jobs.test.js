const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const webRequire = createRequire(require.resolve('@ruyi/web/package.json'));
const vue = webRequire('vue');
const { parse, compileScript, compileTemplate } = webRequire('@vue/compiler-sfc');

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function readComponent(relative) {
  const filename = path.resolve(__dirname, '../apps/web/src', relative);
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename });
  compileScript(descriptor, { id: 'jobs-test' });
  assert.deepEqual(compileTemplate({ filename, id: 'jobs-test', source: descriptor.template.content }).errors, []);
  return { filename, descriptor };
}

function mount(relative, labels, names, api, props = {}) {
  const { filename, descriptor } = readComponent(relative);
  const mounted = [], unmounted = [], timers = new Map(), calls = [];
  let serial = 0, confirmResult = true, confirms = 0;
  let time = new Date('2026-10-20T00:02:05Z').getTime();
  const apiFetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ url, method });
    const result = await api(url, method, options);
    const data = JSON.parse(JSON.stringify(result.data ?? result));
    return { ok: (result.httpStatus || 200) < 400, async json() { return data; }, async text() { return result.text || ''; } };
  };
  const icons = descriptor.scriptSetup.content.match(/import \{([\s\S]*?)\} from 'lucide-vue-next'/)?.[1].split(',').map((name) => name.trim()).filter(Boolean) || [];
  const sandbox = {
    ...vue, ...labels, ...Object.fromEntries(icons.map((name) => [name, {}])), URLSearchParams, AbortController,
    document: { activeElement: { focus() {} } },
    Date: class extends Date { static now() { return time; } },
    onMounted(fn) { mounted.push(fn); }, onBeforeUnmount(fn) { unmounted.push(fn); },
    defineProps: () => ({ currentUser: { id: 7 }, page: '/', ...props }), defineEmits() {}, defineExpose() {},
    location: { hash: '#/' },
    window: {
      setTimeout(fn, delay) { const id = ++serial; timers.set(id, { fn, delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
      confirm() { confirms++; return confirmResult; },
    }, apiFetch,
    async observeResultJob() { return ''; }, async downloadJobResults(job) { calls.push({ url: `/api/jobs/${job.id}/results`, method: 'DOWNLOAD' }); return '已发起 ZIP 下载'; }, resetResultDownloads() {},
    async requestJson(url, options) {
      const response = await apiFetch(url, options);
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.message || '请求失败');
      return data;
    },
  };
  const source = descriptor.scriptSetup.content.replace(/^import[\s\S]*?from '[^']+'\n/gm, '');
  const view = vm.runInNewContext(`${source}\n;({ ${names.join(', ')} })`, sandbox, { filename });
  // 自动推进面板每 15 秒刷新一次状态，与任务轮询计时器分开统计。
  const jobTimers = () => [...timers.entries()].filter(([, timer]) => timer.delay !== 15000);
  return {
    view, calls, timers, sandbox, jobTimers,
    async start() { await Promise.all(mounted.map((fn) => fn())); await flush(); },
    unmount() { unmounted.forEach((fn) => fn()); },
    confirm(value) { confirmResult = value; }, confirms: () => confirms,
    async tick(delay) {
      time += delay;
      const pending = [...timers.entries()].filter(([, timer]) => timer.delay === delay);
      for (const [id, timer] of pending) { timers.delete(id); await timer.fn(); }
      await flush();
    },
  };
}
const fallback = { ok: true, status: 'valid' };

async function testTaskPanel(labels) {
  const names = ['items', 'page', 'pages', 'files', 'jobs', 'filters', 'form', 'showCreate', 'platformStatus', 'error', 'notice', 'busy', 'expanded', 'load', 'toggleTask', 'openCreate', 'chooseFiles', 'chooseFolder', 'selectedSummary', 'createTask', 'removeFile', 'removeTask', 'resume', 'continueTask', 'download', 'stepStatus', 'statusLabel', 'presentJob'];
  let status = 'queued', platform = 'valid', fail = false, createError = false;
  const bodies = [];
  const task = () => ({ id: 'task-1', name: '测试任务', status, currentStep: 'upload', version: 3 });
  const file = { id: 'file-1', originalName: '测试oaid.txt', excludedAt: null, sizeBytes: 5 };
  const records = [{ id: 'job-1', task: 'upload', status: 'running' }];
  const handler = async (url, method, options) => {
    if (fail) throw new Error('列表暂不可用');
    if (url === '/api/platform-state') return { ok: true, status: platform };
    if (method === 'DELETE') { assert.equal(options.body.version, 3); return { ok: true, status: status === 'running' ? 'cancelling' : 'deleted' }; }
    if (method === 'POST') {
      if (url.endsWith('/stop')) { assert.equal(options.body.version, 3); return { ok: true, status: 'cancelling' }; }
      if (url.endsWith('/continue')) assert.equal(options.body.version, 3);
      if (url === '/api/tasks') {
        bodies.push(options.body);
        if (createError) return { httpStatus: 409, data: { ok: false, message: '任务创建失败，请重试' } };
      }
      return { ok: true };
    }
    if (url.endsWith('/files')) return { ok: true, items: [file] };
    if (url.endsWith('/task-1')) return { ok: true, item: task(), jobs: records };
    return { ok: true, items: [task()], total: 41, page: Number(new URL(url, 'http://local').searchParams.get('page')) };
  };
  const page = mount('components/JobsTable.vue', { ...labels, FormData, File }, names, handler);
  await page.start();
  assert.equal(page.calls[0].url, '/api/tasks?page=1&pageSize=20');
  assert.equal(page.view.pages.value, 3);
  assert.equal(page.view.jobs['task-1'].length, 1);
  assert.equal(page.view.presentJob({ status: 'waiting_platform', message: '新API等待' }).message, '新API等待');
  assert.equal(page.view.presentJob({ status: 'failed', errorMessage: '任务未就绪，稍后可重试：平台计算中' }).status, 'waiting_platform');
  assert.equal(page.view.presentJob({ status: 'failed', errorMessage: '任务未就绪，稍后可重试', outcome: 'failure' }).status, 'failed');
  assert.equal(page.view.presentJob({ status: 'failed', errorMessage: '任务未就绪，稍后可重试', exitCode: 2, exitSignal: null }).status, 'failed', '显式新协议失败不以旧前缀改写');
  assert.equal(page.view.presentJob({ status: 'failed', errorMessage: '普通任务未就绪错误' }).status, 'failed');
  records.push({ id: 'waiting-record', task: 'analyse', status: 'waiting_platform', outcome: 'not_ready', errorMessage: null });
  await page.view.load(1);
  assert.equal(page.view.jobs['task-1'][1].status, 'waiting_platform');
  assert.equal(page.view.statusLabel('waiting_platform'), '等待平台处理');
  assert.equal(page.view.stepStatus({ ...task(), status: 'running', currentStep: 'analyse' }, 'analyse'), 'running');
  records.pop();
  await page.view.load(1);
  assert.equal(page.view.files['task-1'], undefined, '文件清单按需加载');
  await page.view.toggleTask(task());
  assert.equal(page.view.expanded['task-1'], true);
  assert.equal(page.view.files['task-1'][0].originalName, file.originalName);
  assert.equal(page.view.statusLabel('pending'), '未开始');
  assert.equal(page.view.stepStatus(task(), 'upload'), 'running');
  assert.equal(page.view.stepStatus(task(), 'analyse'), 'pending');
  records[0].status = 'failed'; status = 'running';
  await page.view.load(1);
  assert.equal(page.view.stepStatus(task(), 'upload'), 'running', '平台未就绪的非零退出不应把正在推进的步骤显示为失败');
  records[0].status = 'running'; status = 'queued';
  await page.view.load(2); assert.equal(page.view.page.value, 2);
  page.confirm(false); await page.view.removeFile(task(), file);
  assert.equal(page.calls.some((call) => call.method === 'DELETE'), false);
  page.confirm(true); await page.view.removeFile(task(), file);
  assert.ok(page.calls.some((call) => call.url === '/api/tasks/task-1/files/file-1' && call.method === 'DELETE'));
  status = 'running'; await page.view.removeTask(task());
  assert.ok(page.calls.some((call) => call.url === '/api/tasks/task-1/stop' && call.method === 'POST'), '停止使用独立接口');
  assert.equal(page.calls.some((call) => call.url === '/api/tasks/task-1' && call.method === 'DELETE'), false, '运行中停止不发送删除请求');
  assert.equal(page.view.notice.value, '停止请求已提交，完成后可继续任务');
  const before = page.calls.length;
  await page.view.removeFile(task(), file);
  assert.equal(page.calls.length, before, '运行中任务禁止删除文件');
  platform = 'none'; await page.view.openCreate();
  page.view.chooseFiles({ target: { files: [new File(['x'], '测试oaid.txt')] } });
  await page.view.createTask();
  assert.ok(page.view.error.value.includes('平台登录'));
  assert.equal(page.calls.some((call) => call.url === '/api/tasks' && call.method === 'POST'), false);
  const folderFile = (name, relative) => {
    const file = new File(['x'], name);
    Object.defineProperty(file, 'webkitRelativePath', { value: relative });
    return file;
  };
  const eventFor = (files) => ({ target: { files, value: 'folder-selection' } });
  const folderSelection = eventFor([
    folderFile('样本oaid.txt', '批次/子目录/样本oaid.txt'),
    folderFile('.隐藏pn.txt', '批次/.隐藏pn.txt'),
    folderFile('样本pn.csv', '批次/.缓存/样本pn.csv'),
    folderFile('说明.md', '批次/说明.md'),
  ]);
  page.view.chooseFolder(folderSelection);
  assert.equal(page.view.form.files.length, 1); assert.equal(page.view.selectedSummary.value.skipped, 3);
  assert.equal(folderSelection.target.value, '', '重置输入便于再次选择同一文件夹');
  page.view.chooseFolder(eventFor([]));
  assert.equal(page.view.form.files.length, 1, '取消选择保留原清单');
  page.view.chooseFolder(eventFor([folderFile('a_oaid.txt', '批次/a/a_oaid.txt'), folderFile('a_oaid.txt', '批次/b/a_oaid.txt')]));
  assert.ok(page.view.selectedSummary.value.error.includes('重名'));
  const countBeforeInvalid = page.calls.length;
  await page.view.createTask(); assert.equal(page.calls.length, countBeforeInvalid, '文件夹重名在提交前阻断');
  page.view.chooseFolder(eventFor([folderFile('é_oaid.txt', '批次/a/é_oaid.txt'), folderFile('é_oaid.txt', '批次/b/é_oaid.txt')]));
  assert.ok(page.view.selectedSummary.value.error.includes('重名'), 'NFC等价文件名也阻断');
  page.view.chooseFolder(eventFor([folderFile('oaid.txt', '批次/oaid.txt'), folderFile('oaid.csv', '批次/oaid.csv')]));
  assert.ok(page.view.selectedSummary.value.error.includes('主名称'), '不同扩展名的结果重名也阻断');
  page.view.chooseFolder(eventFor([folderFile('说明.md', '批次/说明.md')]));
  assert.ok(page.view.selectedSummary.value.error.includes('没有可导入'));
  const zeroCalls = page.calls.length; await page.view.createTask(); assert.equal(page.calls.length, zeroCalls);
  page.view.chooseFolder(eventFor(Array.from({ length: 1001 }, (_, i) => ({ name: `oaid_${i}.txt`, size: 1 }))));
  assert.ok(page.view.selectedSummary.value.error.includes('1000'));
  page.view.chooseFolder(eventFor([{ name: 'oaid_large.txt', size: 1024 * 1024 * 1024 + 1 }]));
  assert.ok(page.view.selectedSummary.value.error.includes('1GB'));
  page.view.chooseFolder(eventFor([folderFile('样本oaid.txt', '批次/子目录/样本oaid.txt')]));
  platform = 'valid'; createError = true; page.view.form.name = ' 自定义任务 ';
  await page.view.createTask();
  assert.ok(page.view.error.value.includes('创建失败')); assert.equal(page.view.form.files.length, 1, '失败保留所选文件便于重试');
  createError = false; await page.view.createTask();
  assert.equal(bodies.at(-1).get('name'), '自定义任务');
  assert.equal(bodies.at(-1).getAll('files')[0].name, '样本oaid.txt', '任务上传仅传原始basename，不把目录当作文件名');
  assert.ok(page.calls.some((call) => call.url === '/api/tasks' && call.method === 'POST'));
  assert.equal(page.view.form.files.length, 0); assert.equal(page.view.showCreate.value, false);
  status = 'waiting_login'; await page.view.resume(task());
  assert.ok(page.calls.some((call) => call.url === '/api/tasks/task-1/resume'));
  status = 'interrupted'; platform = 'none'; await page.view.continueTask(task());
  assert.ok(page.view.error.value.includes('平台登录'));
  assert.equal(page.calls.some((call) => call.url.endsWith('/continue')), false);
  platform = 'valid'; page.confirm(false); await page.view.continueTask(task());
  assert.equal(page.calls.some((call) => call.url.endsWith('/continue')), false);
  page.confirm(true); await page.view.continueTask(task());
  assert.ok(page.calls.some((call) => call.url === '/api/tasks/task-1/continue' && call.method === 'POST'));
  const continued = page.calls.length;
  status = 'running'; await page.view.continueTask(task());
  assert.equal(page.calls.length, continued, '非中断任务不能继续');
  status = 'waiting_login';
  const deletionCount = page.calls.filter((call) => call.method === 'DELETE').length;
  await page.view.removeFile({ ...task(), startedAt: '2026-11-10T00:00:00Z' }, file);
  assert.equal(page.calls.filter((call) => call.method === 'DELETE').length, deletionCount + 1, '等待登录任务即使已启动也允许删除后续文件');
  status = 'succeeded'; records.push({ id: 'download-1', task: 'download', status: 'succeeded' });
  await page.view.load(1); await page.view.download(task());
  assert.ok(page.calls.some((call) => call.url === '/api/jobs/download-1/results' && call.method === 'DOWNLOAD'));
  fail = true; await page.tick(5000);
  assert.equal(page.view.error.value, '列表暂不可用'); assert.equal(page.timers.size, 1, '失败后仍可自动刷新');
  page.unmount(); assert.equal(page.timers.size, 0);

  const admin = mount('components/JobsTable.vue', labels, names, handler, { admin: true });
  fail = false; await admin.start();
  admin.view.filters.username = '用户甲'; admin.view.filters.status = 'waiting_login';
  await admin.view.load(1, true);
  const url = admin.calls.findLast((call) => call.url.includes('?')).url;
  assert.ok(url.startsWith('/api/admin/tasks?')); assert.ok(url.includes('waiting_login'));
  const count = admin.calls.length;
  await admin.view.removeTask(task()); await admin.view.resume(task()); await admin.view.continueTask({ ...task(), status: 'interrupted' }); await admin.view.createTask(); await admin.view.download(task());
  assert.equal(admin.calls.length, count, '管理员页面只读，不发起用户任务写操作');
  admin.unmount();

  const auditRows = [1, 2].map((id) => ({ id, userId: 1, action: 'job.finish', result: 'success', detail: { taskId: 'task-1', task: 'analyse', status: 'waiting_login', outcome: 'login_required' } }));
  const audit = mount('components/LogTable.vue', labels, ['groups', 'expanded', 'resultLabel', 'resultTone'], () => ({}), { items: auditRows });
  assert.equal(audit.view.groups.value.length, 1);
  assert.equal(audit.view.groups.value[0].records.length, 2);
  assert.equal(audit.view.resultLabel(auditRows[0]), '等待登录');
  assert.equal(audit.view.resultTone(auditRows[0]), 'job-status-queued');
  audit.view.expanded[audit.view.groups.value[0].id] = true;
  assert.equal(audit.view.expanded[1], true);
  assert.equal(audit.view.resultLabel({ result: 'failure' }), '失败');

  const gate = deferred();
  const late = mount('components/JobsTable.vue', labels, names, () => gate.promise);
  const pending = late.view.load(); late.unmount();
  gate.resolve({ ok: true, items: [task()], total: 1, page: 1 }); await pending;
  assert.equal(late.view.items.value.length, 0); assert.equal(late.timers.size, 0);
}

function labelsForShell() { return { formatTime: () => '时间' }; }

async function main() {
  await require('./frontend-wait-records.test')();
  await testLogDialog();
  const workbenchTemplate = readComponent('views/WorkbenchView.vue').descriptor.template.content;
  assert.ok(workbenchTemplate.includes('class="login-status"'), '保留上方平台登录状态入口');
  const navigation = workbenchTemplate.match(/<nav class="side-nav"[\s\S]*?<\/nav>/)[0];
  assert.ok(!navigation.includes('href="#/platform-login"'), '导航中不再重复展示平台登录入口');
  assert.ok(!workbenchTemplate.includes('WORKSPACE SNAPSHOT'), '不再显示当前状态模块');
  assert.ok(!workbenchTemplate.includes('queue-panel'), '不再显示队列统计卡片');
  assert.ok(!navigation.includes('操作面板'), '操作面板入口下线');
  const shell = mount('views/WorkbenchView.vue', labelsForShell(), ['refreshPlatformState', 'platformState'], () => ({ ok: true, status: 'valid' }));
  await shell.start();
  assert.equal(shell.calls.length, 1);
  assert.equal(shell.calls[0].url, '/api/platform-state');
  assert.equal(shell.timers.size, 0, '布局不启动旧工作流轮询');
  shell.unmount();
  const labels = { ...await import('../apps/web/src/labels.js'), ...await import('../apps/web/src/wait-records.js') };
  assert.deepEqual({ ...labels.taskLabels }, { upload: '上传文件', create: '创建人群', analyse: '人群洞悉', download: '下载结果' });
  assert.deepEqual({ ...labels.jobStatusLabels }, { queued: '排队中', running: '运行中', succeeded: '成功', failed: '失败', cancelled: '已取消', interrupted: '已中断' });
  for (const [status, message] of Object.entries({
    running: '上传文件运行中...', succeeded: '上传文件已完成', failed: '上传文件执行失败：请查看日志',
    cancelled: '上传文件已取消', interrupted: '上传文件因服务重启中断，请重新运行',
  })) assert.equal(labels.jobNotice({ task: 'upload', status }), message);
  assert.equal(labels.jobNotice({ task: 'create', status: 'failed', errorMessage: '模拟失败' }), '创建人群执行失败：模拟失败');
  for (const position of [0, 1]) assert.equal(labels.jobNotice({ task: 'upload', status: 'queued', position }), '上传文件即将开始');
  assert.equal(labels.jobDuration({ status: 'queued' }), '—');
  assert.equal(labels.jobDuration({ status: 'failed', startedAt: '无效时间' }), '—');
  assert.equal(labels.jobDuration({ startedAt: '2026-10-20T00:00:00Z', finishedAt: '2026-10-20T00:01:09Z' }), '1 分 9 秒');
  await testTaskPanel(labels);
  for (const relative of ['views/MyJobsView.vue', 'views/AdminJobsView.vue']) readComponent(relative);
  const app = mount('App.vue', labels, ['currentUser', 'page', 'syncPage'], () => fallback);
  app.view.currentUser.value = { role: 'user' };
  app.sandbox.location.hash = '#/jobs'; app.view.syncPage();
  assert.equal(app.view.page.value, '/jobs');
  app.sandbox.location.hash = '#/admin/jobs'; app.view.syncPage();
  assert.equal(app.view.page.value, '/');
  app.view.currentUser.value = { role: 'admin' };
  app.sandbox.location.hash = '#/admin/jobs'; app.view.syncPage();
  assert.equal(app.view.page.value, '/admin/jobs');
  console.log('任务前端编译、状态文案、队列恢复、取消、分页筛选与路由权限测试通过。');
}
async function testLogDialog() {
  const names = ['loadLog', 'output', 'error', 'loading', 'query', 'lines', 'matches', 'visibleLines', 'logUrl', 'lineTone'];
  let result = { text: '开始处理\nWARN 正在重试\nERROR 任务失败\n<script>不应执行</script>' };
  const page = mount('components/JobLogDialog.vue', {}, names, () => result, { job: { id: 'job/a', task: 'upload' } });
  await page.start();
  assert.equal(page.calls[0].url, '/api/jobs/job%2Fa/log');
  assert.equal(page.view.lines.value.length, 4);
  page.view.query.value = 'error';
  assert.equal(page.view.matches.value.length, 1);
  assert.equal(page.view.visibleLines.value[0].number, 3);
  assert.equal(page.view.lineTone('ERROR 任务失败'), 'log-line-error');
  assert.equal(page.view.lineTone('WARN 重试'), 'log-line-warning');
  page.view.query.value = '找不到';
  assert.equal(page.view.visibleLines.value.length, 0);
  page.view.query.value = '';
  result = { text: Array.from({ length: 2500 }, (_, i) => `第 ${i} 行`).join('\n') };
  await page.view.loadLog();
  assert.equal(page.view.visibleLines.value.length, 2000);
  assert.equal(page.view.visibleLines.value[0].number, 501);
  result = { httpStatus: 403, message: '无权查看日志' };
  await page.view.loadLog();
  assert.equal(page.view.error.value, '无权查看日志');
  assert.equal(page.view.loading.value, false);
  result = { text: '' };
  await page.view.loadLog();
  assert.equal(page.view.error.value, '');
  assert.equal(page.view.lines.value.length, 0);
  page.unmount();
  const adminLog = mount('components/JobLogDialog.vue', {}, names, () => ({ text: '管理员可见日志' }), { job: { id: 'other-job' }, admin: true });
  await adminLog.start();
  assert.equal(adminLog.calls[0].url, '/api/admin/jobs/other-job/log');
  adminLog.unmount();
  const gate = deferred();
  const late = mount('components/JobLogDialog.vue', {}, names, () => gate.promise, { job: { id: 'late' } });
  const pending = late.view.loadLog(); late.unmount();
  gate.resolve({ text: '不应在关闭后更新' }); await pending;
  assert.equal(late.view.output.value, '');
  const template = readComponent('components/JobLogDialog.vue').descriptor.template.content;
  assert.ok(!template.includes('v-html'), '日志仅作为文本展示');
  assert.ok(template.includes('@close="emit(\'close\')"'), '原生对话框支持 Escape 关闭');
  assert.ok(readComponent('components/JobsTable.vue').descriptor.template.content.includes('@click="logJob = item"'));
}
module.exports = main;
if (require.main === module) main().catch((error) => { console.error('任务前端测试失败：', error); process.exitCode = 1; });

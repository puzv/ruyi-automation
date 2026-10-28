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
    return { ok: (result.httpStatus || 200) < 400, async json() { return data; } };
  };
  const icons = descriptor.scriptSetup.content.match(/import \{([\s\S]*?)\} from 'lucide-vue-next'/)?.[1].split(',').map((name) => name.trim()).filter(Boolean) || [];
  const sandbox = {
    ...vue, ...labels, ...Object.fromEntries(icons.map((name) => [name, {}])), URLSearchParams,
    Date: class extends Date { static now() { return time; } },
    onMounted(fn) { mounted.push(fn); }, onBeforeUnmount(fn) { unmounted.push(fn); },
    defineProps: () => ({ currentUser: { id: 7 }, page: '/', ...props }), defineEmits() {}, defineExpose() {},
    location: { hash: '#/' },
    window: {
      setTimeout(fn, delay) { const id = ++serial; timers.set(id, { fn, delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
      confirm() { confirms++; return confirmResult; },
    }, apiFetch,
    async observeResultJob() { return ''; }, async downloadJobResults() { return '已发起 ZIP 下载'; }, resetResultDownloads() {},
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
// 统一上传入口：文件与文件夹两种选择方式共用导入流程，只有导入出有效文件才提交上传任务。
async function testUnifiedUpload(labels) {
  const uploadNames = ['handleUploadSelection', 'toggleUploadPicker', 'closeUploadPicker', 'uploadPickerOpen', 'importing', 'notice', 'submitting', 'runTask'];
  const uploadCalls = (page, url) => page.calls.filter((call) => call.url === url && call.method === 'POST');
  const runCalls = (page) => uploadCalls(page, '/api/run/upload');
  const importCalls = (page) => uploadCalls(page, '/api/import-folder');
  const makeFile = (name, relative = '') => {
    const file = new File(['数据'], name, { type: 'text/plain' });
    if (relative) Object.defineProperty(file, 'webkitRelativePath', { value: relative });
    return file;
  };
  const eventFor = (files) => ({ target: { files, value: 'fake-selection' } });
  const mountUpload = (importResult, { runError = null } = {}) => {
    const bodies = [];
    const page = mount('views/WorkbenchView.vue', { ...labels, FormData, File }, uploadNames, async (url, method, options = {}) => {
      if (url === '/api/import-folder') {
        bodies.push(options.body);
        if (importResult instanceof Error) throw importResult;
        return importResult;
      }
      if (url === '/api/run/upload') {
        if (runError) return { httpStatus: 409, data: { ok: false, message: runError } };
        return { ok: true, id: 'upload-1', status: 'queued', position: 0 };
      }
      if (url === '/api/jobs/upload-1') return { ok: true, job: { id: 'upload-1', task: 'upload', status: 'queued', position: 0, output: '' } };
      return fallback;
    }, { currentUser: { id: 7 } });
    return { page, bodies };
  };

  // 文件选择：多文件导入成功后只提交一次上传任务，且表单内只包含可用文件。
  {
    const { page, bodies } = await mountUpload({ ok: true, count: 2, skipped: 1 });
    await page.start();
    const { view } = page;
    view.toggleUploadPicker();
    assert.equal(view.uploadPickerOpen.value, true);
    await view.handleUploadSelection(eventFor([makeFile('idfa-a.txt'), makeFile('pn-b.csv'), makeFile('readme.md')]));
    assert.equal(importCalls(page).length, 1);
    const names = bodies[0].getAll('files').map((file) => file.name);
    assert.deepEqual(names, ['idfa-a.txt', 'pn-b.csv']);
    assert.equal(runCalls(page).length, 1);
    assert.equal(view.uploadPickerOpen.value, false);
    assert.equal(view.notice.value, '上传文件即将开始');
    page.unmount();
  }

  // 文件夹选择复用同一流程，保留 webkitRelativePath 作为上传表单中的路径。
  {
    const { page, bodies } = await mountUpload({ ok: true, count: 1, skipped: 0 });
    await page.start();
    await page.view.handleUploadSelection(eventFor([makeFile('oaid.txt', '批次一/oaid.txt')]));
    assert.equal(bodies[0].getAll('files')[0].name, '批次一/oaid.txt');
    assert.equal(runCalls(page).length, 1);
    page.unmount();
  }

  // 取消（空选择）、无有效文件、导入失败、导入数量为零、网络异常：均不提交上传任务。
  const rejected = [
    ['取消选择', { ok: true, count: 0 }, [], '未选择文件'],
    ['无有效文件', { ok: true, count: 0 }, [makeFile('readme.md'), makeFile('notes.txt')], '未找到符合条件的文件'],
    ['导入失败', { ok: false, message: '文件已存在，不会覆盖：idfa.txt' }, [makeFile('idfa.txt')], '导入失败：文件已存在'],
    ['导入数量为零', { ok: true, count: 0, skipped: 1 }, [makeFile('idfa.txt')], '没有新增文件'],
    ['网络异常', new Error('无法连接服务'), [makeFile('idfa.txt')], '导入失败：无法连接服务'],
  ];
  for (const [name, importResult, files, message] of rejected) {
    const { page } = await mountUpload(importResult);
    await page.start();
    await page.view.handleUploadSelection(eventFor(files));
    assert.equal(runCalls(page).length, 0, `${name}不应提交上传任务`);
    assert.match(page.view.notice.value, new RegExp(message), name);
    assert.equal(page.view.importing.value, false, `${name}结束后应恢复按钮`);
    assert.equal(page.view.uploadPickerOpen.value, false, `${name}结束后应收起选择面板`);
    page.unmount();
  }

  // 导入成功但上传任务被拒绝时，导入结果保留并展示任务错误；不重复导入。
  {
    const { page } = await mountUpload({ ok: true, count: 1, skipped: 0 }, { runError: '当前用户有任务正在运行' });
    await page.start();
    await page.view.handleUploadSelection(eventFor([makeFile('idfa.txt')]));
    assert.equal(importCalls(page).length, 1);
    assert.equal(runCalls(page).length, 1);
    assert.equal(page.view.notice.value, '当前用户有任务正在运行');
    page.unmount();
  }

  // 选择面板：导入中不能切换，避免同一批文件被重复提交。
  {
    const { page } = await mountUpload({ ok: true, count: 1, skipped: 0 });
    await page.start();
    page.view.importing.value = true;
    page.view.toggleUploadPicker();
    assert.equal(page.view.uploadPickerOpen.value, false);
    page.view.importing.value = false;
    page.view.toggleUploadPicker();
    page.view.closeUploadPicker();
    assert.equal(page.view.uploadPickerOpen.value, false);
    page.unmount();
  }
}

const workbenchNames = ['runTask', 'restoreActiveJob', 'pollJob', 'cancelJob', 'currentJob', 'jobs', 'jobId', 'notice', 'jobLog', 'running', 'submitting', 'platformLoginRequired'];
const tableNames = ['load', 'cancelJob', 'items', 'page', 'pages', 'total', 'filters', 'loading', 'error', 'now'];
const fallback = { ok: true, workspaceStatus: '等待操作', status: 'valid', headless: true };

async function testAutoProgress(labels) {
  const page = mount('views/WorkbenchView.vue', labels,
    ['autoAdvance', 'autoProgress', 'statusCounts'], () => fallback);
  const { autoAdvance, autoProgress, statusCounts } = page.view;
  statusCounts.value = { createCount: 1, analyseCount: 2, doneCount: 3 };
  const phases = {
    idle: [0, 'idle', 0], waitingFiles: [1, 'waiting', 0], readyCreate: [1, 'submitting', 1],
    waitingAudience: [2, 'waiting', 1], readyAnalyse: [2, 'submitting', 2],
    waitingResults: [3, 'waiting', 2], resultsReady: [3, 'done', 3],
    stalled: [1, 'blocked', 0], error: [1, 'blocked', 0], loginRequired: [1, 'blocked', 0], paused: [1, 'paused', 0],
  };
  for (const [phase, [step, mode, completedSteps]] of Object.entries(phases)) {
    autoAdvance.value = { phase, pending: {} };
    assert.equal(autoProgress.value.step, step, phase);
    assert.equal(autoProgress.value.mode, mode, phase);
    assert.equal(autoProgress.value.completedSteps, completedSteps, phase);
    assert.equal(autoProgress.value.pendingText, '', phase);
  }
  for (const phase of ['stalled', 'error', 'loginRequired', 'paused']) {
    autoAdvance.value = { phase, pending: {} };
    for (const [counts, step] of [
      [{ createCount: 0, analyseCount: 2, doneCount: 3 }, 2],
      [{ createCount: 0, analyseCount: 0, doneCount: 3 }, 3],
      [{ createCount: 0, analyseCount: 0, doneCount: 0 }, 0],
    ]) {
      statusCounts.value = counts;
      assert.equal(autoProgress.value.step, step, `${phase} 工作区推导`);
    }
  }
  for (const [phase, key, text] of [
    ['waitingFiles', 'files', '剩余 3 个文件'],
    ['waitingAudience', 'audiences', '剩余 3 个人群包'],
    ['waitingResults', 'results', '剩余 3 个洞悉结果'],
  ]) {
    autoAdvance.value = { phase, pending: { [key]: 3 } };
    assert.equal(autoProgress.value.pendingText, text);
    autoAdvance.value = { phase, pending: {} };
    assert.equal(autoProgress.value.pendingText, '');
    autoAdvance.value = { phase };
    assert.equal(autoProgress.value.pendingText, '');
    autoAdvance.value = { phase, pending: { [key]: 0 } };
    assert.equal(autoProgress.value.pendingText, '');
  }
  autoAdvance.value = { phase: 'readyCreate', pending: { files: 0 } };
  assert.equal(autoProgress.value.pendingText, '');
  autoAdvance.value = { phase: 'resultsReady', pending: { results: 0 } };
  assert.equal(autoProgress.value.pendingText, '');
  assert.equal(page.timers.size, 0, '进度动画不能新增 JS 计时器');
  assert.match(fs.readFileSync(path.resolve(__dirname, '../apps/web/src/style.css'), 'utf8'), /prefers-reduced-motion/);
  page.unmount();
}

async function testWorkbench(labels) {
  let job = { id: 'restore-1', task: 'upload', status: 'queued', position: 4, output: '排队日志' };
  let pollError = false;
  const page = mount('views/WorkbenchView.vue', labels, workbenchNames, async (url, method) => {
    if (url === '/api/jobs/active') return { ok: true, job };
    if (method === 'POST') {
      job = { ...job, status: 'cancelled' }; return { ok: true, result: 'cancelled' };
    }
    if (url === '/api/jobs/restore-1') {
      if (pollError) throw new Error('网络暂不可用');
      return { ok: true, job };
    }
    return fallback;
  });
  await page.start();
  const view = page.view;
  assert.equal(view.jobId.value, 'restore-1');
  assert.equal(view.notice.value, '上传文件排队中，前面还有 3 个任务');
  assert.equal(view.jobLog.value, '排队日志');
  assert.equal(page.jobTimers()[0][1].delay, 1000);
  pollError = true;
  await page.tick(1000);
  assert.match(view.notice.value, /网络暂不可用/);
  assert.equal(page.jobTimers().length, 1);
  pollError = false;
  job.position = 0;
  await page.tick(1000);
  assert.equal(view.notice.value, '上传文件即将开始');
  page.confirm(false);
  await view.cancelJob();
  assert.equal(page.calls.some((call) => call.method === 'POST'), false);
  page.confirm(true);
  await view.cancelJob();
  assert.equal(page.confirms(), 2);
  assert.equal(view.notice.value, '上传文件已取消');
  assert.equal(page.jobTimers().length, 0);
  assert.equal(page.calls.filter((call) => call.url.endsWith('/cancel')).length, 1);
  page.unmount();

  // 每个按钮只在提交请求中禁用；其他任务及同类后续任务都可排队。
  const gate = deferred();
  let serial = 0, submitError = '';
  const queuePage = mount('views/WorkbenchView.vue', labels, workbenchNames, async (url, method) => {
    if (url.startsWith('/api/run/')) {
      if (url.endsWith('/upload')) await gate.promise;
      if (submitError) return { httpStatus: 409, data: { ok: false, code: 'user_limit', message: submitError } };
      return { ok: true, id: `job-${++serial}`, status: 'queued', position: 2 };
    }
    if (url === '/api/jobs/active') return { ok: true, job: null };
    if (url.startsWith('/api/jobs/') && method === 'GET') return { ok: true, job: { id: url.split('/').pop(), task: 'create', status: 'queued', position: 2, output: '日志' } };
    return fallback;
  });
  const q = queuePage.view;
  const first = q.runTask('上传文件');
  await q.runTask('上传文件');
  assert.equal(queuePage.calls.filter((call) => call.url === '/api/run/upload').length, 1);
  assert.equal(q.submitting.value.upload, true);
  await q.runTask('创建人群');
  assert.equal(q.jobs.value.length, 1);
  gate.resolve(); await first; await flush();
  assert.equal(q.submitting.value.upload, false);
  assert.equal(q.jobs.value.length, 2);
  await q.runTask('创建人群'); await flush();
  assert.equal(q.jobs.value.length, 3);
  assert.equal(queuePage.timers.size, 3);
  submitError = '排队任务过多，请等待已有任务完成';
  await q.runTask('人群洞悉');
  assert.equal(q.notice.value, submitError);
  assert.equal(q.submitting.value.analyse, false);
  await queuePage.tick(1000);
  assert.equal(q.notice.value, submitError, '后台轮询不能覆盖提交失败的服务端提示');
  queuePage.unmount();
  assert.equal(queuePage.timers.size, 0);

  // 取消前发出的旧轮询不得覆盖“正在停止”，离开页面后也不能重建计时器。
  const stale = deferred();
  let held = false;
  let runningJob = { id: 'running-1', task: 'download', status: 'running', output: '运行日志' };
  const race = mount('views/WorkbenchView.vue', labels, workbenchNames, async (url, method) => {
    if (url === '/api/jobs/active') return { ok: true, job: runningJob };
    if (method === 'POST') { runningJob = { ...runningJob, cancelRequested: true }; return { ok: true, result: 'cancelling' }; }
    if (url === '/api/jobs/running-1') {
      if (held) { held = false; return stale.promise; }
      return { ok: true, job: runningJob };
    }
    return fallback;
  });
  await race.start(); held = true;
  const oldPoll = race.tick(1000); await flush();
  await race.view.cancelJob();
  assert.equal(race.view.notice.value, '正在停止任务…');
  stale.resolve({ ok: true, job: { ...runningJob, cancelRequested: false } });
  await oldPoll;
  assert.equal(race.view.currentJob.value.cancelRequested, true);
  runningJob.status = 'cancelled';
  await race.tick(1000);
  assert.equal(race.view.notice.value, '下载结果已取消');
  assert.equal(race.jobTimers().length, 0);
  race.unmount();

  const leaving = deferred();
  const late = mount('views/WorkbenchView.vue', labels, workbenchNames, async (url) => url === '/api/jobs/active' ? leaving.promise : fallback);
  const restoring = late.view.restoreActiveJob();
  late.unmount(); leaving.resolve({ ok: true, job: runningJob }); await restoring;
  assert.equal(late.view.jobId.value, '');
  assert.equal(late.timers.size, 0);

  for (const task of ['upload', 'create', 'analyse', 'download']) {
    const success = mount('views/WorkbenchView.vue', labels, workbenchNames, async (url) => {
      if (url.startsWith('/api/run/')) return { ok: true, id: task, status: 'queued' };
      if (url === `/api/jobs/${task}`) return { ok: true, job: { id: task, task, status: 'succeeded', output: '已结束' } };
      return fallback;
    });
    await success.view.runTask(labels.taskLabels[task]); await flush();
    assert.equal(success.view.running.value, '');
    assert.equal(success.view.currentJob.value.status, 'succeeded');
    assert.equal(success.timers.size, 0);
    assert.equal(success.calls.filter((call) => call.url === '/api/status').length, task === 'download' ? 1 : 2);
    success.unmount();
  }

  const background = mount('views/WorkbenchView.vue', labels, workbenchNames, async (url) => {
    if (url === '/api/jobs/completed') return { ok: true, job: { id: 'completed', task: 'upload', status: 'succeeded' } };
    return fallback;
  });
  background.view.jobs.value = [{ id: 'completed', task: 'upload', status: 'running' }, { id: 'selected', task: 'download', status: 'queued' }];
  background.view.jobId.value = 'selected';
  background.view.notice.value = '下载结果即将开始';
  await background.view.pollJob('completed');
  assert.equal(background.calls.filter((call) => call.url === '/api/status').length, 2, '后台完成的任务也需要检测当前状态');
  assert.equal(background.view.notice.value, '下载结果即将开始', '后台检测不能覆盖当前任务的提示');
  background.unmount();

  // 自动推进开启时由服务端探测平台。前端若仍然自己请求 /api/platform-status，
  // 会和引擎抢同一个用户占位，拿到 409 后被误显示成“平台状态读取失败”。
  const auto = mount('views/WorkbenchView.vue', labels, workbenchNames, async (url) => {
    if (url === '/api/auto-advance') {
      return { ok: true, enabled: true, phase: 'waitingFiles', message: '正在等待平台处理上传文件', intervalMs: 300000 };
    }
    if (url === '/api/auto-advance/check') return { ok: true, enabled: true, phase: 'waitingFiles', message: '正在等待平台处理上传文件' };
    if (url === '/api/jobs/auto-1') return { ok: true, job: { id: 'auto-1', task: 'upload', status: 'succeeded' } };
    // 有创建待办时检测才会真的去读平台；这里让它一定会被调用到。
    if (url === '/api/status') {
      const refreshed = auto.calls.filter((call) => call.url === '/api/status').length > 1
      return { ok: true, workspaceStatus: refreshed ? '等待洞悉' : '等待创建人群包', createCount: refreshed ? 0 : 1, createNames: refreshed ? [] : ['pzw_oaid_x_1'], analyseCount: refreshed ? 1 : 0, doneCount: 0 }
    }
    if (url === '/api/platform-status') return { ok: true, pnPending: 0, idfaPending: 0, oaidPending: 0, insightPending: 0, resultPending: 0, errors: [] };
    return fallback;
  });
  auto.view.jobs.value = [{ id: 'auto-1', task: 'upload', status: 'running' }];
  auto.view.jobId.value = 'auto-1';
  await auto.view.pollJob('auto-1');
  assert.equal(auto.calls.filter((call) => call.url === '/api/platform-status').length, 0,
    '自动推进开启时前端不得自行探测平台');
  assert.equal(auto.calls.filter((call) => call.url === '/api/auto-advance/check').length, 1,
    '应当请求服务端立即检查，而不是等下一轮定时');
  assert.equal(auto.calls.filter((call) => call.url === '/api/status').length, 2,
    '自动推进检查完成后应立即刷新工作区状态');
  assert.match(auto.view.notice.value, /自动推进正在接管/);
  auto.unmount();

  // 关闭自动推进后回到原来的行为，手动检测仍要工作。
  const manual = mount('views/WorkbenchView.vue', labels, workbenchNames, async (url) => {
    if (url === '/api/auto-advance') return { ok: true, enabled: false, phase: 'paused', message: '自动推进已关闭', intervalMs: 300000 };
    if (url === '/api/jobs/manual-1') return { ok: true, job: { id: 'manual-1', task: 'upload', status: 'succeeded' } };
    if (url === '/api/status') return { ok: true, workspaceStatus: '等待创建人群包', createCount: 1, createNames: ['pzw_oaid_x_1'], analyseCount: 0, doneCount: 0 };
    if (url === '/api/platform-status') return { ok: true, pnPending: 0, idfaPending: 0, oaidPending: 0, insightPending: 0, resultPending: 0, errors: [] };
    return fallback;
  });
  manual.view.jobs.value = [{ id: 'manual-1', task: 'upload', status: 'running' }];
  manual.view.jobId.value = 'manual-1';
  await manual.view.pollJob('manual-1');
  assert.equal(manual.calls.filter((call) => call.url === '/api/platform-status').length, 1,
    '关闭自动推进后仍需自动检测平台');
  assert.equal(manual.calls.filter((call) => call.url === '/api/auto-advance/check').length, 0);
  manual.unmount();
}

async function testTables(labels) {
  let items = [{ id: 'mine', task: 'upload', status: 'running', startedAt: '2026-10-20T00:00:00Z' }];
  let fail = false;
  const page = mount('components/JobsTable.vue', labels, tableNames, async (url, method) => {
    if (method === 'POST') { items = [{ ...items[0], status: 'cancelled' }]; return { ok: true, result: 'cancelled' }; }
    if (fail) throw new Error('列表暂不可用');
    return { ok: true, items, page: Number(new URL(url, 'http://local').searchParams.get('page')), total: 41 };
  });
  await page.start();
  assert.equal(page.calls[0].url, '/api/jobs?page=1&pageSize=20');
  assert.equal(page.view.pages.value, 3);
  assert.equal(labels.jobDuration(page.view.items.value[0], page.view.now.value), '2 分 5 秒');
  assert.equal([...page.timers.values()][0].delay, 3000);
  await page.tick(3000);
  assert.equal(labels.jobDuration(page.view.items.value[0], page.view.now.value), '2 分 8 秒');
  await page.view.load(2);
  assert.equal(page.view.page.value, 2);
  fail = true; await page.tick(3000);
  assert.equal(page.view.error.value, '列表暂不可用');
  assert.equal(page.timers.size, 1);
  fail = false;
  page.confirm(false); await page.view.cancelJob(page.view.items.value[0]);
  assert.equal(page.calls.some((call) => call.method === 'POST'), false);
  page.confirm(true); await page.view.cancelJob(page.view.items.value[0]);
  assert.equal(page.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(page.view.items.value[0].status, 'cancelled');
  assert.equal(page.timers.size, 0);
  page.unmount();

  const admin = mount('components/JobsTable.vue', labels, tableNames, async (url) => ({
    ok: true, items: [{ id: 'admin-1', task: 'create', username: '用户甲', status: 'queued' }],
    page: Number(new URL(url, 'http://local').searchParams.get('page')), total: 41,
  }), { admin: true });
  await admin.start();
  await admin.view.load(2);
  admin.view.filters.username = '用户甲'; admin.view.filters.status = 'queued';
  await admin.view.load(1, true);
  assert.equal(admin.view.page.value, 1);
  let query = new URL(admin.calls.at(-1).url, 'http://local');
  assert.equal(query.pathname, '/api/admin/jobs');
  assert.equal(query.searchParams.get('username'), '用户甲');
  assert.equal(query.searchParams.get('status'), 'queued');
  admin.view.filters.username = '尚未查询';
  await admin.tick(3000);
  query = new URL(admin.calls.at(-1).url, 'http://local');
  assert.equal(query.searchParams.get('username'), '用户甲');
  await admin.view.cancelJob(admin.view.items.value[0]);
  assert.equal(admin.confirms(), 0);
  assert.equal(admin.calls.some((call) => call.method === 'POST'), false);
  admin.unmount();
  assert.equal(admin.timers.size, 0);

  const gate = deferred();
  const late = mount('components/JobsTable.vue', labels, tableNames, () => gate.promise);
  const loading = late.view.load(); late.unmount();
  gate.resolve({ ok: true, items, total: 1, page: 1 }); await loading;
  assert.equal(late.view.items.value.length, 0);
  assert.equal(late.timers.size, 0);
}

async function main() {
  const labels = await import('../apps/web/src/labels.js');
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
  await testAutoProgress(labels);
  await testWorkbench(labels);
  await testUnifiedUpload(labels);
  await testTables(labels);
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
module.exports = main;
if (require.main === module) main().catch((error) => { console.error('任务前端测试失败：', error); process.exitCode = 1; });

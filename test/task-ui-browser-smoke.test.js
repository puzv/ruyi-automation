const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const baseUrl = process.env.RUYI_UI_SMOKE_URL || 'http://localhost:5173';
const screenshotDir = process.env.RUYI_UI_SMOKE_SCREENSHOTS || os.tmpdir();
function chromePath() {
  if (process.env.RUYI_UI_SMOKE_BROWSER) return process.env.RUYI_UI_SMOKE_BROWSER;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    ...(process.platform === 'win32' ? [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ] : []),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}
const screenshot = (name) => path.join(screenshotDir, `task-ui-${name}.png`);
async function run() {
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname), '仅连接本机前端开发服务');
  fs.mkdirSync(screenshotDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, timeout: 30000 });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const tasks = [
      { id: 'task-running', name: '职业人群洞悉 2026-11', status: 'running', currentStep: 'analyse', startedAt: '2026-11-10T12:00:00Z', createdAt: '2026-11-10T11:50:00Z', version: 1 },
      { id: 'task-login', name: '手机号码人群', status: 'waiting_login', currentStep: 'upload', createdAt: '2026-11-10T11:00:00Z', version: 1 },
      { id: 'task-done', name: '设备人群结果', status: 'succeeded', currentStep: 'download', createdAt: '2026-11-10T10:00:00Z', version: 1 },
      { id: 'task-failed', name: '真实失败任务', status: 'failed', currentStep: 'analyse', createdAt: '2026-11-10T09:00:00Z', version: 1, errorMessage: '真实自动化异常' },
      { id: 'task-interrupted', name: '中断待继续任务', status: 'interrupted', currentStep: 'analyse', createdAt: '2026-11-10T08:00:00Z', version: 3 },
    ];
    let loggedIn = true;
    const uploads = [];
    const continued = [];
    const stopped = [];
    const logs = [
      ...[3, 2, 1].map((number) => ({ id: `wait-${number}`, userId: 1, username: 'reviewer', action: 'job.finish', targetType: 'job', targetId: `check-${number}`, result: 'success', createdAt: `2026-11-10T12:00:0${number}Z`, detail: { taskId: 'task-running', task: 'analyse', status: 'waiting_platform', outcome: 'not_ready', code: 2 } })),
      { id: 'real-failure-log', userId: 1, username: 'reviewer', action: 'job.finish', result: 'failure', errorMessage: '真实检查失败，不能合并', createdAt: '2026-11-10T11:00:00Z', detail: { taskId: 'task-running', task: 'analyse', status: 'failed', code: 1 } },
      { id: 'other-task-log', userId: 1, username: 'reviewer', action: 'job.finish', result: 'success', createdAt: '2026-11-10T10:00:00Z', detail: { taskId: 'different-task', task: 'analyse', status: 'waiting_platform', outcome: 'not_ready', code: 2 } },
      { id: 'login-2', userId: 1, username: 'reviewer', action: 'job.finish', result: 'success', createdAt: '2026-11-10T09:02:00Z', detail: { taskId: 'task-login', task: 'create', status: 'waiting_login', outcome: 'login_required' } },
      { id: 'login-1', userId: 1, username: 'reviewer', action: 'job.finish', result: 'success', createdAt: '2026-11-10T09:01:00Z', detail: { taskId: 'task-login', task: 'create', status: 'waiting_login', outcome: 'login_required' } },
      { id: 'legacy-without-owner', action: 'job.finish', result: 'failure', errorMessage: '任务未就绪，稍后可重试', detail: { task: 'analyse', status: 'failed', code: 2 } },
    ];
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== new URL(baseUrl).origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      let data;
      if (url.pathname === '/api/tasks' && route.request().method() === 'POST') {
        const payload = route.request().postDataBuffer().toString('utf8');
        const names = [...payload.matchAll(/filename="([^"]+)"/g)].map((match) => match[1]);
        uploads.push(names);
        data = { ok: true, item: { id: 'created-task', status: 'queued' } };
      }
      else if (url.pathname === '/api/tasks/task-running/stop') {
        assert.equal(route.request().method(), 'POST');
        assert.deepEqual(route.request().postDataJSON(), { version: 1 });
        stopped.push(url.pathname); tasks[0].cancelRequested = true;
        data = { ok: true, status: 'cancelling' };
      }
      else if (url.pathname === '/api/tasks/task-interrupted/continue') {
        assert.equal(route.request().method(), 'POST');
        assert.deepEqual(route.request().postDataJSON(), { version: 3 });
        continued.push(url.pathname); tasks.at(-1).status = 'queued';
        data = { ok: true, status: 'queued', message: '任务已从未完成步骤重新入队，请等待执行' };
      }
      else if (url.pathname === '/api/auth/me') data = { ok: true, user: { id: 1, username: 'reviewer', displayName: '审查账号', role: 'admin', mustChangePassword: false } };
      else if (url.pathname === '/api/platform-state') data = { ok: true, status: loggedIn ? 'valid' : 'none' };
      else if (url.pathname === '/api/logs/mine' || url.pathname === '/api/admin/logs') {
        if (url.searchParams.has('groupId')) {
          assert.equal(url.searchParams.get('snapshot'), '500', '展开沿用列表快照');
          const rawPage = Number(url.searchParams.get('page'));
          const rawLogs = Array.from({ length: 25 }, (_, i) => ({ ...logs[0], id: `wait-${25 - i}` }));
          data = { ok: true, items: rawLogs.slice((rawPage - 1) * 20, rawPage * 20), total: 25, page: rawPage };
        } else data = { ok: true, grouped: true, snapshot: '500', items: [
          { ...logs[0], waitGroup: { count: 25, first: logs[2].createdAt, last: logs[0].createdAt } },
          ...logs.slice(3, 5).map((log) => ({ ...log, waitGroup: { count: 1, first: log.createdAt, last: log.createdAt } })),
          { ...logs[5], waitGroup: { count: 2, first: logs[6].createdAt, last: logs[5].createdAt } },
          { ...logs[7], waitGroup: { count: 1 } },
        ], total: 5, page: 1 };
      }
      else if (/\/tasks$/.test(url.pathname)) data = { ok: true, items: tasks.map(t => ({ ...t, username: 'reviewer' })), total: tasks.length, page: 1 };
      else if (url.pathname.endsWith('/files')) data = { ok: true, items: [{ id: 'file-1', originalName: '职业样本_oaid_原始名称.txt', fileType: 'oaid', sizeBytes: 20480 }] };
      else if (/\/tasks\/[^/]+$/.test(url.pathname)) {
        const task = tasks.find(t => t.id === url.pathname.split('/').pop());
        data = { ok: true, item: task, jobs: ['upload', 'create', 'analyse', 'download'].slice(0, task.status === 'succeeded' ? 4 : task.status === 'running' ? 3 : 0).map((step, i) => ({ id: `job-${task.id}-${step}`, task: step, status: task.status === 'running' && i === 2 ? 'running' : 'succeeded', startedAt: task.createdAt })) };
        if (task.id === 'task-running') data.jobs.splice(2, 0, { id: 'check-not-ready', task: 'analyse', status: 'waiting_platform', outcome: 'not_ready', exitCode: 2, message: '等待平台处理，系统将自动检查并继续', startedAt: task.createdAt });
        if (task.id === 'task-running') data.jobs.splice(2, 0, { id: 'legacy-not-ready', task: 'analyse', status: 'failed', errorMessage: '任务未就绪，稍后可重试：平台计算中', startedAt: task.createdAt });
        if (task.id === 'task-running') data.jobs.splice(4, 0, ...[1, 2].map((number) => ({ id: `login-check-${number}`, task: 'analyse', status: 'waiting_login', outcome: 'login_required', startedAt: task.createdAt })));
        if (task.id === 'task-failed') data.jobs.push({ id: 'real-failure', task: 'analyse', status: 'failed', exitCode: 1, exitSignal: null, errorMessage: '真实步骤失败', startedAt: task.createdAt });
      } else if (url.pathname.endsWith('/log')) return route.fulfill({ status: 200, contentType: 'text/plain', body: '开始处理\n正在查询平台状态\n等待平台处理完成' });
      else throw new Error(`未mock API: ${url.pathname}`);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.goto(`${baseUrl.replace(/\/$/, '')}/#/jobs`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByText('职业人群洞悉 2026-11', { exact: true }).waitFor();
    assert.equal(await page.getByText('操作面板', { exact: true }).count(), 0);
    loggedIn = false;
    await page.getByRole('button', { name: '继续任务', exact: true }).click();
    await page.getByText('请先完成平台登录，再继续任务', { exact: true }).waitFor();
    assert.equal(continued.length, 0);
    loggedIn = true;
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '继续任务', exact: true }).click();
    await page.getByText('任务已从未完成步骤重新入队，请等待执行', { exact: true }).waitFor();
    await page.getByRole('row').filter({ hasText: '中断待继续任务' }).locator('.result-badge.job-status-queued').waitFor();
    assert.equal(continued.length, 1);
    assert.equal(await page.getByRole('button', { name: '继续任务', exact: true }).count(), 0);
    await page.screenshot({ path: screenshot('list'), fullPage: true });
    await page.getByRole('button', { name: '文件与流程' }).first().click();
    await page.getByText('职业样本_oaid_原始名称.txt', { exact: true }).waitFor();
    await page.getByText('等待平台处理', { exact: true }).first().waitFor();
    await page.getByText('连续 2 次检查', { exact: true }).first().waitFor();
    assert.equal(await page.locator('.task-job-list .job-status-waiting_platform').count(), 1, '相邻等待检查显示为一组');
    assert.equal(await page.locator('.task-job-list .job-status-waiting_login').count(), 1, '同一任务登录等待类别独立成组');
    assert.equal(await page.getByRole('button', { name: '展开每次日志' }).count(), 2, '平台等待与登录等待不能合并为一组');
    await page.getByRole('button', { name: '展开每次日志' }).first().click();
    assert.equal(await page.locator('.check-records li').count(), 2, '可展开访问全部原始检查');
    await page.locator('.check-records').getByRole('button', { name: '查看日志' }).first().click();
    await page.getByRole('dialog').getByText('等待平台处理', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭日志' }).click();
    assert.equal(await page.locator('.task-job-list .job-status-failed').count(), 0, '暂未就绪检查不展示失败徽章');
    const runningRow = page.getByRole('row').filter({ hasText: '职业人群洞悉 2026-11' });
    page.once('dialog', dialog => dialog.accept());
    await runningRow.getByRole('button', { name: '停止任务', exact: true }).click();
    await runningRow.getByText('正在停止…', { exact: true }).waitFor();
    assert.equal(stopped.length, 1);
    assert.equal(await runningRow.getByRole('button', { name: '停止任务', exact: true }).isDisabled(), true);
    assert.equal(await runningRow.getByRole('button', { name: '继续任务', exact: true }).count(), 0, '真正退出前不能继续');
    tasks[0].status = 'interrupted';
    // 故意保留旧停止标记，终态 UI 也不能永久显示“正在停止”。
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await runningRow.getByRole('button', { name: '继续任务', exact: true }).waitFor();
    assert.equal(await runningRow.getByText('正在停止…', { exact: true }).count(), 0);
    assert.equal(await runningRow.getByRole('button', { name: '继续任务', exact: true }).isEnabled(), true);
    assert.equal(await runningRow.getByRole('button', { name: '删除任务', exact: true }).isEnabled(), true);
    await page.screenshot({ path: screenshot('stopped'), fullPage: true });
    tasks[0].status = 'succeeded'; tasks[0].currentStep = 'download';
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByRole('row').filter({ hasText: '职业人群洞悉 2026-11' }).getByRole('button', { name: '下载结果', exact: true }).waitFor();
    await page.getByRole('row').filter({ hasText: '真实失败任务' }).getByRole('button', { name: '文件与流程' }).click();
    await page.getByText('真实自动化异常', { exact: true }).waitFor();
    assert.equal(await page.locator('.task-job-list .job-status-failed').count(), 1, '真实非重试失败仍用失败徽章');
    await page.getByText('真实步骤失败', { exact: true }).waitFor();
    await page.getByRole('row').filter({ hasText: '真实失败任务' }).getByRole('button', { name: '收起详情' }).click();
    await page.getByRole('button', { name: '查看日志' }).first().click();
    await page.getByRole('dialog').getByText('正在查询平台状态', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭日志' }).click();
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByPlaceholder('不填写则使用任务编号').fill('新任务名称');
    await page.getByRole('dialog').locator('input[type=file]:not([webkitdirectory])').setInputFiles({ name: '测试oaid.txt', mimeType: 'text/plain', buffer: Buffer.from('fake') });
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-folder-picker-'));
    fs.mkdirSync(path.join(folder, 'subdir'));
    fs.mkdirSync(path.join(folder, '.hidden'));
    fs.writeFileSync(path.join(folder, 'sample_oaid.txt'), 'synthetic oaid');
    fs.writeFileSync(path.join(folder, 'subdir', 'sample_pn.csv'), 'synthetic pn');
    fs.writeFileSync(path.join(folder, '.hidden', 'skip_idfa.txt'), 'synthetic hidden');
    fs.writeFileSync(path.join(folder, 'readme.md'), 'synthetic non-input');
    await page.getByRole('dialog').locator('input[webkitdirectory]').setInputFiles(folder);
    await page.getByRole('dialog').getByText('有效 2 个文件，已跳过 2 个不符合条件的文件。换选文件或文件夹会替换当前清单。', { exact: true }).waitFor();
    await page.getByRole('dialog').getByText(new RegExp('subdir/sample_pn.csv$')).waitFor();
    await page.screenshot({ path: screenshot('folder'), fullPage: true });
    await page.getByRole('dialog').locator('input[webkitdirectory]').setInputFiles(folder);
    await page.getByRole('dialog').getByText('有效 2 个文件，已跳过 2 个不符合条件的文件。换选文件或文件夹会替换当前清单。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').getByRole('button', { name: '上传并创建任务' }).isEnabled(), true, '同一目录可重复选择，输入清空不会丢失File对象');
    await page.screenshot({ path: screenshot('create'), fullPage: true });
    await page.getByRole('dialog').getByRole('button', { name: '上传并创建任务' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(uploads.length, 1);
    assert.deepEqual(uploads[0].slice().sort(), ['sample_oaid.txt', 'sample_pn.csv'], 'multipart仅发送两个有效basename，不发送父目录、隐藏文件及readme');
    await page.getByText('任务已创建并进入队列', { exact: true }).waitFor();
    loggedIn = false;
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    await page.getByRole('dialog').getByText('前往平台登录', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').locator('input[type=file]:not([webkitdirectory])').isDisabled(), true);
    assert.equal(await page.getByRole('dialog').locator('input[webkitdirectory]').isDisabled(), true);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('link', { name: '全部任务', exact: true }).click();
    await page.getByRole('heading', { name: '全部任务', exact: true }).waitFor();
    await page.getByText('职业人群洞悉 2026-11', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '恢复入队' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '继续任务' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '下载结果' }).count(), 0);
    await page.screenshot({ path: screenshot('admin'), fullPage: true });
    for (const route of ['我的操作记录', '全部操作记录']) {
      await page.getByRole('link', { name: route, exact: true }).click();
      await page.getByText('连续 25 次等待检查', { exact: true }).waitFor();
      await page.getByText('连续 2 次等待检查', { exact: true }).waitFor();
      await page.getByText('真实检查失败，不能合并', { exact: true }).waitFor();
      await page.getByText('任务未就绪，稍后可重试', { exact: true }).waitFor();
      await page.getByRole('button', { name: '展开原始记录' }).first().click();
      await page.getByText('记录 ID：wait-25', { exact: true }).waitFor();
      assert.equal(await page.locator('.wait-raw-record .log-description').count(), 20, '大组原始明细分页加载');
      await page.getByRole('button', { name: '下一页原始记录', exact: true }).click();
      await page.getByText('记录 ID：wait-1', { exact: true }).waitFor();
      assert.equal(await page.locator('.wait-raw-record .log-description').count(), 5);
      await page.getByText('第 1 / 1 页，共 5 个展示条目', { exact: true }).waitFor();
      await page.screenshot({ path: screenshot(route === '我的操作记录' ? 'wait-mine' : 'wait-admin'), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl.replace(/\/$/, '')}/#/jobs`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByText('职业人群洞悉 2026-11', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '手机页面不应产生横向溢出，表格只在容器内滚动');
    await page.screenshot({ path: screenshot('mobile-list'), fullPage: true });
    loggedIn = true;
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await page.getByPlaceholder('不填写则使用任务编号').fill('手机创建任务');
    await dialog.locator('input[type=file]:not([webkitdirectory])').setInputFiles({ name: '手机oaid.txt', mimeType: 'text/plain', buffer: Buffer.from('fake') });
    assert.equal(await dialog.getByRole('button', { name: '上传并创建任务' }).isEnabled(), true, '手机弹窗可选择文件并提交');
    const box = await dialog.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, '手机弹窗保持在可视范围内');
    await page.screenshot({ path: screenshot('mobile-create'), fullPage: true });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.deepEqual(errors, []);
    console.log(`桌面与390px手机任务界面浏览器检查通过；截图目录：${screenshotDir}`);
  } finally { await browser.close(); }
}
module.exports = run;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });

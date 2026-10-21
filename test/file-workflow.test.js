const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-workflow-'));
const previous = { user: process.env.RUYI_USER, job: process.env.RUYI_JOB_ID, upload: process.env.RUYI_UPLOAD_DIR };
process.env.RUYI_USER = 'pnalice';
process.env.RUYI_JOB_ID = 'offline-upload-task';
process.env.RUYI_UPLOAD_DIR = temporary;
const manifest = require('@ruyi/automation/lib/file-manifest');
const browser = require('@ruyi/automation/lib/browser');
const login = require('@ruyi/automation/lib/login');
const config = require('@ruyi/shared/config');
const originals = { launch: browser.launchBrowser, close: browser.closeBrowserContext,
  navigate: login.navigateWithLogin, rename: fs.renameSync, write: fs.writeFileSync,
  candidates: config.uploadRootCandidates };
let browserCount = 0;
let chosen = [];
const page = {
  on() {}, goto: async () => {}, url: () => config.urls.pnUpload, waitForTimeout: async () => {},
  waitForResponse: async () => ({ ok: () => true, json: async () => ({ success: true }), status: () => 200 }),
  locator(selector) {
    const control = {
      first() { return this; }, last() { return this; }, filter() { return this; }, nth() { return this; },
      count: async () => selector.includes('fileItemStatusText') ? chosen.length : 1,
      waitFor: async () => {}, isVisible: async () => true, isEnabled: async () => true,
      setInputFiles: async (files) => { chosen = files; }, click: async () => {},
    };
    return control;
  },
  getByText() { return this.locator('submit'); },
};
browser.launchBrowser = async () => { browserCount += 1; return { pages: () => [page], on() {} }; };
browser.closeBrowserContext = async () => {};
login.navigateWithLogin = async () => page;
const upload = require('@ruyi/automation/upload');
const download = require('@ruyi/automation/download');
function loadFunctions(script, marker, names, overrides = {}) {
  const filename = require.resolve(`@ruyi/automation/${script}`);
  const source = fs.readFileSync(filename, 'utf8').split(marker)[0];
  const realRequire = createRequire(filename);
  const context = {
    require: (name) => Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name),
    console, process, __dirname: path.dirname(filename),
  };
  vm.createContext(context);
  return vm.runInContext(`${source}\n({ ${names.join(', ')} })`, context);
}
function sample(root, name, value = '人工样本') {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
  return target;
}
function audiencePage(fileName, scenario, calls) {
  let taskName = '';
  const control = {
    first() { return this; }, last() { return this; }, filter() { return this; }, locator() { return this; },
    count: async () => 1, waitFor: async () => {}, isVisible: async () => true, isEnabled: async () => true,
    click: async () => {}, fill: async (value) => { taskName = value; }, inputValue: async () => taskName,
    innerText: async () => fileName,
  };
  const row = {
    getAttribute: async (name) => ({ class: scenario.className || '', 'aria-disabled': scenario.ariaDisabled || '' }[name] || ''),
    innerText: async () => `${fileName} ${scenario.status || 'SUCCESS'}`,
    locator(selector) {
      if (selector === '.audience-name') return { ...control, getAttribute: async () => fileName };
      assert.equal(selector, '.audience-number');
      return { innerText: async () => {
        calls.numberReads += 1;
        if (scenario.number === undefined) throw new Error('模拟缺失人数元素');
        return scenario.number;
      } };
    },
    click: async () => { calls.selections += 1; },
  };
  return {
    on() {}, waitForTimeout: async () => {}, url: () => config.urls.result,
    waitForResponse: async () => ({ json: async () => ({ success: true }) }),
    getByText: () => control,
    getByRole: () => ({ ...control, click: async () => { calls.submissions += 1; } }),
    locator: (selector) => selector === 'ul.selection-results:visible li.selection-info'
      ? { ...control, nth: () => row } : control,
  };
}
async function testAudienceReadiness() {
  const cases = [
    { label: '处理中0', status: 'PROCESSING', number: '0', blocked: true, unavailable: true },
    { label: '处理中999', status: 'PROCESSING', number: '999', blocked: true, unavailable: true },
    { label: '中文处理中', status: '计算中', number: '0', blocked: true, unavailable: true },
    { label: '等待中', status: 'PENDING', number: '999', blocked: true, unavailable: true },
    { label: '禁用样式', className: 'selection-info disabled', number: '999', blocked: true, unavailable: true },
    { label: 'ARIA禁用', ariaDisabled: 'true', number: '0', blocked: true, unavailable: true },
    { label: '已就绪999', number: '999', small: true },
    { label: '已就绪0', number: '0', small: true },
    { label: '非禁用999', ariaDisabled: 'false', number: '999', small: true },
    { label: '已就绪1000', number: '1000' },
    { label: '英文千分位', number: '1,000' },
    { label: '中文千分位', number: ' 1，234 ' },
    { label: '空白人数', number: ' \n\t ', blocked: true },
    { label: '空字符串人数', number: '', blocked: true },
    { label: '缺失人数', blocked: true },
    { label: '无效人数', number: '--', blocked: true },
    { label: '非整数人数', number: '999.5', blocked: true },
    { label: '负数人数', number: '-1', blocked: true },
  ];
  for (const [index, scenario] of cases.entries()) {
    const root = path.join(temporary, `readiness-${index}`);
    const fileName = '人工职业_pn';
    const listPath = sample(root, 'analyseToDoList.json', JSON.stringify([fileName, 'other_pn']));
    const donePath = sample(root, 'done.json', '["already_pn"]');
    const beforeList = fs.readFileSync(listPath, 'utf8');
    const beforeDone = fs.readFileSync(donePath, 'utf8');
    const calls = { numberReads: 0, selections: 0, submissions: 0, closed: 0, stages: [] };
    const fakePage = audiencePage(fileName, scenario, calls);
    const analyse = loadFunctions('analyse.js', '\nmain().catch', ['main'], {
      './lib/preflight': { checkPreflight() {} },
      './lib/paths': { requireUploadRoot: () => root },
      './lib/browser': {
        launchBrowser: async () => ({ pages: () => [fakePage] }),
        closeBrowserContext: async () => { calls.closed += 1; },
      },
      './lib/login': { navigateWithLogin: async () => fakePage },
      './lib/file-manifest': { requireMapping() {}, updateStage: (...args) => { calls.stages.push(args); } },
    });
    if (scenario.blocked) {
      await assert.rejects(analyse.main(), (error) => {
        assert.notEqual(error.code, 'AUDIENCE_TOO_SMALL', scenario.label);
        assert.match(error.message, /暂不可用.*已停止提交.*稍后重试/, scenario.label);
        return true;
      });
      assert.equal(fs.readFileSync(listPath, 'utf8'), beforeList, `${scenario.label}必须保留分析清单`);
      if (scenario.unavailable) assert.equal(calls.numberReads, 0, '必须先判断状态，不能读取未就绪人数');
    } else {
      await analyse.main();
      assert.deepEqual(JSON.parse(fs.readFileSync(listPath, 'utf8')), ['other_pn'], scenario.label);
    }
    assert.equal(calls.submissions, scenario.blocked || scenario.small ? 0 : 1, scenario.label);
    assert.equal(calls.selections, scenario.blocked || scenario.small ? 0 : 1, scenario.label);
    if (scenario.blocked || scenario.small) {
      assert.equal(fs.readFileSync(donePath, 'utf8'), beforeDone, `${scenario.label}不得改动完成清单`);
      assert.deepEqual(calls.stages, []);
    } else {
      assert.deepEqual(JSON.parse(fs.readFileSync(donePath, 'utf8')), ['already_pn', fileName]);
      assert.equal(calls.stages.length, 1);
      assert.equal(calls.stages[0][2], 'analysed');
    }
    assert.equal(calls.closed, 1, `${scenario.label}必须关闭假浏览器上下文`);
  }
}
function testAnalyseRetry() {
  for (const mixed of [false, true]) {
    const root = path.join(temporary, `retry-analysis-${mixed}`);
    const listPath = sample(root, 'analyseToDoList.json', '["processing_pn","ready_pn"]');
    const donePath = sample(root, 'done.json', '["already_pn"]');
    const beforeDone = fs.readFileSync(donePath, 'utf8');
    const attempts = [];
    const { recordDone } = loadFunctions('analyse.js', '\nmain().catch', ['recordDone']);
    const batch = loadFunctions('analyseAll.js', '\ntry {\n  main();', ['main'], {
      './lib/preflight': { checkPreflight() {} },
      './lib/paths': { requireUploadRoot: () => root },
      child_process: { spawnSync: () => {
        const current = JSON.parse(fs.readFileSync(listPath, 'utf8'))[0];
        attempts.push(current);
        if (mixed && current === 'ready_pn') {
          recordDone(donePath, listPath, current);
          return { status: 0 };
        }
        return { status: 2 };
      } },
    });
    batch.main();
    assert.deepEqual(attempts, mixed ? ['processing_pn', 'ready_pn', 'processing_pn'] : ['processing_pn', 'ready_pn']);
    assert.deepEqual(JSON.parse(fs.readFileSync(listPath, 'utf8')), mixed ? ['processing_pn'] : ['processing_pn', 'ready_pn']);
    if (mixed) assert.deepEqual(JSON.parse(fs.readFileSync(donePath, 'utf8')), ['already_pn', 'ready_pn']);
    else assert.equal(fs.readFileSync(donePath, 'utf8'), beforeDone);
  }
}
async function main() {
  try {
    await testAudienceReadiness();
    testAnalyseRetry();
    for (const failure of ['archive', 'queue']) {
      const root = path.join(temporary, failure);
      sample(root, 'raw/import/1/职业_pn.txt');
      sample(root, 'raw/import/2/学生_pn.txt');
      config.uploadRootCandidates = [root];
      let failed = false;
      if (failure === 'archive') fs.renameSync = (source, target) => {
        if (!failed && target.includes(`${path.sep}done${path.sep}`)) {
          failed = true;
          throw new Error('模拟上传确认后归档失败');
        }
        return originals.rename(source, target);
      };
      else fs.writeFileSync = (file, ...args) => {
        if (!failed && path.basename(file) === 'createGroupToDoList.json') {
          failed = true;
          throw new Error('模拟上传确认后写清单失败');
        }
        return originals.write(file, ...args);
      };
      const beforeBrowser = browserCount;
      await upload.main();
      assert.equal(failed, true);
      assert.equal(process.exitCode, 1);
      assert.equal(browserCount, beforeBrowser + 1);
      const records = manifest.readManifest(root).files;
      assert.ok(records.every((item) => item.stage === 'uploaded'));
      fs.renameSync = originals.rename;
      fs.writeFileSync = originals.write;
      process.exitCode = 0;
      process.env.RUYI_JOB_ID = `retry-${failure}`;
      await upload.main();
      assert.equal(browserCount, beforeBrowser + 1, '确认成功后的重试必须本地恢复，不能重新启动浏览器');
      const restored = manifest.readManifest(root).files;
      assert.deepEqual(restored.map((item) => item.platformName), records.map((item) => item.platformName));
      assert.ok(restored.every((item) => item.currentPath.startsWith('pn/done/')));
      const todoPath = path.join(root, 'createGroupToDoList.json');
      const queue = JSON.parse(fs.readFileSync(todoPath, 'utf8'));
      assert.deepEqual(new Set(queue), new Set(records.map((item) => item.platformName)));
      assert.ok(queue.every((item) => typeof item === 'string'));
      assert.equal(manifest.pendingCandidates(root).length, 0);

      const create = loadFunctions('createGroup.js', '\nmain().catch', ['getGroupType', 'readNextFileName', 'recordAnalysedFile', 'removeFromCreateTodoList']);
      const task = create.readNextFileName(root);
      assert.equal(task.fileName, queue[0]);
      create.recordAnalysedFile(task.analysePath, task.fileName, task.analysed);
      create.removeFromCreateTodoList(task.todoPath, task.fileName);
      const analyse = loadFunctions('analyse.js', '\nmain().catch', ['resolveTask', 'recordDone']);
      const next = analyse.resolveTask(root);
      assert.equal(next.fileName, queue[0]);
      analyse.recordDone(next.donePath, next.listPath, next.fileName);
      assert.deepEqual(JSON.parse(fs.readFileSync(next.donePath, 'utf8')), [queue[0]]);

      const artifact = sample(root, 'fake-download.xlsx', '人工下载结果');
      const file = { failure: async () => null, path: async () => artifact, suggestedFilename: () => `${next.fileName}.xlsx` };
      const downloadControl = {
        first() { return this; }, count: async () => 1, waitFor: async () => {},
        evaluate: async () => false, click: async () => {},
      };
      const fakeDownloadPage = {
        evaluate: async () => ({ ok: true, title: next.fileName }),
        locator: () => downloadControl, context: () => ({ once() {} }), once() {},
        waitForEvent: async () => file, isClosed: () => false,
      };
      assert.equal(await download.clickDownload(fakeDownloadPage, [next.fileName], { uploadRoot: root, fileName: next.fileName }), true);
      const record = restored.find((item) => item.platformName === next.fileName);
      const destination = path.join(root, 'result', `${path.basename(record.originalName, '.txt')}.xlsx`);
      assert.equal(fs.readFileSync(destination, 'utf8'), '人工下载结果');
      const doneBefore = fs.readFileSync(next.donePath, 'utf8');
      await assert.rejects(download.clickDownload(fakeDownloadPage, [next.fileName], { uploadRoot: root, fileName: next.fileName }), /已存在/);
      assert.equal(fs.readFileSync(next.donePath, 'utf8'), doneBefore, '保存冲突不得清空下载清单');
    }
    // A foreign object's longer name can contain the target's exact name.
    // Status inspection must ignore it and count only the exact match.
    const platform = require('@ruyi/server/src/modules/files/platform');
    const target = manifest.readManifest(path.join(temporary, 'queue')).files[0].platformName;
    page.evaluate = async (_callback, pageNumber) => ({ data: { listing: { items: pageNumber === 1
      ? [{ name: `foreign_${target}_suffix`, status: 'PROCESSING' }, { name: target, status: 'SUCCESS' }] : [] } } });
    assert.equal(await platform.inspectAnalyseAudience([target]), 0);
    console.log('假平台上传确认、重试归档、精确匹配与下载恢复测试通过');
  } finally {
    browser.launchBrowser = originals.launch;
    browser.closeBrowserContext = originals.close;
    login.navigateWithLogin = originals.navigate;
    fs.renameSync = originals.rename;
    fs.writeFileSync = originals.write;
    config.uploadRootCandidates = originals.candidates;
    for (const [name, value] of Object.entries({ RUYI_USER: previous.user, RUYI_JOB_ID: previous.job, RUYI_UPLOAD_DIR: previous.upload })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

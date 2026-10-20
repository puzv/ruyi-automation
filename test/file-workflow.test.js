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
const manifest = require('../lib/file-manifest');
const browser = require('../lib/browser');
const login = require('../lib/login');
const config = require('../config');
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
const upload = require('../upload');
const download = require('../download');
function loadFunctions(script, marker, names) {
  const filename = path.resolve(__dirname, '..', script);
  const source = fs.readFileSync(filename, 'utf8').split(marker)[0];
  const context = { require: createRequire(filename), console, process, __dirname: path.dirname(filename) };
  vm.createContext(context);
  return vm.runInContext(`${source}\n({ ${names.join(', ')} })`, context);
}
function sample(root, name, value = '人工样本') {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
  return target;
}
async function main() {
  try {
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
    const platform = require('../server/platform');
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

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const m = require('../lib/file-manifest');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-manifest-'));
const options = { username: 'pnalice', jobId: 'full-upload-job-001' };
function workspace(name) {
  const root = path.join(temporary, name);
  fs.mkdirSync(path.join(root, 'raw'), { recursive: true });
  return root;
}
function input(root, relative, content = '人工样本\n') {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
function snapshot(root) {
  const output = {};
  const visit = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) visit(file);
      else output[path.relative(root, file)] = fs.readFileSync(file, 'utf8');
    }
  };
  visit(root); return output;
}
try {
  assert.equal(m.jobKey(options.jobId), m.jobKey(options.jobId));
  assert.notEqual(m.jobKey(options.jobId), m.jobKey('another-job'));
  const name = m.createPlatformName({ ...options, type: 'idfa', sequence: 1 });
  assert.match(name, /^pnalice_idfa_[a-f0-9]{8}_1$/);
  assert.equal(name.includes('学生'), false);
  assert.notEqual(name, m.createPlatformName({ ...options, type: 'idfa', sequence: 2 }));
  assert.throws(() => m.createPlatformName({ ...options, username: 'a'.repeat(30), type: 'oaid', sequence: 1 }), /30 个字符/);
  assert.equal(m.unicodeLength('中文😀'), 3);
  for (const type of ['idfa', 'oaid']) {
    assert.equal(m.createPlatformName({ ...options, username: 'a'.repeat(12), type, sequence: 999 }).length, 30);
    assert.throws(() => m.createPlatformName({ ...options, username: 'a'.repeat(12), type, sequence: 1000 }), {
      message: `平台名称超过 30 个字符（用户名“${'a'.repeat(12)}”过长或单次任务文件过多），请缩短用户名或分批上传`,
    });
  }
  assert.equal(m.createPlatformName({ ...options, username: 'a'.repeat(14), type: 'idfa', sequence: 1 }).length, 30);
  assert.throws(() => m.createPlatformName({ ...options, username: 'a'.repeat(14), type: 'idfa', sequence: 10 }), /30 个字符/);
  assert.throws(() => m.createPlatformName({ ...options, type: 'pn', sequence: 0 }), /正整数/);
  assert.throws(() => m.createPlatformName({ ...options, type: 'pn', sequence: 1, existing: [m.createPlatformName({ ...options, type: 'pn', sequence: 1 })] }), /碰撞/);

  const root = workspace('managed');
  input(root, 'raw/import-a/1/学生_idfa.txt');
  input(root, 'raw/import-a/2/手机_pn.csv');
  input(root, 'oaid/原始_oaid.txt');
  input(root, 'pn/done/手机_pn.csv');
  const before = snapshot(root);
  const plan = m.planUpload(root, options);
  assert.deepEqual(snapshot(root), before, '计划必须只读');
  assert.equal(plan.moves.length, 3);
  assert.deepEqual(plan.manifest.files.map((file) => file.sequence), [1, 2, 3]);
  assert.equal(new Set(plan.manifest.files.map((file) => file.platformName)).size, 3);
  m.prepareUpload(root, options);
  const records = m.readManifest(root).files;
  assert.equal(records.length, 3);
  for (const record of records) {
    assert.equal(record.jobId, options.jobId);
    assert.equal(record.stage, 'pending');
    assert.ok(fs.existsSync(path.join(root, record.currentPath)));
    assert.equal(m.resolveFileType(root, record.platformName), record.type);
  }
  assert.deepEqual(m.groupPlatformNames(root, records.map((file) => file.platformName)).idfa, records.filter((file) => file.type === 'idfa').map((file) => file.platformName));
  m.prepareUpload(root, { ...options, jobId: 'new-server-retry-job' });
  assert.deepEqual(m.readManifest(root).files, records, '新服务端任务ID重试必须保留上传ID和序号');
  assert.deepEqual(m.pendingCandidates(root).map((file) => file.originalName).sort(), records.map((file) => file.originalName).sort());
  const copied = m.readManifest(root);
  copied.files[0].type = copied.files[0].type === 'idfa' ? 'pn' : 'idfa';
  assert.throws(() => m.writeManifest(root, copied), /字段无效/);
  assert.throws(() => m.requireMapping(root, 'somebody_pn_1234abcd_1'), /找不到平台名称/);
  assert.equal(m.requireMapping(root, '旧数据_pn.txt').legacy, true);
  assert.equal(m.resolveFileType(root, records.find((file) => file.type === 'idfa').platformName), 'idfa', '用户名pn不能改变类型');

  const duplicate = workspace('duplicate');
  input(duplicate, 'raw/batch-a/1/相同_pn.txt');
  input(duplicate, 'idfa/相同_pn.txt');
  input(duplicate, 'raw/batch-b/2/重复_oaid.txt');
  input(duplicate, 'oaid/重复_oaid.txt');
  const duplicateBefore = snapshot(duplicate);
  assert.throws(() => m.prepareUpload(duplicate, options), (error) => error.message.includes('相同_pn.txt') && error.message.includes('重复_oaid.txt'));
  assert.deepEqual(snapshot(duplicate), duplicateBefore);
  for (const script of ['uploadAll.js', 'upload.js', 'move.js']) {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '..', script)], {
      env: { ...process.env, RUYI_UPLOAD_DIR: duplicate, RUYI_USER: options.username, RUYI_JOB_ID: options.jobId,
        RUYI_PROFILE_DIR: path.join(temporary, 'profile-must-not-be-created'), RUYI_CHROME_PATH: '/missing-browser-for-test' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /重复原始文件名/);
    assert.deepEqual(snapshot(duplicate), duplicateBefore);
    assert.equal(fs.existsSync(path.join(temporary, 'profile-must-not-be-created')), false);
  }

  const nfc = workspace('nfc');
  input(nfc, 'raw/1/café_pn.txt');
  input(nfc, 'raw/2/cafe\u0301_pn.txt');
  assert.throws(() => m.planUpload(nfc, options), /重复原始文件名/);
  const tooLong = workspace('long');
  input(tooLong, 'raw/学生_pn.txt');
  assert.throws(() => m.prepareUpload(tooLong, { ...options, username: 'a'.repeat(25) }), /30 个字符/);
  assert.equal(fs.existsSync(path.join(tooLong, m.MANIFEST_FILE)), false);

  const crash = workspace('crash');
  input(crash, 'raw/batch/1/恢复_idfa.txt');
  input(crash, 'raw/batch/2/恢复_pn.txt');
  const crashPlan = m.planUpload(crash, options);
  m.writeManifest(crash, crashPlan.manifest);
  fs.mkdirSync(path.dirname(crashPlan.moves[0].target), { recursive: true });
  fs.renameSync(crashPlan.moves[0].source, crashPlan.moves[0].target);
  m.prepareUpload(crash, { ...options, jobId: 'retry' });
  assert.equal(m.readManifest(crash).files.length, 2);
  assert.ok(m.readManifest(crash).files.every((file) => file.jobId === options.jobId));
  const retryRecord = m.readManifest(crash).files[0];
  input(crash, `raw/again/${retryRecord.originalName}`);
  assert.throws(() => m.planUpload(crash, options), /重复原始文件名/);

  const empty = workspace('empty');
  input(empty, 'raw/空文件_pn.txt', '');
  m.prepareUpload(empty, options);
  assert.equal(m.readManifest(empty).files[0].stage, 'empty');
  assert.match(m.readManifest(empty).files[0].currentPath, /^pn\/done\//);
  assert.equal(m.pendingCandidates(empty).length, 0);
  const emptyCrash = workspace('empty-crash');
  input(emptyCrash, 'raw/empty_pn.txt', '');
  const emptyPlan = m.planUpload(emptyCrash, options);
  m.writeManifest(emptyCrash, emptyPlan.manifest);
  fs.mkdirSync(path.dirname(emptyPlan.moves[0].target), { recursive: true });
  fs.renameSync(emptyPlan.moves[0].source, emptyPlan.moves[0].target);
  m.prepareUpload(emptyCrash, { ...options, jobId: 'retry-empty' });
  assert.equal(m.readManifest(emptyCrash).files[0].stage, 'empty');
  const source = input(temporary, 'download-artificial.xlsx', '人工表格结果');
  const student = records.find((file) => file.originalName === '学生_idfa.txt');
  const saved = m.saveDownloadedFile(root, student.platformName, `${student.platformName}.xlsx`, source);
  assert.equal(path.basename(saved), '学生_idfa.xlsx');
  assert.equal(fs.readFileSync(saved, 'utf8'), '人工表格结果');
  assert.throws(() => m.saveDownloadedFile(root, student.platformName, 'anything.xlsx', source), /已存在/);
  assert.throws(() => m.resolveDownloadTarget(root, student.platformName, '../../outside.xlsx'), /不安全/);
  assert.throws(() => m.resolveDownloadTarget(root, 'missing_pn_1234abcd_1', 'x.xlsx'), /找不到平台名称/);
  assert.equal(path.basename(m.resolveDownloadTarget(root, '旧数据_pn.txt', '平台结果.xlsx')), '平台结果.xlsx');

  const legacy = workspace('legacy');
  input(legacy, 'raw/oldoccupation_pn.txt');
  assert.equal(m.planUpload(legacy, { username: '', jobId: '' }).named, false);
  assert.equal(fs.existsSync(path.join(legacy, m.MANIFEST_FILE)), false);
  input(legacy, 'createGroupToDoList.json', '["oldoccupation_pn"]');
  assert.throws(() => m.planUpload(legacy, options), /旧任务清单/);

  const symlink = workspace('symlink');
  const outside = workspace('outside');
  fs.symlinkSync(outside, path.join(symlink, 'raw', 'link'));
  assert.throws(() => m.planUpload(symlink, options), /符号链接/);
  const linkedManifest = workspace('linked-manifest');
  fs.symlinkSync(path.join(root, m.MANIFEST_FILE), path.join(linkedManifest, m.MANIFEST_FILE));
  assert.throws(() => m.readManifest(linkedManifest), /符号链接/);
  const archive = workspace('archive');
  fs.mkdirSync(path.join(archive, 'pn', 'done'), { recursive: true });
  fs.symlinkSync('/missing-archive-target', path.join(archive, 'pn', 'done', 'broken'));
  assert.deepEqual(m.pendingCandidates(archive), []);
  console.log('文件映射与上传预检测试通过');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

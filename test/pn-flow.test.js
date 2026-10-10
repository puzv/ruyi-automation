const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-pn-'));
function loadFunctions(script, marker, names) {
  const filename = path.join(root, script);
  const source = fs.readFileSync(filename, 'utf8').split(marker)[0];
  const context = { require: createRequire(filename), console, process, __dirname: root };
  vm.createContext(context);
  return vm.runInContext(`${source}\n({ ${names.join(', ')} })`, context);
}

try {
  const raw = path.join(temporary, 'raw');
  fs.mkdirSync(raw);
  fs.writeFileSync(path.join(raw, 'occupation_sample_PN_md5.txt'), 'phone-hash\n');
  fs.writeFileSync(path.join(raw, 'oaid_sample.txt'), 'oaid-hash\n');
  fs.writeFileSync(path.join(raw, 'idfa_sample.txt'), 'idfa-hash\n');
  fs.writeFileSync(path.join(raw, 'empty_pn.csv'), '');
  const batch = loadFunctions('uploadAll.js', '\nmain();', ['normalizeRawFileNames', 'getPendingFiles']);
  batch.normalizeRawFileNames(temporary);
  const result = spawnSync(process.execPath, [path.join(root, 'move.js')], {
    env: { ...process.env, RUYI_UPLOAD_DIR: temporary }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(temporary, 'pn', 'pnsamplemd5.txt')));
  assert.ok(fs.existsSync(path.join(temporary, 'pn', 'done', 'pnempty.csv')));
  assert.ok(fs.existsSync(path.join(temporary, 'oaid', 'oaidsample.txt')));
  assert.ok(fs.existsSync(path.join(temporary, 'idfa', 'idfasample.txt')));
  assert.equal(batch.getPendingFiles(temporary).length, 3);
  const upload = loadFunctions('upload.js', '\n(async () => {', ['appendCreateGroupTodoList']);
  upload.appendCreateGroupTodoList(temporary, [path.join(temporary, 'pn', 'pnsamplemd5.txt')]);
  const todoPath = path.join(temporary, 'createGroupToDoList.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(todoPath, 'utf8')), ['pnsamplemd5']);
  const create = loadFunctions('createGroup.js', '\nmain().catch', ['getGroupType', 'readNextFileName', 'recordAnalysedFile', 'removeFromCreateTodoList']);
  assert.equal(create.getGroupType('sample_PN.txt'), 'pn');
  assert.equal(create.getGroupType('oaid_sample.txt'), 'oaid');
  assert.equal(create.getGroupType('idfa_sample.txt'), 'idfa');
  const next = create.readNextFileName(temporary);
  create.recordAnalysedFile(next.analysePath, next.fileName, next.analysed);
  create.removeFromCreateTodoList(next.todoPath, next.fileName);
  assert.deepEqual(JSON.parse(fs.readFileSync(todoPath, 'utf8')), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(next.analysePath, 'utf8')), ['pnsamplemd5']);
  const { urls } = require('../config');
  assert.equal(new URL(urls.pnImport).searchParams.get('from'), 'dmp_MD5_MOBILE_PHONE');
  assert.equal(new URL(urls.pnUpload).searchParams.get('idType'), 'MD5_MOBILE_PHONE');
  console.log('PN flow checks passed');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

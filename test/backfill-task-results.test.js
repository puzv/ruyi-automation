const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { backfillTaskResults, assertLocal } = require('../scripts/backfill-task-results');

async function main() {
  const config = { host: '127.0.0.1', port: 3306, database: 'ruyi_dev', user: 'ruyi' };
  for (const changed of [{ host: 'localhost' }, { host: 'remote' }, { port: 3307 }, { database: 'ruyi_test' }, { user: 'root' }]) assert.throws(() => assertLocal({ ...config, ...changed }), /仅允许/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-backfill-'));
  const taskId = randomUUID(), jobId = randomUUID(), fileId = randomUUID();
  const task = { id: taskId, user_id: 1, username: 'fixture', status: 'succeeded', deleted_at: null, claim_token: null };
  const tables = { 'ruyi_tasks as t': [task], ruyi_jobs: [{ id: jobId, task_id: taskId, user_id: 1, task: 'download', status: 'succeeded', claim_token: null }],
    ruyi_task_files: [{ id: fileId, task_id: taskId, user_id: 1, original_name: '合成_pn.txt', excluded_at: null }], ruyi_task_result_sets: [], ruyi_task_results: [] };
  const db = {
    transaction: () => ({ execute: async (action) => {
      const before = structuredClone(tables);
      try { return await action(db); } catch (error) { Object.assign(tables, before); throw error; }
    } }),
    selectFrom(table) {
      const conditions = [];
      return { innerJoin() { return this; }, selectAll() { return this; }, select() { return this; }, forUpdate() { return this; }, orderBy() { return this; },
        where(key, operator, value) { conditions.push([key.replace(/^t\./, ''), operator, value]); return this; },
        async execute() { return tables[table].filter((row) => conditions.every(([key, operator, value]) => operator === 'is' ? row[key] == value : row[key] === value)); },
        async executeTakeFirst() { return (await this.execute())[0]; } };
    },
    insertInto(table) { return { values(value) { this.value = value; return this; }, async execute() { tables[table].push(...[].concat(this.value)); } }; },
  };
  const folder = path.join(root, 'users/fixture/tasks', taskId, 'execution/job-results', jobId, 'files');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, '合成_pn.xlsx');
  fs.writeFileSync(file, 'synthetic-only');
  const run = (apply = false) => backfillTaskResults({ db, config, taskId, root, apply });
  try {
    assert.equal((await run()).jobs[0].fileCount, 1);
    assert.equal(tables.ruyi_task_result_sets.length, 0, '默认 dry-run 不写库');
    fs.truncateSync(file, 0);
    await assert.rejects(run(), /为空/);
    fs.writeFileSync(file, 'synthetic-only');
    tables.ruyi_task_files.push({ ...tables.ruyi_task_files[0], id: randomUUID(), original_name: '合成_pn.csv' });
    await assert.rejects(run(), /同名主干/);
    tables.ruyi_task_files.pop();
    fs.writeFileSync(path.join(folder, 'unknown.json'), '{}');
    await assert.rejects(run(), /未知文件格式/);
    fs.renameSync(path.join(folder, 'unknown.json'), path.join(root, 'ignored.json'));
    const backup = path.join(root, 'backup.xlsx');
    fs.renameSync(file, backup);
    fs.symlinkSync(backup, file);
    await assert.rejects(run(), /路径不安全/);
    fs.unlinkSync(file); fs.renameSync(backup, file);
    const original = fs.statSync(file);
    await run(true);
    assert.equal(tables.ruyi_task_result_sets.length, 1);
    assert.equal(tables.ruyi_task_results[0].file_id, fileId);
    assert.equal(fs.statSync(file).mtimeMs, original.mtimeMs, '补建不修改原文件');
    assert.equal((await run(true)).jobs[0].skipped, true);
    assert.equal(tables.ruyi_task_results.length, 1, '已存在索引不覆盖');
    task.status = 'running';
    // 上述失败事务恢复会替换 FakeDB 对象，修改当前数据库引用。
    tables['ruyi_tasks as t'][0].status = 'running';
    await assert.rejects(run(), /终态整任务/);
    console.log('历史结果补建：本地库限制、只读预览、归属、符号链接拒绝、格式校验及幂等通过');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
module.exports = main();
module.exports.catch((error) => { console.error(error); process.exitCode = 1; });

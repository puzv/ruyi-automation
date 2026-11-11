const assert = require('node:assert/strict');
const { Kysely, DummyDriver, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler } = require('kysely');
const { checkStatement, createdTable } = require('../db/migration-guard');
const migration = require('../db/migrations/20261110_009_create_tasks');

async function main() {
  const statements = [];
  class RecordingDriver extends DummyDriver {
    async acquireConnection() {
      return {
        async executeQuery(query) { statements.push(query.sql.trim()); return { rows: [] }; },
        async *streamQuery() {},
      };
    }
  }
  const db = new Kysely({ dialect: {
    createAdapter: () => new MysqlAdapter(),
    createDriver: () => new RecordingDriver(),
    createIntrospector: (instance) => new MysqlIntrospector(instance),
    createQueryCompiler: () => new MysqlQueryCompiler(),
  } });
  try { await migration.up(db); } finally { await db.destroy(); }
  assert.equal(statements.length, 3);
  for (const statement of statements) {
    assert.equal(checkStatement(statement), null);
    assert.doesNotMatch(statement, /\b(SKIP LOCKED|NOWAIT|WITH|OVER|utf8mb4_0900_ai_ci|DELETE|DROP|TRUNCATE)\b/i);
    if (createdTable(statement)) assert.match(statement, /ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci/);
  }
  const [tasks, files, jobs] = statements;
  assert.equal(createdTable(tasks), 'ruyi_tasks');
  assert.match(tasks, /status ENUM\('queued','running','waiting_login','succeeded','failed','cancelled','interrupted'\)/);
  assert.doesNotMatch(tasks, /'draft'|'waiting'/);
  assert.match(tasks, /name VARCHAR\(128\) NOT NULL/);
  assert.match(tasks, /queue_order BIGINT UNSIGNED NOT NULL AUTO_INCREMENT/);
  assert.match(tasks, /UNIQUE KEY uk_ruyi_task_queue_order \(queue_order\)/);
  assert.match(tasks, /\(user_id, status, deleted_at, queued_at, queue_order\)/);
  for (const field of ['next_check_at', 'waiting_login_at', 'claim_token', 'heartbeat_at', 'version', 'deleted_at']) {
    assert.match(tasks, new RegExp(`\\b${field}\\b`));
  }
  assert.equal(createdTable(files), 'ruyi_task_files');
  assert.match(files, /UNIQUE KEY uk_ruyi_task_file_original \(task_id, original_name_key\)/);
  assert.match(files, /original_name_key VARBINARY\(1020\) NOT NULL/);
  assert.match(files, /UNIQUE KEY uk_ruyi_task_file_sequence \(task_id, sequence\)/);
  assert.match(files, /UNIQUE KEY uk_ruyi_task_file_platform \(platform_name\)/);
  assert.match(files, /\(task_id, excluded_at, stage\)/);
  assert.doesNotMatch(files, /\b(?:MEDIUMBLOB|LONGBLOB|CASCADE)\b/i);
  assert.match(jobs, /^ALTER TABLE ruyi_jobs\s+ADD COLUMN task_id CHAR\(36\) NULL/);
  for (const statement of [files, jobs]) {
    assert.match(statement, /FOREIGN KEY \(task_id, user_id\) REFERENCES ruyi_tasks \(id, user_id\)/);
  }
  await assert.rejects(migration.down(), /不支持自动回滚/);
  console.log('任务表结构测试通过：MySQL 5.7 SQL、安全检查、任务内文件唯一、用户归属、状态与旧记录兼容。');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

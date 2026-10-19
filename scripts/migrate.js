// 执行数据库迁移。
//
//   node scripts/migrate.js status    查看每个迁移是否已执行（只读）
//   node scripts/migrate.js plan      列出将要执行的迁移及其完整 SQL（只读，不连接执行）
//   node scripts/migrate.js up        执行所有未执行的迁移
//   node scripts/migrate.js down      回滚最近一个迁移（仅允许本地开发库）
//
// 安全措施（共享库 bsg_dw）：
// - 执行前检查：每条语句必须以 CREATE TABLE / ALTER TABLE / CREATE INDEX 开头，
//   且只作用于 ruyi_ 开头的表；外键也只能引用 ruyi_ 表；up 中不允许 DROP。
// - 执行前检查：要创建的表在库中已存在则停止，绝不覆盖。
// - 迁移记录表与锁表使用 ruyi_ 前缀，不与其他项目冲突。
// - down（会 DROP 表）只允许连接 localhost / 127.0.0.1。
// - up 需要输入数据库名确认；在终端外运行时需设置 RUYI_MIGRATE_CONFIRM=<库名>。
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { DummyDriver, Kysely, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler, sql } = require("kysely");
const { Migrator } = require("kysely/migration");
const { readDbConfig, createDb } = require("../db");
const { loadDotEnv } = require("../db/env");
const { tablePrefix, checkStatement, createdTable } = require("../db/migration-guard");

const migrationDir = path.join(__dirname, "..", "db", "migrations");
const migrationTableName = "ruyi_migrations";
const migrationLockTableName = "ruyi_migration_lock";

loadDotEnv(path.join(__dirname, "..", ".env"));

function migrationFiles() {
  return fs.readdirSync(migrationDir).filter((name) => /^\d{8}_\d{3}_[a-z0-9_]+\.js$/.test(name)).sort();
}

const migrationProvider = {
  async getMigrations() {
    const migrations = {};
    for (const file of migrationFiles()) migrations[file.replace(/\.js$/, "")] = require(path.join(migrationDir, file));
    return migrations;
  },
};

// Run each migration's up() against a Kysely instance whose driver records
// queries instead of sending them, so the exact SQL is known before anything
// touches a database.
async function captureSql(migration) {
  const statements = [];
  class RecordingDriver extends DummyDriver {
    async acquireConnection() {
      return {
        executeQuery: async (compiled) => { statements.push(compiled.sql.trim()); return { rows: [] }; },
        streamQuery: async function* stream() {},
      };
    }
  }
  const recorder = new Kysely({
    dialect: {
      createAdapter: () => new MysqlAdapter(),
      createDriver: () => new RecordingDriver(),
      createIntrospector: (db) => new MysqlIntrospector(db),
      createQueryCompiler: () => new MysqlQueryCompiler(),
    },
  });
  try {
    await migration.up(recorder);
  } finally {
    await recorder.destroy();
  }
  return statements.filter(Boolean);
}

async function pendingWithSql(db) {
  const migrations = await migrationProvider.getMigrations();
  let executed = new Set();
  if (db) {
    const exists = await tableExists(db, migrationTableName);
    if (exists) {
      const rows = await sql`SELECT name FROM ${sql.table(migrationTableName)}`.execute(db);
      executed = new Set(rows.rows.map((row) => row.name));
    }
  }
  const pending = [];
  for (const [name, migration] of Object.entries(migrations)) {
    if (executed.has(name)) continue;
    pending.push({ name, statements: await captureSql(migration) });
  }
  return pending;
}

async function tableExists(db, name) {
  const result = await sql`
    SELECT COUNT(*) AS n FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = ${name}
  `.execute(db);
  return Number(result.rows[0].n) > 0;
}

function validate(pending) {
  const problems = [];
  for (const item of pending) {
    if (!item.statements.length) problems.push(`${item.name}：没有生成任何 SQL`);
    for (const statement of item.statements) {
      const problem = checkStatement(statement);
      if (problem) problems.push(`${item.name}：${problem}`);
    }
  }
  return problems;
}

function isLocalHost(host) {
  return ["localhost", "127.0.0.1", "::1"].includes(String(host).toLowerCase());
}

async function confirm(database) {
  if (process.env.RUYI_MIGRATE_CONFIRM !== undefined) return process.env.RUYI_MIGRATE_CONFIRM === database;
  if (!process.stdin.isTTY) return false;
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => input.question(`确认在数据库 ${database} 上执行以上迁移？请输入库名确认：`, resolve));
  input.close();
  return answer.trim() === database;
}

function printPlan(pending) {
  if (!pending.length) { console.log("没有待执行的迁移。"); return; }
  for (const item of pending) {
    console.log(`\n=== ${item.name}`);
    for (const statement of item.statements) console.log(`${statement.replace(/^\s+/gm, "  ")};`);
  }
}

async function main() {
  const command = process.argv[2] || "status";
  if (!["status", "plan", "up", "down"].includes(command)) throw new Error(`未知命令：${command}`);

  if (command === "plan" && !process.env.RUYI_DB_HOST) {
    // Plan without a database: show every migration's SQL.
    const pending = await pendingWithSql(null);
    printPlan(pending);
    const problems = validate(pending);
    console.log(problems.length ? `\n安全检查未通过：\n- ${problems.join("\n- ")}` : "\n安全检查通过：只涉及 ruyi_ 开头的表，无删除或清空语句。");
    process.exitCode = problems.length ? 1 : 0;
    return;
  }

  const config = readDbConfig();
  // Refuse before connecting: rollback drops tables.
  if (command === "down" && !isLocalHost(config.host)) {
    throw new Error(`回滚会删除表，只允许在本地开发库执行（当前：${config.host}）。`);
  }
  const db = createDb(config);
  try {
    const version = (await sql`SELECT VERSION() AS v, DATABASE() AS d`.execute(db)).rows[0];
    console.log(`数据库：${config.user}@${config.host}:${config.port}/${version.d}（${version.v}）`);
    const migrator = new Migrator({ db, provider: migrationProvider, migrationTableName, migrationLockTableName });

    if (command === "status") {
      if (!await tableExists(db, migrationTableName)) {
        console.log(`尚未执行过任何迁移（${migrationTableName} 表不存在）。`);
        for (const file of migrationFiles()) console.log(`  未执行  ${file.replace(/\.js$/, "")}`);
        return;
      }
      for (const item of await migrator.getMigrations()) {
        console.log(`  ${item.executedAt ? `已执行 ${item.executedAt.toISOString()}` : "未执行"}  ${item.name}`);
      }
      return;
    }

    if (command === "down") {
      const { error, results } = await migrator.migrateDown();
      for (const item of results || []) console.log(`  ${item.status}  ${item.migrationName}（回滚）`);
      if (error) throw error;
      return;
    }

    const pending = await pendingWithSql(db);
    printPlan(pending);
    if (!pending.length) return;

    const problems = validate(pending);
    for (const item of pending) {
      for (const statement of item.statements) {
        const table = createdTable(statement);
        if (table && await tableExists(db, table)) problems.push(`${item.name}：表 ${table} 已存在，不会覆盖`);
      }
    }
    if (problems.length) throw new Error(`安全检查未通过，未执行任何迁移：\n- ${problems.join("\n- ")}`);
    console.log("\n安全检查通过：只涉及 ruyi_ 开头的表，无删除或清空语句，要创建的表均不存在。");
    if (command === "plan") return;

    if (!await confirm(version.d)) throw new Error("未确认，已取消。");
    const { error, results } = await migrator.migrateToLatest();
    for (const item of results || []) console.log(`  ${item.status}  ${item.migrationName}`);
    if (error) throw error;
    console.log("迁移完成。");
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(`迁移失败：${error.message}`);
  process.exitCode = 1;
});

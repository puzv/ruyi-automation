const { sql } = require('kysely')

async function up(db) {
  await sql`ALTER TABLE ruyi_task_files
    ADD COLUMN pending_operation ENUM('upload','create','analyse','download') NULL COMMENT '已开始但未确认的平台操作，非空时禁止自动重放',
    ADD COLUMN operation_job_id CHAR(36) NULL COMMENT '发起待确认操作的子流程，用于判断崩溃重试边界'`.execute(db)
}
async function down() {
  throw new Error('任务操作状态迁移不支持丢失执行证据的自动回滚')
}
module.exports = { up, down }

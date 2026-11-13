const { sql } = require('kysely')

async function up(db) {
  await sql`ALTER TABLE ruyi_task_files
    ADD COLUMN audience_deleted_at DATETIME(3) NULL COMMENT '洞悉确认成功后对应平台人群已清理的时间',
    ADD COLUMN audience_cleanup_pending TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '本版本确认洞悉成功后才允许自动清理，不回溯清理历史任务'`.execute(db)
}
async function down() {
  throw new Error('人群清理记录不支持自动回滚，请通过后续迁移保留清理证据')
}
module.exports = { up, down }

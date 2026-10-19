// 数据库表：用户操作记录（只追加）。
// 只创建本项目自己的表，不读写、不修改库中任何其他表。
// 不加外键并保存用户名快照：日志保持操作当时的样子，不随用户表变化。
const { sql } = require("kysely");

async function up(db) {
  await sql`
    CREATE TABLE ruyi_operation_logs (
      id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id       BIGINT UNSIGNED NULL COMMENT '登录失败、用户名不存在时为空',
      username      VARCHAR(32)  NULL COMMENT '操作时的用户名快照；登录失败时记录尝试的用户名',
      action        VARCHAR(64)  NOT NULL COMMENT '动作编码，如 auth.login、file.upload、job.start',
      target_type   VARCHAR(32)  NULL COMMENT '操作对象类型：file / job / user / session ...',
      target_id     VARCHAR(255) NULL COMMENT '对象标识：文件名、任务 ID、被操作的用户名',
      result        ENUM('success','failure') NOT NULL,
      error_message VARCHAR(1000) NULL,
      detail        JSON         NULL COMMENT '补充信息；不得包含密码、令牌、登录态、文件内容',
      ip            VARCHAR(45)  NULL,
      user_agent    VARCHAR(255) NULL,
      request_id    CHAR(36)     NULL COMMENT '同一次请求或任务的多条记录用它关联',
      created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      KEY idx_user_time (user_id, created_at),
      KEY idx_action_time (action, created_at),
      KEY idx_target (target_type, target_id(64)),
      KEY idx_time (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户操作记录，只追加'
  `.execute(db);
}

// 仅供本地开发库回滚使用；scripts/migrate.js 对非本地库拒绝执行回滚。
async function down(db) {
  await sql`DROP TABLE ruyi_operation_logs`.execute(db);
}

module.exports = { up, down };

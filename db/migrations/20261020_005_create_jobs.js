// 数据库表：持久化任务队列。
const { sql } = require("kysely");

async function up(db) {
  await sql`
    CREATE TABLE ruyi_jobs (
      id               CHAR(36)        NOT NULL COMMENT '任务 ID（UUID），同时作为 RUYI_JOB_ID 传给脚本',
      user_id          BIGINT UNSIGNED NOT NULL,
      username         VARCHAR(32)     NOT NULL COMMENT '启动时的用户名快照',
      task             ENUM('upload','create','analyse','download') NOT NULL,
      status           ENUM('queued','running','succeeded','failed','cancelled','interrupted') NOT NULL DEFAULT 'queued',
      headless         TINYINT(1)      NOT NULL DEFAULT 1 COMMENT '启动时的运行模式',
      request_id       CHAR(36)        NULL COMMENT '与操作记录关联',
      claim_token      CHAR(36)        NULL COMMENT 'Worker 认领时写入',
      worker_id        VARCHAR(128)    NULL,
      cancel_requested TINYINT(1)      NOT NULL DEFAULT 0,
      exit_code        INT             NULL,
      exit_signal      VARCHAR(16)     NULL,
      error_message    VARCHAR(1000)   NULL,
      state_refreshed  TINYINT(1)      NOT NULL DEFAULT 0,
      state_expired    TINYINT(1)      NOT NULL DEFAULT 0,
      log_path         VARCHAR(255)    NULL COMMENT '相对用户工作区的日志文件路径',
      queued_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      started_at       DATETIME(3)     NULL,
      finished_at      DATETIME(3)     NULL,
      heartbeat_at     DATETIME(3)     NULL COMMENT 'Worker 每 15 秒更新一次',
      PRIMARY KEY (id),
      KEY idx_status_queued (status, queued_at),
      KEY idx_user_queued (user_id, queued_at),
      KEY idx_user_status (user_id, status),
      CONSTRAINT fk_ruyi_job_user FOREIGN KEY (user_id) REFERENCES ruyi_users (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='任务队列'
  `.execute(db);
}

// 仅供本地开发库回滚使用；scripts/migrate.js 对非本地库拒绝执行回滚。
async function down(db) {
  await sql`DROP TABLE ruyi_jobs`.execute(db);
}

module.exports = { up, down };

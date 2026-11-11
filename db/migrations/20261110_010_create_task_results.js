const { sql } = require('kysely');

async function up(db) {
  await sql`CREATE TABLE ruyi_task_result_sets (
    job_id CHAR(36) NOT NULL,
    task_id CHAR(36) NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    sealed_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (job_id),
    KEY idx_ruyi_result_set_owner (task_id, user_id),
    CONSTRAINT fk_ruyi_result_set_task FOREIGN KEY (task_id, user_id) REFERENCES ruyi_tasks (id, user_id),
    CONSTRAINT fk_ruyi_result_set_job FOREIGN KEY (job_id) REFERENCES ruyi_jobs (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='下载轮次结果封存状态，替代磁盘 JSON 索引'`.execute(db);
  await sql`CREATE TABLE ruyi_task_results (
    id CHAR(36) NOT NULL,
    job_id CHAR(36) NOT NULL,
    file_id CHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    name_key VARBINARY(1020) NOT NULL,
    stored_path VARCHAR(512) NOT NULL,
    size_bytes BIGINT UNSIGNED NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uk_ruyi_result_name (job_id, name_key),
    UNIQUE KEY uk_ruyi_result_file (job_id, file_id),
    CONSTRAINT fk_ruyi_result_set FOREIGN KEY (job_id) REFERENCES ruyi_task_result_sets (job_id),
    CONSTRAINT fk_ruyi_result_file FOREIGN KEY (file_id) REFERENCES ruyi_task_files (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='结果文件数据库索引，文件正文仍存磁盘'`.execute(db);
}

async function down() {
  throw new Error('结果索引迁移不支持自动回滚，请使用后续增量迁移保留结果数据');
}

module.exports = { up, down };

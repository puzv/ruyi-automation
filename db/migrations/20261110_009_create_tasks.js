const { sql } = require('kysely');

async function up(db) {
  await sql`
    CREATE TABLE ruyi_tasks (
      id CHAR(36) NOT NULL COMMENT '完整任务编号，贯穿文件及四步流程',
      user_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(128) NOT NULL COMMENT '用户任务名称，未填写时由应用写入完整任务编号',
      status ENUM('queued','running','waiting_login','succeeded','failed','cancelled','interrupted') NOT NULL DEFAULT 'queued',
      current_step ENUM('upload','create','analyse','download') NOT NULL DEFAULT 'upload',
      queued_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '入队或用户明确恢复入队的时间，不是创建时间',
      queue_order BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '同毫秒入队时的稳定排序键',
      started_at DATETIME(3) NULL,
      finished_at DATETIME(3) NULL,
      next_check_at DATETIME(3) NULL COMMENT '等待平台异步结果的下次检查时间，整体仍为运行中',
      waiting_login_at DATETIME(3) NULL,
      claim_token CHAR(36) NULL COMMENT '整项任务执行租约，认领与状态回写需校验',
      worker_id VARCHAR(128) NULL,
      heartbeat_at DATETIME(3) NULL,
      cancel_requested TINYINT(1) NOT NULL DEFAULT 0,
      error_message VARCHAR(1000) NULL,
      version INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '编辑、删除文件与推进的乐观锁版本',
      deleted_at DATETIME(3) NULL COMMENT '软删除，不级联删除文件、执行记录或审计',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uk_ruyi_task_queue_order (queue_order),
      UNIQUE KEY uk_ruyi_task_owner (id, user_id),
      KEY idx_ruyi_task_queue (status, deleted_at, queued_at, queue_order),
      KEY idx_ruyi_task_user_queue (user_id, status, deleted_at, queued_at, queue_order),
      KEY idx_ruyi_task_check (status, next_check_at),
      KEY idx_ruyi_task_heartbeat (status, heartbeat_at),
      CONSTRAINT fk_ruyi_task_user FOREIGN KEY (user_id) REFERENCES ruyi_users (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='完整业务任务及整任务队列'
  `.execute(db);

  await sql`
    CREATE TABLE ruyi_task_files (
      id CHAR(36) NOT NULL COMMENT '文件唯一编号，删除和推进均使用此编号而非文件名',
      task_id CHAR(36) NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      sequence INT UNSIGNED NOT NULL COMMENT '任务内固定序号，删除后不重排或复用',
      original_name VARCHAR(255) NOT NULL COMMENT '初始文件名，仅元数据，不存文件内容',
      original_name_key VARBINARY(1020) NOT NULL COMMENT '应用写入 NFC 规范化文件名的 UTF-8 字节，任务内重名检查',
      file_type ENUM('idfa','oaid','pn') NOT NULL,
      size_bytes BIGINT UNSIGNED NOT NULL,
      content_sha256 CHAR(64) NULL COMMENT '可选内容摘要，不跨任务强制去重',
      original_path VARCHAR(512) NOT NULL COMMENT '相对任务工作区的初始文件路径，不接受绝对路径或上级路径',
      current_path VARCHAR(512) NOT NULL COMMENT '相对任务工作区的当前文件路径',
      platform_name VARCHAR(30) NULL COMMENT '平台名称，含任务标识，与初始文件名分离',
      platform_resource_id VARCHAR(128) NULL COMMENT '平台返回的文件或人群资源标识',
      stage ENUM('pending','uploading','uploaded','created','analysed','downloaded','empty') NOT NULL DEFAULT 'pending',
      error_message VARCHAR(1000) NULL,
      excluded_at DATETIME(3) NULL COMMENT '用户删除清单项后排除所有后续步骤，不表示撤回平台已提交操作',
      version INT UNSIGNED NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uk_ruyi_task_file_sequence (task_id, sequence),
      UNIQUE KEY uk_ruyi_task_file_original (task_id, original_name_key),
      UNIQUE KEY uk_ruyi_task_file_platform (platform_name),
      KEY idx_ruyi_task_file_owner (task_id, user_id),
      KEY idx_ruyi_task_file_pending (task_id, excluded_at, stage),
      CONSTRAINT fk_ruyi_task_file_owner FOREIGN KEY (task_id, user_id) REFERENCES ruyi_tasks (id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='任务文件清单与逐文件处理映射'
  `.execute(db);

  // 旧执行记录保持 NULL，不按时间猜测历史归属；原有代码可继续创建旧格式任务。
  await sql`
    ALTER TABLE ruyi_jobs
      ADD COLUMN task_id CHAR(36) NULL COMMENT '所属业务任务，旧记录为空；原 task 字段仍表示执行步骤',
      ADD KEY idx_ruyi_job_task (task_id, queued_at, id),
      ADD KEY idx_ruyi_job_task_owner (task_id, user_id),
      ADD CONSTRAINT fk_ruyi_job_task_owner FOREIGN KEY (task_id, user_id) REFERENCES ruyi_tasks (id, user_id)
  `.execute(db);
}

// 本次为保留数据的增量迁移，不提供会丢失任务数据的自动回滚。
async function down() {
  throw new Error('任务表迁移不支持自动回滚，请保留任务数据并使用后续增量迁移修正');
}

module.exports = { up, down };

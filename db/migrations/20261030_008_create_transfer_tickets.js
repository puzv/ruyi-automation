const { sql } = require('kysely');

async function up(db) {
  // 票据数据量较小，过期记录保留，不另设清理任务。
  await sql`
    CREATE TABLE ruyi_transfer_tickets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '票据编号',
      user_id BIGINT UNSIGNED NOT NULL COMMENT '所属用户编号',
      purpose ENUM('upload','download') NOT NULL COMMENT '票据用途',
      job_id CHAR(36) NULL COMMENT '下载结果任务编号',
      secret_hash CHAR(64) NOT NULL COMMENT '票据明文的 SHA-256 哈希',
      expires_at DATETIME NOT NULL COMMENT '过期时间',
      used_at DATETIME NULL COMMENT '领用时间',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
      PRIMARY KEY (id),
      UNIQUE KEY uk_secret_hash (secret_hash),
      KEY idx_user (user_id),
      CONSTRAINT fk_ruyi_transfer_tickets_user FOREIGN KEY (user_id) REFERENCES ruyi_users (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='一次性文件传输票据'
  `.execute(db);
}

async function down(db) {
  await sql`DROP TABLE ruyi_transfer_tickets`.execute(db);
}

module.exports = { up, down };

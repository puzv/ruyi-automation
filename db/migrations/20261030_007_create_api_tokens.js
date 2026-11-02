const { sql } = require('kysely');

async function up(db) {
  await sql`
    CREATE TABLE ruyi_api_tokens (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '令牌编号',
      user_id BIGINT UNSIGNED NOT NULL COMMENT '所属用户编号',
      name VARCHAR(64) NOT NULL COMMENT '令牌用途名称',
      display_prefix CHAR(13) NOT NULL COMMENT '用于辨认的令牌前缀',
      secret_hash CHAR(64) NOT NULL COMMENT '令牌明文的 SHA-256 哈希',
      last_used_at DATETIME NULL COMMENT '最后使用时间',
      expires_at DATETIME NOT NULL COMMENT '过期时间',
      revoked_at DATETIME NULL COMMENT '吊销时间',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
      PRIMARY KEY (id),
      UNIQUE KEY uk_secret_hash (secret_hash),
      KEY idx_user (user_id),
      CONSTRAINT fk_ruyi_api_tokens_user FOREIGN KEY (user_id) REFERENCES ruyi_users (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='个人访问令牌'
  `.execute(db);
}

async function down(db) {
  await sql`DROP TABLE ruyi_api_tokens`.execute(db);
}

module.exports = { up, down };

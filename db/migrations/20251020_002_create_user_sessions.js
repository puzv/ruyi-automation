// 数据库表：登录会话。
// 只创建本项目自己的表，不读写、不修改库中任何其他表。
const { sql } = require("kysely");

async function up(db) {
  await sql`
    CREATE TABLE ruyi_user_sessions (
      id           CHAR(64)        NOT NULL COMMENT '会话令牌的 SHA-256；Cookie 中存原始令牌，库里只存哈希',
      user_id      BIGINT UNSIGNED NOT NULL,
      ip           VARCHAR(45)     NULL,
      user_agent   VARCHAR(255)    NULL,
      created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at   DATETIME        NOT NULL,
      revoked_at   DATETIME        NULL COMMENT '退出登录、改密码、管理员踢下线时写入',
      PRIMARY KEY (id),
      KEY idx_user (user_id),
      KEY idx_expires (expires_at),
      CONSTRAINT fk_ruyi_session_user FOREIGN KEY (user_id) REFERENCES ruyi_users (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='登录会话'
  `.execute(db);
}

// 仅供本地开发库回滚使用；scripts/migrate.js 对非本地库拒绝执行回滚。
async function down(db) {
  await sql`DROP TABLE ruyi_user_sessions`.execute(db);
}

module.exports = { up, down };

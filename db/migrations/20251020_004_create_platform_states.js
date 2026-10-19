// 数据库表：平台（如翼 / DataNexus）登录态，AES-256-GCM 加密存储。
// 只创建本项目自己的表，不读写、不修改库中任何其他表。
const { sql } = require("kysely");

async function up(db) {
  await sql`
    CREATE TABLE ruyi_platform_states (
      id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id          BIGINT UNSIGNED NOT NULL COMMENT '每个用户一份，各自登录、互不影响',
      platform_account VARCHAR(64)  NULL COMMENT '登录的是哪个平台账号，仅用于显示',
      state_ciphertext MEDIUMBLOB   NULL COMMENT 'AES-256-GCM 加密后的 storageState：iv(12) + tag(16) + 密文；清除登录态时置空',
      key_version      SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '用哪个版本的密钥加密，便于换密钥',
      status           ENUM('valid','expired') NOT NULL DEFAULT 'valid',
      captured_at      DATETIME     NOT NULL COMMENT '用户扫码登录、导出的时间',
      refreshed_at     DATETIME     NULL COMMENT '最近一次任务成功后回写的时间',
      expires_hint_at  DATETIME     NULL COMMENT '根据关键 cookie 估算的过期时间，用于提醒',
      last_verified_at DATETIME     NULL COMMENT '最近一次确认两个站点都处于登录状态的时间',
      version          INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '每次回写加 1，防止并发回写互相覆盖',
      created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_user (user_id),
      CONSTRAINT fk_ruyi_state_user FOREIGN KEY (user_id) REFERENCES ruyi_users (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='平台登录态（加密）'
  `.execute(db);
}

// 仅供本地开发库回滚使用；scripts/migrate.js 对非本地库拒绝执行回滚。
async function down(db) {
  await sql`DROP TABLE ruyi_platform_states`.execute(db);
}

module.exports = { up, down };

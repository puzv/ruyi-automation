// 数据库表：平台用户。
// 只创建本项目自己的表，不读写、不修改库中任何其他表。
const { sql } = require("kysely");

async function up(db) {
  await sql`
    CREATE TABLE ruyi_users (
      id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      username             VARCHAR(32)  NOT NULL COMMENT '登录名，同时用作平台文件名前缀；仅 a-z 0-9 _，创建后不可修改',
      display_name         VARCHAR(64)  NOT NULL COMMENT '显示名，可用中文',
      password_hash        VARCHAR(255) NOT NULL COMMENT 'bcrypt 或 argon2id 哈希，绝不存明文',
      role                 ENUM('user','admin') NOT NULL DEFAULT 'user',
      status               ENUM('active','disabled') NOT NULL DEFAULT 'active' COMMENT '停用代替删除，保证操作记录可追溯',
      must_change_password TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '管理员创建或重置密码后，首次登录必须修改',
      password_changed_at  DATETIME     NULL,
      failed_login_count   INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '连续登录失败次数，成功后清零',
      locked_until         DATETIME     NULL COMMENT '连续失败过多时临时锁定到此时间',
      last_login_at        DATETIME     NULL,
      last_login_ip        VARCHAR(45)  NULL,
      created_by           BIGINT UNSIGNED NULL COMMENT '由哪个管理员创建',
      created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='平台用户'
  `.execute(db);
}

// 仅供本地开发库回滚使用；scripts/migrate.js 对非本地库拒绝执行回滚。
async function down(db) {
  await sql`DROP TABLE ruyi_users`.execute(db);
}

module.exports = { up, down };

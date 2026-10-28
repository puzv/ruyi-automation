// 数据库表：用户的自动推进偏好。
// 只创建本项目自己的表，不读写、不修改库中任何其他表。
// 只保存“是否开启”这一项设置；当前阶段、下次检查时间等运行状态放在进程内存里，
// 重启后按工作区文件和平台状态重新推导，避免库里留下过期进度。
const { sql } = require("kysely");

async function up(db) {
  await sql`
    CREATE TABLE ruyi_auto_advance (
      user_id    BIGINT UNSIGNED NOT NULL,
      enabled    TINYINT(1)      NOT NULL DEFAULT 1 COMMENT '是否自动查询平台并在就绪后推进下一个任务',
      updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id),
      CONSTRAINT fk_ruyi_auto_advance_user FOREIGN KEY (user_id) REFERENCES ruyi_users (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='自动推进偏好'
  `.execute(db);
}

// 仅供本地开发库回滚使用；scripts/migrate.js 对非本地库拒绝执行回滚。
async function down(db) {
  await sql`DROP TABLE ruyi_auto_advance`.execute(db);
}

module.exports = { up, down };

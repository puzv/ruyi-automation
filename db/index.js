// 数据库连接配置与 Kysely 实例。
// 连接信息只从环境变量读取（本地可放在 .env，K8s 用 Secret 注入），不写进代码。
const { CompiledQuery, Kysely, MysqlDialect } = require("kysely");
const { createPool } = require("mysql2");

function readDbConfig(env = process.env) {
  const missing = ["RUYI_DB_HOST", "RUYI_DB_USER", "RUYI_DB_NAME"].filter((name) => !env[name]);
  if (missing.length) throw new Error(`缺少数据库配置：${missing.join("、")}。请在 .env 或环境变量中设置。`);
  return {
    host: env.RUYI_DB_HOST,
    port: Number(env.RUYI_DB_PORT || 3306),
    user: env.RUYI_DB_USER,
    password: env.RUYI_DB_PASSWORD || "",
    database: env.RUYI_DB_NAME,
  };
}

function createDb(config = readDbConfig()) {
  return new Kysely({
    dialect: new MysqlDialect({
      pool: createPool({
        ...config,
        charset: "utf8mb4",
        // DATETIME has no zone; everything is Beijing time. `timezone` tells the
        // driver how to convert JS Dates, and onCreateConnection below makes the
        // server's NOW()/CURRENT_TIMESTAMP use the same zone.
        timezone: "+08:00",
        connectionLimit: 5,
        // Only one statement per query: a crafted value can never chain a second statement.
        multipleStatements: false,
      }),
      onCreateConnection: async (connection) => {
        await connection.executeQuery(CompiledQuery.raw("SET time_zone = '+08:00'"));
      },
    }),
  });
}

module.exports = { readDbConfig, createDb };

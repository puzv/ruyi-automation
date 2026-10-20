const path = require("path");
const { loadDotEnv } = require("../db/env");

if (!["RUYI_DB_HOST", "RUYI_DB_USER", "RUYI_DB_NAME", "RUYI_STATE_KEY"].every((key) => process.env[key])) {
  loadDotEnv(path.join(__dirname, "..", ".env"));
}

const { buildApp } = require("./app");
const { loadKeys } = require("./platform-state/crypto");

const { createDb } = require("../db");
const { createWorker } = require("./worker");
const { uploadRoot } = require("../config");
let app;
try {
  const stateKeys = loadKeys();
  const db = createDb();
  app = buildApp({ db, stateKeys });
  app.addHook("onClose", async () => { await db.destroy(); });
} catch (error) {
  console.error(`服务启动失败：${error.message}`);
  process.exit(1);
}
let closing = false;

async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    console.error(`服务关闭失败：${error.message}`);
    process.exit(1);
  }
}

// npm 与终端可能重复转发同一个信号；关闭期间继续由 closing 守卫接住。
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

app.listen({
  port: Number(process.env.RUYI_SERVER_PORT || 5173),
  host: process.env.RUYI_SERVER_HOST || "0.0.0.0",
}).then(async () => {
  if (process.env.RUYI_WORKER !== "off" && !closing) {
    app.worker = createWorker({ db: app.db, keys: app.stateKeys, log: app.log, dataRoot: uploadRoot });
    await app.worker.start();
  }
}).catch(async (error) => {
  console.error(`服务启动失败：${error.message}`);
  await app.close();
  process.exitCode = 1;
});

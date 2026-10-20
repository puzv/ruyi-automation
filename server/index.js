const path = require("path");
const { loadDotEnv } = require("../db/env");

loadDotEnv(path.join(__dirname, "..", ".env"));

const { buildApp } = require("./app");
const { loadKeys } = require("./platform-state/crypto");

const { createDb } = require("../db");
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

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

app.listen({
  port: Number(process.env.RUYI_SERVER_PORT || 5173),
  host: process.env.RUYI_SERVER_HOST || "0.0.0.0",
}).catch(async (error) => {
  console.error(`服务启动失败：${error.message}`);
  await app.close();
  process.exitCode = 1;
});

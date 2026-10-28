const path = require("path");
const { projectRoot } = require("@ruyi/shared/paths");
const { loadDotEnv } = require("../../../db/env");

if (!["RUYI_DB_HOST", "RUYI_DB_USER", "RUYI_DB_NAME", "RUYI_STATE_KEY"].every((key) => process.env[key])) {
  loadDotEnv(path.join(projectRoot, ".env"));
}

const { buildApp } = require("./app");
const { loadKeys } = require("@ruyi/shared/runtime/platform-state/crypto");

const { createDb } = require("../../../db");
const { createWorker } = require("@ruyi/worker/src/index");
const { createAutoAdvance } = require("./modules/auto-advance/engine");
const { uploadRoot } = require("@ruyi/shared/config");
let app;
let autoAdvance = null;
// 引擎在 buildApp 之前就要交给路由，但此时 app.log 还不存在，用代理延迟取值。
const lazyLog = {
  info: (message) => app?.log?.info?.(message),
  warn: (message) => app?.log?.warn?.(message),
  error: (message) => app?.log?.error?.(message),
};
try {
  const stateKeys = loadKeys();
  const db = createDb();
  // 引擎必须在 buildApp 之前创建：路由注册时就要拿到它，否则接口不会被挂载。
  // start() 仍要等监听之后再调用，避免和 Worker 恢复中断任务抢浏览器。
  if (process.env.RUYI_AUTO_ADVANCE !== "off") {
    autoAdvance = createAutoAdvance({ db, keys: stateKeys, log: lazyLog, dataRoot: uploadRoot });
  }
  app = buildApp({ db, stateKeys, autoAdvance });
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
    app.worker = createWorker({ db: app.db, keys: app.stateKeys, log: app.log, dataRoot: uploadRoot,
      // 引擎已创建，任务结束时直接唤醒它检查平台状态。
      onFinished: (job) => app.autoAdvance?.wake(job?.user_id ?? job?.userId) });
    await app.worker.start();
  }
  // 自动推进跟随 API 进程运行：按用户轮询平台并提交后续任务，
  // 不依赖用户页面是否打开。监听之后再启动，避免和 Worker 抢浏览器。
  if (app.autoAdvance && !closing) {
    await app.autoAdvance.start();
  }
}).catch(async (error) => {
  console.error(`服务启动失败：${error.message}`);
  await app.close();
  process.exitCode = 1;
});

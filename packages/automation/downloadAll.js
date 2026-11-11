const { projectRoot } = require("@ruyi/shared/paths");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const { stateFile } = require("@ruyi/shared/config");
const { requireUploadRoot } = require("./lib/paths");
const { readJsonArray } = require("./lib/files");
const { checkPreflight, waitForProfileRelease } = require("./lib/preflight");
const { TASK_OUTCOME } = require("@ruyi/shared/runtime/task-outcome");
const taskStore = require('@ruyi/shared/runtime/task-file-store');

const readDone = (donePath) => readJsonArray(donePath, "完成清单").filter((name) => typeof name === "string");

function runDownload() {
  const scriptPath = path.join(__dirname, "download.js");
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  if (result.error) throw new Error(`download.js 启动失败：${result.error.message}`);
  // spawnSync waits for Node, but Chrome can outlive the child briefly while
  // releasing the persistent profile lock. Do not start the next task early.
  if (!stateFile && !waitForProfileRelease({ timeoutMs: 30000 })) {
    throw new Error("download.js 已退出，但 Chrome profile 未及时释放；请稍后重试或关闭占用该 Profile 的 Chrome。");
  }
  if (result.status === TASK_OUTCOME.NOT_READY) return TASK_OUTCOME.NOT_READY;
  if (result.status !== 0) {
    const reason = result.signal ? `信号 ${result.signal}` : `退出码 ${result.status}`;
    throw new Error(`download.js 执行失败（${reason}）`);
  }
  return TASK_OUTCOME.SUCCESS;
}

function main({ spawnDownload = runDownload, root, donePath: donePathOption, log = console.log,
  preflight = true } = {}) {
  if (taskStore.enabled()) return taskStore.runAll('download', require.resolve('./download.js')).then((code) => ({ ok: code === TASK_OUTCOME.SUCCESS, code }));
  // 测试只关心结束判定，允许跳过依赖真实 profile 与浏览器目录的启动前检查。
  if (preflight) checkPreflight({ taskFiles: ["done.json"] });
  const uploadRoot = root || requireUploadRoot();
  const donePath = donePathOption || path.join(uploadRoot, "done.json");
  let pending = readDone(donePath);
  let round = 0;
  let stalled = 0;

  while (pending.length > 0) {
    round += 1;
    log(`开始第 ${round} 个下载任务：${pending[0]}（剩余 ${pending.length} 个）`);
    const before = pending.length;
    const outcome = spawnDownload();
    const completed = outcome === true || outcome === TASK_OUTCOME.SUCCESS;
    const remaining = readDone(donePath);
    // Always refresh the in-memory queue before deciding whether to stop. A
    // failed task is deliberately kept in done.json and may be rotated for a
    // later retry, so the old `pending` value is not a reliable completion
    // signal.
    pending = remaining;
    if (completed && remaining.length >= before) {
      log("download.js 执行成功，但完成清单没有减少，已停止以避免重复下载。");
      return { ok: false, pending: remaining.length };
    }
    if (!completed && remaining.length === before) {
      const done = readDone(donePath);
      if (done.length > 1) done.push(done.shift());
      fs.writeFileSync(donePath, `${JSON.stringify(done, null, 2)}\n`, "utf8");
      // Keep the in-memory queue aligned with the rotated on-disk order so
      // the next log entry names the task download.js will actually select.
      pending = done;
      stalled += 1;
      if (stalled >= done.length) {
        log("连续一轮下载任务均未就绪，暂时停止，保留 done.json 供下次重试。");
        break;
      }
    } else if (remaining.length < before) {
      stalled = 0;
    }
  }
  // Re-read after the loop because the stop condition may be a stalled round,
  // not successful completion. Never claim completion while entries remain.
  pending = readDone(donePath);
  if (pending.length === 0) {
    log("done.json 中没有待下载文件，全部下载完成。");
    return { ok: true, pending: 0 };
  }
  // 还有待下载文件说明本轮没有全部完成（多半是结果仍在 PROCESSING）。
  // 调用方必须让进程以非零退出，否则 Worker 会把任务记成 succeeded，
  // “我的任务”里就会出现一个成功但没有任何可下载文件的记录。
  log(`本轮下载已暂停，done.json 中仍有 ${pending.length} 个待下载文件，保留供下次重试。`);
  return { ok: false, pending: pending.length };
}

// 仅直接运行时执行；被测试 require 时只导出函数。
if (require.main === module) {
  Promise.resolve().then(() => main()).then((result) => {
    // 退出码 2 表示“未就绪，可稍后重试”，Worker 据此判为未成功，
    // 避免留下成功但没有可下载文件的任务记录。
    if (!result.ok) process.exitCode = result.code || TASK_OUTCOME.NOT_READY;
  }).catch((error) => {
    console.error(`批量下载失败：${error.message}`);
    process.exitCode = 1;
  }).finally(() => taskStore.close());
}

module.exports = { main, runDownload };

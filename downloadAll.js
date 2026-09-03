const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const { requireUploadRoot } = require("./lib/paths");
const { readJsonArray } = require("./lib/files");
const { checkPreflight, waitForProfileRelease } = require("./lib/preflight");

const readDone = (donePath) => readJsonArray(donePath, "完成清单").filter((name) => typeof name === "string");

function runDownload() {
  const scriptPath = path.join(__dirname, "download.js");
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: __dirname,
    stdio: "inherit",
  });
  if (result.error) throw new Error(`download.js 启动失败：${result.error.message}`);
  // spawnSync waits for Node, but Chrome can outlive the child briefly while
  // releasing the persistent profile lock. Do not start the next task early.
  if (!waitForProfileRelease({ timeoutMs: 30000 })) {
    throw new Error("download.js 已退出，但 Chrome profile 未及时释放；请稍后重试或关闭占用该 Profile 的 Chrome。");
  }
  if (result.status === 2) return false;
  if (result.status !== 0) {
    const reason = result.signal ? `信号 ${result.signal}` : `退出码 ${result.status}`;
    throw new Error(`download.js 执行失败（${reason}）`);
  }
}

function main() {
  checkPreflight({ taskFiles: ["done.json"] });
  const uploadRoot = requireUploadRoot();
  const donePath = path.join(uploadRoot, "done.json");
  let pending = readDone(donePath);
  let round = 0;
  let stalled = 0;

  while (pending.length > 0) {
    round += 1;
    console.log(`开始第 ${round} 个下载任务：${pending[0]}（剩余 ${pending.length} 个）`);
    const before = pending.length;
    const completed = runDownload();
    const remaining = readDone(donePath);
    // Always refresh the in-memory queue before deciding whether to stop. A
    // failed task is deliberately kept in done.json and may be rotated for a
    // later retry, so the old `pending` value is not a reliable completion
    // signal.
    pending = remaining;
    if (!completed && remaining.length === before) {
      const done = readDone(donePath);
      if (done.length > 1) done.push(done.shift());
      fs.writeFileSync(donePath, `${JSON.stringify(done, null, 2)}\n`, "utf8");
      stalled += 1;
      if (stalled >= done.length) {
        console.log("连续一轮下载任务均未就绪，暂时停止，保留 done.json 供下次重试。");
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
    console.log("done.json 中没有待下载文件，全部下载完成。");
  } else {
    console.log(`本轮下载已暂停，done.json 中仍有 ${pending.length} 个待下载文件，保留供下次重试。`);
  }
}

try {
  main();
} catch (error) {
  console.error(`批量下载失败：${error.message}`);
  process.exitCode = 1;
}

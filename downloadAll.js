const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const { requireUploadRoot } = require("./lib/paths");
const { readJsonArray } = require("./lib/files");
const { checkPreflight } = require("./lib/preflight");

const readDone = (donePath) => readJsonArray(donePath, "完成清单").filter((name) => typeof name === "string");

function runDownload() {
  const scriptPath = path.join(__dirname, "download.js");
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: __dirname,
    stdio: "inherit",
  });
  if (result.error) throw new Error(`download.js 启动失败：${result.error.message}`);
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
    pending = remaining;
  }
  console.log("done.json 中没有待下载文件，全部下载完成。");
}

try {
  main();
} catch (error) {
  console.error(`批量下载失败：${error.message}`);
  process.exitCode = 1;
}

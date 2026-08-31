const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { projectRoot } = require("./config");
const { requireUploadRoot } = require("./lib/paths");
const { readJsonArray } = require("./lib/files");
const { checkPreflight } = require("./lib/preflight");

function getPending(uploadRoot) {
  const todoPath = path.join(uploadRoot, "analysetodolist.json");
  if (!fs.existsSync(todoPath)) throw new Error(`找不到分析任务清单：${todoPath}`);
  const done = new Set(readJsonArray(path.join(uploadRoot, "done.json"), "完成清单")
    .filter((name) => typeof name === "string")
    .map((name) => path.basename(name)));
  return readJsonArray(todoPath, "分析任务清单")
    .filter((name) => typeof name === "string")
    .map((name) => path.basename(name))
    .filter((name, index, all) => !done.has(name) && all.indexOf(name) === index);
}

function runAnalyse() {
  const result = spawnSync(process.execPath, [path.join(projectRoot, "analyse.js")], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  if (result.error) throw new Error(`analyse.js 启动失败：${result.error.message}`);
  if (result.status === 2) return false;
  if (result.status !== 0) {
    const reason = result.signal ? `信号 ${result.signal}` : `退出码 ${result.status}`;
    throw new Error(`analyse.js 执行失败（${reason}）`);
  }
}

function main() {
  checkPreflight({ taskFiles: ["analysetodolist.json", "done.json"] });
  const uploadRoot = requireUploadRoot();

  let pending = getPending(uploadRoot);
  let round = 0;
  let stalled = 0;
  while (pending.length > 0) {
    round += 1;
    const current = pending[0];
    console.log(`开始第 ${round} 个分析任务：${current}（剩余 ${pending.length} 个）`);
    const before = pending.length;
    const completed = runAnalyse();
    const remaining = getPending(uploadRoot);
    if (!completed && remaining.length === before) {
      const todo = readJsonArray(path.join(uploadRoot, "analysetodolist.json"), "分析任务清单");
      if (todo.length > 1) todo.push(todo.shift());
      fs.writeFileSync(path.join(uploadRoot, "analysetodolist.json"), `${JSON.stringify(todo, null, 2)}\n`, "utf8");
      stalled += 1;
      if (stalled >= todo.length) {
        console.log("连续一轮分析任务均未就绪，暂时停止，保留分析任务清单供下次重试。");
        break;
      }
    } else if (remaining.length < before) {
      stalled = 0;
    }
    pending = remaining;
  }
  console.log("分析任务清单中没有待处理文件，全部分析完成。");
}

try {
  main();
} catch (error) {
  console.error(`批量分析失败：${error.message}`);
  process.exitCode = 1;
}

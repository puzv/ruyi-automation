const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
require("@ruyi/shared/playwright-env");
const { projectRoot } = require("@ruyi/shared/config");
const { requireUploadRoot } = require("./lib/paths");
const { readJsonArray } = require("./lib/files");
const { checkPreflight } = require("./lib/preflight");
const { TASK_OUTCOME } = require("@ruyi/shared/runtime/task-outcome");
const { withoutExtension } = require("@ruyi/shared/runtime/workspace");

function getPending(uploadRoot) {
  const todoPath = path.join(uploadRoot, "analyseToDoList.json");
  if (!fs.existsSync(todoPath)) throw new Error(`找不到分析任务清单：${todoPath}`);
  const done = new Set(readJsonArray(path.join(uploadRoot, "done.json"), "完成清单")
    .filter((name) => typeof name === "string")
    .map(withoutExtension));
  const seen = new Set();
  return readJsonArray(todoPath, "分析任务清单")
    .filter((name) => typeof name === "string")
    .map((name) => path.basename(name))
    .filter((name) => {
      const normalized = withoutExtension(name);
      if (!normalized || done.has(normalized) || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}

function runAnalyse() {
  const result = spawnSync(process.execPath, [path.join(__dirname, "analyse.js")], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  if (result.error) throw new Error(`analyse.js 启动失败：${result.error.message}`);
  if (result.status === TASK_OUTCOME.NOT_READY) return TASK_OUTCOME.NOT_READY;
  if (result.status !== 0) {
    const reason = result.signal ? `信号 ${result.signal}` : `退出码 ${result.status}`;
    throw new Error(`analyse.js 执行失败（${reason}）`);
  }
  return TASK_OUTCOME.SUCCESS;
}

function main() {
  checkPreflight({ taskFiles: ["analyseToDoList.json", "done.json"] });
  const uploadRoot = requireUploadRoot();

  let pending = getPending(uploadRoot);
  let round = 0;
  let stalled = 0;
  while (pending.length > 0) {
    round += 1;
    const current = pending[0];
    console.log(`开始第 ${round} 个分析任务：${current}（剩余 ${pending.length} 个）`);
    const before = pending.length;
    const outcome = runAnalyse();
    const completed = outcome === TASK_OUTCOME.SUCCESS;
    const remaining = getPending(uploadRoot);
    if (completed && remaining.length >= before) {
      console.error("analyse.js 执行成功，但分析任务清单没有减少，已停止以避免空跑或重复提交。");
      return TASK_OUTCOME.FAILURE;
    }
    if (!completed && remaining.length === before) {
      const todo = readJsonArray(path.join(uploadRoot, "analyseToDoList.json"), "分析任务清单");
      if (todo.length > 1) todo.push(todo.shift());
      fs.writeFileSync(path.join(uploadRoot, "analyseToDoList.json"), `${JSON.stringify(todo, null, 2)}\n`, "utf8");
      stalled += 1;
      if (stalled >= todo.length) {
        console.log("连续一轮分析任务均未就绪，暂时停止，保留分析任务清单供下次重试。");
        return TASK_OUTCOME.NOT_READY;
      }
    } else if (remaining.length < before) {
      stalled = 0;
    }
    pending = remaining;
  }
  if (pending.length === 0) {
    console.log("分析任务清单中没有待处理文件，全部分析完成。");
    return TASK_OUTCOME.SUCCESS;
  } else {
    console.log(`分析任务清单仍有 ${pending.length} 个任务未就绪，保留清单供稍后重试。`);
    return TASK_OUTCOME.NOT_READY;
  }
}

if (typeof module !== "undefined" && require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`批量分析失败：${error.message}`);
    process.exitCode = TASK_OUTCOME.FAILURE;
  }
}

if (typeof module !== "undefined") module.exports = { main, getPending, runAnalyse };

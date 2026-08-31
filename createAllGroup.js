const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { profileDir, chromePath, urls, uploadRootCandidates, projectRoot, audienceLimit } = require("./config");
const { launchBrowser } = require("./lib/browser");
const { findUploadRoot } = require("./lib/paths");
const { readJsonArray } = require("./lib/files");
const { checkPreflight } = require("./lib/preflight");

function findCreateTodoPath(uploadRoot) {
  const candidates = [
    path.join(uploadRoot, "createGroupToDoList.json"),
    path.join(uploadRoot, "creategrouptodolist.json"),
  ];
  return candidates.find((file) => fs.existsSync(file));
}

function readTodo(todoPath) {
  const content = fs.readFileSync(todoPath, "utf8").trim();
  if (!content) return [];

  const value = JSON.parse(content);
  if (!Array.isArray(value)) {
    throw new Error(`创建任务清单必须是文件名数组：${todoPath}`);
  }
  return value;
}

function runCreateGroup() {
  const scriptPath = path.join(projectRoot, "createGroup.js");
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: projectRoot,
    stdio: "inherit",
  });

  if (result.error) {
    throw new Error(`createGroup.js 启动失败：${result.error.message}`);
  }
  if (result.status === 2) return false;
  if (result.status !== 0) {
    const reason = result.signal ? `信号 ${result.signal}` : `退出码 ${result.status}`;
    throw new Error(`createGroup.js 执行失败（${reason}）`);
  }
}

async function inspectAudienceTotal() {
  const context = await launchBrowser();

  try {
    const page = context.pages()[0] || (await context.newPage());
    const listResponse = page.waitForResponse(
      (response) => response.url().includes("/api/audience/list"),
      { timeout: 60000 },
    );
    await page.goto(urls.audience, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (!page.url().startsWith(urls.audience)) {
      throw new Error(`打开人群列表后被重定向到：${page.url()}，可能需要登录。`);
    }

    // 页面底部是列表分页区域；滚动到底部后再读取接口返回的总记录数。
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const response = await listResponse;
    const payload = await response.json();
    const total = payload?.data?.listing?.total;
    if (!Number.isFinite(total)) {
      throw new Error("人群列表接口未返回有效的总记录数。");
    }
    console.log(`当前人群总记录数：${total}`);
    return total;
  } finally {
    await context.close();
    console.log("人群列表页面已关闭。");
  }
}

async function main() {
  checkPreflight({ taskFiles: ["createGroupToDoList.json", "creategrouptodolist.json", "analysetodolist.json", "analyseToDoList.json", "done.json"] });
  const uploadRoot = findUploadRoot();
  if (!uploadRoot) {
    throw new Error(`找不到 upload 目录，请创建：${uploadRootCandidates.join(" 或 ")}`);
  }

  const todoPath = findCreateTodoPath(uploadRoot);
  if (!todoPath) {
    throw new Error(
      `找不到创建任务清单：${[
        path.join(uploadRoot, "createGroupToDoList.json"),
        path.join(uploadRoot, "creategrouptodolist.json"),
      ].join(" 或 ")}`,
    );
  }

  let pending = readTodo(todoPath);
  if (pending.length > 0) {
    const audienceTotal = await inspectAudienceTotal();
    const createTodoCount = pending.length;
    const combinedCount = audienceTotal + createTodoCount;
    console.log(`当前人群总记录数 + 创建任务文件数：${audienceTotal} + ${createTodoCount} = ${combinedCount}`);
    if (combinedCount >= audienceLimit) {
      throw new Error(
        `人群总记录数（${audienceTotal}）与创建任务文件数（${createTodoCount}）之和为 ${combinedCount}，已达到或超过 ${audienceLimit}，程序中断。`,
      );
    }
  }
  let round = 0;
  let stalledRounds = 0;
  while (pending.length > 0) {
    round += 1;
    console.log(`开始第 ${round} 轮创建人群，剩余 ${pending.length} 个文件。`);
    const before = pending.length;
    const created = runCreateGroup();

    const remaining = readTodo(todoPath);
    if (!created && remaining.length === before) {
      // 当前文件尚未出现在平台：移到清单末尾，继续尝试其它文件。
      const todo = readTodo(todoPath);
      if (todo.length > 1) todo.push(todo.shift());
      fs.writeFileSync(todoPath, `${JSON.stringify(todo, null, 2)}\n`, "utf8");
      stalledRounds += 1;
      if (stalledRounds >= todo.length) {
        console.log("连续一轮文件均未在平台找到，暂时停止，保留待创建清单供下次重试。");
        break;
      }
    } else if (remaining.length < before) {
      stalledRounds = 0;
    }
    pending = remaining;
  }

  console.log("创建任务清单已清空，所有人群创建操作完成。");
}

main().catch((error) => {
  console.error(`批量创建人群失败：${error.message}`);
  process.exitCode = 1;
});

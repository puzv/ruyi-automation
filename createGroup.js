const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");
const { profileDir, chromePath, uploadRootCandidates, urls, browserHeadless } = require("./config");
const { requireUploadRoot } = require("./lib/paths");
const { readJsonArray, writeJsonArray } = require("./lib/files");
const { launchBrowser, closeBrowserContext } = require("./lib/browser");
const { checkPreflight } = require("./lib/preflight");

const groupUrls = {
  idfa: urls.idfaUpload,
  oaid: urls.oaidUpload,
};

function withoutExtension(fileName) {
  return path.basename(fileName).replace(/\.[^.]+$/, "");
}

function getGroupType(fileName) {
  const lowerName = path.basename(fileName).toLowerCase();
  if (lowerName.includes("idfa")) return "idfa";
  if (lowerName.includes("oaid")) return "oaid";
  return null;
}

const getUploadRoot = () => requireUploadRoot();


function readNextFileName(uploadRoot) {
  const todoCandidates = [
    path.join(uploadRoot, "createGroupToDoList.json"),
    path.join(uploadRoot, "creategrouptodolist.json"),
  ];
  const todoPath = todoCandidates.find((file) => fs.existsSync(file));
  if (!todoPath) throw new Error(`找不到创建任务清单：${todoCandidates.join(" 或 ")}`);

  const todo = readJsonArray(todoPath, "创建任务清单");

  const analysePath = path.join(uploadRoot, "analyseToDoList.json");
  const analysed = readJsonArray(analysePath, "分析任务清单");

  const analysedSet = new Set(analysed.filter((name) => typeof name === "string").map(withoutExtension));
  const fileName = todo.find((name) => (
    typeof name === "string" && !analysedSet.has(withoutExtension(name))
  ));
  if (!fileName) throw new Error("创建任务清单中没有待处理文件。");
  return { fileName, todoPath, analysePath, analysed };
}

function recordAnalysedFile(analysePath, fileName, previousAnalysed = []) {
  const analysed = readJsonArray(analysePath, "分析任务清单");
  previousAnalysed.forEach((name) => {
    if (!analysed.includes(name)) analysed.push(name);
  });
  const normalized = withoutExtension(fileName);
  const normalizedAnalysed = analysed.map((name) => (typeof name === "string" ? withoutExtension(name) : name));
  if (!normalizedAnalysed.includes(normalized)) analysed.push(normalized);
  writeJsonArray(analysePath, analysed);
  console.log(`已写入分析任务清单：${fileName}`);
}

function removeFromCreateTodoList(todoPath, fileName) {
  const todo = readJsonArray(todoPath, "创建任务清单");
  const normalized = withoutExtension(fileName);
  const remaining = todo.filter((name) => (
    typeof name !== "string" || withoutExtension(name) !== normalized
  ));
  writeJsonArray(todoPath, remaining);
  console.log(`已从创建任务清单移除：${fileName}`);
}

function waitForEnter(message = "页面操作完成后按回车关闭浏览器：") {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    input.question(message, () => {
      input.close();
      resolve();
    });
  });
}

async function selectAudienceFile(page, fileName) {
  const requestedName = path.basename(fileName);
  const nameWithoutExtension = requestedName.replace(/\.[^.]+$/, "");
  const normalizeName = (name) => name.replace(/\s+/g, " ").trim();
  const candidates = new Set([
    normalizeName(requestedName),
    normalizeName(nameWithoutExtension),
  ]);
  const list = page.locator(".file-select-wrap-left-table");
  await list.waitFor({ state: "visible", timeout: 30000 });
  const rows = list.locator("tr.spaui-table-tr-data");
  await rows.first().waitFor({ state: "visible", timeout: 30000 });
  const fileCells = rows.locator('td[data-index="2"]');
  let matchedRow = null;
  const displayedNames = [];
  async function findVisibleMatch() {
    for (let index = 0; index < await fileCells.count(); index += 1) {
      const displayedName = normalizeName(await fileCells.nth(index).innerText());
      if (!displayedNames.includes(displayedName)) displayedNames.push(displayedName);
      if (candidates.has(displayedName)) return rows.nth(index);
    }
    return null;
  }
  matchedRow = await findVisibleMatch();

  if (!matchedRow) {
    const search = page.locator('input[placeholder="搜索文件ID/名称"]').first();
    if (await search.count()) {
      await search.fill(nameWithoutExtension);
      await page.waitForTimeout(800);
      matchedRow = await findVisibleMatch();
    }
  }

  if (!matchedRow) {
    throw new Error(`列表中找不到文件名称：${requestedName}；当前页面文件：${displayedNames.join("、")}`);
  }

  const checkbox = matchedRow.locator('input.check, input[type="checkbox"]').first();
  const checkboxLabel = matchedRow.locator("label.spaui-checkbox").first();
  if (!(await checkbox.isChecked())) {
    if (await checkboxLabel.count() > 0) {
      await checkboxLabel.click();
    } else {
      await checkbox.check();
    }
  }
  await page.waitForTimeout(200);
  if (!(await checkbox.isChecked())) {
    throw new Error(`文件名称已找到，但复选框未能选中：${requestedName}`);
  }

  console.log(`已选中人群文件：${displayedNameForLog(requestedName, nameWithoutExtension)}`);
}

async function fillGroupInfo(page, fileName) {
  const groupName = page.locator('input[placeholder="请输入人群名称"]').first();
  const groupDescription = page.locator('input[placeholder="请输入人群描述"]').first();
  await groupName.waitFor({ state: "visible", timeout: 30000 });
  await groupDescription.waitFor({ state: "visible", timeout: 30000 });

  const name = path.basename(fileName);
  await groupName.fill(name);
  await groupDescription.fill(name);

  if (await groupName.inputValue() !== name || await groupDescription.inputValue() !== name) {
    throw new Error(`文件名已找到并选中，但人群名称或描述填充失败：${name}`);
  }
  console.log(`已填入人群名称和描述：${name}`);
}

async function submitGroup(page) {
  const submitButton = page.getByRole("button", { name: "提交", exact: true }).last();
  await submitButton.waitFor({ state: "visible", timeout: 30000 });
  const deadline = Date.now() + 30000;
  while (!(await submitButton.isEnabled().catch(() => false))) {
    if (Date.now() >= deadline) {
      throw new Error("提交按钮在 30 秒内没有变为可用");
    }
    await page.waitForTimeout(200);
  }
  await submitButton.click();
  await page.waitForTimeout(1000);
  console.log("已点击提交。");
}

function displayedNameForLog(requestedName, nameWithoutExtension) {
  return requestedName === nameWithoutExtension
    ? requestedName
    : `${requestedName}（页面匹配 ${nameWithoutExtension}）`;
}

async function main() {
  checkPreflight({ taskFiles: ["createGroupToDoList.json", "creategrouptodolist.json", "analyseToDoList.json"] });
  const uploadRoot = getUploadRoot();
  const { fileName, todoPath, analysePath, analysed } = readNextFileName(uploadRoot);
  const groupType = getGroupType(fileName);
  if (!groupType) {
    console.error(`文件名中不含 idfa 或 oaid，无法确定创建地址：${fileName}`);
    process.exitCode = 1;
    return;
  }

  const context = await launchBrowser();

  try {
    const page = context.pages()[0] || (await context.newPage());
    const url = groupUrls[groupType];
    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (!page.url().includes("/audience/dnUpload")) {
      if (browserHeadless) {
        throw new Error("当前未登录或未进入人群文件页面；无头模式无法进行人工登录，请先用可视模式登录后再重试。");
      }
      await waitForEnter("请完成登录并进入人群文件页面后按回车继续：");
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    await selectAudienceFile(page, fileName);
    await fillGroupInfo(page, fileName);
    await submitGroup(page);
    recordAnalysedFile(analysePath, fileName, analysed);
    removeFromCreateTodoList(todoPath, fileName);
    console.log(`已根据 ${fileName} 跳转到 ${groupType.toUpperCase()} 创建地址：${url}`);
  } finally {
    await closeBrowserContext(context);
    console.log("浏览器已关闭。");
  }
}

main().catch((error) => {
  console.error(`创建地址跳转失败：${error.message}`);
  process.exitCode = /列表中找不到文件名称/.test(error.message) ? 2 : 1;
});

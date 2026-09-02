const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");
const { profileDir, chromePath, uploadRootCandidates, urls, browserHeadless } = require("./config");
const { requireUploadRoot } = require("./lib/paths");
const { readJsonArray, writeJsonArray } = require("./lib/files");
const { launchBrowser } = require("./lib/browser");
const { checkPreflight } = require("./lib/preflight");

function withoutExtension(fileName) {
  return path.basename(fileName).replace(/\.[^.]+$/, "");
}

function resolveTask(uploadRoot) {
  const listPath = path.join(uploadRoot, "analyseToDoList.json");
  if (!fs.existsSync(listPath)) {
    throw new Error(`找不到分析任务清单：${listPath}`);
  }
  const donePath = path.join(uploadRoot, "done.json");
  const pending = readJsonArray(listPath, "分析任务清单");
  const done = new Set(readJsonArray(donePath, "完成清单")
    .filter((name) => typeof name === "string")
    .map(withoutExtension));
  const fileName = pending.find((name) => (
    typeof name === "string" && !done.has(withoutExtension(name))
  ));
  if (!fileName) throw new Error("分析任务清单中没有待处理文件。");
  return { fileName: path.basename(fileName), donePath, listPath };
}

function resolveTaskFromUpload() {
  const uploadRoot = requireUploadRoot();
  return { uploadRoot, ...resolveTask(uploadRoot) };
}

function recordDone(donePath, listPath, fileName) {
  const done = readJsonArray(donePath, "完成清单");
  const normalized = withoutExtension(fileName);
  const normalizedDone = done.map((name) => (typeof name === "string" ? withoutExtension(name) : name));
  if (!normalizedDone.includes(normalized)) done.push(normalized);
  writeJsonArray(donePath, done);
  console.log(`已写入完成清单：${donePath}`);

  const todo = readJsonArray(listPath, "分析任务清单");
  const remaining = todo.filter((name) => (
    typeof name !== "string" || withoutExtension(name) !== normalized
  ));
  writeJsonArray(listPath, remaining);
  console.log(`已从分析任务清单移除：${fileName}`);
}

function waitForEnter(message) {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => input.question(message, () => { input.close(); resolve(); }));
}

async function selectAudience(page, fileName) {
  const requested = path.basename(fileName);
  const stem = requested.replace(/\.[^.]+$/, "");
  const normalize = (value) => value.replace(/\s+/g, " ").trim();
  const candidates = new Set([normalize(requested), normalize(stem)]);

  const placeholder = page.getByText("请选择", { exact: true }).first();
  const trigger = await placeholder.isVisible().catch(() => false)
    ? placeholder
    : page.locator(".ndmp-audience-select:visible").first();
  await trigger.waitFor({ state: "visible", timeout: 30000 });
  await trigger.click();

  // 打开后页面同时保留字段本身和 portal 下拉层，后者带有 spaui-select-portal。
  const dropdown = page.locator(".ndmp-audience-select.spaui-select-portal");
  await dropdown.waitFor({ state: "attached", timeout: 30000 });
  const search = page.locator('input[placeholder="搜索"]:visible').first();
  await search.waitFor({ state: "visible", timeout: 30000 });
  await search.fill(stem);
  const rows = page.locator("ul.selection-results:visible li.selection-info");
  await rows.first().waitFor({ state: "visible", timeout: 30000 });

  let match = null;
  const displayed = [];
  for (let i = 0; i < await rows.count(); i += 1) {
    const row = rows.nth(i);
    const nameNode = row.locator(".audience-name").first();
    const name = normalize(
      (await nameNode.getAttribute("title").catch(() => "")) ||
      (await nameNode.innerText().catch(() => "")),
    );
    displayed.push(name);
    if (!candidates.has(name)) continue;
    const state = normalize([
      await row.innerText().catch(() => ""),
      await row.getAttribute("class").catch(() => ""),
      await row.getAttribute("aria-disabled").catch(() => ""),
      await row.getAttribute("title").catch(() => ""),
    ].join(" ")).toLowerCase();
    if (/(计算中|处理中|生成中|processing|pending|disabled|不可用)/i.test(state)) {
      throw new Error(`人群包“${requested}”正在计算中或暂不可用，已停止提交，请稍后重试`);
    }
    match = row;
    break;
  }
  if (!match) throw new Error(`下拉列表中找不到“${requested}”（搜索结果：${displayed.join("、")}）`);
  await match.click();
  await page.waitForTimeout(300);
  const selectedControl = page.locator(".ndmp-audience-select:visible").first();
  const selectedText = normalize(
    (await selectedControl.locator(".selection-single-text").innerText().catch(() => "")) ||
    (await selectedControl.innerText().catch(() => "")),
  );
  if (!candidates.has(selectedText) && !selectedText.includes(stem) && !selectedText.includes(requested)) {
    throw new Error(`人群包“${requested}”未成功选中，已停止提交以避免创建空洞悉任务`);
  }
  console.log(`已选中人群包：${requested}${requested === stem ? "" : `（页面名称：${stem}）`}`);
}

function monitorPage(page) {
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      console.log(`[页面${message.type()}] ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => console.log(`[页面异常] ${error.message}`));
  page.on("requestfailed", (request) => {
    console.log(`[请求失败] ${request.method()} ${request.url()}：${request.failure()?.errorText || "未知错误"}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) console.log(`[HTTP ${response.status()}] ${response.request().method()} ${response.url()}`);
  });
}

async function fillTaskName(page, fileName) {
  const requested = path.basename(fileName);
  const taskName = page.locator('input[placeholder="请输入洞察任务名称"]').first();
  await taskName.waitFor({ state: "visible", timeout: 30000 });
  await taskName.fill(requested);
  if (await taskName.inputValue() !== requested) {
    throw new Error(`任务名称填充失败：${requested}`);
  }
  console.log(`已填入任务名称：${requested}`);
}

async function selectFilterTag(page, filterName, tagName) {
  const title = page.getByText(filterName, { exact: true }).first();
  await title.waitFor({ state: "visible", timeout: 30000 });
  let filter = title.locator("..");
  let tag = null;
  // 页面版本变化时，标签可能位于标题的父级或祖父级容器中。
  for (let level = 0; level < 3 && !tag; level += 1) {
    const candidate = filter.locator(".tags-third:visible").filter({ hasText: tagName }).first();
    if (await candidate.count()) {
      tag = candidate;
      break;
    }
    const textCandidate = filter.getByText(tagName, { exact: true }).first();
    if (await textCandidate.count() && await textCandidate.isVisible().catch(() => false)) {
      tag = textCandidate;
      break;
    }
    filter = filter.locator("..");
  }
  if (!tag) throw new Error(`找不到${filterName}中的选项：${tagName}`);
  await tag.waitFor({ state: "visible", timeout: 30000 });
  await tag.click();
  await page.waitForTimeout(250);
  console.log(`已选择${filterName}：${tagName}`);
}

async function selectInsightFilters(page) {
  // “全部”用于清除该分组的其它条件；only-one 标签直接选择目标维度。
  await selectFilterTag(page, "基本信息", "全部");
  await selectFilterTag(page, "工作状态", "预测职业类型");
  await selectFilterTag(page, "地域属性", "全部");
  await selectFilterTag(page, "消费属性", "消费水平");
  await selectFilterTag(page, "设备信息", "全部");
  await selectFilterTag(page, "资产状况", "全部");
}

async function submitInsight(page) {
  const namedSubmit = page.getByRole("button", { name: "提交", exact: true }).last();
  const submit = await namedSubmit.isVisible().catch(() => false)
    ? namedSubmit
    : page.locator('button[type="submit"]:visible').last();
  await submit.waitFor({ state: "visible", timeout: 30000 });
  const deadline = Date.now() + 30000;
  while (!(await submit.isEnabled().catch(() => false))) {
    if (Date.now() >= deadline) throw new Error("提交按钮在 30 秒内没有变为可用");
    await page.waitForTimeout(200);
  }

  const createResponse = page.waitForResponse(
    (response) => response.url().includes("/api/insight/create") && response.request().method() === "POST",
    { timeout: 60000 },
  ).catch(() => null);
  await submit.click();
  const response = await createResponse;
  let responseBody = null;
  if (response) responseBody = await response.json().catch(() => null);
  const navigationDeadline = Date.now() + 10000;
  while (
    !page.url().includes("/audience-profile/result")
    && !page.url().endsWith("/insight/insight")
    && Date.now() < navigationDeadline
  ) {
    await page.waitForTimeout(250);
  }
  const navigated = page.url().includes("/audience-profile/result") || page.url().endsWith("/insight/insight");
  if (!navigated && !responseBody?.success) {
    const errors = await page.locator('[role="alert"]:visible, .spaui-form-item-error:visible, .error:visible').allInnerTexts().catch(() => []);
    throw new Error(`洞察提交后未跳转${errors.length ? `：${errors.join("；")}` : "，请检查必填项和筛选项"}`);
  }
  console.log(`提交成功${navigated ? `，已跳转：${page.url()}` : "（接口已确认成功）"}`);
}

async function main() {
  checkPreflight({ taskFiles: ["analyseToDoList.json", "done.json"] });
  const { fileName, donePath, listPath } = resolveTaskFromUpload();
  const context = await launchBrowser();
  try {
    const page = context.pages()[0] || await context.newPage();
    monitorPage(page);
    await page.goto(urls.insightCreate, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);
    if (!page.url().includes("/insight/create")) {
      if (browserHeadless) {
        throw new Error("当前未登录或未进入洞察创建页面；无头模式无法进行人工登录，请先用可视模式登录后再重试。");
      }
      await waitForEnter("请完成登录并进入洞察创建页面后按回车继续：");
      await page.goto(urls.insightCreate, { waitUntil: "domcontentloaded" });
    }
    await selectAudience(page, fileName);
    await fillTaskName(page, fileName);
    await selectInsightFilters(page);
    await submitInsight(page);
    recordDone(donePath, listPath, fileName);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(`分析页面操作失败：${error.message}`);
  process.exitCode = /找不到|不可用|没有待处理|计算中|处理中|未成功选中|暂不可用/.test(error.message) ? 2 : 1;
});

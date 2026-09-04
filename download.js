const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { profileDir, chromePath, urls, resultDirCandidates, uploadRootCandidates } = require("./config");
const resultUrl = urls.result;
const { requireUploadRoot } = require("./lib/paths");
const { readJsonArray, writeJsonArray, ensureDir } = require("./lib/files");
const { launchBrowser, closeBrowserContext } = require("./lib/browser");
const { checkPreflight } = require("./lib/preflight");

function resolveDoneTask() {
  const uploadRoot = requireUploadRoot();
  const donePath = path.join(uploadRoot, "done.json");
  const fileName = readJsonArray(donePath, "完成清单").find((name) => typeof name === "string");
  if (!fileName) throw new Error(`完成清单中没有待下载文件：${donePath}`);
  return { donePath, fileName: path.basename(fileName) };
}

function removeDoneFile(donePath, fileName) {
  const remaining = readJsonArray(donePath, "完成清单")
    .filter((name) => typeof name !== "string" || path.basename(name) !== fileName);
  writeJsonArray(donePath, remaining);
  console.log(`已从完成清单移除：${fileName}`);
}

function getResultDir() {
  const existing = resultDirCandidates.find((dir) => fs.existsSync(path.dirname(dir)));
  const resultDir = existing || resultDirCandidates[resultDirCandidates.length - 1];
  ensureDir(resultDir);
  return resultDir;
}

async function selectTask(page, fileName) {
  const requested = path.basename(fileName);
  const stem = requested.replace(/\.[^.]+$/, "");
  // The result list is paginated (often hundreds of pages), so always use the
  // built-in search rather than walking pages one by one.
  const searchTrigger = page.getByText("搜索", { exact: true }).first();
  await searchTrigger.waitFor({ state: "visible", timeout: 30000 });
  await searchTrigger.click();
  const input = page.locator('input[placeholder="请输入关键词或ID"]:visible').first();
  await input.waitFor({ state: "visible", timeout: 10000 });
  const searchResponse = page.waitForResponse((response) => {
    if (!response.url().includes("/api/insight/list") || response.request().method() !== "POST") return false;
    try {
      const payload = JSON.parse(response.request().postData() || "{}");
      return payload?.filtering?.some((entry) => entry.field === "keyword"
        && entry.values?.includes(stem));
    } catch (_) {
      return false;
    }
  }, { timeout: 15000 }).catch(() => null);
  await input.fill(stem);

  // Search is debounced by the UI. Waiting for its API response prevents the
  // previous page's same-named card from winning the selection race.
  if (!await searchResponse) throw new Error(`搜索分析任务失败：未收到结果列表响应（关键词：${stem}）`);
  // Allow the response handler/React render to replace the card list before
  // inspecting status dots (the response can precede DOM reconciliation).
  await page.waitForTimeout(250);
  const found = await page.waitForFunction(({ requestedName, stemName }) => {
    const titles = [...document.querySelectorAll(".listItem--G0aPY .title--cpoFh")]
      .map((node) => node.innerText.trim());
    return titles.some((title) => title === requestedName || title === stemName);
  }, { requestedName: requested, stemName: stem }, { timeout: 15000 }).catch(() => false);
  if (!found) throw new Error(`分析任务列表中找不到：${requested}`);

  const items = page.locator(".listItem--G0aPY");
  const matches = [];
  for (let i = 0; i < await items.count(); i += 1) {
    const card = items.nth(i);
    const title = (await card.locator(".title--cpoFh").innerText()).trim();
    if (title !== requested && title !== stem) continue;
    // Search results are sorted by lastModifiedTime descending. Duplicate
    // names can therefore include an older SUCCESS record and a newer queued
    // record; keep the newest card so we do not download stale data.
    matches.push({ card, title });
  }
  if (matches.length) {
    const { card, title } = matches[0];
    await card.click();
    await page.waitForFunction((expected) => {
      const active = document.querySelector(".listItem--G0aPY.active--okDqb .title--cpoFh");
      return active && active.innerText.trim() === expected;
    }, title, { timeout: 30000 });
    console.log(`已选择分析任务：${title}`);
    return;
  }
  throw new Error(`分析任务列表中找不到：${requested}`);
}

async function ensureTaskReady(page, fileName) {
  const requested = path.basename(fileName);
  // The result detail loads asynchronously after the list item becomes active.
  // A queued/processing task still exposes a "下载数据" button, but the
  // server responds with a 48-byte JSON error disguised as an .xls download.
  const status = page.locator('[class*="waitTag"]:visible, [class*="infoTag"]:visible, [class*="successTag"]:visible, [class*="errorTag"]:visible').last();
  const deadline = Date.now() + 10000;
  let statusText = "";
  while (!statusText && Date.now() < deadline) {
    // Keep the probe bounded when this optional status marker is absent on a
    // page variant; Locator.innerText otherwise waits Playwright's 30s default.
    statusText = (await status.innerText({ timeout: 500 }).catch(() => "")).replace(/\s+/g, " ").trim();
    if (!statusText) await page.waitForTimeout(250);
  }
  if (/(排队中|计算中|处理中|生成中|失败|错误|processing|pending|error)/i.test(statusText)) {
    throw new Error(`下载未就绪：分析任务“${requested}”当前状态为“${statusText}”，请等待结果生成后重试`);
  }
  if (statusText) console.log(`分析任务状态：${statusText}`);
}

async function clickDownload(page) {
  const downloadText = page.getByText("下载数据", { exact: true }).last();
  const button = downloadText.locator("xpath=ancestor::button[1]");
  const download = await button.count() ? button : downloadText;
  await download.waitFor({ state: "visible", timeout: 30000 });
  // The UI renders a custom button whose disabled state belongs to an
  // ancestor element, while the text locator resolves to an inner <div>.
  // Inspect the control itself so PROCESSING/ERROR tasks are not force-clicked
  // and turned into a misleading 48-byte error "spreadsheet" download.
  const disabled = await download.evaluate((element) => {
    const control = element.closest("button,[role='button']") || element;
    return control.hasAttribute("disabled")
      || control.getAttribute("aria-disabled") === "true"
      || control.getAttribute("data-odn-button-disabled") === "true"
      || /disabled/.test(control.className || "");
  }).catch(() => false);
  if (disabled) throw new Error("下载未就绪：页面已禁用下载按钮（分析任务可能仍在计算中或已失败）");
  const context = page.context();
  let pageClosed = false;
  let contextClosed = false;
  page.once("close", () => { pageClosed = true; });
  context.once("close", () => { contextClosed = true; });
  let downloadEventError;
  const downloadEvent = page.waitForEvent("download", { timeout: 30000 }).catch((error) => {
    downloadEventError = error;
    return null;
  });
  await download.click();
  const file = await downloadEvent;
  if (file) {
    const failure = await file.failure().catch((error) => error.message);
    console.log(`已触发下载：${file.suggestedFilename()}${failure ? `（失败：${failure}）` : ""}`);
    if (failure) {
      const url = page.isClosed() ? "[页面已关闭]" : page.url();
      console.log(`下载失败时页面状态：pageClosed=${pageClosed} contextClosed=${contextClosed} url=${url}`);
      if (pageClosed || contextClosed || /Target page, context or browser has been closed/i.test(failure)) {
        throw new Error("下载未成功：浏览器页面或上下文在下载期间被关闭，请检查 Chrome/Profile 是否崩溃或被其他进程释放。");
      }
    }
    if (!failure) {
      let filePath;
      try {
        filePath = await file.path();
      } catch (error) {
        if (pageClosed || contextClosed || /Target page, context or browser has been closed/i.test(error.message || "")) {
          throw new Error("下载未成功：浏览器页面或上下文在下载期间被关闭，请检查 Chrome/Profile 是否崩溃或被其他进程释放。");
        }
        throw error;
      }
      if (filePath) {
        const size = fs.statSync(filePath).size;
        console.log(`下载文件大小：${size} 字节`);
        if (size < 1024) {
          const bytes = fs.readFileSync(filePath);
          const text = bytes.toString("utf8");
          console.log(`下载内容（文本）：${JSON.stringify(text)}`);
          console.log(`下载内容（十六进制）：${bytes.toString("hex")}`);
          let payload;
          try {
            payload = JSON.parse(text);
          } catch (_) {
            // 小文件不是 JSON 时按普通下载继续处理。
          }
          if (payload && payload.success === false) {
            throw new Error(`下载未成功：服务端返回失败（code=${payload.code ?? "未知"}，message=${payload.message || "未知错误"}），结果尚未生成或当前任务不可下载。`);
          }
        }
        const downloadDir = getResultDir();
        let targetPath = path.join(downloadDir, file.suggestedFilename());
        if (fs.existsSync(targetPath)) {
          const ext = path.extname(targetPath);
          const base = targetPath.slice(0, -ext.length);
          let index = 1;
          do targetPath = `${base} (${index++})${ext}`; while (fs.existsSync(targetPath));
        }
        await file.saveAs(targetPath);
        console.log(`已保存下载文件：${targetPath}`);
        return true;
      }
    }
  } else {
    const url = page.isClosed() ? "[页面已关闭]" : page.url();
    console.log(`已点击下载数据，但未捕获浏览器下载事件（pageClosed=${pageClosed} contextClosed=${contextClosed} url=${url}）。`);
    if (pageClosed || contextClosed || /Target page, context or browser has been closed/i.test(downloadEventError?.message || "")) {
      throw new Error("下载未成功：浏览器页面或上下文在下载期间被关闭，请检查 Chrome/Profile 是否崩溃或被其他进程释放。");
    }
  }
  return false;
}

async function main() {
  checkPreflight({ taskFiles: ["done.json"] });
  const { fileName, donePath } = resolveDoneTask();

  let context;
  try {
    context = await launchBrowser({ acceptDownloads: true });
  } catch (error) {
    if (/existing browser session|Target page, context or browser has been closed/i.test(error.message)) {
      throw new Error("无法启动浏览器：ruyi-profile 正被其他 Chrome 会话占用。请完全退出 Chrome 后重新运行 downloadAll.js。");
    }
    throw error;
  }
  try {
    const pages = context.pages();
    const page = pages.find((candidate) => candidate.url() !== "about:blank")
      || pages[0]
      || await context.newPage();
    await page.bringToFront();
    await page.goto(resultUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);
    await selectTask(page, fileName);
    await ensureTaskReady(page, fileName);
    if (!await clickDownload(page)) throw new Error("下载未成功，保留完成清单中的文件名以便重试");
    removeDoneFile(donePath, fileName);
  } finally {
    await closeBrowserContext(context);
  }
}

main().catch((error) => {
  console.error(`下载任务失败：${error.message}`);
  process.exitCode = /下载未成功|下载未就绪|排队中|计算中|处理中|生成中|不可用/.test(error.message) ? 2 : 1;
});

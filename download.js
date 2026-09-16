const fs = require("fs");
const path = require("path");
require("./lib/playwright-env");
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

function normalizeTaskName(value) {
  return path.basename(String(value || ""))
    .replace(/\.(?:txt|csv)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getExpectedTitles(fileName, selectedTitle) {
  return [...new Set([fileName, selectedTitle]
    .filter(Boolean)
    .flatMap((value) => [path.basename(String(value)), normalizeTaskName(value)])
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean))];
}

const UNAVAILABLE_INSIGHT_STATUSES = new Set([
  "PROCESSING", "LOCKING", "FROZEN", "ERROR", "PENDING", "WAITING", "GENERATING", "FAILED",
]);

async function fetchInsightStatus(page, searchKeyword, expectedTitles) {
  const keyword = normalizeTaskName(searchKeyword);
  const request = {
    page: 1,
    pageSize: 100,
    sortField: "lastModifiedTime",
    sortType: "DESC",
    filtering: [
      { field: "keyword", operator: "CONTAINS", values: [keyword] },
      { field: "type", operator: "IN", values: ["TAG"] },
      { field: "status", operator: "IN", values: ["SUCCESS", "PROCESSING", "ERROR", "FROZEN", "LOCKING"] },
    ],
  };
  const response = await page.evaluate(async (payload) => {
    const result = await fetch("/api/insight/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!result.ok) throw new Error(`洞悉列表接口返回 HTTP ${result.status}`);
    return result.json();
  }, request);
  if (response?.success === false || (response?.code != null && response.code !== 0)) {
    throw new Error(`洞悉列表接口失败：${response?.message || `code=${response?.code}`}`);
  }

  const expected = new Set((expectedTitles || [searchKeyword]).map(normalizeTaskName).filter(Boolean));
  const items = response?.data?.listing?.items || [];
  const matched = items.filter((item) => expected.has(normalizeTaskName(item?.name)));
  const latest = matched[0];
  return {
    status: String(latest?.status || latest?.frontStatus || "").toUpperCase(),
    matchedCount: matched.length,
    item: latest || null,
  };
}

async function markDownloadTarget(page, expectedTitles = []) {
  const titles = [...new Set(expectedTitles.map((title) => String(title || "").replace(/\s+/g, " ").trim()).filter(Boolean))];
  return page.evaluate(({ expectedTitles: names }) => {
    const normalized = new Set(names);
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const text = (element) => String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    document.querySelectorAll('[data-ruyi-dl-target="1"]').forEach((element) => {
      element.removeAttribute("data-ruyi-dl-target");
    });

    const controls = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter((element) => visible(element) && text(element) === "下载数据");
    if (!controls.length) return { ok: false, reason: "no-download-control" };

    const titleNodes = [...document.querySelectorAll("body *")].filter((element) => {
      if (!visible(element) || !normalized.has(text(element))) return false;
      // The left result list also contains the requested name. It must never
      // be accepted as proof that the asynchronously loaded detail is ready.
      if (element.closest('[class*="listItem"], [class*="list-item"], aside, nav')) return false;
      return ![...element.children].some((child) => normalized.has(text(child)));
    });
    if (!titleNodes.length) return { ok: false, reason: "target-detail-not-shown" };

    const matches = [];
    for (const control of controls) {
      let scope = control.parentElement;
      let matchedTitle = null;
      while (scope && scope !== document.body && scope !== document.documentElement) {
        matchedTitle = titleNodes.find((titleNode) => scope.contains(titleNode));
        if (matchedTitle) break;
        scope = scope.parentElement;
      }
      if (matchedTitle) matches.push({ control, title: text(matchedTitle) });
    }
    if (matches.length !== 1) {
      return { ok: false, reason: matches.length ? `ambiguous-controls(${matches.length})` : "target-detail-not-shown" };
    }
    matches[0].control.setAttribute("data-ruyi-dl-target", "1");
    return { ok: true, title: matches[0].title };
  }, { expectedTitles: titles });
}

async function selectTask(page, fileName) {
  const requested = path.basename(fileName);
  const stem = normalizeTaskName(requested);
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
    return title;
  }
  throw new Error(`分析任务列表中找不到：${requested}`);
}

async function ensureTaskReady(page, fileName, selectedTitle) {
  const requested = path.basename(fileName);
  const expectedTitles = getExpectedTitles(requested, selectedTitle);
  let result;
  try {
    result = await fetchInsightStatus(page, normalizeTaskName(requested), expectedTitles);
  } catch (error) {
    throw new Error(`下载未就绪：无法确认目标任务“${requested}”的接口状态（${error.message}）`);
  }
  if (!result.matchedCount) {
    throw new Error(`下载未就绪：洞悉列表接口未返回目标任务“${requested}”`);
  }
  if (UNAVAILABLE_INSIGHT_STATUSES.has(result.status)) {
    throw new Error(`下载未就绪：分析任务“${requested}”当前状态为“${result.status}”，请等待结果生成后重试`);
  }
  if (result.status !== "SUCCESS") {
    throw new Error(`下载未就绪：分析任务“${requested}”状态未知（${result.status || "空"}）`);
  }
  console.log(`分析任务状态：${result.status}${result.matchedCount > 1 ? `（同名 ${result.matchedCount} 条，采用最新记录）` : ""}`);
}

async function clickDownload(page, expectedTitles = []) {
  const deadline = Date.now() + 15000;
  let target = { ok: false, reason: "not-checked" };
  while (Date.now() < deadline) {
    target = await markDownloadTarget(page, expectedTitles);
    if (target.ok) break;
    await page.waitForTimeout(250);
  }
  if (!target.ok) {
    throw new Error(`下载未就绪：无法定位目标任务详情区（${target.reason}），已停止提交以避免下载到其他任务的结果`);
  }
  const download = page.locator('[data-ruyi-dl-target="1"]').first();
  if (!await download.count()) {
    throw new Error("下载未就绪：目标任务的下载控件在点击前消失，请稍后重试");
  }
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
    const selectedTitle = await selectTask(page, fileName);
    const expectedTitles = getExpectedTitles(fileName, selectedTitle);
    await ensureTaskReady(page, fileName, selectedTitle);
    if (!await clickDownload(page, expectedTitles)) throw new Error("下载未成功，保留完成清单中的文件名以便重试");
    removeDoneFile(donePath, fileName);
  } finally {
    await closeBrowserContext(context);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`下载任务失败：${error.message}`);
    process.exitCode = /下载未成功|下载未就绪|排队中|计算中|处理中|生成中|不可用/.test(error.message) ? 2 : 1;
  });
}

module.exports = {
  UNAVAILABLE_INSIGHT_STATUSES,
  clickDownload,
  ensureTaskReady,
  fetchInsightStatus,
  getExpectedTitles,
  markDownloadTarget,
  normalizeTaskName,
  selectTask,
};

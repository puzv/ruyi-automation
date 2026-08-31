const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { profileDir, chromePath, urls, resultDirCandidates, uploadRootCandidates } = require("./config");
const resultUrl = urls.result;
const { requireUploadRoot } = require("./lib/paths");
const { readJsonArray, writeJsonArray, ensureDir } = require("./lib/files");
const { launchBrowser } = require("./lib/browser");
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
  const items = page.locator(".listItem--G0aPY");
  await items.first().waitFor({ state: "visible", timeout: 30000 });

  async function clickMatch() {
    for (let i = 0; i < await items.count(); i += 1) {
      const title = (await items.nth(i).locator(".title--cpoFh").innerText()).trim();
      if (title === requested || title === stem) {
        await items.nth(i).click();
        await page.waitForFunction((expected) => {
          const active = document.querySelector(".listItem--G0aPY.active--okDqb .title--cpoFh");
          return active && active.innerText.trim() === expected;
        }, title, { timeout: 30000 });
        console.log(`已选择分析任务：${title}`);
        return true;
      }
    }
    return false;
  }

  // 分页逐页检查，直到找到目标或“下一页”按钮不可用。
  while (true) {
    if (await clickMatch()) return;
    const next = page.locator("ul.pagination li.page-roll.backward:not(.disabled) a").first();
    if (!(await next.count()) || !(await next.isVisible())) break;
    const currentPage = await page.locator("ul.pagination li.active a").getAttribute("title");
    const previousFirstTitle = await items.first().locator(".title--cpoFh").innerText();
    await next.click();
    await page.waitForFunction((previous) => {
      const active = document.querySelector("ul.pagination li.active a");
      return active && active.getAttribute("title") !== previous;
    }, currentPage, { timeout: 30000 });
    await page.waitForFunction((previous) => {
      const first = document.querySelector(".listItem--G0aPY .title--cpoFh");
      return first && first.innerText !== previous;
    }, previousFirstTitle, { timeout: 30000 });
  }

  // 列表默认只显示当前页，找不到时使用页面搜索功能。
  const searchTrigger = page.getByText("搜索", { exact: true }).first();
  if (await searchTrigger.count()) {
    await searchTrigger.click();
    const input = page.locator('input[placeholder*="搜索"], input[placeholder*="名称"]:visible').first();
    if (await input.count()) {
      await input.fill(stem);
      await page.waitForTimeout(800);
      const result = page.locator(".listItem--G0aPY").filter({ hasText: stem }).first();
      if (await result.count() && await result.isVisible()) {
        await result.click();
        console.log(`已选择分析任务：${stem}`);
        return;
      }
    }
  }
  throw new Error(`分析任务列表中找不到：${requested}`);
}

async function clickDownload(page) {
  const download = page.getByText("下载数据", { exact: true }).last();
  await download.waitFor({ state: "visible", timeout: 30000 });
  const downloadEvent = page.waitForEvent("download", { timeout: 30000 }).catch(() => null);
  await download.click();
  const file = await downloadEvent;
  if (file) {
    const failure = await file.failure();
    console.log(`已触发下载：${file.suggestedFilename()}${failure ? `（失败：${failure}）` : ""}`);
    if (!failure) {
      const filePath = await file.path();
      if (filePath) {
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
        const size = fs.statSync(filePath).size;
        console.log(`下载文件大小：${size} 字节`);
        if (size < 1024) {
          const bytes = fs.readFileSync(filePath);
          const text = bytes.toString("utf8");
          console.log(`下载内容（文本）：${JSON.stringify(text)}`);
          console.log(`下载内容（十六进制）：${bytes.toString("hex")}`);
          try {
            const payload = JSON.parse(text);
            if (payload && payload.success === false) {
              console.log(`下载接口返回失败：${payload.message || "未知错误"}`);
              return false;
            }
          } catch (_) {
            // 小文件不是 JSON 时按普通下载继续处理。
          }
        }
        return true;
      }
    }
  } else {
    console.log("已点击下载数据，但 30 秒内未捕获浏览器下载事件。");
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
      throw new Error("无法启动浏览器：ruyi-profile 正被其他 Chrome 会话占用。请完全退出 Chrome 后重新运行 conclude.js。");
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
    if (!await clickDownload(page)) throw new Error("下载未成功，保留完成清单中的文件名以便重试");
    removeDoneFile(donePath, fileName);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(`选择分析任务失败：${error.message}`);
  process.exitCode = /下载未成功|计算中|处理中|不可用/.test(error.message) ? 2 : 1;
});

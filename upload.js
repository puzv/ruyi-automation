const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");
const { uploadRootCandidates, profileDir, chromePath, urls } = require("./config");
const { requireUploadRoot } = require("./lib/paths");
const { readJsonArray, writeJsonArray } = require("./lib/files");
const { launchBrowser } = require("./lib/browser");
const uploadRoot = requireUploadRoot("上传");

if (!uploadRoot) {
  console.error(`找不到上传目录，请创建：${uploadRootCandidates.join(" 或 ")}`);
  process.exit(1);
}

const folderConfigs = [
  {
    idType: "idfa",
    importUrl: urls.idfaImport,
    successUrl: urls.idfaUpload,
  },
  {
    idType: "oaid",
    importUrl: urls.oaidImport,
    successUrl: urls.oaidUpload,
  },
];


function getFiles(folder, idType) {
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder)
    .map((name) => path.join(folder, name))
    .filter((file) => fs.statSync(file).isFile())
    .filter((file) => path.basename(file).toLowerCase().includes(idType))
    .sort();
}

function moveToDone(files, folder) {
  const doneDir = path.join(folder, "done");
  fs.mkdirSync(doneDir, { recursive: true });
  const destinations = files.map((file) => path.join(doneDir, path.basename(file)));
  const existing = destinations.find((destination) => fs.existsSync(destination));
  if (existing) {
    throw new Error(`done 文件夹中已存在同名文件，不会覆盖：${existing}`);
  }
  files.forEach((file, index) => {
    fs.renameSync(file, destinations[index]);
    console.log(`已移动到：${destinations[index]}`);
  });
}

function withoutExtension(fileName) {
  return path.basename(fileName).replace(/\.[^.]+$/, "");
}

function platformFileName(fileName) {
  // 平台人群文件名最多 30 个字符；Array.from 按 Unicode 字符截取，避免截断中文代理项。
  return Array.from(withoutExtension(fileName)).slice(0, 30).join('');
}

function findExistingFileInBatch(message, batch) {
  const match = String(message).match(/文件名\s*(.+?)已存在/);
  if (!match) return null;
  const requested = withoutExtension(match[1].trim());
  return batch.find((file) => withoutExtension(file) === requested) || null;
}

function appendCreateGroupTodoList(uploadRoot, files) {
  const candidates = [
    path.join(uploadRoot, "createGroupToDoList.json"),
    path.join(uploadRoot, "creategrouptodolist.json"),
  ];
  const todoPath = candidates.find((file) => fs.existsSync(file)) || candidates[0];
  const todo = readJsonArray(todoPath, "创建任务清单")
    .filter((name) => typeof name === "string")
    .map(platformFileName);
  const existing = new Set(todo);
  let added = 0;

  files.forEach((file) => {
    const name = platformFileName(file);
    if (!name) return;
    if (!existing.has(name)) {
      todo.push(name);
      existing.add(name);
      added += 1;
    }
  });
  writeJsonArray(todoPath, todo);
  console.log(`已更新创建任务清单：${todoPath}（新增 ${added} 个文件，当前 ${todo.length} 个）`);
}

async function pressEnter(message) {
  console.log(message);
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => input.question("完成后按回车继续：", resolve));
  input.close();
}

async function waitForUploadSuccessCount(page, expected, timeout = 60000) {
  // 使用精确文本，避免把页面说明中的“上传成功后……”误计为成功文件。
  const success = page.getByText(/^(上传成功|导入成功|文件上传成功)$/i);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const count = await success.count();
    let visibleCount = 0;
    for (let index = 0; index < count; index += 1) {
      if (await success.nth(index).isVisible().catch(() => false)) {
        visibleCount += 1;
      }
    }
    if (visibleCount >= expected) return visibleCount;
    await page.waitForTimeout(250);
  }
  return 0;
}

async function waitForImportPageReady(page, pageReadyResponse = null) {
  // domcontentloaded 只代表 HTML 到达；数据平台的上传组件还依赖场景方案接口。
  // 等待接口（若本次导航触发了它）和上传控件挂载，避免过早 setInputFiles 导致页面无提示。
  const fileInput = page.locator('input[type="file"]').first();
  if (pageReadyResponse) {
    // 接口可能因缓存而不再发起；控件先就绪时无需白等接口超时。
    await Promise.race([
      pageReadyResponse,
      fileInput.waitFor({ state: "attached", timeout: 30000 }),
    ]);
  }
  await fileInput.waitFor({ state: "attached", timeout: 30000 });
  await page.getByText("文件上传", { exact: true }).first().waitFor({ state: "visible", timeout: 30000 });
  await page.waitForTimeout(1500);
}

async function waitForSubmitNavigationOrFailure(page, successUrl, timeout = 60000) {
  const failure = page.getByText(/请等待文件上传成功或删除尚未上传成功的文件/i).last();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (page.url().startsWith(successUrl)) {
      return { type: "success", message: page.url() };
    }
    if (await failure.isVisible().catch(() => false)) {
      return { type: "failure", message: (await failure.innerText()).trim() };
    }
    const notices = page.locator('[role="alert"], [class*="message"], [class*="toast"], [class*="notify"]');
    for (let index = 0; index < await notices.count(); index += 1) {
      const notice = notices.nth(index);
      if (!(await notice.isVisible().catch(() => false))) continue;
      const message = (await notice.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (message && /已存在|文件名|上传失败|提交失败|请等待/.test(message)) {
        console.log(`检测到页面消息：${message}`);
        return { type: "failure", message };
      }
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function uploadFolder(page, config) {
  const completedFiles = [];
  const folder = path.join(uploadRoot, config.idType);
  const files = getFiles(folder, config.idType).slice(0, 5);
  if (files.length === 0) {
    console.log(`${config.idType.toUpperCase()} 文件夹没有待上传文件，跳过：${folder}`);
    return completedFiles;
  }

  console.log(`开始处理 ${config.idType.toUpperCase()} 文件夹，共 ${files.length} 个文件`);
  for (let offset = 0; offset < files.length; offset += 5) {
    const batch = files.slice(offset, offset + 5);
    const batchEnd = offset + batch.length;
    console.log(`开始第 ${offset / 5 + 1} 批：${batch.length} 个文件（${offset + 1}-${batchEnd}/${files.length}）`);

    const waitForScheme = () => page.waitForResponse(
      (response) => response.url().includes("/fileaccess/api/scene/scheme"),
      { timeout: 15000 },
    ).catch(() => null);
    let pageReadyResponse = waitForScheme();
    await page.goto(config.importUrl, { waitUntil: "domcontentloaded" });
    if (!page.url().includes("/web/workbench/file/import")) {
      await pressEnter("请在数据平台页面完成登录，并进入文件导入页面；完成后按回车继续。");
      // 登录后重新导航，前一次等待的响应不再适用。
      pageReadyResponse = waitForScheme();
      await page.goto(config.importUrl, { waitUntil: "domcontentloaded" });
    }

    await waitForImportPageReady(page, pageReadyResponse);
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(batch);
    await page.waitForTimeout(1000);
    console.log(`已一次性选择第 ${offset + 1}-${batchEnd}/${files.length} 个 ${config.idType.toUpperCase()} 文件：${batch.map((file) => path.basename(file)).join("、")}`);
    const successCount = await waitForUploadSuccessCount(page, batch.length);
    if (successCount < batch.length) {
      throw new Error(`第 ${offset + 1}-${batchEnd}/${files.length} 个文件未全部上传成功（检测到 ${successCount}/${batch.length} 个成功提示）`);
    }
    console.log(`第 ${offset + 1}-${batchEnd}/${files.length} 个文件全部上传成功（${successCount}/${batch.length}）`);

    const submitDelaySeconds = 2;
    console.log(`第 ${offset / 5 + 1} 批上传成功，固定等待 ${submitDelaySeconds} 秒后提交...`);
    await page.waitForTimeout(submitDelaySeconds * 1000);
    const submitButton = page.getByText("提交", { exact: true }).last();
    const submitDeadline = Date.now() + 30000;
    while (true) {
      const ready = await submitButton.isVisible().catch(() => false) &&
        await submitButton.isEnabled().catch(() => false);
      if (ready) break;
      if (Date.now() >= submitDeadline) {
        throw new Error(`${config.idType.toUpperCase()} 第 ${offset / 5 + 1} 批上传成功，但提交按钮在 30 秒内没有变为可用`);
      }
      await page.waitForTimeout(200);
    }
    let submitSuccessMessage = null;
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      await submitButton.click();
      const submitResult = await waitForSubmitNavigationOrFailure(page, config.successUrl);
      if (submitResult?.type === "success") {
        submitSuccessMessage = submitResult.message;
        break;
      }
      if (submitResult?.type === "failure") {
        const existingFile = findExistingFileInBatch(submitResult.message, batch);
        if (existingFile) {
          console.log(`检测到文件名已存在：${path.basename(existingFile)}，将其视为已处理并重新开始上传流程。`);
          moveToDone([existingFile], folder);
          completedFiles.push(existingFile);
          return completedFiles;
        }
        console.log(`第 ${attempt} 次提交提示文件仍未全部上传成功，等待 2 秒后重试：${submitResult.message}`);
        await page.waitForTimeout(2000);
        continue;
      }
      console.log(`第 ${attempt} 次提交后 60 秒内未检测到结果，等待 2 秒后继续提交...`);
      await page.waitForTimeout(2000);
    }
    if (!submitSuccessMessage) {
      throw new Error(`${config.idType.toUpperCase()} 第 ${offset / 5 + 1} 批提交重试 60 次后仍未成功，流程超时`);
    }
    console.log(`${config.idType.toUpperCase()} 第 ${offset / 5 + 1} 批已跳转到提交结果页面：${submitSuccessMessage}`);
    moveToDone(batch, folder);
    completedFiles.push(...batch);
  }
  return completedFiles;
}

(async () => {
  let context;
  let completedFiles = [];
  try {
    context = await launchBrowser();
    const page = context.pages()[0] || (await context.newPage());
    page.on('dialog', async (dialog) => {
      console.log(`检测到浏览器弹窗：${dialog.message()}`);
      await dialog.dismiss().catch(() => {});
    });
    const config = folderConfigs.find((item) => {
      const folder = path.join(uploadRoot, item.idType);
      return getFiles(folder, item.idType).length > 0;
    });
    if (config) {
      completedFiles = await uploadFolder(page, config);
    } else {
      console.log("IDFA 和 OAID 文件夹中都没有待上传文件。");
    }
    if (completedFiles.length > 0) appendCreateGroupTodoList(uploadRoot, completedFiles);
    console.log("本次上传操作完成。");
  } catch (error) {
    console.error("上传流程失败：", error.message);
    process.exitCode = 1;
  } finally {
    if (context) {
      await context.close().catch(() => {});
      console.log("浏览器已关闭，上传脚本结束。");
    }
  }
})();

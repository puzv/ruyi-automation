const fs = require("fs");
const path = require("path");
require("@ruyi/shared/playwright-env");
const { chromium } = require("playwright");
const { profileDir, stateFile, chromePath, browserHeadless } = require("@ruyi/shared/config");
const { waitForProfileRelease } = require("./preflight");
const { loginTargets } = require("./storage-state");
const memoryContexts = new WeakSet();

function launchBrowser(options = {}) {
  if (options.storageState && typeof options.storageState === "object") return launchStateContext(options, true);
  if (stateFile) return launchStateContext(options);
  // Remove stale Singleton* links left by a crashed/forcibly closed Chrome
  // before creating a new persistent context. Without this, Chromium refuses
  // to launch even though the recorded owner PID is already gone.
  waitForProfileRelease({ timeoutMs: 3000 });
  return chromium.launchPersistentContext(profileDir, {
    headless: browserHeadless,
    executablePath: chromePath,
    viewport: { width: 1440, height: 1000 },
    ...options,
  });
}

// storageState mode: a fresh browser per call, so several workflows can use
// the same login state concurrently and nothing is left on disk afterwards.
async function launchStateContext(options = {}, inMemory = false) {
  if (!inMemory && !fs.existsSync(stateFile)) throw new Error(`找不到登录态文件：${stateFile}。请先运行 scripts/login-export-state.js。`);
  const { headless = browserHeadless, ...contextOptions } = options;
  const browser = await chromium.launch({ headless, executablePath: chromePath });
  try {
    const context = await browser.newContext({
      storageState: stateFile,
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
      ...contextOptions,
    });
    if (inMemory) memoryContexts.add(context);
    return context;
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

// Only refresh the state file from a context that is visibly still logged
// in. A run that ended on the SSO page must not overwrite a state that may
// still be valid for the other site.
async function saveRefreshedState(context, file = stateFile) {
  if (memoryContexts.has(context) || !file) return;
  const pages = context.pages().filter((page) => !page.isClosed());
  const urls = pages.map((page) => { try { return new URL(page.url()); } catch (_) { return null; } }).filter(Boolean);
  const onLoginPage = urls.some((url) => /(^|\.)sso\.e\.qq\.com$/i.test(url.hostname) || /\/login/i.test(url.pathname));
  const onBusinessPage = urls.some((url) => Object.values(loginTargets).some((target) => target.matches(url)));
  if (onLoginPage || !onBusinessPage) {
    if (onLoginPage) fs.writeFileSync(`${file}.logged-out`, "", { mode: 0o600 });
    console.log("未确认登录状态，本次不回写登录态文件。");
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, "", { mode: 0o600, flag: "wx" });
    await context.storageState({ path: tmp, indexedDB: true });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (_) {
    // The context may already be closing (for example the window was closed).
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function closeBrowserContext(context) {
  if (!context) return;
  if (memoryContexts.has(context) || stateFile) {
    const browser = context.browser();
    try {
      if (!memoryContexts.has(context)) await saveRefreshedState(context);
    } finally {
      await context.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
    return;
  }
  await context.close().catch(() => {});
  // Chrome may release Singleton* files shortly after Playwright resolves close().
  // Wait here so the next workflow can safely reuse the same persistent profile.
  if (waitForProfileRelease({ timeoutMs: 3000 })) return;

  // In some macOS/Chrome combinations persistent contexts leave the browser
  // process alive after context.close().  The SingletonLock identifies that
  // exact process; terminate it so subsequent probes do not report a false
  // "需要登录" state because the shared profile is still locked.
  const lockFile = path.join(profileDir, "SingletonLock");
  try {
    const target = fs.readlinkSync(lockFile);
    const match = target.match(/-(\d+)$/);
    const pid = match && Number(match[1]);
    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid, "SIGTERM");
      waitForProfileRelease({ timeoutMs: 3000 });
      if (fs.existsSync(lockFile)) process.kill(pid, "SIGKILL");
    }
  } catch (_) {
    // The process may have exited between checking the lock and terminating it.
  }
  waitForProfileRelease({ timeoutMs: 3000 });
}

module.exports = { launchBrowser, closeBrowserContext, saveRefreshedState };

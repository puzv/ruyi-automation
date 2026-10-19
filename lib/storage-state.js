const fs = require("fs");
const path = require("path");
require("./playwright-env");
const { chromium } = require("playwright");
const { chromePath } = require("../config");

// The SPA shells render briefly at the target URL before their scripts
// redirect to sso.e.qq.com, so a URL/no-login-text check alone reports a
// false "logged in". Require a business UI element that only appears after
// authentication; the selectors are the same readiness checks the workflow
// scripts use (analyse.js for 如翼, upload.js for DataNexus).
const loginTargets = {
  ruyi: {
    label: "如翼",
    url: "https://ruyi.qq.com/insight/create",
    matches: (url) => url.hostname === "ruyi.qq.com" && !/login|sso|\/auth/i.test(`${url.pathname}${url.search}`),
    ready: async (page) => (
      await page.locator(".ndmp-audience-select:visible").first().isVisible().catch(() => false)
      || await page.getByText("请选择", { exact: true }).first().isVisible().catch(() => false)
    ),
  },
  datanexus: {
    label: "DataNexus",
    url: "https://datanexus.qq.com/web/workbench/file/import?from=dmp_MD5_IFA",
    matches: (url) => url.hostname === "datanexus.qq.com" && !/login|sso/i.test(`${url.pathname}${url.search}`),
    ready: async (page) => (
      await page.getByText("文件上传", { exact: true }).first().isVisible().catch(() => false)
      || await page.locator('input[type="file"]').first().count().catch(() => 0) > 0
    ),
  },
};
const loginPromptPattern = /(请先登录|请登录|立即登录|扫码登录|账号登录|统一登录)/i;
// Consecutive positive checks (1 s apart) needed before trusting the result,
// so a page that is about to redirect is not accepted.
const stableChecks = 3;

async function pageLooksLoggedIn(page, target) {
  if (!page || page.isClosed()) return false;
  let url;
  try { url = new URL(page.url()); } catch (_) { return false; }
  if (!target.matches(url)) return false;
  const text = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
  if (loginPromptPattern.test(text)) return false;
  return target.ready(page);
}

// Poll until the page has looked logged in for `stableChecks` consecutive
// seconds, or the timeout expires.
async function waitStableLoggedIn(page, target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let streak = 0;
  while (Date.now() < deadline) {
    if (page.isClosed()) return false;
    streak = await pageLooksLoggedIn(page, target) ? streak + 1 : 0;
    if (streak >= stableChecks) return true;
    await page.waitForTimeout(1000).catch(() => {});
  }
  return false;
}

// Open the target in a fresh page and report whether the business UI loads
// and stays without a login redirect. A fresh page avoids stale SSO redirects.
async function probeSite(context, target, { timeoutMs = 20000 } = {}) {
  const page = await context.newPage();
  try {
    const response = await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const ok = Boolean(response && response.status() < 400) && await waitStableLoggedIn(page, target, timeoutMs);
    return { ok, url: page.url() };
  } catch (error) {
    return { ok: false, url: page.url(), error: error.message };
  } finally {
    await page.close().catch(() => {});
  }
}

async function launchStateBrowser({ headless, statePath } = {}) {
  const browser = await chromium.launch({ headless, executablePath: chromePath });
  const context = await browser.newContext({
    storageState: statePath && fs.existsSync(statePath) ? statePath : undefined,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  return { browser, context };
}

// Write to a temporary file first so readers never see a half-written state.
async function saveState(context, statePath) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  try {
    await context.storageState({ path: tmp, indexedDB: true });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, statePath);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

module.exports = { loginTargets, pageLooksLoggedIn, waitStableLoggedIn, probeSite, launchStateBrowser, saveState };

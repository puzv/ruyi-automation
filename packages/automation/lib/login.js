const readline = require("readline");

function isLivePage(page) {
  return Boolean(page && !page.isClosed());
}

async function ensurePage(context, page) {
  if (isLivePage(page)) return page;
  const existing = context.pages().slice().reverse().find(isLivePage);
  return existing || context.newPage();
}

async function bodyText(page) {
  return page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
}

async function looksLoggedOut(page, expectedPath) {
  if (!isLivePage(page)) return true;
  const url = page.url();
  if (expectedPath && url.includes(expectedPath)) {
    // The SPA can keep the target URL briefly while its 401 response is being
    // handled, so inspect the rendered login copy as well.
    const text = await bodyText(page);
    return /(?:立即登录|扫码登录|账号登录|密码登录)/i.test(text);
  }
  if (/\/login(?:[/?#]|$)|datanexus\.qq\.com\/?$/i.test(url)) return true;
  const text = await bodyText(page);
  return /(?:立即登录|扫码登录|账号登录|密码登录)/i.test(text);
}

async function waitForReady(page, { expectedPath, ready, timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!isLivePage(page)) return "closed";
    if (await ready(page)) return "ready";
    if (await looksLoggedOut(page, expectedPath)) return "login";
    await page.waitForTimeout(250);
  }
  return "timeout";
}

function waitForEnterOrClose(context, page, message) {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let finished = false;
    const watchedPages = new Set();
    const finish = (reason) => {
      if (finished) return;
      finished = true;
      watchedPages.forEach((item) => item.off("close", onClose));
      context?.off("page", onNewPage);
      input.close();
      resolve(reason);
    };
    const onClose = () => finish("closed");
    const watch = (item) => {
      if (!isLivePage(item) || watchedPages.has(item)) return;
      watchedPages.add(item);
      item.once("close", onClose);
    };
    const onNewPage = (item) => watch(item);
    context?.pages().forEach(watch);
    watch(page);
    context?.on("page", onNewPage);
    input.question(message, () => finish("enter"));
  });
}

/**
 * Navigate to a protected page and confirm that its business UI is rendered.
 * If login is required in headed mode, either Enter or closing the login tab
 * advances the flow; a fresh page is then opened and the target is rechecked.
 */
async function navigateWithLogin(context, initialPage, {
  url,
  expectedPath,
  ready,
  label = "目标页面",
  headless = true,
  timeout = 15000,
} = {}) {
  let page = await ensurePage(context, initialPage);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    page = await ensurePage(context, page);
    if (!isLivePage(page)) throw new Error(`${label}页面已关闭，无法继续`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    let state = await waitForReady(page, { expectedPath, ready, timeout });
    if (state === "ready") return page;
    if (state === "closed") {
      page = await ensurePage(context, null);
      continue;
    }
    if (headless) {
      throw new Error(`${label}未登录或页面未加载完成（当前地址：${page.url()}）。请先设置 RUYI_HEADLESS=0 完成登录后重试。`);
    }

    const reason = state === "login" ? "检测到登录页面" : "页面未在规定时间就绪";
    console.log(`${reason}：${label}。请在打开的浏览器中完成登录；完成后按回车，或直接关闭登录页面继续检查。`);
    await waitForEnterOrClose(context, page, "完成登录后按回车继续（关闭登录页面也会自动继续）：");
    // A successful SSO flow may open a new tab while leaving the original
    // target tab alive. Prefer the newest live tab after manual login.
    const livePages = context.pages().filter(isLivePage);
    page = livePages[livePages.length - 1] || await ensurePage(context, page);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    state = await waitForReady(page, { expectedPath, ready, timeout: 30000 });
    if (state === "ready") return page;
    if (state === "closed") {
      page = await ensurePage(context, null);
      continue;
    }
    if (state === "login") {
      // The first login may have completed on the other domain; loop once so
      // the user can authenticate the second service serially.
      continue;
    }
    throw new Error(`${label}登录后仍未就绪（当前地址：${page.url()}）。请检查账号权限和网络后重试。`);
  }
  throw new Error(`${label}登录状态连续检查失败，请重新运行并完成登录。`);
}

module.exports = { navigateWithLogin, ensurePage, isLivePage };

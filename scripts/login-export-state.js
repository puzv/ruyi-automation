// 打开一个空白的临时浏览器，等你手动登录如翼和 DataNexus，
// 两个站点都确认已登录后导出 storageState。不读写 ruyi-profile。
//
// 用法：node scripts/login-export-state.js [输出文件，默认 state-test.json]
const path = require("path");
const { loginTargets, pageLooksLoggedIn, probeSite, launchStateBrowser, saveState } = require("@ruyi/automation/lib/storage-state");

const statePath = path.resolve(process.argv[2] || "state-test.json");
const loginTimeoutMs = Number(process.env.RUYI_LOGIN_TIMEOUT_MS || 10 * 60 * 1000);
// Seconds a page must stay logged in before the login is accepted. The SPA
// can render its shell before redirecting to SSO, so a single check is not enough.
const stableSeconds = 3;
const maxRounds = 3;

async function waitForLogin(context, target) {
  const page = await context.newPage();
  await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  console.log(`请在浏览器窗口中登录 ${target.label}（最多等待 ${Math.round(loginTimeoutMs / 60000)} 分钟）……`);
  const deadline = Date.now() + loginTimeoutMs;
  let streak = 0;
  while (Date.now() < deadline) {
    if (context.pages().every((item) => item.isClosed())) throw new Error("浏览器窗口已关闭，未完成登录");
    // Login may finish in a new tab; any open page counts.
    let loggedInPage = null;
    for (const item of context.pages()) {
      if (await pageLooksLoggedIn(item, target)) { loggedInPage = item; break; }
    }
    streak = loggedInPage ? streak + 1 : 0;
    if (streak >= stableSeconds) {
      console.log(`${target.label} 已登录：${loggedInPage.url()}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${target.label} 登录超时`);
}

(async () => {
  const { browser, context } = await launchStateBrowser({ headless: false });
  try {
    let pending = Object.values(loginTargets);
    for (let round = 1; pending.length > 0; round += 1) {
      if (round > maxRounds) throw new Error(`连续 ${maxRounds} 轮复查未通过：${pending.map((item) => item.label).join("、")}`);
      for (const target of pending) await waitForLogin(context, target);
      // Re-open every site in a fresh page: logging into one site can expire
      // or redirect the other, and the export must reflect both domains.
      const failed = [];
      for (const target of Object.values(loginTargets)) {
        const result = await probeSite(context, target);
        console.log(`${result.ok ? "复查通过" : "复查未通过"}  ${target.label}  ${result.url}`);
        if (!result.ok) failed.push(target);
      }
      pending = failed;
      if (pending.length > 0) console.log("请在浏览器窗口中重新登录未通过的站点。");
    }
    await saveState(context, statePath);
    console.log(`已导出登录态：${statePath}`);
    console.log("该文件等同于账号登录凭证，请勿提交或外传，测试完成后删除。");
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((error) => {
  console.error(`导出失败：${error.message}`);
  process.exitCode = 1;
});

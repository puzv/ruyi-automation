// 在全新的浏览器上下文中加载 storageState，检查两个站点能否直接进入业务页面。
// 不读写 ruyi-profile，也不修改登录态文件。
//
// 用法：node scripts/verify-state.js [登录态文件，默认 state-test.json]
// 设置 RUYI_HEADLESS=0 可看到浏览器窗口，检查结束后窗口保留 30 秒供人工确认。
const fs = require("fs");
const path = require("path");
const { browserHeadless } = require("../config");
const { loginTargets, probeSite, launchStateBrowser } = require("../lib/storage-state");

const statePath = path.resolve(process.argv[2] || "state-test.json");

(async () => {
  if (!fs.existsSync(statePath)) throw new Error(`找不到登录态文件：${statePath}`);
  const ageHours = (Date.now() - fs.statSync(statePath).mtimeMs) / 3600000;
  console.log(`登录态文件：${statePath}（导出于 ${ageHours.toFixed(1)} 小时前）`);

  const { browser, context } = await launchStateBrowser({ headless: browserHeadless, statePath });
  let allOk = true;
  try {
    for (const target of Object.values(loginTargets)) {
      const result = await probeSite(context, target);
      allOk = allOk && result.ok;
      console.log(`${result.ok ? "通过" : "失败"}  ${target.label}  ${result.url}${result.error ? `  (${result.error})` : ""}`);
    }
    if (!browserHeadless) {
      const page = await context.newPage();
      await page.goto(loginTargets.ruyi.url, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(30000);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(allOk ? "结论：storageState 可用。" : "结论：至少一个站点未登录，storageState 不能直接使用。");
  process.exitCode = allOk ? 0 : 1;
})().catch((error) => {
  console.error(`验证失败：${error.message}`);
  process.exitCode = 1;
});

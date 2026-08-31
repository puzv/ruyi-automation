const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const config = require("../config");

function checkPreflight({ taskFiles = [] } = {}) {
  const errors = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 18) errors.push("Node.js 版本过低（需要 18 或更高），请升级 Node.js。");

  try { require.resolve("playwright"); } catch (_) {
    errors.push("未安装 Playwright，请在项目目录执行：npm install");
  }

  if (!config.chromePath || !fs.existsSync(config.chromePath)) {
    const candidates = process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
      : process.platform === "win32" ? [] : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
    const detected = candidates.find((file) => fs.existsSync(file))
      || (process.platform !== "win32" && ["google-chrome", "chromium", "chromium-browser"].find((command) => spawnSync("which", [command], { stdio: "ignore" }).status === 0));
    if (!detected) errors.push("找不到 Chrome/Chromium，请安装浏览器，或设置 RUYI_CHROME_PATH。");
  }

  for (const [label, dir] of [["upload", config.uploadRoot], ["profile", config.profileDir]]) {
    if (!fs.existsSync(dir)) {
      errors.push(`${label} 目录不存在：${dir}。请创建该目录。`);
      continue;
    }
    try { fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK); } catch (_) {
      errors.push(`${label} 目录不可读写：${dir}。请检查文件权限。`);
    }
  }

  for (const fileName of taskFiles) {
    const filePath = path.join(config.uploadRoot, fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8") || "[]");
      if (!Array.isArray(value)) errors.push(`任务清单必须是 JSON 数组：${filePath}`);
    } catch (error) {
      errors.push(`任务清单 JSON 格式错误：${filePath}（${error.message}）`);
    }
  }

  const lockFiles = ["SingletonLock", "SingletonCookie", "SingletonSocket"]
    .map((name) => path.join(config.profileDir, name))
    .filter((file) => fs.existsSync(file));
  if (lockFiles.length) errors.push(`Chrome profile 可能正被其他实例占用（存在锁文件：${lockFiles.join(", ")}）。请先完全退出 Chrome 后重试。`);

  if (errors.length) {
    throw new Error(`启动前检查失败：\n- ${errors.join("\n- ")}`);
  }
}

module.exports = { checkPreflight };

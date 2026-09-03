const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// 所有脚本共享的运行配置。路径以本配置文件所在目录为基准，便于整体复制和分发。
const projectRoot = __dirname;
const uploadRoot = process.env.RUYI_UPLOAD_DIR || path.join(projectRoot, "upload");
const profileDir = process.env.RUYI_PROFILE_DIR || path.join(projectRoot, "ruyi-profile");
const envUrl = (name, fallback) => process.env[`RUYI_URL_${name}`] || fallback;
const defaultChromePath = process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/google-chrome";

function detectChromePath() {
  // Prefer Playwright's tested Chromium build when available. Recent system
  // Chrome releases can abort with SIGILL under Playwright's persistent,
  // remote-debugging mode (the page then reports `Target page, context or
  // browser has been closed` during downloads). The profile data, cookies and
  // sessions remain compatible because they are stored separately.
  try {
    const playwrightChrome = require("playwright").chromium.executablePath();
    if (playwrightChrome && fs.existsSync(playwrightChrome)) return playwrightChrome;
  } catch (_) {
    // Playwright may not be installed yet; the preflight check reports that
    // situation and the normal system-browser detection below still applies.
  }
  const candidates = process.platform === "win32"
    ? [
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
      process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Chromium/Application/chrome.exe"),
    ]
    : process.platform === "darwin"
      ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ]
      : [
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
      ];

  const filePath = candidates.filter(Boolean).find((candidate) => fs.existsSync(candidate));
  if (filePath) return filePath;
  if (process.platform !== "win32") {
    for (const command of ["google-chrome", "chromium", "chromium-browser"]) {
      const result = spawnSync("which", [command], { encoding: "utf8" });
      if (result.status === 0) {
        const resolved = result.stdout.trim();
        if (resolved) return resolved;
      }
    }
  }
  return defaultChromePath;
}

const chromePath = process.env.RUYI_CHROME_PATH || detectChromePath();
const browserHeadless = /^(1|true|yes|on)$/i.test(process.env.RUYI_HEADLESS || "");

module.exports = {
  projectRoot,
  uploadRoot,
  uploadRootCandidates: [uploadRoot],
  profileDir,
  chromePath,
  browserHeadless,
  resultDir: path.join(uploadRoot, "result"),
  resultDirCandidates: [path.join(uploadRoot, "result")],
  audienceLimit: Number(process.env.RUYI_AUDIENCE_LIMIT || 480),
  urls: {
    audience: envUrl("AUDIENCE", "https://ruyi.qq.com/audience"),
    idfaUpload: envUrl("IDFA_UPLOAD", "https://ruyi.qq.com/audience/dnUpload?idType=MD5_IFA"),
    oaidUpload: envUrl("OAID_UPLOAD", "https://ruyi.qq.com/audience/dnUpload?idType=MD5_OAID"),
    insightCreate: envUrl("INSIGHT_CREATE", "https://ruyi.qq.com/insight/create"),
    result: envUrl("RESULT", "https://ruyi.qq.com/audience-profile/result/"),
    idfaImport: envUrl("IDFA_IMPORT", "https://datanexus.qq.com/web/workbench/file/import?from=dmp_MD5_IFA"),
    oaidImport: envUrl("OAID_IMPORT", "https://datanexus.qq.com/web/workbench/file/import?from=dmp_MD5_OAID"),
  },
};

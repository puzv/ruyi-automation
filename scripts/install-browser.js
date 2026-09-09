#!/usr/bin/env node

/* Install this project's macOS Chromium Release asset for the current CPU. */

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");
const { spawnSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const browsersDir = path.join(projectRoot, ".playwright-browsers");
const repository = process.env.GITHUB_REPOSITORY || "puzv/ruyi-automation";
const force = process.env.PLAYWRIGHT_BROWSER_FORCE === "1" || process.argv.includes("--force");

function removeDirectory(directory) {
  if (!fs.existsSync(directory)) return;
  if (fs.rmSync) fs.rmSync(directory, { recursive: true, force: true });
  else fs.rmdirSync(directory, { recursive: true });
}

function playwrightVersion() {
  if (process.env.PLAYWRIGHT_VERSION) return process.env.PLAYWRIGHT_VERSION;
  try {
    return require("playwright/package.json").version;
  } catch (_) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
    const declared = packageJson.dependencies && packageJson.dependencies.playwright;
    const match = declared && declared.match(/(\d+\.\d+\.\d+)/);
    if (match) return match[1];
  }
  throw new Error("无法确定 Playwright 版本，请设置 PLAYWRIGHT_VERSION，例如 1.62.1");
}

function download(url, destination, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const request = client.get(url, { headers: { "User-Agent": "playwright-upload-browser-installer" } }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) return reject(new Error("下载重定向次数过多"));
        const next = new URL(response.headers.location, url).toString();
        return download(next, destination, redirectsLeft - 1).then(resolve, reject);
      }
      if (status < 200 || status >= 300) {
        response.resume();
        return reject(new Error(`下载失败（HTTP ${status}）：${url}`));
      }
      const output = fs.createWriteStream(destination);
      response.pipe(output);
      output.on("finish", () => output.close(resolve));
      output.on("error", (error) => { output.destroy(); reject(error); });
      response.on("error", reject);
    });
    request.on("error", reject);
  });
}

function hasBrowser(directory) {
  if (!fs.existsSync(directory)) return false;
  return fs.readdirSync(directory, { withFileTypes: true }).some(
    (entry) => entry.isDirectory() && /^chromium-/.test(entry.name)
  );
}

function readInstallInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(browsersDir, ".playwright-browser-install.json"), "utf8"));
  } catch (_) { return null; }
}

function replaceBrowserDirectory(extractedDir) {
  fs.mkdirSync(path.dirname(browsersDir), { recursive: true });
  let backupDir = null;
  if (fs.existsSync(browsersDir)) {
    backupDir = `${browsersDir}.backup-${Date.now()}`;
    fs.renameSync(browsersDir, backupDir);
  }
  try {
    fs.renameSync(extractedDir, browsersDir);
  } catch (error) {
    if (backupDir && !fs.existsSync(browsersDir)) fs.renameSync(backupDir, browsersDir);
    throw error;
  }
  if (backupDir) console.log(`已保留旧浏览器目录：${backupDir}`);
}

async function main() {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
    throw new Error(`当前脚本仅支持 macOS Apple Silicon/Intel（darwin/arm64 或 darwin/x64），检测到 ${process.platform}/${process.arch}`);
  }

  const version = playwrightVersion();
  const architecture = process.arch;
  const tag = process.env.PLAYWRIGHT_BROWSER_RELEASE_TAG || `playwright-browsers-v${version}`;
  const assetName = process.env.PLAYWRIGHT_BROWSER_ASSET_NAME || `chromium-${version}-darwin-${architecture}.tar.gz`;
  if (path.basename(assetName) !== assetName || !assetName.endsWith(".tar.gz")) {
    throw new Error(`浏览器附件名称必须是简单的 .tar.gz 文件名：${assetName}`);
  }
  const assetUrl = process.env.PLAYWRIGHT_BROWSER_ASSET_URL ||
    `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;

  const currentInfo = readInstallInfo();
  if (!force && hasBrowser(browsersDir)) {
    if (currentInfo && currentInfo.assetName === assetName && currentInfo.releaseTag === tag) {
      console.log(`Chromium 已安装（${assetName}），无需重复下载。需要重新安装时使用 npm run install-browser -- --force`);
    } else {
      console.log(`检测到已有 Chromium：${browsersDir}。需要替换时使用 npm run install-browser -- --force`);
    }
    return;
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-browser-install-"));
  const archivePath = path.join(temporaryRoot, assetName);
  const extractedDir = path.join(temporaryRoot, "extracted");
  try {
    fs.mkdirSync(extractedDir);
    console.log(`下载 Chromium：${assetUrl}`);
    await download(assetUrl, archivePath);
    const extraction = spawnSync("tar", ["-xzf", archivePath, "-C", extractedDir], { stdio: "inherit" });
    if (extraction.error) throw extraction.error;
    if (extraction.status !== 0) throw new Error(`解压失败，tar 退出码：${extraction.status}`);
    if (!hasBrowser(extractedDir)) throw new Error("压缩包内容不包含 chromium-* 浏览器目录，可能不是匹配的 Release 包");

    fs.writeFileSync(path.join(extractedDir, ".playwright-browser-install.json"), JSON.stringify({
      version, releaseTag: tag, assetName, assetUrl,
      platform: process.platform, arch: architecture,
      installedAt: new Date().toISOString()
    }, null, 2) + "\n");
    replaceBrowserDirectory(extractedDir);
    console.log(`Chromium 已安装到：${browsersDir}`);
  } finally {
    removeDirectory(temporaryRoot);
  }
}

main().catch((error) => {
  console.error(`浏览器安装失败：${error.message}`);
  process.exitCode = 1;
});

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const { requireUploadRoot } = require("./lib/paths");
const { checkPreflight } = require("./lib/preflight");

function getPendingFiles(uploadRoot) {
  return ["idfa", "oaid"].flatMap((idType) => {
    const folder = path.join(uploadRoot, idType);
    if (!fs.existsSync(folder)) return [];

    return fs.readdirSync(folder)
      .map((name) => path.join(folder, name))
      .filter((file) => fs.statSync(file).isFile())
      .filter((file) => path.basename(file).toLowerCase().includes(idType));
  });
}

function normalizeRawFileNames(uploadRoot) {
  const rawDir = path.join(uploadRoot, "raw");
  if (!fs.existsSync(rawDir)) {
    throw new Error(`找不到 raw 文件夹：${rawDir}`);
  }

  const files = fs.readdirSync(rawDir)
    .map((name) => path.join(rawDir, name))
    .filter((file) => fs.statSync(file).isFile());

  const renames = files
    .map((file) => {
      const sourceName = path.basename(file);
      const extension = path.extname(sourceName);
      const stem = path.basename(sourceName, extension);
      const idMatch = stem.match(/(idfa|oaid)/i);

      // 仅规范 ID 文件；不相关文件保持原名，仍由 move.js 负责跳过。
      if (!idMatch && !/occupation/i.test(stem)) return null;

      // 删除 occupation 和下划线，再把 idfa/oaid 统一放到文件名最前面。
      // 平台名称通常会截取前 30 个字符，因此将中文集中放到 ID 类型后，
      // 让职业/人群等中文标识尽可能保留在平台名称中。
      const idType = idMatch ? idMatch[1].toLowerCase() : null;
      let normalizedStem = stem.replace(/occupation/gi, "");
      if (idType) normalizedStem = normalizedStem.replace(new RegExp(idType, "i"), "");
      normalizedStem = normalizedStem.replace(/_/g, "");
      const chinese = Array.from(normalizedStem)
        .filter((character) => /\p{Script=Han}/u.test(character))
        .join("");
      const nonChinese = Array.from(normalizedStem)
        .filter((character) => !/\p{Script=Han}/u.test(character))
        .join("");
      const targetStem = idType ? `${idType}${chinese}${nonChinese}` : normalizedStem;

      return {
        source: file,
        sourceName,
        targetName: `${targetStem}${extension}`,
      };
    })
    .filter(Boolean)
    .filter(({ sourceName, targetName }) => sourceName !== targetName);

  const emptyName = renames.find(({ targetName }) => !path.basename(targetName, path.extname(targetName)));
  if (emptyName) {
    throw new Error(`删除 occupation 后文件名为空：${emptyName.sourceName}`);
  }

  for (const { source, sourceName, targetName } of renames) {
    const target = path.join(rawDir, targetName);
    if (fs.existsSync(target)) {
      throw new Error(`规范文件名时目标文件已存在，不会覆盖：${target}（来源：${sourceName}）`);
    }
    fs.renameSync(source, target);
    console.log(`已规范文件名：${sourceName} -> ${targetName}`);
  }
}

function writeRawFileList(uploadRoot) {
  const manifestPath = path.join(uploadRoot, "createGroupToDoList.json");
  const existing = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8") || "[]")
    : [];
  if (!Array.isArray(existing)) throw new Error(`创建任务清单必须是文件名数组：${manifestPath}`);

  const discovered = ["raw", "idfa", "oaid"].flatMap((folderName) => {
    const folder = path.join(uploadRoot, folderName);
    if (!fs.existsSync(folder)) return [];
    return fs.readdirSync(folder)
      .map((name) => path.join(folder, name))
      .filter((file) => fs.statSync(file).isFile())
      .filter((file) => {
        const lowerName = path.basename(file).toLowerCase();
        return lowerName.includes("idfa") || lowerName.includes("oaid");
      })
      .map((file) => path.basename(file).replace(/\.[^.]+$/, ""));
  });
  const fileNames = [...new Set([...existing, ...discovered]
    .filter((name) => typeof name === "string")
    .map((name) => path.basename(name).replace(/\.[^.]+$/, "")))].sort();
  fs.writeFileSync(manifestPath, `${JSON.stringify(fileNames, null, 2)}\n`, "utf8");
  console.log(`已更新创建任务清单：${manifestPath}（${fileNames.length} 个文件）`);
}

function runScript(scriptName) {
  const scriptPath = path.join(__dirname, scriptName);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: __dirname,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`${scriptName} 启动失败：${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    const reason = result.signal ? `信号 ${result.signal}` : `退出码 ${result.status}`;
    console.error(`${scriptName} 执行失败（${reason}）。`);
    return false;
  }
  return true;
}

function main() {
  checkPreflight({ taskFiles: ["createGroupToDoList.json", "analyseToDoList.json", "done.json"] });
  const uploadRoot = requireUploadRoot("upload");

  console.log("开始整理数据文件...");
  try {
    normalizeRawFileNames(uploadRoot);
  } catch (error) {
    console.error(`文件预处理失败：${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (!runScript("move.js")) {
    process.exitCode = 1;
    return;
  }

  let pending = getPendingFiles(uploadRoot);
  let round = 0;
  while (pending.length > 0) {
    round += 1;
    console.log(`开始第 ${round} 轮上传，剩余 ${pending.length} 个文件。`);
    if (!runScript("upload.js")) {
      process.exitCode = 1;
      return;
    }

    const remaining = getPendingFiles(uploadRoot);
    if (remaining.length >= pending.length) {
      console.error("upload.js 执行成功，但没有减少待处理文件，已停止以避免无限循环。");
      process.exitCode = 1;
      return;
    }
    pending = remaining;
  }

  console.log("所有数据文件均已处理完成。");
}

main();

const fs = require("fs");
const path = require("path");

const { requireUploadRoot } = require("./lib/paths");
let uploadRoot;
try {
  uploadRoot = requireUploadRoot();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const rawDir = path.join(uploadRoot, "raw");
if (!fs.existsSync(rawDir)) {
  console.error(`找不到 raw 文件夹：${rawDir}`);
  process.exit(1);
}

const destinations = {
  idfa: path.join(uploadRoot, "idfa"),
  oaid: path.join(uploadRoot, "oaid"),
};
Object.values(destinations).forEach((dir) => fs.mkdirSync(dir, { recursive: true }));

const files = fs.readdirSync(rawDir)
  .map((name) => path.join(rawDir, name))
  .filter((file) => fs.statSync(file).isFile());

let moved = 0;
let movedEmptyToDone = 0;
let skipped = 0;
for (const file of files) {
  const name = path.basename(file);
  const lowerName = name.toLowerCase();
  const idType = lowerName.includes("idfa") ? "idfa" :
    lowerName.includes("oaid") ? "oaid" : null;

  if (!idType) {
    console.log(`跳过（文件名不含 idfa 或 oaid）：${name}`);
    skipped += 1;
    continue;
  }

  const isEmpty = fs.statSync(file).size === 0;
  const destinationDir = isEmpty
    ? path.join(destinations[idType], "done")
    : destinations[idType];
  fs.mkdirSync(destinationDir, { recursive: true });
  // DataNexus normalizes dots in the stem to underscores. Apply the same
  // conversion locally while preserving the final data extension.
  const extensionMatch = name.match(/\.(?:txt|csv)$/i);
  const extension = extensionMatch ? extensionMatch[0] : "";
  const stem = name.slice(0, name.length - extension.length);
  const targetName = `${stem.replace(/\./g, "_")}${extension}`;
  let finalName = targetName;
  let destination = path.join(destinationDir, finalName);
  for (let prefix = 1; fs.existsSync(destination); prefix += 1) {
    finalName = `${prefix}${stem.replace(/\./g, "_")}${extension}`;
    destination = path.join(destinationDir, finalName);
  }
  if (finalName !== targetName) {
    console.log(`检测到移动目标重名，已重命名：${targetName} -> ${finalName}`);
  }

  fs.renameSync(file, destination);
  if (isEmpty) {
    console.log(`检测到空文件，已直接移动到 ${idType}/done：${finalName}`);
    movedEmptyToDone += 1;
  } else {
    console.log(`已移动到 ${idType}：${finalName}`);
    moved += 1;
  }
}

console.log(`处理完成：移动待上传文件 ${moved} 个，空文件直接归档 ${movedEmptyToDone} 个，跳过 ${skipped} 个。`);

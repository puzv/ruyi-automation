const fs = require("fs");

function readJsonArray(filePath, description) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8").trim();
  if (!content) return [];
  const value = JSON.parse(content);
  if (!Array.isArray(value)) throw new Error(`${description}必须是数组：${filePath}`);
  return value;
}

function writeJsonArray(filePath, value) {
  if (!Array.isArray(value)) throw new Error(`写入内容必须是数组：${filePath}`);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { readJsonArray, writeJsonArray, ensureDir };

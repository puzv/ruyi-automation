const fs = require("fs");
const path = require("path");
const config = require("../config");

function findUploadRoot() {
  return config.uploadRootCandidates.find((dir) => fs.existsSync(dir));
}

function requireUploadRoot(label = "upload") {
  const uploadRoot = findUploadRoot();
  if (!uploadRoot) {
    throw new Error(`找不到 ${label} 目录，请创建：${config.uploadRootCandidates.join(" 或 ")}`);
  }
  return uploadRoot;
}

function taskPath(uploadRoot, names) {
  const candidates = names.map((name) => path.join(uploadRoot, name));
  return candidates.find((file) => fs.existsSync(file));
}

function requireTaskPath(uploadRoot, names, description) {
  const file = taskPath(uploadRoot, names);
  if (!file) throw new Error(`找不到${description}：${names.map((name) => path.join(uploadRoot, name)).join(" 或 ")}`);
  return file;
}

module.exports = { findUploadRoot, requireUploadRoot, taskPath, requireTaskPath };

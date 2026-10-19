// 迁移 SQL 的静态安全检查（共享库 bsg_dw 用）。
// 每条语句必须以允许的 DDL 关键字开头，且只作用于 ruyi_ 开头的表；
// 连接池关闭了 multipleStatements，一条语句不能夹带第二条。
const tablePrefix = "ruyi_";

function normalize(text) {
  return text
    .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ")
    // Blank out string literals (COMMENT '...') so words inside them are not parsed.
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns null when allowed, otherwise the reason it is rejected.
function checkStatement(text) {
  const normalized = normalize(text);
  if (/;\s*\S/.test(normalized)) return `一条迁移语句里包含多条 SQL：${normalized.slice(0, 80)}`;
  const head = normalized.match(/^(CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX\s+\S+\s+ON)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?`?([A-Za-z0-9_]+)`?/i);
  if (!head) return `只允许 CREATE TABLE / ALTER TABLE / CREATE INDEX：${normalized.slice(0, 80)}`;
  // `up` never needs DROP; it is reserved for local rollbacks.
  if (/^DROP/i.test(head[1])) return `迁移的 up 中不允许删除表：${head[2]}`;
  if (!head[2].startsWith(tablePrefix)) return `操作的表不是本项目的 ${tablePrefix} 表：${head[2]}`;
  if (/^ALTER/i.test(head[1]) && /\b(?:DROP|RENAME)\b/i.test(normalized)) return `ALTER 中包含删除或改名操作，需人工确认：${head[2]}`;
  for (const ref of normalized.matchAll(/\bREFERENCES\s+`?([A-Za-z0-9_]+)`?/gi)) {
    if (!ref[1].startsWith(tablePrefix)) return `外键引用了非本项目的表：${ref[1]}`;
  }
  return null;
}

function createdTable(text) {
  const match = normalize(text).match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z0-9_]+)`?/i);
  return match ? match[1] : null;
}

module.exports = { tablePrefix, checkStatement, createdTable };

const path = require("path");
const readline = require("readline");
const { Writable } = require("stream");
const { loadDotEnv } = require("../db/env");
const { createDb } = require("../db");
const users = require("@ruyi/shared/runtime/repos/users");
const { hashPassword, validatePasswordStrength, validateUsername } = require("@ruyi/server/src/modules/auth/password");

async function readPassword() {
  if (!process.stdin.isTTY) {
    if (process.env.RUYI_ADMIN_PASSWORD === undefined) {
      throw new Error("非终端环境请通过 RUYI_ADMIN_PASSWORD 环境变量提供密码。");
    }
    return process.env.RUYI_ADMIN_PASSWORD;
  }

  // readline 的所有回显都写入空输出流，提示单独写到终端。
  const muted = new Writable({ write(chunk, encoding, callback) { callback(); } });
  const input = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
  function ask(prompt) {
    process.stdout.write(prompt);
    return new Promise((resolve, reject) => {
      const cancel = () => { cleanup(); reject(new Error("密码输入已取消。")); };
      const cleanup = () => { input.removeListener("close", cancel); input.removeListener("SIGINT", cancel); };
      input.once("close", cancel);
      input.once("SIGINT", cancel);
      input.question("", (answer) => { cleanup(); process.stdout.write("\n"); resolve(answer); });
    });
  }
  try {
    const password = await ask("请输入密码：");
    const confirmation = await ask("请再次输入密码：");
    if (password !== confirmation) throw new Error("两次输入的密码不一致。");
    return password;
  } finally {
    input.close();
  }
}

async function main() {
  loadDotEnv(path.join(__dirname, "..", ".env"));
  const [username, displayName = username] = process.argv.slice(2);
  if (!username || process.argv.length > 4) throw new Error("用法：node scripts/create-admin.js <用户名> [显示名]");
  const usernameError = validateUsername(username);
  if (usernameError) throw new Error(usernameError);
  const password = await readPassword();
  const passwordError = validatePasswordStrength(password);
  if (passwordError) throw new Error(passwordError);
  const db = createDb();
  try {
    if (await users.findByUsername(db, username)) throw new Error("用户名已存在。");
    const passwordHash = await hashPassword(password);
    await db.transaction().execute(async (trx) => {
      await users.createUser(trx, { username, displayName, passwordHash, role: "admin", mustChangePassword: false });
      await trx.insertInto("ruyi_operation_logs").values({
        user_id: null, username: "cli", action: "admin.user_create",
        target_type: "user", target_id: username, result: "success",
      }).execute();
    });
    console.log(`管理员 ${username} 创建成功。`);
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  const message = error.code === "ER_DUP_ENTRY" ? "用户名已存在。" : error.code ? "数据库操作失败，请检查本地连接配置。" : error.message;
  console.error(`创建管理员失败：${message}`);
  process.exitCode = 1;
});

// 自动推进偏好。
// 默认开启：没有记录的用户按开启处理，用户显式关闭后写入 enabled = 0。
function isEnabled(db, userId) {
  return db.selectFrom("ruyi_auto_advance").select("enabled").where("user_id", "=", userId)
    .executeTakeFirst().then((row) => row == null || Boolean(row.enabled));
}

function setEnabled(db, userId, enabled) {
  return db.insertInto("ruyi_auto_advance").values({ user_id: userId, enabled: enabled ? 1 : 0 })
    .onDuplicateKeyUpdate({ enabled: enabled ? 1 : 0 }).execute();
}

async function listDisabled(db) {
  const rows = await db.selectFrom("ruyi_auto_advance").select("user_id").where("enabled", "=", 0).execute();
  return new Set(rows.map((row) => Number(row.user_id)));
}

module.exports = { isEnabled, setEnabled, listDisabled };

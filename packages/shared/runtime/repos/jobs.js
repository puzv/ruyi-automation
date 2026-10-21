const { sql } = require("kysely");

async function withClaimLock(db, fn, { timeoutSeconds = 5 } = {}) {
  return db.connection().execute(async (conn) => {
    const result = await sql`SELECT GET_LOCK('ruyi_job_claim', ${timeoutSeconds}) AS acquired`.execute(conn);
    if (Number(result.rows[0].acquired) !== 1) return null;
    try {
      return await fn(conn);
    } finally {
      await sql`SELECT RELEASE_LOCK('ruyi_job_claim')`.execute(conn);
    }
  });
}

async function enqueueJob(db, {
  id, userId, username, task, headless = true, requestId, maxPerUser = 5, timeoutSeconds = 5,
}) {
  const result = await withClaimLock(db, async (conn) => {
    const count = await conn.selectFrom("ruyi_jobs").select((eb) => eb.fn.countAll().as("total"))
      .where("user_id", "=", userId).where("status", "in", ["queued", "running"]).executeTakeFirstOrThrow();
    if (Number(count.total) >= maxPerUser) return { ok: false, reason: "user_limit" };
    await conn.insertInto("ruyi_jobs").values({
      id, user_id: userId, username, task, headless: headless ? 1 : 0, request_id: requestId ?? null,
    }).execute();
    return { ok: true };
  }, { timeoutSeconds });
  return result ?? { ok: false, reason: "busy" };
}

async function claimNextJob(db, { workerId, claimToken }) {
  return withClaimLock(db, async (conn) => {
    const candidate = await conn.selectFrom("ruyi_jobs as j").select("j.id")
      .where("j.status", "=", "queued").where("j.cancel_requested", "=", 0)
      .where(({ not, exists, selectFrom }) => not(exists(
        selectFrom("ruyi_jobs as running").select("running.id")
          .whereRef("running.user_id", "=", "j.user_id").where("running.status", "=", "running"),
      )))
      .orderBy("j.queued_at").orderBy("j.id").executeTakeFirst();
    if (!candidate) return null;
    // 候选在 SELECT 中排除同用户运行任务；UPDATE 不引用同表子查询，兼容 MySQL 5.7。
    const updated = await conn.updateTable("ruyi_jobs").set({
      status: "running", claim_token: claimToken, worker_id: workerId,
      started_at: sql`NOW(3)`, heartbeat_at: sql`NOW(3)`,
    }).where("id", "=", candidate.id).where("status", "=", "queued").executeTakeFirst();
    return updated.numUpdatedRows === 1n ? getJob(conn, candidate.id) : null;
  });
}

function heartbeat(db, { workerId, jobIds }) {
  if (jobIds && !jobIds.length) return Promise.resolve();
  let query = db.updateTable("ruyi_jobs").set({ heartbeat_at: sql`NOW(3)` })
    .where("worker_id", "=", workerId).where("status", "=", "running");
  if (jobIds) query = query.where("id", "in", jobIds);
  return query.executeTakeFirst();
}

async function finishJob(db, {
  id, claimToken, status, exitCode, exitSignal, errorMessage, stateRefreshed, stateExpired, logPath,
}) {
  if (!["succeeded", "failed", "cancelled", "interrupted"].includes(status)) throw new Error("任务结束状态只能是 succeeded、failed、cancelled 或 interrupted");
  const result = await db.updateTable("ruyi_jobs").set({
    status, exit_code: exitCode ?? null, exit_signal: exitSignal ?? null,
    error_message: errorMessage == null ? null : Array.from(errorMessage).slice(0, 1000).join(""),
    state_refreshed: stateRefreshed ? 1 : 0, state_expired: stateExpired ? 1 : 0,
    ...(logPath !== undefined ? { log_path: logPath } : {}), finished_at: sql`NOW(3)`,
  }).where("id", "=", id).where("claim_token", "=", claimToken).where("status", "=", "running")
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

async function setLogPath(db, { id, claimToken, logPath }) {
  const result = await db.updateTable("ruyi_jobs").set({ log_path: logPath })
    .where("id", "=", id).where("claim_token", "=", claimToken).where("status", "=", "running")
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

async function requestCancel(db, { id, userId }) {
  const queued = await db.updateTable("ruyi_jobs").set({ status: "cancelled", finished_at: sql`NOW(3)` })
    .where("id", "=", id).where("user_id", "=", userId).where("status", "=", "queued").executeTakeFirst();
  if (queued.numUpdatedRows === 1n) return "cancelled";
  // 排队取消若输给认领，就转为通知运行中的 Worker，不能覆盖 running 状态。
  const running = await db.updateTable("ruyi_jobs").set({ cancel_requested: 1 })
    .where("id", "=", id).where("user_id", "=", userId).where("status", "=", "running").executeTakeFirst();
  if (running.numUpdatedRows === 1n) return "cancelling";
  const job = await getJobForUser(db, id, userId);
  if (!job) return null;
  return job.status === "running" ? "cancelling" : "finished";
}

function listCancelRequested(db, { workerId }) {
  return db.selectFrom("ruyi_jobs").selectAll().where("worker_id", "=", workerId)
    .where("status", "=", "running").where("cancel_requested", "=", 1).execute();
}

async function recoverStaleJobs(db, { staleSeconds = 60 } = {}) {
  // 锁住选中的行，确保返回的记录确实由本次回收中断，避免心跳或其他回收者抢先更新。
  return db.transaction().execute(async (trx) => {
    const staleBefore = sql`DATE_SUB(NOW(3), INTERVAL ${staleSeconds} SECOND)`;
    const rows = await trx.selectFrom("ruyi_jobs")
      .select(["id", "user_id as userId", "username", "task", "request_id as requestId"])
      .where("status", "=", "running").where("heartbeat_at", "<", staleBefore).forUpdate().execute();
    if (!rows.length) return [];
    await trx.updateTable("ruyi_jobs").set({
      status: "interrupted", error_message: "服务重启或异常退出，任务已中断", finished_at: sql`NOW(3)`,
    }).where("id", "in", rows.map((row) => row.id)).where("status", "=", "running")
      .where("heartbeat_at", "<", staleBefore).execute();
    return rows;
  });
}

function getJob(db, id) {
  return db.selectFrom("ruyi_jobs").selectAll().where("id", "=", id).executeTakeFirst();
}

function getJobForUser(db, id, userId) {
  return db.selectFrom("ruyi_jobs").selectAll().where("id", "=", id).where("user_id", "=", userId).executeTakeFirst();
}

async function queuePosition(db, job) {
  if (job.status !== "queued") return 0;
  const row = await db.selectFrom("ruyi_jobs").select((eb) => eb.fn.countAll().as("total"))
    .where("status", "=", "queued").where((eb) => eb.or([
      eb("queued_at", "<", job.queued_at),
      eb.and([eb("queued_at", "=", job.queued_at), eb("id", "<", job.id)]),
    ])).executeTakeFirstOrThrow();
  return Number(row.total);
}

async function listJobs(db, { userId, username, status, page = 1, pageSize = 20 } = {}) {
  let query = db.selectFrom("ruyi_jobs");
  if (userId != null) query = query.where("user_id", "=", userId);
  if (username) query = query.where("username", "=", username);
  if (status) query = query.where("status", "=", status);
  const count = await query.select((eb) => eb.fn.countAll().as("total")).executeTakeFirstOrThrow();
  const items = await query.selectAll().orderBy("queued_at", "desc").orderBy("id", "desc")
    .limit(pageSize).offset((page - 1) * pageSize).execute();
  return { items, total: Number(count.total) };
}

function activeJobForUser(db, userId) {
  return db.selectFrom("ruyi_jobs").selectAll().where("user_id", "=", userId)
    .where("status", "in", ["queued", "running"]).orderBy("queued_at", "desc").orderBy("id", "desc")
    .executeTakeFirst();
}

async function hasRunningJob(db, userId) {
  const row = await db.selectFrom("ruyi_jobs").select("id").where("user_id", "=", userId)
    .where("status", "=", "running").executeTakeFirst();
  return Boolean(row);
}

module.exports = {
  withClaimLock, enqueueJob, claimNextJob, heartbeat, finishJob, setLogPath, requestCancel,
  listCancelRequested, recoverStaleJobs, getJob, getJobForUser, queuePosition, listJobs,
  activeJobForUser, hasRunningJob,
};

const assert = require("assert");
const { randomUUID } = require("crypto");
const { sql } = require("kysely");
const { createDb, readDbConfig } = require("../db");
const users = require("@ruyi/shared/runtime/repos/users");
const jobs = require("@ruyi/shared/runtime/repos/jobs");

const usernames = ["jobs_repo_a", "jobs_repo_b"];

async function clearTestData(db) {
  const rows = await db.selectFrom("ruyi_users").select("id").where("username", "in", usernames).execute();
  if (!rows.length) return;
  const ids = rows.map((row) => row.id);
  await db.deleteFrom("ruyi_jobs").where("user_id", "in", ids).execute();
  await db.deleteFrom("ruyi_users").where("id", "in", ids).execute();
}

async function assertLockFree(db) {
  const row = (await sql`SELECT IS_FREE_LOCK('ruyi_job_claim') AS free`.execute(db)).rows[0];
  assert.equal(Number(row.free), 1, "测试后必须释放认领命名锁");
}

async function testRepo(db, userA, userB) {
  const resetJobs = () => db.deleteFrom("ruyi_jobs").where("user_id", "in", [userA, userB]).execute();
  const enqueue = async (userId = userA, options = {}) => {
    const id = randomUUID();
    assert.deepEqual(await jobs.enqueueJob(db, {
      id, userId, username: userId === userA ? "中文用户甲😀" : "中文用户乙", task: "upload", ...options,
    }), { ok: true });
    return id;
  };
  const claim = (workerId = "worker-a") => jobs.claimNextJob(db, { workerId, claimToken: randomUUID() });
  const finish = (job, options = {}) => jobs.finishJob(db, {
    id: job.id, claimToken: job.claim_token, status: "succeeded", exitCode: 0, ...options,
  });
  const stamp = new Date("2026-10-20T00:00:00.123+08:00");
  const setOrder = (id, queuedAt = stamp) => db.updateTable("ruyi_jobs").set({ queued_at: queuedAt })
    .where("id", "=", id).execute();

  const requestId = randomUUID();
  const firstId = await enqueue(userA, { headless: false, requestId, task: "analyse" });
  const queued = await jobs.getJob(db, firstId);
  assert.equal(queued.status, "queued");
  assert.equal(queued.username, "中文用户甲😀");
  assert.equal(queued.task, "analyse");
  assert.equal(queued.headless, 0);
  assert.equal(queued.request_id, requestId);
  assert.equal(queued.cancel_requested, 0);
  assert.equal(queued.claim_token, null);
  assert.equal(queued.started_at, null);
  assert.equal(queued.finished_at, null);
  assert.ok(queued.queued_at instanceof Date);
  assert.deepEqual(await jobs.getJobForUser(db, firstId, userA), queued);
  assert.equal(await jobs.getJobForUser(db, firstId, userB), undefined);
  assert.equal(await jobs.getJob(db, randomUUID()), undefined);
  assert.equal(await jobs.hasRunningJob(db, userA), false);
  const first = await claim();
  assert.equal(first.id, firstId);
  assert.equal(first.status, "running");
  assert.ok(first.claim_token);
  assert.equal(first.worker_id, "worker-a");
  assert.ok(first.started_at instanceof Date);
  assert.ok(first.heartbeat_at instanceof Date);
  assert.equal(await jobs.hasRunningJob(db, userA), true);
  assert.equal(await jobs.queuePosition(db, first), 0);
  const wrongToken = randomUUID();
  assert.equal(await finish(first, { claimToken: wrongToken }), false);
  assert.equal(await jobs.setLogPath(db, { id: firstId, claimToken: wrongToken, logPath: "logs/wrong.log" }), false);
  assert.deepEqual(await jobs.getJob(db, firstId), first);
  const logPath = `logs/${firstId}.log`;
  assert.equal(await jobs.setLogPath(db, { id: firstId, claimToken: first.claim_token, logPath }), true);
  for (const status of ["queued", "running", "unknown"]) {
    await assert.rejects(finish(first, { status }), /任务结束状态只能是/);
  }
  assert.equal(await finish(first, {
    status: "failed", exitCode: 2, exitSignal: "SIGTERM", errorMessage: "中😀".repeat(600),
    stateRefreshed: true, stateExpired: true,
  }), true);
  const finished = await jobs.getJob(db, firstId);
  assert.equal(finished.status, "failed");
  assert.equal(finished.exit_code, 2);
  assert.equal(finished.exit_signal, "SIGTERM");
  assert.equal(finished.error_message, "中😀".repeat(500));
  assert.equal(finished.state_refreshed, 1);
  assert.equal(finished.state_expired, 1);
  assert.equal(finished.log_path, logPath);
  assert.ok(finished.finished_at instanceof Date);
  assert.equal(await finish(first), false);
  assert.equal(await jobs.setLogPath(db, { id: firstId, claimToken: first.claim_token, logPath: "logs/late.log" }), false);
  assert.equal(await jobs.hasRunningJob(db, userA), false);
  assert.equal(await jobs.activeJobForUser(db, userA), undefined);

  await resetJobs();
  await enqueue();
  const stopped = await claim();
  assert.equal(await finish(stopped, { status: "interrupted" }), true);
  assert.equal((await jobs.getJob(db, stopped.id)).status, "interrupted");

  await resetJobs();
  const sameUserIds = [await enqueue(), await enqueue()];
  for (const id of sameUserIds) await setOrder(id);
  sameUserIds.sort();
  const sameUserFirst = await claim();
  assert.equal(sameUserFirst.id, sameUserIds[0], "相同入队时间按 ID 决定认领顺序");
  assert.equal(await claim("worker-b"), null);
  assert.equal(await finish(sameUserFirst), true);
  assert.equal((await claim("worker-b")).id, sameUserIds[1]);

  await resetJobs();
  const aId = await enqueue();
  const bId = await enqueue(userB);
  assert.deepEqual(new Set([(await claim()).id, (await claim("worker-b")).id]), new Set([aId, bId]));

  await resetJobs();
  const concurrentIds = [];
  for (const userId of [userA, userB]) {
    for (let count = 0; count < 3; count++) concurrentIds.push(await enqueue(userId));
  }
  const attempts = Array.from({ length: 10 }, (_, index) => ({ workerId: `worker-${index}`, claimToken: randomUUID() }));
  const results = await Promise.all(attempts.map((options) => jobs.claimNextJob(db, options)));
  const claimed = results.filter(Boolean);
  assert.equal(claimed.length, 2);
  assert.equal(new Set(claimed.map((row) => row.id)).size, 2);
  assert.equal(new Set(claimed.map((row) => row.user_id)).size, 2);
  for (const [index, row] of results.entries()) {
    if (!row) continue;
    assert.ok(concurrentIds.includes(row.id));
    assert.equal(row.claim_token, attempts[index].claimToken);
    assert.equal(row.worker_id, attempts[index].workerId);
  }
  const running = await db.selectFrom("ruyi_jobs").selectAll().where("status", "=", "running").execute();
  assert.equal(running.length, 2);
  assert.equal(new Set(running.map((row) => row.user_id)).size, 2);
  await assertLockFree(db);

  await resetJobs();
  const limitedId = await enqueue();
  const limitedRunning = await claim();
  for (let count = 1; count < 5; count++) await enqueue();
  const limitOptions = { id: randomUUID(), userId: userA, username: "限额测试", task: "create" };
  assert.deepEqual(await jobs.enqueueJob(db, limitOptions), { ok: false, reason: "user_limit" });
  assert.equal(await jobs.getJob(db, limitOptions.id), undefined);
  assert.equal(limitedRunning.id, limitedId);
  await finish(limitedRunning);
  assert.deepEqual(await jobs.enqueueJob(db, limitOptions), { ok: true });
  assert.deepEqual(await jobs.enqueueJob(db, { ...limitOptions, id: randomUUID(), maxPerUser: 1 }),
    { ok: false, reason: "user_limit" });

  await resetJobs();
  const concurrentEnqueues = await Promise.all(Array.from({ length: 10 }, () => jobs.enqueueJob(db, {
    id: randomUUID(), userId: userA, username: "并发入队", task: "upload",
  })));
  assert.equal(concurrentEnqueues.filter((result) => result.ok).length, 5);
  assert.equal(concurrentEnqueues.filter((result) => result.reason === "user_limit").length, 5);

  await resetJobs();
  const cancelId = await enqueue();
  assert.equal(await jobs.requestCancel(db, { id: cancelId, userId: userB }), null);
  assert.equal((await jobs.getJob(db, cancelId)).status, "queued");
  assert.equal(await jobs.requestCancel(db, { id: randomUUID(), userId: userA }), null);
  assert.equal(await jobs.requestCancel(db, { id: cancelId, userId: userA }), "cancelled");
  assert.ok((await jobs.getJob(db, cancelId)).finished_at instanceof Date);
  assert.equal(await claim(), null);
  assert.equal(await jobs.requestCancel(db, { id: cancelId, userId: userA }), "finished");
  const cancelRunningId = await enqueue();
  const cancelRunning = await claim();
  assert.equal(await jobs.requestCancel(db, { id: cancelRunningId, userId: userB }), null);
  assert.equal((await jobs.getJob(db, cancelRunningId)).cancel_requested, 0);
  assert.equal(await jobs.requestCancel(db, { id: cancelRunningId, userId: userA }), "cancelling");
  assert.equal(await jobs.requestCancel(db, { id: cancelRunningId, userId: userA }), "cancelling");
  assert.deepEqual((await jobs.listCancelRequested(db, { workerId: "worker-a" })).map((row) => row.id), [cancelRunningId]);
  assert.deepEqual(await jobs.listCancelRequested(db, { workerId: "worker-b" }), []);
  assert.equal(await finish(cancelRunning, { status: "cancelled", exitCode: null }), true);
  assert.deepEqual(await jobs.listCancelRequested(db, { workerId: "worker-a" }), []);
  assert.equal(await jobs.requestCancel(db, { id: cancelRunningId, userId: userA }), "finished");
  assert.equal(await jobs.requestCancel(db, { id: limitedId, userId: userA }), null);

  await resetJobs();
  const skipId = await enqueue();
  await db.updateTable("ruyi_jobs").set({ cancel_requested: 1 }).where("id", "=", skipId).execute();
  assert.equal(await claim(), null, "不得认领已请求取消的排队任务");

  await resetJobs();
  for (let count = 0; count < 10; count++) {
    const id = await enqueue();
    const [cancelResult, claimResult] = await Promise.all([
      jobs.requestCancel(db, { id, userId: userA }), claim(),
    ]);
    const row = await jobs.getJob(db, id);
    if (claimResult) {
      assert.equal(claimResult.id, id);
      assert.equal(cancelResult, "cancelling");
      assert.equal(row.status, "running");
      assert.equal(row.cancel_requested, 1);
      await finish(claimResult, { status: "cancelled" });
    } else {
      assert.equal(cancelResult, "cancelled");
      assert.equal(row.status, "cancelled");
    }
  }

  await resetJobs();
  const staleRequest = randomUUID();
  const staleId = await enqueue(userA, { requestId: staleRequest });
  const freshId = await enqueue(userB, { task: "download" });
  const stale = await claim("stale-worker");
  const fresh = await claim("fresh-worker");
  const byId = new Map([[stale.id, stale], [fresh.id, fresh]]);
  await db.updateTable("ruyi_jobs").set({ heartbeat_at: sql`DATE_SUB(NOW(3), INTERVAL 2 MINUTE)` })
    .where("id", "in", [staleId, freshId]).execute();
  await jobs.heartbeat(db, { workerId: byId.get(freshId).worker_id });
  const recovered = await jobs.recoverStaleJobs(db, {});
  assert.deepEqual(recovered, [{ id: staleId, userId: userA, username: "中文用户甲😀", task: "upload", requestId: staleRequest }]);
  const interrupted = await jobs.getJob(db, staleId);
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.error_message, "服务重启或异常退出，任务已中断");
  assert.ok(interrupted.finished_at instanceof Date);
  assert.equal((await jobs.getJob(db, freshId)).status, "running");
  await jobs.heartbeat(db, { workerId: byId.get(staleId).worker_id });
  assert.deepEqual(await jobs.getJob(db, staleId), interrupted, "心跳只更新运行中的任务");
  assert.equal(await finish(byId.get(staleId)), false);
  assert.deepEqual(await jobs.recoverStaleJobs(db), []);
  assert.equal(await jobs.requestCancel(db, { id: staleId, userId: userA }), "finished");
  await db.updateTable("ruyi_jobs").set({ heartbeat_at: sql`DATE_SUB(NOW(3), INTERVAL 20 SECOND)` })
    .where("id", "=", freshId).execute();
  assert.deepEqual((await jobs.recoverStaleJobs(db, { staleSeconds: 10 })).map((row) => row.id), [freshId]);

  await resetJobs();
  const ordered = [];
  const expectedUserAIds = [];
  for (const userId of [userA, userB, userA, userB]) {
    const id = await enqueue(userId);
    await setOrder(id);
    ordered.push(id);
    if (userId === userA) expectedUserAIds.push(id);
  }
  ordered.sort();
  const earlyId = await enqueue(userB);
  await setOrder(earlyId, new Date(stamp.getTime() - 1));
  ordered.unshift(earlyId);
  for (const [index, id] of ordered.entries()) {
    assert.equal(await jobs.queuePosition(db, await jobs.getJob(db, id)), index);
  }
  const all = await jobs.listJobs(db, { page: 1, pageSize: 2 });
  const descending = [...ordered].reverse();
  assert.equal(all.total, 5);
  assert.deepEqual(all.items.map((row) => row.id), descending.slice(0, 2));
  const secondPage = await jobs.listJobs(db, { page: 2, pageSize: 2 });
  assert.equal(secondPage.total, 5);
  assert.deepEqual(secondPage.items.map((row) => row.id), descending.slice(2, 4));
  assert.deepEqual((await jobs.listJobs(db, { page: 3, pageSize: 2 })).items.map((row) => row.id), descending.slice(4));
  assert.deepEqual(await jobs.listJobs(db, { page: 4, pageSize: 2 }), { items: [], total: 5 });
  const userRows = (await jobs.listJobs(db, { userId: userA, page: 1, pageSize: 1 }));
  assert.equal(userRows.total, 2);
  expectedUserAIds.sort().reverse();
  assert.deepEqual(userRows.items.map((row) => row.id), expectedUserAIds.slice(0, 1));
  const userAAll = await jobs.listJobs(db, { userId: userA });
  assert.deepEqual(userAAll.items.map((row) => row.id), expectedUserAIds);
  assert.equal((await jobs.activeJobForUser(db, userA)).id, userAAll.items[0].id);
  const early = await claim();
  assert.equal(early.id, earlyId);
  assert.equal(await jobs.queuePosition(db, early), 0);
  assert.equal(await jobs.queuePosition(db, await jobs.getJob(db, ordered[1])), 0);
  await finish(early, { logPath: `logs/${early.id}.log` });
  assert.equal((await jobs.getJob(db, early.id)).log_path, `logs/${early.id}.log`);
  assert.equal((await jobs.listJobs(db)).total, 5, "历史列表包含已结束的任务");

  await resetJobs();
  await db.connection().execute(async (conn) => {
    assert.equal(Number((await sql`SELECT GET_LOCK('ruyi_job_claim', 0) AS acquired`.execute(conn)).rows[0].acquired), 1);
    try {
      let invoked = false;
      assert.equal(await jobs.withClaimLock(db, async () => { invoked = true; }, { timeoutSeconds: 0 }), null);
      assert.equal(invoked, false);
      const blockedId = randomUUID();
      assert.deepEqual(await jobs.enqueueJob(db, {
        id: blockedId, userId: userA, username: "锁测试", task: "upload", timeoutSeconds: 1,
      }), { ok: false, reason: "busy" });
      assert.equal(await jobs.getJob(db, blockedId), undefined);
    } finally {
      await sql`SELECT RELEASE_LOCK('ruyi_job_claim')`.execute(conn);
    }
  });
  await assertLockFree(db);
  await enqueue();
  await assert.rejects(jobs.withClaimLock(db, async (conn) => {
    assert.equal(Number((await sql`SELECT IS_USED_LOCK('ruyi_job_claim') = CONNECTION_ID() AS owned`.execute(conn)).rows[0].owned), 1);
    throw new Error("模拟认领异常");
  }), /模拟认领异常/);
  await assertLockFree(db);
  assert.equal(await jobs.withClaimLock(db, async () => "已获取"), "已获取");

  for (const task of ["create", "analyse", "download"]) await enqueue(userA, { task });
  await assert.rejects(jobs.enqueueJob(db, {
    id: randomUUID(), userId: userB, username: "非法任务", task: "invalid",
  }), (error) => ["WARN_DATA_TRUNCATED", "ER_TRUNCATED_WRONG_VALUE_FOR_FIELD"].includes(error.code));
  await assertLockFree(db);
  const enumId = await enqueue(userB);
  await assert.rejects(db.updateTable("ruyi_jobs").set({ status: "invalid" }).where("id", "=", enumId).execute(),
    (error) => ["WARN_DATA_TRUNCATED", "ER_TRUNCATED_WRONG_VALUE_FOR_FIELD"].includes(error.code));
  assert.equal((await jobs.getJob(db, enumId)).status, "queued");
}

async function main() {
  const config = readDbConfig();
  if (config.database !== "ruyi_test" || config.host !== "127.0.0.1" || config.port !== 3306 ||
    config.user !== "ruyi" || config.password !== "ruyi") {
    throw new Error("数据库测试只允许连接本机 Docker 的 ruyi_test 测试数据库。");
  }
  const db = createDb(config);
  try {
    await clearTestData(db);
    // 认领和回收是全局操作，遇到其他测试留下的任务时先停止，避免改动不属于本测试的数据。
    assert.equal((await jobs.listJobs(db)).total, 0, "任务队列不为空，请先清理其他测试写入的任务");
    const ids = [];
    for (const username of usernames) {
      ids.push(await users.createUser(db, { username, displayName: "任务仓库测试用户", passwordHash: "伪造密码摘要", mustChangePassword: false }));
    }
    await testRepo(db, ...ids);
    await assertLockFree(db);
    console.log("任务入队、并发认领、取消、心跳回收、分页和命名锁数据库测试通过。");
  } finally {
    try { await clearTestData(db); } finally { await db.destroy(); }
  }
}

main().catch((error) => { console.error("任务仓库数据库测试失败：", error); process.exitCode = 1; });

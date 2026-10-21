const { randomUUID } = require('node:crypto');
const { chromePath } = require('@ruyi/shared/config');
const { chromium } = require('playwright');
const { loginTargets, pageLooksLoggedIn, probeSite } = require('@ruyi/automation/lib/storage-state');
const { loadUserState, storeCapturedState } = require('@ruyi/shared/runtime/platform-state/index');
const { writeLog } = require('@ruyi/shared/runtime/audit');
const { readDisplayConfig } = require('./display');

const activeStatuses = new Set(['starting', 'waiting', 'saving']);
const messages = {
  succeeded: '两个平台登录成功，登录态已保存',
  failed: '平台登录失败，请重新尝试',
  cancelled: '平台登录已取消',
  expired: '平台登录超时，请重新开始',
};

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function publicSession(session) {
  return {
    id: session.id,
    status: session.status,
    sites: { ...session.sites },
    message: session.message,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    display: session.display,
  };
}

function createSessionManager({ now = Date.now, sweepMs = 10000, retentionMs = 10 * 60 * 1000 } = {}) {
  const sessions = new Map();
  const endListeners = new Set();
  let timer = null;

  function active(session) {
    return activeStatuses.has(session.status);
  }

  async function closeBrowser(session) {
    if (!session.browser) return;
    if (!session.closePromise) session.closePromise = Promise.resolve().then(() => session.browser.close()).catch(() => {});
    await session.closePromise;
    session.browser = null;
    session.context = null;
  }

  function finish(session, status) {
    if (!active(session)) return session.finishPromise;
    session.status = status;
    session.message = messages[status];
    session.finishedAt = now();
    session.lastActivityAt = new Date(now());
    for (const listener of endListeners) listener(session.id);
    session.wake?.();
    session.finishPromise = (async () => {
      await closeBrowser(session);
      await session.startLog;
      await writeLog(session.db, {
        ...session.audit, userId: session.userId, username: session.username,
        action: 'platform.login', result: status === 'succeeded' ? 'success' : 'failure',
        detail: { sessionId: session.id, status },
      }, session.log);
    })();
    return session.finishPromise;
  }

  function alive(session) {
    if (active(session) && now() >= session.expiresAt.getTime()) void finish(session, 'expired');
    return active(session);
  }

  function sweep() {
    for (const [id, session] of sessions) {
      if (active(session)) alive(session);
      else if (!session.running && session.finishedAt + retentionMs <= now()) sessions.delete(id);
    }
  }

  function pause(session, ms) {
    return new Promise((resolve) => {
      const timeout = setTimeout(done, Math.min(ms, Math.max(0, session.expiresAt.getTime() - now())));
      function done() {
        clearTimeout(timeout);
        session.wake = null;
        resolve();
      }
      session.wake = done;
      if (!alive(session)) done();
    });
  }

  function watchPage(session, page) {
    page.once('close', () => {
      // 新标签页可能在同一次跳转中替换旧页面，等页面列表更新后再判断。
      queueMicrotask(() => {
        if (alive(session) && session.context?.pages().every((item) => item.isClosed())) void finish(session, 'cancelled');
      });
    });
  }

  async function waitForLogin(session, key, checks, pollMs) {
    if (!alive(session)) return false;
    session.status = 'waiting';
    session.message = `请在浏览器窗口中登录${loginTargets[key].label}`;
    const page = await session.context.newPage();
    if (!alive(session)) return false;
    await page.goto(loginTargets[key].url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    let streak = 0;
    while (alive(session)) {
      const pages = session.context.pages().filter((item) => !item.isClosed());
      if (!pages.length) { await finish(session, 'cancelled'); return false; }
      let loggedIn = false;
      for (const item of pages) {
        if (await checks.pageLooksLoggedIn(item, loginTargets[key])) { loggedIn = true; break; }
      }
      if (!alive(session)) return false;
      streak = loggedIn ? streak + 1 : 0;
      if (streak >= 3) {
        session.sites[key] = true;
        session.lastActivityAt = new Date(now());
        return true;
      }
      await pause(session, pollMs);
    }
    return false;
  }

  async function run(session, { launch, checks, pollMs, keys }) {
    try {
      await session.startLog;
      if (!alive(session)) return;
      const loaded = await loadUserState(session.db, session.userId, keys);
      if (!alive(session)) return;
      session.browser = await launch({ headless: false, executablePath: chromePath,
        ...(session.display === 'vnc' ? {
          env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
          args: ['--start-maximized', '--window-position=0,0', '--window-size=1280,800'],
        } : { args: ['--disable-dev-shm-usage'] }),
      });
      // 取消可能发生在启动或创建上下文期间；迟到的资源也必须关闭。
      if (!alive(session)) { await closeBrowser(session); return; }
      session.browser.on('disconnected', () => { if (alive(session)) void finish(session, 'cancelled'); });
      session.context = await session.browser.newContext({
        viewport: { width: 1280, height: 800 },
        ...(loaded ? { storageState: loaded.state } : {}),
      });
      if (!alive(session)) { await closeBrowser(session); session.context = null; return; }
      session.context.on('page', (page) => watchPage(session, page));
      session.context.on('close', () => { if (alive(session)) void finish(session, 'cancelled'); });
      for (const page of session.context.pages()) watchPage(session, page);
      let pending = Object.keys(loginTargets);
      for (let round = 0; round < 3; round++) {
        for (const key of pending) {
          if (!await waitForLogin(session, key, checks, pollMs)) return;
        }
        pending = [];
        for (const [key, target] of Object.entries(loginTargets)) {
          if (!alive(session)) return;
          const result = await checks.probeSite(session.context, target);
          if (!alive(session)) return;
          session.sites[key] = Boolean(result.ok);
          if (!result.ok) pending.push(key);
        }
        if (!pending.length) break;
        session.message = '平台登录复查未通过，请重新登录未通过的站点';
      }
      if (!alive(session)) return;
      if (pending.length) { await finish(session, 'failed'); return; }
      session.status = 'saving';
      session.message = '正在保存平台登录态';
      const captured = await session.context.storageState({ indexedDB: true });
      if (!alive(session)) return;
      // 保存期间若被取消或超时，回滚尚未提交的登录态。
      await session.db.transaction().execute(async (db) => {
        if (!alive(session)) throw new Error('会话已结束');
        await storeCapturedState(db, session.userId, captured, keys);
        if (!alive(session)) throw new Error('会话已结束');
      });
      if (alive(session)) await finish(session, 'succeeded');
    } catch (_) {
      // 浏览器和数据库异常可能携带凭证，响应及审计只使用固定中文概括。
      if (alive(session)) await finish(session, 'failed');
    } finally {
      if (!active(session)) await closeBrowser(session);
      session.running = false;
    }
  }

  function startSession(user, { db, keys, log, audit = {}, launch = (options) => chromium.launch(options),
    checks = {}, pollMs = 1000, timeoutMs = process.env.RUYI_LOGIN_SESSION_TIMEOUT_MS,
    displayConfig = readDisplayConfig() } = {}) {
    sweep();
    const existing = [...sessions.values()].find((session) => session.userId === user.id && active(session));
    if (existing) return existing;
    // 共享桌面要等旧浏览器（包括迟到的启动）完全退出，才能交给下一位用户。
    const occupied = [...sessions.values()].filter((session) => active(session)
      || (displayConfig.mode === 'vnc' && session.running));
    const count = occupied.length;
    const max = displayConfig.mode === 'vnc' ? 1 : Math.max(1, Math.floor(positiveNumber(process.env.RUYI_MAX_LOGIN_SESSIONS, 2)));
    if (count >= max) {
      const minutes = Math.max(1, Math.ceil((occupied[0].expiresAt.getTime() - now()) / 60000));
      const error = new Error(displayConfig.mode === 'vnc'
        ? `有其他用户正在登录平台，请稍后再试（约 ${minutes} 分钟）`
        : `登录排队中：当前已有 ${count} 人正在登录，请稍后再试`);
      error.statusCode = 409;
      throw error;
    }
    const createdAt = new Date(now());
    const session = {
      id: randomUUID(), userId: user.id, username: user.username, status: 'starting',
      sites: { ruyi: false, datanexus: false }, message: '正在启动平台登录窗口',
      createdAt, lastActivityAt: createdAt,
      expiresAt: new Date(createdAt.getTime() + positiveNumber(timeoutMs, 15 * 60 * 1000)),
      browser: null, context: null, display: displayConfig.mode, running: true, db, log,
      audit: { ip: audit.ip, userAgent: audit.userAgent, requestId: audit.requestId || randomUUID() },
    };
    sessions.set(session.id, session);
    if (!timer) { timer = setInterval(sweep, sweepMs); timer.unref(); }
    session.startLog = writeLog(db, {
      ...session.audit, userId: session.userId, username: session.username,
      action: 'platform.login_start', result: 'success', detail: { sessionId: session.id },
    }, log);
    session.task = run(session, { launch, keys, pollMs: positiveNumber(pollMs, 1000),
      checks: { pageLooksLoggedIn, probeSite, ...checks } });
    return session;
  }

  function getSession(id, userId) {
    sweep();
    const session = sessions.get(id);
    return session?.userId === userId ? session : null;
  }

  async function cancelSession(id, userId) {
    const session = getSession(id, userId);
    if (!session) return false;
    if (active(session)) await finish(session, 'cancelled');
    return true;
  }

  async function closeAllSessions() {
    clearInterval(timer);
    timer = null;
    const current = [...sessions.values()];
    await Promise.all(current.map((session) => active(session) ? finish(session, 'cancelled') : session.finishPromise));
    await Promise.all(current.map((session) => session.task));
  }

  function onSessionEnd(listener) {
    endListeners.add(listener);
    return () => endListeners.delete(listener);
  }

  return { startSession, getSession, cancelSession, closeAllSessions, publicSession, onSessionEnd };
}

module.exports = { ...createSessionManager(), createSessionManager, publicSession };

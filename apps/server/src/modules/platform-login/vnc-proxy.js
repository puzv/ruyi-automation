const net = require('node:net');
const { WebSocket, WebSocketServer } = require('ws');
const { authenticateSession } = require('../auth/guard');
const sessions = require('./sessions');

function sameOrigin(request) {
  try {
    const origin = new URL(request.headers.origin);
    const target = new URL(`${origin.protocol}//${request.headers.host}`);
    return ['http:', 'https:'].includes(origin.protocol) && origin.origin === request.headers.origin
      && !target.username && !target.password && target.pathname === '/' && !target.search && !target.hash
      && origin.origin === target.origin;
  } catch (_) {
    return false;
  }
}

function registerVncProxy(app, displayConfig) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024,
    handleProtocols: (protocols) => protocols.has('binary') ? 'binary' : false });
  const connections = new Map();
  const pending = new Set();
  let closing = false;

  function reject(socket, status) {
    const reasons = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict' };
    socket.write(`HTTP/1.1 ${status} ${reasons[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  function connect(ws, id) {
    connections.get(id)?.close();
    const tcp = net.connect(displayConfig.port, displayConfig.host);
    let closeTimer;
    let stopped = false;
    const entry = {
      close(code = 1000) {
        if (stopped) return;
        stopped = true;
        tcp.destroy();
        if (ws.readyState === WebSocket.OPEN) ws.close(code);
        // 不依赖浏览器回应关闭帧，保证应用退出和异常断网时也释放连接。
        closeTimer = setTimeout(() => ws.terminate(), 1000);
        closeTimer.unref();
      },
    };
    connections.set(id, entry);
    app.log.info({ sessionId: id }, '远程桌面连接已建立');
    ws.on('message', (data, binary) => {
      if (!binary) { entry.close(1003); return; }
      if (!stopped && !tcp.write(data)) ws.pause();
    });
    tcp.on('drain', () => { if (!stopped) ws.resume(); });
    tcp.on('data', (data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      tcp.pause();
      ws.send(data, { binary: true }, (error) => {
        if (error) entry.close(1011);
        else if (!stopped) tcp.resume();
      });
    });
    tcp.on('error', () => entry.close(1011));
    tcp.on('close', () => entry.close());
    ws.on('error', () => entry.close(1011));
    ws.on('close', () => {
      entry.close();
      clearTimeout(closeTimer);
      if (connections.get(id) === entry) connections.delete(id);
      app.log.info({ sessionId: id }, '远程桌面连接已断开');
    });
  }

  async function upgrade(request, socket, head) {
    socket.on('error', () => socket.destroy());
    const match = request.url.match(/^\/api\/platform-login\/([^/?]+)\/vnc(?:\?.*)?$/);
    if (closing || request.method !== 'GET' || !match) { socket.destroy(); return; }
    pending.add(socket);
    try {
      const authSession = await authenticateSession(app.db, app.parseCookie(request.headers.cookie || ''));
      if (socket.destroyed || closing) { socket.destroy(); return; }
      if (!authSession) { reject(socket, 401); return; }
      if (authSession.user.must_change_password || !sameOrigin(request)) { reject(socket, 403); return; }
      const id = decodeURIComponent(match[1]);
      const session = sessions.getSession(id, authSession.user.id);
      if (!session) { reject(socket, 404); return; }
      if (displayConfig.mode !== 'vnc' || session.display !== 'vnc'
        || !['starting', 'waiting'].includes(session.status)) { reject(socket, 409); return; }
      if (!(request.headers['sec-websocket-protocol'] || '').split(',').some((value) => value.trim() === 'binary')) {
        reject(socket, 403); return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => connect(ws, id));
    } catch (_) {
      // 握手错误只返回固定状态，不记录可能携带 Cookie 的请求或异常。
      if (!socket.destroyed) reject(socket, 401);
    } finally {
      pending.delete(socket);
    }
  }

  app.server.on('upgrade', upgrade);
  const unsubscribe = sessions.onSessionEnd((id) => connections.get(id)?.close());
  app.addHook('preClose', async () => {
    closing = true;
    for (const socket of pending) socket.destroy();
    for (const entry of connections.values()) entry.close();
    await new Promise((resolve) => wss.close(resolve));
    app.server.removeListener('upgrade', upgrade);
    unsubscribe();
  });
}

module.exports = { registerVncProxy };

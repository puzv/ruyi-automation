function readDisplayConfig(env = process.env) {
  const mode = env.RUYI_LOGIN_DISPLAY || 'local';
  if (!['local', 'vnc'].includes(mode)) throw new Error('RUYI_LOGIN_DISPLAY 只允许 local 或 vnc');
  const host = env.RUYI_VNC_HOST || '127.0.0.1';
  const port = Number(env.RUYI_VNC_PORT || 5900);
  if (mode === 'vnc') {
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
      throw new Error('VNC 地址只允许 127.0.0.1、localhost 或 ::1');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('VNC 端口必须为 1 至 65535 的整数');
  }
  return { mode, host, port };
}

module.exports = { readDisplayConfig };

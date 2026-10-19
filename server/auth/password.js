const bcrypt = require('bcryptjs');

function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function validatePasswordStrength(plain) {
  if (typeof plain !== 'string' || plain.length < 8) {
    return '密码至少需要 8 位';
  }
  if (Buffer.byteLength(plain, 'utf8') > 72) {
    return '密码不能超过 72 个字节';
  }
  return null;
}

function validateUsername(name) {
  if (typeof name !== 'string' || !/^[a-z0-9_]{3,32}$/.test(name)) {
    return '用户名需为 3 至 32 位小写字母、数字或下划线';
  }
  return null;
}

module.exports = {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  validateUsername,
};

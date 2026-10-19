const crypto = require('crypto');
const { sql } = require('kysely');
const sessions = require('../repos/sessions');

const COOKIE_NAME = 'ruyi_session';
const MAX_AGE = 7 * 24 * 60 * 60;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function cookieOptions() {
  return { httpOnly: true, sameSite: 'lax', path: '/', maxAge: MAX_AGE, secure: process.env.RUYI_COOKIE_SECURE === '1' };
}

function publicUser(user) {
  return {
    id: user.id, username: user.username, displayName: user.display_name,
    role: user.role, mustChangePassword: Boolean(user.must_change_password),
  };
}

async function startSession(db, userId, request, reply) {
  const token = crypto.randomBytes(32).toString('base64url');
  await sessions.createSession(db, {
    tokenHash: hashToken(token), userId, ip: request.ip,
    userAgent: (request.headers['user-agent'] || '').slice(0, 255),
    expiresAt: sql`DATE_ADD(NOW(), INTERVAL 7 DAY)`,
  });
  reply.setCookie(COOKIE_NAME, token, cookieOptions());
}

module.exports = { COOKIE_NAME, MAX_AGE, hashToken, cookieOptions, publicUser, startSession };

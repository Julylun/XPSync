import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import type { RequestHandler } from 'express';
const scrypt = promisify(scryptCallback);
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}
export async function checkPassword(password: string, hash: string) {
  const [salt, expected] = hash.split(':');
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return timingSafeEqual(key, Buffer.from(expected, 'hex'));
}
export function validToken(token: string, secret: string) {
  return jwt.verify(token, secret, {
    algorithms: ['HS256'],
    issuer: 'xpsync',
    audience: 'xpsync-admin',
  });
}
export function issueToken(id: string, secret: string) {
  return jwt.sign({}, secret, {
    subject: id,
    algorithm: 'HS256',
    expiresIn: '8h',
    issuer: 'xpsync',
    audience: 'xpsync-admin',
  });
}
export const requireAdmin =
  (secret: string): RequestHandler =>
  (req, res, next) => {
    try {
      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!token) throw new Error();
      validToken(token, secret);
      next();
    } catch {
      res.status(401).json({ error: 'Authentication required' });
    }
  };

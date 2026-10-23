import { openSync, closeSync, fstatSync, readFileSync, constants } from 'node:fs';
import { isIP } from 'node:net';
import type { MailKeyring } from './mail-crypto.js';
export type AuthProfile = 'LAN_OFFLINE' | 'ONLINE';
export interface SmtpConfig { readonly host: string; readonly port: number; readonly tlsMode: 'implicit' | 'starttls'; readonly user: string; readonly password: string }
export interface OnlineConfig { readonly publicBaseUrl: string; readonly allowedOrigins: readonly string[]; readonly smtp: SmtpConfig; readonly from: string; readonly replyTo: string; readonly keyring: MailKeyring; readonly trustedProxies: readonly string[]; readonly localDemoSkipEmailVerification: boolean }
export function resolveAuthProfile(env: NodeJS.ProcessEnv = process.env): AuthProfile {
  const value = env.OANTUTI_AUTH_PROFILE;
  if (value === undefined) return 'LAN_OFFLINE';
  if (value === 'LAN_OFFLINE' || value === 'ONLINE') return value;
  throw new Error('Invalid OANTUTI_AUTH_PROFILE');
}
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]; if (!value || value.trim() !== value || /[\r\n\0]/.test(value)) throw new Error(`Invalid ${name}`); return value;
}
function secretFile(env: NodeJS.ProcessEnv, name: string): string {
  let fd: number | undefined;
  try { fd = openSync(required(env, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 65536) throw new Error();
    return readFileSync(fd, 'utf8');
  } catch { throw new Error(`Invalid ${name}`); } finally { if (fd !== undefined) closeSync(fd); }
}
function mailbox(env: NodeJS.ProcessEnv, name: string): string { const value = required(env, name); if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value)) throw new Error(`Invalid ${name}`); return value; }
export function loadOnlineConfig(env: NodeJS.ProcessEnv = process.env): OnlineConfig | undefined {
  if (resolveAuthProfile(env) === 'LAN_OFFLINE') return undefined;
  const publicBaseUrl = required(env, 'OANTUTI_PUBLIC_BASE_URL');
  const skipEmailVerification = env.OANTUTI_SKIP_EMAIL_VERIFICATION === 'true' || env.OANTUTI_LOCAL_DEMO_SKIP_EMAIL_VERIFICATION === 'true';
  if (env.OANTUTI_LOCAL_DEMO_SKIP_EMAIL_VERIFICATION === 'true') {
    let hostname = '';
    try { hostname = new URL(publicBaseUrl).hostname; } catch { /* exact URL validation below reports the configuration error */ }
    if (env.NODE_ENV !== 'development' || !['localhost', '127.0.0.1', '::1'].includes(hostname)) {
      throw new Error('Invalid OANTUTI_LOCAL_DEMO_SKIP_EMAIL_VERIFICATION');
    }
  } else if (env.OANTUTI_LOCAL_DEMO_SKIP_EMAIL_VERIFICATION !== undefined && env.OANTUTI_LOCAL_DEMO_SKIP_EMAIL_VERIFICATION !== 'false') {
    throw new Error('Invalid OANTUTI_LOCAL_DEMO_SKIP_EMAIL_VERIFICATION');
  }
  try { const url = new URL(publicBaseUrl); const okProto = skipEmailVerification ? (url.protocol === 'https:' || url.protocol === 'http:') : url.protocol === 'https:'; if (!okProto || url.origin !== publicBaseUrl || url.username || url.password || url.hostname.includes('*')) throw new Error(); } catch { throw new Error('Invalid OANTUTI_PUBLIC_BASE_URL'); }
  const host = env.OANTUTI_SMTP_HOST ?? (skipEmailVerification ? '127.0.0.1' : required(env, 'OANTUTI_SMTP_HOST')); if (!/^[A-Za-z0-9.-]+$/.test(host) || host.includes('..')) throw new Error('Invalid OANTUTI_SMTP_HOST');
  const portText = env.OANTUTI_SMTP_PORT ?? (skipEmailVerification ? '25' : required(env, 'OANTUTI_SMTP_PORT')); const port = Number(portText); if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid OANTUTI_SMTP_PORT');
  const tlsMode = (env.OANTUTI_SMTP_TLS_MODE as 'implicit' | 'starttls') ?? (skipEmailVerification ? 'starttls' : required(env, 'OANTUTI_SMTP_TLS_MODE')); if (tlsMode !== 'implicit' && tlsMode !== 'starttls') throw new Error('Invalid OANTUTI_SMTP_TLS_MODE');
  const user = env.OANTUTI_SMTP_USER ?? (skipEmailVerification ? 'demo' : required(env, 'OANTUTI_SMTP_USER')); const password = env.OANTUTI_SMTP_PASSWORD_FILE ? secretFile(env, 'OANTUTI_SMTP_PASSWORD_FILE').replace(/\r?\n$/, '') : (skipEmailVerification ? 'demo-password' : required(env, 'OANTUTI_SMTP_PASSWORD_FILE')); if (!password || /[\r\n\0]/.test(password)) throw new Error('Invalid OANTUTI_SMTP_PASSWORD_FILE');
  let keyring: MailKeyring;
  if (env.OANTUTI_MAIL_KEYRING_FILE) {
    try { const parsed = JSON.parse(secretFile(env, 'OANTUTI_MAIL_KEYRING_FILE')) as { currentKeyId?: unknown; keys?: unknown }; if (typeof parsed.currentKeyId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(parsed.currentKeyId) || !parsed.keys || typeof parsed.keys !== 'object' || Array.isArray(parsed.keys)) throw new Error();
      const keys = new Map<string, Buffer>(); for (const [id, encoded] of Object.entries(parsed.keys)) { if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof encoded !== 'string') throw new Error(); const key = Buffer.from(encoded, 'base64'); if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error(); keys.set(id, key); }
      if (!keys.has(parsed.currentKeyId)) throw new Error(); keyring = { currentKeyId: parsed.currentKeyId, keys };
    } catch { throw new Error('Invalid OANTUTI_MAIL_KEYRING_FILE'); }
  } else if (skipEmailVerification) {
    keyring = { currentKeyId: 'k', keys: new Map([['k', Buffer.alloc(32, 0)]]) };
  } else { throw new Error('Invalid OANTUTI_MAIL_KEYRING_FILE'); }
  const trustedProxies: string[] = [];
  if (env.OANTUTI_TRUST_PROXY !== undefined) {
    for (const item of required(env, 'OANTUTI_TRUST_PROXY').split(',')) { const parts = item.split('/'); const version = isIP(parts[0]!); if (!version || parts.length > 2 || (parts.length === 2 && (!/^\d+$/.test(parts[1]!) || Number(parts[1]) > (version === 4 ? 32 : 128)))) throw new Error('Invalid OANTUTI_TRUST_PROXY'); trustedProxies.push(item); }
  }
  if (env.OANTUTI_ALLOWED_ORIGINS !== undefined && env.OANTUTI_ALLOWED_ORIGINS !== publicBaseUrl) throw new Error('Invalid OANTUTI_ALLOWED_ORIGINS');
  const baseUrl = new URL(publicBaseUrl);
  const localAlias = baseUrl.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
  const localOriginAlias = `${baseUrl.protocol}//${localAlias}${baseUrl.port ? `:${baseUrl.port}` : ''}`;
  const allowedOrigins: string[] = [publicBaseUrl];
  if (skipEmailVerification) {
    if (!allowedOrigins.includes(localOriginAlias)) allowedOrigins.push(localOriginAlias);
    if (env.PUBLIC_ORIGINS) {
      for (const origin of env.PUBLIC_ORIGINS.split(',')) { const trimmed = origin.trim(); if (trimmed && !allowedOrigins.includes(trimmed)) allowedOrigins.push(trimmed); }
    }
  }
  const from = env.OANTUTI_MAIL_FROM ? mailbox(env, 'OANTUTI_MAIL_FROM') : (skipEmailVerification ? 'noreply@arena.local' : required(env, 'OANTUTI_MAIL_FROM'));
  const replyTo = env.OANTUTI_MAIL_REPLY_TO ? mailbox(env, 'OANTUTI_MAIL_REPLY_TO') : (skipEmailVerification ? 'support@arena.local' : required(env, 'OANTUTI_MAIL_REPLY_TO'));
  return { publicBaseUrl, allowedOrigins, smtp: { host, port, tlsMode, user, password }, from, replyTo, keyring, trustedProxies, localDemoSkipEmailVerification: skipEmailVerification };
}

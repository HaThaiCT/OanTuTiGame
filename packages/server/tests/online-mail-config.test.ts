import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOnlineConfig, resolveAuthProfile } from '../src/identity/online-config.js';
import { sealMailMaterial, openMailMaterial, type MailKeyring } from '../src/identity/mail-crypto.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function environment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), 'online-config-')); roots.push(root);
  writeFileSync(join(root, 'password'), 'smtp-private-password\n', { mode: 0o600 });
  writeFileSync(join(root, 'keys'), JSON.stringify({ currentKeyId: 'current', keys: { current: Buffer.alloc(32, 3).toString('base64') } }), { mode: 0o600 });
  return { OANTUTI_AUTH_PROFILE: 'ONLINE', OANTUTI_PUBLIC_BASE_URL: 'https://arena.example', OANTUTI_SMTP_HOST: 'smtp.example', OANTUTI_SMTP_PORT: '465', OANTUTI_SMTP_TLS_MODE: 'implicit', OANTUTI_SMTP_USER: 'arena', OANTUTI_SMTP_PASSWORD_FILE: join(root, 'password'), OANTUTI_MAIL_KEYRING_FILE: join(root, 'keys'), OANTUTI_MAIL_FROM: 'arena@example.test', OANTUTI_MAIL_REPLY_TO: 'support@example.test' };
}
describe('strict Online configuration', () => {
  it('keeps unset LAN free of mail requirements, rejecting unknown and empty profiles', () => {
    expect(resolveAuthProfile({})).toBe('LAN_OFFLINE'); expect(loadOnlineConfig({})).toBeUndefined();
    for (const value of ['', 'online', 'unexpected']) expect(() => resolveAuthProfile({ OANTUTI_AUTH_PROFILE: value })).toThrow();
  });
  it('loads private credentials without creating transport connections', () => {
    const config = loadOnlineConfig(environment())!;
    expect(config.publicBaseUrl).toBe('https://arena.example'); expect(config.keyring.keys.get('current')).toHaveLength(32);
  });
  it('rejects non-exact origins and invalid transport/proxy/mailbox values', () => {
    for (const value of ['http://arena.example', 'https://arena.example/path', 'https://u@arena.example', 'https://*.example', 'https://arena.example?x=1']) expect(() => loadOnlineConfig({ ...environment(), OANTUTI_PUBLIC_BASE_URL: value })).toThrow();
    for (const [key, value] of [['OANTUTI_SMTP_PORT', '465x'], ['OANTUTI_SMTP_TLS_MODE', 'none'], ['OANTUTI_MAIL_FROM', 'a@b\r\nBcc:evil@b'], ['OANTUTI_TRUST_PROXY', 'true']]) expect(() => loadOnlineConfig({ ...environment(), [key]: value })).toThrow();
  });
  it('rejects exposed or symlinked secrets without including their contents', () => {
    const env = environment(); chmodSync(env.OANTUTI_SMTP_PASSWORD_FILE!, 0o644);
    expect(() => loadOnlineConfig(env)).toThrow(/OANTUTI_SMTP_PASSWORD_FILE/);
    chmodSync(env.OANTUTI_SMTP_PASSWORD_FILE!, 0o600);
    symlinkSync(env.OANTUTI_SMTP_PASSWORD_FILE!, `${env.OANTUTI_SMTP_PASSWORD_FILE}.link`);
    expect(() => loadOnlineConfig({ ...env, OANTUTI_SMTP_PASSWORD_FILE: `${env.OANTUTI_SMTP_PASSWORD_FILE}.link` })).toThrow();
  });

  it('permits the local signup bypass only for a development HTTPS loopback origin', () => {
    const base = environment();
    const enabled = { ...base, NODE_ENV: 'development', OANTUTI_PUBLIC_BASE_URL: 'https://localhost:14443', OANTUTI_LOCAL_DEMO_SKIP_EMAIL_VERIFICATION: 'true' };
    expect(loadOnlineConfig(enabled)).toMatchObject({ localDemoSkipEmailVerification: true, allowedOrigins: ['https://localhost:14443', 'https://127.0.0.1:14443'] });
    expect(() => loadOnlineConfig({ ...enabled, NODE_ENV: 'production' })).toThrow(/OANTUTI_LOCAL_DEMO_SKIP_EMAIL_VERIFICATION/);
    expect(() => loadOnlineConfig({ ...enabled, OANTUTI_PUBLIC_BASE_URL: 'https://arena.example' })).toThrow(/OANTUTI_LOCAL_DEMO_SKIP_EMAIL_VERIFICATION/);
    expect(loadOnlineConfig({ ...base, NODE_ENV: 'development', OANTUTI_PUBLIC_BASE_URL: 'https://localhost:14443' })).toMatchObject({ localDemoSkipEmailVerification: false, allowedOrigins: ['https://localhost:14443'] });
  });
});
describe('authenticated mail material', () => {
  const keyring: MailKeyring = { currentKeyId: 'a', keys: new Map([['a', Buffer.alloc(32, 1)]]) };
  it('encrypts with unique nonces, binds AAD and supports decrypt-only retained keys', () => {
    const material = { recipient: 'secret@example.test', rawToken: 'private-token' };
    const first = sealMailMaterial(keyring, 'event/topic/user/purpose/hash', material);
    expect(JSON.stringify(first)).not.toContain(material.rawToken); expect(first).not.toEqual(sealMailMaterial(keyring, 'event/topic/user/purpose/hash', material));
    expect(openMailMaterial({ currentKeyId: 'b', keys: new Map([...keyring.keys, ['b', Buffer.alloc(32, 2)]]) }, 'event/topic/user/purpose/hash', first)).toEqual(material);
    expect(() => openMailMaterial(keyring, 'other-event', first)).toThrow();
    expect(() => openMailMaterial(keyring, 'event/topic/user/purpose/hash', { ...first, tag: Buffer.alloc(16).toString('base64') })).toThrow();
    expect(() => openMailMaterial({ currentKeyId: 'b', keys: new Map([['b', Buffer.alloc(32, 2)]]) }, 'event/topic/user/purpose/hash', first)).toThrow();
  });
});

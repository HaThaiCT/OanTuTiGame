import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface MailKeyring { readonly currentKeyId: string; readonly keys: ReadonlyMap<string, Buffer> }
export interface MailMaterial { readonly recipient: string; readonly rawToken?: string }
export interface MailEnvelope { readonly version: 1; readonly keyId: string; readonly nonce: string; readonly tag: string; readonly ciphertext: string }

export function sealMailMaterial(keyring: MailKeyring, aad: string, material: MailMaterial): MailEnvelope {
  const key = keyring.keys.get(keyring.currentKeyId);
  if (!key || key.length !== 32) throw new Error('Mail encryption key unavailable');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify([1, keyring.currentKeyId, aad])));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(material), 'utf8'), cipher.final()]);
  return { version: 1, keyId: keyring.currentKeyId, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
export function openMailMaterial(keyring: MailKeyring, aad: string, envelope: MailEnvelope): MailMaterial {
  try {
    const key = keyring.keys.get(envelope.keyId);
    if (envelope.version !== 1 || !key || key.length !== 32) throw new Error();
    const nonce = Buffer.from(envelope.nonce, 'base64'); const tag = Buffer.from(envelope.tag, 'base64');
    if (nonce.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, nonce); decipher.setAAD(Buffer.from(JSON.stringify([envelope.version, envelope.keyId, aad]))); decipher.setAuthTag(tag);
    const value: unknown = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    if (!value || typeof value !== 'object' || !('recipient' in value) || typeof value.recipient !== 'string' || ('rawToken' in value && typeof value.rawToken !== 'string')) throw new Error();
    return value as MailMaterial;
  } catch { throw new Error('Mail material authentication failed'); }
}

import { randomUUID, createHash } from 'node:crypto';
import type pg from 'pg';
import { sealMailMaterial, type MailKeyring } from './mail-crypto.js';
export interface IdentityMailOptions { readonly keyring: MailKeyring; readonly publicBaseUrl: string; readonly from: string; readonly replyTo: string }
export type MailPurpose = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET' | 'EMAIL_CHANGE' | 'EMAIL_CHANGED';
export type MailTopic = 'EMAIL_VERIFICATION_REQUESTED' | 'PASSWORD_RESET_REQUESTED' | 'EMAIL_CHANGE_REQUESTED' | 'EMAIL_CHANGED';
export interface IdentityMailInput { readonly userId: string; readonly topic: MailTopic; readonly purpose: MailPurpose; readonly tokenHash?: string; readonly rawToken?: string; readonly recipient: string; readonly expiresAt: Date }
export function mailAad(eventId: string, topic: string, userId: string, purpose: string, tokenHash: string | null): string { return JSON.stringify([1, eventId, topic, userId, purpose, tokenHash]); }
const TOPIC: Record<MailPurpose, MailTopic> = { EMAIL_VERIFICATION: 'EMAIL_VERIFICATION_REQUESTED', PASSWORD_RESET: 'PASSWORD_RESET_REQUESTED', EMAIL_CHANGE: 'EMAIL_CHANGE_REQUESTED', EMAIL_CHANGED: 'EMAIL_CHANGED' };
export async function enqueueIdentityMail(client: pg.PoolClient, keyring: MailKeyring, input: IdentityMailInput): Promise<void> {
  if (TOPIC[input.purpose] !== input.topic || !Number.isFinite(input.expiresAt.getTime()) || !/^[^\s@<>]+@[^\s@<>]+$/.test(input.recipient) || /[\r\n\0]/.test(input.recipient)) throw new Error('Invalid identity mail request');
  if (input.purpose === 'EMAIL_CHANGED' ? input.rawToken !== undefined || input.tokenHash !== undefined : !input.rawToken || !input.tokenHash || createHash('sha256').update(input.rawToken).digest('hex') !== input.tokenHash) throw new Error('Invalid identity mail token');
  const eventId = randomUUID(); const tokenHash = input.tokenHash ?? null;
  const envelope = sealMailMaterial(keyring, mailAad(eventId, input.topic, input.userId, input.purpose, tokenHash), { recipient: input.recipient, ...(input.rawToken === undefined ? {} : { rawToken: input.rawToken }) });
  await client.query('INSERT INTO outbox_events(id,topic,payload) VALUES($1,$2,$3)', [eventId, input.topic, JSON.stringify({ userId: input.userId, purpose: input.purpose, expiresAt: input.expiresAt.toISOString() })]);
  await client.query(`INSERT INTO identity_mail_deliveries(outbox_id,user_id,purpose,token_hash,expires_at,envelope) VALUES($1,$2,$3,$4,$5,$6)`, [eventId, input.userId, input.purpose, tokenHash, input.expiresAt, JSON.stringify(envelope)]);
}

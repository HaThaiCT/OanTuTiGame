import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Database } from '../persistence/db.js';
import { openMailMaterial, type MailEnvelope } from './mail-crypto.js';
import { mailAad, type IdentityMailOptions, type MailPurpose } from './mail-outbox.js';
export interface MailMessage { readonly recipient: string; readonly from: string; readonly replyTo: string; readonly subject: string; readonly text: string; readonly messageId: string }
export interface MailTransport { send(message: MailMessage, signal?: AbortSignal): Promise<void> }
export interface MailAlert { readonly eventId: string; readonly reason: 'TRANSPORT_FAILED' | 'MATERIAL_INVALID' }
export interface MailConsumerOptions { readonly pollIntervalMs?: number; readonly leaseMs?: number; readonly sendTimeoutMs?: number; readonly alert?: (alert: MailAlert) => void }
interface Delivery extends pg.QueryResultRow { outbox_id: string; user_id: string; purpose: MailPurpose; token_hash: string | null; envelope: MailEnvelope; topic: string; lease_token: string; attempts: number }
export class MailConsumer {
  private readonly leaseMs: number;
  private readonly timeoutMs: number;
  private readonly intervalMs: number;
  private readonly alert: (alert: MailAlert) => void;
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = false;
  constructor(private readonly db: Database, private readonly config: IdentityMailOptions, private readonly transport: MailTransport, options: MailConsumerOptions = {}) {
    this.leaseMs = options.leaseMs ?? 60_000; this.timeoutMs = options.sendTimeoutMs ?? 20_000; this.intervalMs = options.pollIntervalMs ?? 1000;
    if (!Number.isFinite(this.leaseMs) || !Number.isFinite(this.timeoutMs) || !Number.isFinite(this.intervalMs) || this.timeoutMs <= 0 || this.leaseMs <= this.timeoutMs + 1000 || this.intervalMs <= 0) throw new Error('Invalid mail consumer timing');
    this.alert = options.alert ?? (alert => { console.error('IDENTITY_MAIL_HELD', alert); });
  }
  start(): void { if (this.stopped || this.timer) return; this.timer = setInterval(() => { void this.tick().catch(() => { /* Durable pending work is retried by the next poll; never log database parameters. */ }); }, this.intervalMs); this.timer.unref(); }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.deliverOne().finally(() => { this.active = undefined; }); return this.active;
  }
  async stop(): Promise<void> { this.stopped = true; clearInterval(this.timer); this.timer = undefined; await this.active; }
  private async deliverOne(): Promise<void> {
    const leaseToken = randomUUID();
    const delivery = await this.db.withTransaction(async client => {
      // Held ciphertext is retained only until its bounded expiry, never indefinitely.
      await client.query(`UPDATE identity_mail_deliveries SET state='EXPIRED',envelope=NULL,lease_until=NULL,lease_token=NULL,finished_at=clock_timestamp() WHERE state IN ('PENDING','HELD') AND expires_at<=clock_timestamp()`);
      const result = await client.query<Delivery>(`WITH candidate AS (
        SELECT outbox_id FROM identity_mail_deliveries WHERE (state='PENDING' AND next_attempt_at<=clock_timestamp()) OR (state='SENDING' AND lease_until<=clock_timestamp())
        ORDER BY next_attempt_at,outbox_id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE identity_mail_deliveries d SET state='SENDING',lease_token=$1,lease_until=clock_timestamp()+($2::double precision*interval '1 millisecond')
        FROM candidate c,outbox_events o WHERE d.outbox_id=c.outbox_id AND o.id=d.outbox_id RETURNING d.*,o.topic`, [leaseToken, this.leaseMs]);
      return result.rows[0];
    });
    if (!delivery) return;
    let material;
    try { material = openMailMaterial(this.config.keyring, mailAad(delivery.outbox_id, delivery.topic, delivery.user_id, delivery.purpose, delivery.token_hash), delivery.envelope); }
    catch { await this.fail(delivery, 'MATERIAL_INVALID'); return; }
    // Identity writers lock users before token rows too. The send itself is deliberately
    // outside this transaction; redemption always revalidates after any subsequent rotation.
    const eligible = await this.db.withTransaction(async client => {
      const user = await client.query('SELECT id,email FROM users WHERE id=$1 FOR UPDATE', [delivery.user_id]);
      const claim = await client.query(`SELECT expires_at>clock_timestamp() AS fresh FROM identity_mail_deliveries WHERE outbox_id=$1 AND state='SENDING' AND lease_token=$2 AND lease_until>clock_timestamp() FOR UPDATE`, [delivery.outbox_id, delivery.lease_token]);
      if (!claim.rows[0]) return false;
      if (!claim.rows[0].fresh) { await this.terminal(client, delivery, 'EXPIRED'); return false; }
      let valid = user.rows.length > 0;
      if (valid && delivery.purpose !== 'EMAIL_CHANGED') {
        const reset = delivery.purpose === 'PASSWORD_RESET';
        const result = reset
          ? await client.query(`SELECT 1 FROM password_reset_tokens WHERE user_id=$1 AND token_hash=$2 AND target_email=$3 AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`, [delivery.user_id, delivery.token_hash, material.recipient])
          : await client.query(`SELECT 1 FROM email_verification_tokens WHERE user_id=$1 AND token_hash=$2 AND target_email=$3 AND purpose=$4 AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`, [delivery.user_id, delivery.token_hash, material.recipient, delivery.purpose]);
        valid = result.rows.length > 0 && !!material.rawToken && (delivery.purpose === 'EMAIL_CHANGE' || user.rows[0].email === material.recipient);
      }
      if (!valid) await this.terminal(client, delivery, 'CANCELLED'); return valid;
    });
    if (!eligible) return;
    const path = delivery.purpose === 'PASSWORD_RESET' ? '/reset-password' : '/verify-email';
    const message: MailMessage = { recipient: material.recipient, from: this.config.from, replyTo: this.config.replyTo, messageId: `<${delivery.outbox_id}@${new URL(this.config.publicBaseUrl).hostname}>`, subject: delivery.purpose === 'EMAIL_CHANGED' ? 'Email address changed' : delivery.purpose === 'PASSWORD_RESET' ? 'Reset your password' : 'Verify your email', text: delivery.purpose === 'EMAIL_CHANGED' ? 'Your account email address has changed. If you did not request this, contact your arena administrator.' : `Open this link and explicitly confirm the request:\n${this.config.publicBaseUrl}${path}#token=${encodeURIComponent(material.rawToken!)}` };
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.transport.send(message, controller.signal), new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error('Mail delivery timeout')); }, this.timeoutMs); })]);
    } catch {
      await this.fail(delivery, 'TRANSPORT_FAILED');
      return;
    } finally { clearTimeout(timeout); }
    // SMTP may have accepted the message. If durable acknowledgement fails, retain the SENDING
    // lease for restart recovery rather than falsely classifying this as a transport failure.
    await this.db.withTransaction(async client => { await this.terminal(client, delivery, 'DELIVERED'); });
  }
  private async terminal(client: pg.PoolClient, delivery: Delivery, state: 'DELIVERED' | 'CANCELLED' | 'EXPIRED'): Promise<void> {
    const result = await client.query(`UPDATE identity_mail_deliveries SET state=$3,envelope=NULL,lease_until=NULL,lease_token=NULL,finished_at=clock_timestamp() WHERE outbox_id=$1 AND state='SENDING' AND lease_token=$2 AND lease_until>clock_timestamp() RETURNING outbox_id`, [delivery.outbox_id, delivery.lease_token, state]);
    if (state === 'DELIVERED' && result.rows.length) await client.query('UPDATE outbox_events SET delivered_at=clock_timestamp() WHERE id=$1', [delivery.outbox_id]);
  }
  private async fail(delivery: Delivery, reason: MailAlert['reason']): Promise<void> {
    const attempts = delivery.attempts + 1; const hold = reason === 'MATERIAL_INVALID' || attempts >= 4; const delay = [15, 60, 300][attempts - 1] ?? 300;
    const result = await this.db.query(`UPDATE identity_mail_deliveries SET attempts=$3,state=$4,last_failure=$5,next_attempt_at=clock_timestamp()+($6::integer*interval '1 second'),lease_until=NULL,lease_token=NULL WHERE outbox_id=$1 AND state='SENDING' AND lease_token=$2 AND lease_until>clock_timestamp() RETURNING outbox_id`, [delivery.outbox_id, delivery.lease_token, attempts, hold ? 'HELD' : 'PENDING', reason, delay]);
    if (hold && result.rows.length) { try { this.alert({ eventId: delivery.outbox_id, reason }); } catch { /* Alerts cannot alter committed durable state or leak provider errors. */ } }
  }
}

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../src/persistence/db.js';
import { hashToken } from '../src/identity/crypto.js';
import { enqueueIdentityMail, type IdentityMailOptions } from '../src/identity/mail-outbox.js';
import { MailConsumer, type MailMessage, type MailTransport } from '../src/identity/mail-consumer.js';

class RecordingTransport implements MailTransport {
  readonly messages: MailMessage[] = [];
  failure = false;
  sendHook?: (message: MailMessage, signal?: AbortSignal) => Promise<void>;
  async send(message: MailMessage, signal?: AbortSignal): Promise<void> {
    if (this.sendHook) return this.sendHook(message, signal);
    if (this.failure) throw new Error('private SMTP credentials and recipient');
    this.messages.push(message);
  }
}
const db = new Database();
const users: string[] = [];
const currentUsers: string[] = [];
const resultEvents: string[] = [];
const key = Buffer.alloc(32, 7);
const config: IdentityMailOptions = {
  publicBaseUrl: 'https://arena.example', from: 'arena@example.test', replyTo: 'support@example.test',
  keyring: { currentKeyId: 'test', keys: new Map([['test', key]]) },
};
async function queue(expiresAt = new Date(Date.now() + 3_600_000)) {
  const userId = randomUUID(); users.push(userId); currentUsers.push(userId);
  const recipient = `${userId}@example.test`; const rawToken = randomUUID(); const tokenHash = hashToken(rawToken);
  await db.withTransaction(async client => {
    await client.query(`INSERT INTO users(id,username,display_name,email,password_hash,role,activation_method)
      VALUES($1,$2,'Mail test',$3,'unused','STUDENT','SELF_REGISTER')`, [userId, userId, recipient]);
    await client.query(`INSERT INTO email_verification_tokens(user_id,token_hash,target_email,purpose,expires_at)
      VALUES($1,$2,$3,'EMAIL_VERIFICATION',$4)`, [userId, tokenHash, recipient, expiresAt]);
    await enqueueIdentityMail(client, config.keyring, { userId, topic:'EMAIL_VERIFICATION_REQUESTED', purpose:'EMAIL_VERIFICATION', tokenHash, rawToken, recipient, expiresAt });
  });
  const row = await db.query<{outbox_id:string}>('SELECT outbox_id FROM identity_mail_deliveries WHERE user_id=$1', [userId]);
  return { userId, rawToken, tokenHash, recipient, eventId: row.rows[0].outbox_id };
}
async function delivery(eventId: string) {
  return (await db.query<{state:string;attempts:number;envelope:unknown;lease_token:string|null;lease_until:Date|null}>('SELECT state,attempts,envelope,lease_token,lease_until FROM identity_mail_deliveries WHERE outbox_id=$1',[eventId])).rows[0];
}
beforeAll(async () => {
  // This suite shares arena_rebuild_test across runs. Remove orphaned retryable mail rows left by interrupted prior runs so a tick cannot consume another fixture's message.
  await db.query("DELETE FROM outbox_events WHERE id IN (SELECT outbox_id FROM identity_mail_deliveries WHERE state IN ('PENDING','SENDING','HELD'))");
  const result = await db.query<{name:string}>('SELECT current_database() AS name');
  if (!/^arena_[a-z0-9_]*test[a-z0-9_]*$/.test(result.rows[0].name)) throw new Error('Mail tests require an isolated arena_*test* database');
});
let currentResultEvents: string[] = [];
beforeEach(() => { currentResultEvents = []; });
afterEach(async () => {
  if (currentResultEvents.length) await db.query('DELETE FROM outbox_events WHERE id=ANY($1::uuid[])',[currentResultEvents]);
  if (currentUsers.length) {
    await db.query('DELETE FROM outbox_events WHERE id IN(SELECT outbox_id FROM identity_mail_deliveries WHERE user_id=ANY($1::uuid[]))',[currentUsers]);
    await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[currentUsers]);
    currentUsers.splice(0);
  }
  if (resultEvents.length) await db.query('DELETE FROM outbox_events WHERE id=ANY($1::uuid[])',[resultEvents]);
});
afterAll(async () => { if(users.length) await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]); await db.close(); });
describe('durable encrypted identity mail', () => {
  it('persists ciphertext, sends a stable-ID message and erases terminal material', async () => {
    const queued=await queue();
    const stored=await db.query('SELECT d.envelope,o.payload FROM identity_mail_deliveries d JOIN outbox_events o ON o.id=d.outbox_id WHERE d.outbox_id=$1',[queued.eventId]);
    expect(JSON.stringify(stored.rows)).not.toContain(queued.rawToken);
    expect(JSON.stringify(stored.rows)).not.toContain(queued.recipient);
    const transport=new RecordingTransport(); const consumer=new MailConsumer(db,config,transport);
    await consumer.tick();
    expect(transport.messages).toHaveLength(1);
    expect(transport.messages[0].recipient).toBe(queued.recipient);
    expect(transport.messages[0].text).toContain(`#token=${queued.rawToken}`);
    expect(transport.messages[0].messageId).toContain(queued.eventId);
    expect(await delivery(queued.eventId)).toMatchObject({state:'DELIVERED',envelope:null,lease_token:null});
    expect((await db.query('SELECT delivered_at FROM outbox_events WHERE id=$1',[queued.eventId])).rows[0].delivered_at).not.toBeNull();
    await consumer.stop();
  });

  it('suppresses expired and rotated tokens without calling transport', async () => {
    const expired=await queue(new Date(Date.now()-1000)); const rotated=await queue();
    await db.query('UPDATE email_verification_tokens SET consumed_at=clock_timestamp() WHERE token_hash=$1',[rotated.tokenHash]);
    const transport=new RecordingTransport(); const consumer=new MailConsumer(db,config,transport);
    await consumer.tick(); await consumer.tick();
    expect(transport.messages).toHaveLength(0);
    expect(await delivery(expired.eventId)).toMatchObject({state:'EXPIRED',envelope:null});
    expect(await delivery(rotated.eventId)).toMatchObject({state:'CANCELLED',envelope:null});
    await consumer.stop();
  });

  it('retries at 15, 60 and 300 seconds then holds with a redacted alert', async () => {
    const queued=await queue(); const transport=new RecordingTransport(); transport.failure=true; const alerts: unknown[]=[];
    const consumer=new MailConsumer(db,config,transport,{alert:alert=>alerts.push(alert)});
    for (const [attempt,seconds] of [[1,15],[2,60],[3,300]] as const) {
      await consumer.tick();
      const row=(await db.query<{state:string;attempts:number;delay:number}>('SELECT state,attempts,extract(epoch from next_attempt_at-clock_timestamp())::float8 AS delay FROM identity_mail_deliveries WHERE outbox_id=$1',[queued.eventId])).rows[0];
      expect(row.state).toBe('PENDING'); expect(row.attempts).toBe(attempt);
      expect(row.delay).toBeGreaterThan(seconds-5); expect(row.delay).toBeLessThanOrEqual(seconds);
      await db.query('UPDATE identity_mail_deliveries SET next_attempt_at=clock_timestamp() WHERE outbox_id=$1',[queued.eventId]);
    }
    await consumer.tick();
    expect(await delivery(queued.eventId)).toMatchObject({state:'HELD',attempts:4});
    expect(alerts).toEqual([{eventId:queued.eventId,reason:'TRANSPORT_FAILED'}]);
    expect(JSON.stringify(alerts)).not.toContain(queued.recipient);
    await consumer.stop();
  });

  it('reclaims expired leases and never consumes result-topic outbox rows', async () => {
    const queued=await queue();
    await db.query(`UPDATE identity_mail_deliveries SET state='SENDING',lease_until=clock_timestamp()-interval '1 second',lease_token=gen_random_uuid() WHERE outbox_id=$1`,[queued.eventId]);
    const resultId=randomUUID(); resultEvents.push(resultId); currentResultEvents.push(resultId);
    await db.query("INSERT INTO outbox_events(id,topic,payload) VALUES($1,'GAME_RESULT_ACCEPTED','{}')",[resultId]);
    const transport=new RecordingTransport(); const one=new MailConsumer(db,config,transport); const two=new MailConsumer(db,config,transport);
    await Promise.all([one.tick(),two.tick()]);
    expect(transport.messages.filter(m=>m.recipient===queued.recipient)).toHaveLength(1);
    expect((await db.query('SELECT delivered_at FROM outbox_events WHERE id=$1',[resultId])).rows[0].delivered_at).toBeNull();
    await one.stop(); await two.stop();
  });

  it('holds unauthenticatable ciphertext without sending or retaining it after expiry', async () => {
    const queued=await queue();
    await db.query(`UPDATE identity_mail_deliveries SET envelope=jsonb_set(envelope,'{tag}','"AAAAAAAAAAAAAAAAAAAAAA=="') WHERE outbox_id=$1`,[queued.eventId]);
    const alerts: unknown[]=[]; const transport=new RecordingTransport(); const consumer=new MailConsumer(db,config,transport,{alert:alert=>alerts.push(alert)});
    await consumer.tick();
    expect(transport.messages).toHaveLength(0);
    expect(await delivery(queued.eventId)).toMatchObject({state:'HELD',attempts:1});
    expect(alerts).toEqual([{eventId:queued.eventId,reason:'MATERIAL_INVALID'}]);
    await db.query("UPDATE identity_mail_deliveries SET expires_at=clock_timestamp()-interval '1 second' WHERE outbox_id=$1",[queued.eventId]);
    await consumer.tick();
    expect(await delivery(queued.eventId)).toMatchObject({state:'EXPIRED',envelope:null});
    await consumer.stop();
  });

  it('drains an active transport before stop resolves and rejects subsequent ticks', async () => {
    const queued=await queue();
    const gate=Promise.withResolvers<void>(); const entered=Promise.withResolvers<void>();
    const transport=new RecordingTransport();
    transport.sendHook=async message=>{transport.messages.push(message); entered.resolve(); await gate.promise;};
    const consumer=new MailConsumer(db,config,transport); const ticking=consumer.tick();
    await entered.promise;
    let stopped=false; const stopping=consumer.stop().then(()=>{stopped=true;});
    await Promise.resolve(); expect(stopped).toBe(false);
    gate.resolve(); await Promise.all([ticking,stopping]);
    expect(transport.messages).toHaveLength(1); expect(stopped).toBe(true); expect(await consumer.tick()).toBeUndefined();
    expect(await delivery(queued.eventId)).toMatchObject({state:'DELIVERED'});
  });

  it('does not acknowledge a send after another worker replaces its lease fence', async () => {
    const queued=await queue();
    const gate=Promise.withResolvers<void>(); const entered=Promise.withResolvers<void>();
    const transport=new RecordingTransport();
    transport.sendHook=async message=>{transport.messages.push(message); entered.resolve(); await gate.promise;};
    const consumer=new MailConsumer(db,config,transport); const ticking=consumer.tick();
    await entered.promise;
    const replacement=randomUUID();
    await db.query('UPDATE identity_mail_deliveries SET lease_token=$2,lease_until=clock_timestamp()+interval \'1 minute\' WHERE outbox_id=$1',[queued.eventId,replacement]);
    gate.resolve(); await ticking;
    expect(transport.messages).toHaveLength(1);
    expect(await delivery(queued.eventId)).toMatchObject({state:'SENDING',attempts:0,lease_token:replacement});
    await consumer.stop();
  });

  it('sends verification to the target address and notification to the previous address', async () => {
    const queued=await queue(); const target='changed@example.test'; const token=randomUUID(); const tokenHash=hashToken(token);
    await db.withTransaction(async client=>{
      await client.query('UPDATE email_verification_tokens SET consumed_at=clock_timestamp() WHERE user_id=$1',[queued.userId]);
      await client.query(`INSERT INTO email_verification_tokens(user_id,token_hash,target_email,purpose,expires_at) VALUES($1,$2,$3,'EMAIL_CHANGE',clock_timestamp()+interval '1 hour')`,[queued.userId,tokenHash,target]);
      await client.query('UPDATE users SET email_verified_at=clock_timestamp() WHERE id=$1',[queued.userId]);
      await enqueueIdentityMail(client,config.keyring,{userId:queued.userId,topic:'EMAIL_CHANGE_REQUESTED',purpose:'EMAIL_CHANGE',tokenHash,rawToken:token,recipient:target,expiresAt:new Date(Date.now()+3_600_000)});
      await enqueueIdentityMail(client,config.keyring,{userId:queued.userId,topic:'EMAIL_CHANGED',purpose:'EMAIL_CHANGED',recipient:queued.recipient,expiresAt:new Date(Date.now()+3_600_000)});
    });
    const transport=new RecordingTransport(); const consumer=new MailConsumer(db,config,transport);
    await consumer.tick(); await consumer.tick(); await consumer.tick();
    expect(transport.messages.map(message=>message.recipient)).toEqual([target,queued.recipient]);
    expect(transport.messages[1].text).not.toContain('token=');
    await consumer.stop();
  });

  it('aborts a timed-out transport and never records provider exception data', async () => {
    const queued=await queue(); let aborted=false; const transport=new RecordingTransport();
    transport.sendHook=(_message,signal)=>new Promise((_resolve,reject)=>{signal?.addEventListener('abort',()=>{aborted=true;reject(new Error('SMTP secret detail'));},{once:true});});
    const alerts: unknown[]=[]; const consumer=new MailConsumer(db,config,transport,{sendTimeoutMs:25,leaseMs:2000,alert:alert=>alerts.push(alert)});
    await consumer.tick();
    expect(aborted).toBe(true); expect(await delivery(queued.eventId)).toMatchObject({state:'PENDING',attempts:1});
    expect(JSON.stringify(await db.query('SELECT last_failure FROM identity_mail_deliveries WHERE outbox_id=$1',[queued.eventId]))).not.toContain('secret');
    expect(alerts).toHaveLength(0);
    await consumer.stop();
  });

  it('holds a message when its decrypt key has been removed rather than issuing a new token', async () => {
    const queued=await queue(); const transport=new RecordingTransport();
    const rotated: IdentityMailOptions={...config,keyring:{currentKeyId:'next',keys:new Map([['next',Buffer.alloc(32,9)]])}};
    const alerts: unknown[]=[]; const consumer=new MailConsumer(db,rotated,transport,{alert:alert=>alerts.push(alert)});
    await consumer.tick();
    expect(transport.messages).toHaveLength(0); expect(await delivery(queued.eventId)).toMatchObject({state:'HELD',attempts:1});
    expect(alerts).toEqual([{eventId:queued.eventId,reason:'MATERIAL_INVALID'}]);
    await consumer.stop();
  });

  it('does not schedule a duplicate after SMTP accepted but delivery acknowledgement failed', async () => {
    const queued=await queue();
    const fn=`fail_mail_ack_${randomUUID().replaceAll('-','')}`; const trigger=`fail_mail_ack_${randomUUID().replaceAll('-','')}`;
    await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated acknowledgement outage'; END $$`);
    await db.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON outbox_events FOR EACH ROW WHEN (NEW.delivered_at IS NOT NULL) EXECUTE FUNCTION ${fn}()`);
    const transport=new RecordingTransport(); const consumer=new MailConsumer(db,config,transport);
    try {
      await expect(consumer.tick()).rejects.toThrow('simulated acknowledgement outage');
      expect(transport.messages).toHaveLength(1);
      expect(await delivery(queued.eventId)).toMatchObject({state:'SENDING',attempts:0});
    } finally { await consumer.stop(); await db.query(`DROP TRIGGER ${trigger} ON outbox_events`); await db.query(`DROP FUNCTION ${fn}()`); }
  });
});

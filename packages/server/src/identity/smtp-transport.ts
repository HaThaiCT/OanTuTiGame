import nodemailer from 'nodemailer';
import type { SmtpConfig } from './online-config.js';
import type { MailMessage, MailTransport } from './mail-consumer.js';

/** No socket or SMTP verification happens at construction; LAN never calls this factory. */
export function createSmtpTransport(config: SmtpConfig): MailTransport {
  return {
    async send(message: MailMessage, signal?: AbortSignal): Promise<void> {
      const transport = nodemailer.createTransport({
        host: config.host, port: config.port, secure: config.tlsMode === 'implicit',
        requireTLS: config.tlsMode === 'starttls', ignoreTLS: false,
        auth: { user: config.user, pass: config.password },
        tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: config.host },
        connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
        logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
      });
      const abort = () => { transport.close(); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (signal?.aborted) throw new Error('SMTP delivery aborted');
        const result = await transport.sendMail({ from: message.from, to: message.recipient, replyTo: message.replyTo, subject: message.subject, text: message.text, messageId: message.messageId, disableFileAccess: true, disableUrlAccess: true });
        if (!result.accepted?.length || result.rejected?.length) throw new Error('SMTP recipient not accepted');
      } catch { throw new Error('SMTP delivery failed'); }
      finally { signal?.removeEventListener('abort', abort); transport.close(); }
    },
  };
}

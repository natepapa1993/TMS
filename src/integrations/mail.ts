import { simpleParser, type ParsedMail } from "mailparser";
import { createHash } from "node:crypto";

/**
 * The inbox agent's transport (spec Module 12 "Ingest"): an email is bytes from an IMAP folder or a POST
 * to the company's inbound URL (what Cloudflare Email Routing, Mailgun routes, Postmark and SES all
 * offer: forward dispatch@ to a URL). Either way it becomes one ParsedEmail here; the pipeline never
 * knows which. IMAP is what Gmail and Microsoft 365 give with an app password, no Cloud project needed.
 */

export type ParsedEmail = {
  messageId: string;
  from: string;
  fromName: string | null;
  to: string | null;
  subject: string;
  date: Date;
  text: string;
  attachments: { fileName: string; mimeType: string; bytes: Buffer }[];
};

const ATTACHABLE = /^(application\/pdf|image\/(jpeg|png))$/;

export async function parseEmail(raw: Buffer | string): Promise<ParsedEmail> {
  const buf = typeof raw === "string" ? Buffer.from(raw) : raw;
  const m: ParsedMail = await simpleParser(buf, { skipHtmlToText: false });
  const from = m.from?.value?.[0];
  const to = Array.isArray(m.to) ? m.to[0] : m.to;
  const text = (m.text ?? htmlToText(m.html || "") ?? "").replace(/\r\n/g, "\n").trim();
  return {
    messageId: (m.messageId ?? "").trim() || `sha256:${createHash("sha256").update(buf).digest("hex")}`,
    from: (from?.address ?? "").toLowerCase(),
    fromName: from?.name?.trim() || null,
    to: to?.text ?? null,
    subject: (m.subject ?? "").trim(),
    date: m.date ?? new Date(),
    text,
    attachments: (m.attachments ?? [])
      .filter((a) => a.content?.length && ATTACHABLE.test(a.contentType) && a.content.length <= 25 * 1024 * 1024)
      .map((a) => ({ fileName: a.filename || `attachment.${a.contentType === "application/pdf" ? "pdf" : a.contentType.endsWith("png") ? "png" : "jpg"}`, mimeType: a.contentType, bytes: a.content })),
  };
}

function htmlToText(html: string | false) {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n");
}

// ---------- IMAP ----------

export type ImapConfig = { host: string; port?: number; user: string; password: string; folder?: string; secure?: boolean };

/** What the poller needs from a mailbox; ImapFlow in production, a memory box in tests. */
export interface MailBox {
  /** Unread messages newer than `sinceUid`, oldest first, as raw RFC 822 bytes with their UID. */
  fetchNew(sinceUid: number, limit?: number): Promise<{ uid: number; raw: Buffer }[]>;
  close(): Promise<void>;
}

export function validateImap(c: Partial<ImapConfig>): asserts c is ImapConfig {
  const bad = (m: string, field: string) => Object.assign(new Error(m), { name: "ValidationError", field });
  if (!c.host?.trim()) throw bad("IMAP host is required (imap.gmail.com, outlook.office365.com)", "host");
  if (!c.user?.trim()) throw bad("the mailbox user (the full address)", "user");
  if (!c.password) throw bad("an app password for the mailbox", "password");
  if (c.port != null && (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535)) throw bad("port must be 1–65535", "port");
}

export async function openImap(c: ImapConfig): Promise<MailBox> {
  validateImap(c);
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({ host: c.host, port: c.port ?? 993, secure: c.secure ?? true, auth: { user: c.user, pass: c.password }, logger: false });
  await client.connect();
  const folder = c.folder || "INBOX";
  return {
    async fetchNew(sinceUid, limit = 25) {
      const lock = await client.getMailboxLock(folder);
      try {
        const out: { uid: number; raw: Buffer }[] = [];
        for await (const msg of client.fetch({ uid: `${sinceUid + 1}:*` }, { uid: true, source: true })) {
          if (msg.uid <= sinceUid || !msg.source) continue;
          out.push({ uid: msg.uid, raw: msg.source });
          if (out.length >= limit) break;
        }
        return out.sort((a, b) => a.uid - b.uid);
      } finally {
        lock.release();
      }
    },
    async close() {
      await client.logout().catch(() => null);
    },
  };
}

/** A mailbox in memory for tests: push raw messages, they come back once with rising UIDs. */
export function memoryBox(initial: (Buffer | string)[] = []) {
  const msgs: { uid: number; raw: Buffer }[] = initial.map((r, i) => ({ uid: i + 1, raw: Buffer.from(r) }));
  const box: MailBox & { push(raw: Buffer | string): number } = {
    push(raw) {
      const uid = (msgs[msgs.length - 1]?.uid ?? 0) + 1;
      msgs.push({ uid, raw: Buffer.from(raw) });
      return uid;
    },
    async fetchNew(sinceUid, limit = 25) {
      return msgs.filter((m) => m.uid > sinceUid).slice(0, limit);
    },
    async close() {},
  };
  return box;
}

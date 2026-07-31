/**
 * MailEngine — multi-account IMAP sync + SMTP replies.
 *
 * • Accounts (host/user/password) live AES-256-GCM encrypted in the
 *   CipherVault secondary store: vault.storeData('mail-accounts', [...]).
 * • Sync is silent: every syncIntervalMs, new INBOX messages (by UID
 *   high-water mark) are parsed and cached into SQLite with triage flags.
 *   Failures land in mail_sync_state.last_error, never in chat.
 * • sendReply() is only ever called AFTER human approval (the tool loop
 *   gates reply_to_email exactly like install_npm_package).
 * • imapFactory / transportFactory are injectable for tests.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { CipherVault } from './cipher-vault.js';
import { computeFlags, loadVips } from './mail-triage.js';

export const PROVIDER_PRESETS = {
  gmail: { label: 'Gmail', imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465,
    appPasswordUrl: 'https://myaccount.google.com/apppasswords' },
  yahoo: { label: 'Yahoo', imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465,
    appPasswordUrl: 'https://login.yahoo.com/account/security' },
  aol: { label: 'AOL', imapHost: 'imap.aol.com', imapPort: 993, smtpHost: 'smtp.aol.com', smtpPort: 465,
    appPasswordUrl: 'https://login.aol.com/account/security' },
  office365: { label: 'Microsoft 365 (.edu)', imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587,
    appPasswordUrl: 'https://mysignins.microsoft.com/security-info' },
};

const PREVIEW_CHARS = 500;
const VAULT_KEY = 'mail-accounts';

export class MailEngine {
  constructor({ database, vault = null, vaultPath = './data/cipher-vault.enc',
                syncIntervalMs = Number(process.env.MAIL_SYNC_INTERVAL || 300) * 1000,
                imapFactory = null, transportFactory = null, vipPath = './config/mail-vips.json' } = {}) {
    this.db = database;
    this.vault = vault || new CipherVault(vaultPath);
    this.syncIntervalMs = syncIntervalMs;
    this.vipPath = vipPath;
    this._timer = null;
    this._syncing = false;
    this._imapFactory = imapFactory || ((acct) => new ImapFlow({
      host: acct.imapHost, port: acct.imapPort, secure: true,
      auth: { user: acct.email, pass: acct.password }, logger: false,
    }));
    this._transportFactory = transportFactory || ((acct) => nodemailer.createTransport({
      host: acct.smtpHost, port: acct.smtpPort, secure: acct.smtpPort === 465,
      auth: { user: acct.email, pass: acct.password },
    }));
    this._accounts = this.vault.getData(VAULT_KEY) || [];
  }

  // ─── Account registry (vault-backed) ─────────────────

  addAccount({ email, password, provider = null, imapHost, imapPort, smtpHost, smtpPort }) {
    if (!email || !password) throw new Error('email and password are required');
    const preset = provider ? PROVIDER_PRESETS[provider] : null;
    const acct = {
      email: String(email).toLowerCase().trim(),
      password,
      imapHost: imapHost || preset?.imapHost, imapPort: imapPort || preset?.imapPort || 993,
      smtpHost: smtpHost || preset?.smtpHost, smtpPort: smtpPort || preset?.smtpPort || 465,
    };
    if (!acct.imapHost || !acct.smtpHost) throw new Error('imapHost/smtpHost required (or pass a known provider)');
    this._accounts = this._accounts.filter(a => a.email !== acct.email).concat(acct);
    this.vault.storeData(VAULT_KEY, this._accounts);
    return { email: acct.email, imapHost: acct.imapHost, smtpHost: acct.smtpHost };
  }

  listAccounts() {
    return this._accounts.map(a => ({ email: a.email, imapHost: a.imapHost, smtpHost: a.smtpHost }));
  }

  removeAccount(email) {
    const before = this._accounts.length;
    this._accounts = this._accounts.filter(a => a.email !== String(email).toLowerCase().trim());
    this.vault.storeData(VAULT_KEY, this._accounts);
    return this._accounts.length < before;
  }

  // ─── Lifecycle ────────────────────────────────────────

  start() {
    if (this._timer) return;
    console.log(`  ✓ MailEngine started (${this._accounts.length} account(s), sync every ${Math.round(this.syncIntervalMs / 1000)}s)`);
    setTimeout(() => this.syncAll(), 5000);
    this._timer = setInterval(() => this.syncAll(), this.syncIntervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // ─── Sync ─────────────────────────────────────────────

  async syncAll() {
    if (this._syncing) return { synced: 0, errors: [] };
    this._syncing = true;
    const result = { synced: 0, errors: [] };
    try {
      for (const acct of this._accounts) {
        try {
          result.synced += await this.syncAccount(acct);
        } catch (e) {
          // Silent by design: log + record, never notify chat.
          console.error(`  ✗ [Mail] sync failed for ${acct.email}: ${e.message}`);
          this.db.setMailSyncState(acct.email, { lastError: e.message });
          result.errors.push({ account: acct.email, error: e.message });
        }
      }
    } finally {
      this._syncing = false;
    }
    return result;
  }

  async syncAccount(acct) {
    const vips = loadVips(this.vipPath);
    const state = this.db.getMailSyncState(acct.email);
    const lastUid = state?.last_uid || 0;

    const client = this._imapFactory(acct);
    let stored = 0;
    let maxUid = lastUid;
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        for await (const msg of client.fetch({ uid: `${lastUid + 1}:*` }, { uid: true, envelope: true, source: true })) {
          if (msg.uid <= lastUid) continue; // IMAP returns the last message even when range is empty
          const parsed = await simpleParser(msg.source);
          const text = (parsed.text || '').trim();
          const from = msg.envelope?.from?.[0] || {};
          const flags = computeFlags({
            account: acct.email,
            fromAddr: from.address || parsed.from?.value?.[0]?.address || '',
            hasListUnsubscribe: parsed.headers?.has?.('list-unsubscribe') || false,
          }, vips);
          this.db.upsertMailMessage({
            account: acct.email,
            uid: msg.uid,
            messageId: msg.envelope?.messageId || parsed.messageId || null,
            fromAddr: from.address || '',
            fromName: from.name || '',
            subject: msg.envelope?.subject || parsed.subject || '(no subject)',
            preview: text.slice(0, PREVIEW_CHARS),
            body: text || null,
            receivedAt: (msg.envelope?.date || parsed.date || new Date()).toISOString(),
            isEdu: flags.isEdu, isVip: flags.isVip, isAutomated: flags.isAutomated,
          });
          stored += 1;
          if (msg.uid > maxUid) maxUid = msg.uid;
        }
      } finally {
        lock.release();
      }
    } finally {
      try { await client.logout(); } catch { /* best-effort */ }
    }
    this.db.setMailSyncState(acct.email, { lastUid: maxUid });
    return stored;
  }

  // ─── Bodies ───────────────────────────────────────────

  async getBody(messageDbId) {
    const row = this.db.getMailMessage(messageDbId);
    if (!row) throw new Error(`No email with id ${messageDbId}`);
    if (row.body) return row.body;

    const acct = this._accounts.find(a => a.email === row.account);
    if (!acct) throw new Error(`Account ${row.account} is no longer configured`);
    const client = this._imapFactory(acct);
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        for await (const msg of client.fetch({ uid: `${row.uid}:${row.uid}` }, { uid: true, source: true })) {
          if (msg.uid !== row.uid) continue;
          const parsed = await simpleParser(msg.source);
          const text = (parsed.text || '').trim();
          this.db.setMailBody(messageDbId, text);
          return text;
        }
      } finally {
        lock.release();
      }
    } finally {
      try { await client.logout(); } catch { /* best-effort */ }
    }
    throw new Error('Message no longer exists on the server');
  }

  // ─── Reply (post-approval only) ───────────────────────

  async sendReply({ messageDbId, body }) {
    const row = this.db.getMailMessage(messageDbId);
    if (!row) throw new Error(`No email with id ${messageDbId}`);
    if (!body || !String(body).trim()) throw new Error('Reply body is empty');
    const acct = this._accounts.find(a => a.email === row.account);
    if (!acct) throw new Error(`Account ${row.account} is no longer configured`);

    const subject = /^re:/i.test(row.subject || '') ? row.subject : `Re: ${row.subject || ''}`.trim();
    const transport = this._transportFactory(acct);
    await transport.sendMail({
      from: acct.email,
      to: row.from_addr,
      subject,
      text: body,
      inReplyTo: row.message_id || undefined,
      references: row.message_id ? [row.message_id] : undefined,
    });
    return { sent: true, to: row.from_addr, subject, from: acct.email };
  }

  // ─── Status ───────────────────────────────────────────

  getSyncStatus() {
    return this._accounts.map(a => {
      const st = this.db.getMailSyncState(a.email);
      return { account: a.email, lastSyncAt: st?.last_sync_at || null, lastError: st?.last_error || null };
    });
  }
}

export default MailEngine;

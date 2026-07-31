# Email Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nexus reads mail from 4 IMAP accounts, triages importance on demand, and sends human-approved replies.

**Architecture:** A `MailEngine` core module (IMAP sync via imapflow → SQLite, SMTP replies via nodemailer) exposed through the existing tool registry; reply-sending goes through a generalized version of the install-approval gate in `ConversationManager`. Credentials live encrypted in the existing `CipherVault` (`storeData('mail-accounts', …)`).

**Tech Stack:** Node 18+ ESM, better-sqlite3, imapflow, mailparser, nodemailer, existing CipherVault (AES-256-GCM).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-31-email-integration-design.md` — read it before starting.
- No proactive notifications: sync failures are logged, never sent to chat.
- Replies NEVER send without explicit user approval through the pending-tool-call gate.
- Credentials never touch SQLite or plaintext files — vault only.
- Tests are standalone `node <file>.mjs` scripts (this repo has no test framework); follow the `_audit_test.mjs` pattern: throw on failure, print `PASS ✓`.
- Env config: `MAIL_ENABLED` (default off), `MAIL_SYNC_INTERVAL` seconds (default 300).
- All tests need `CIPHER_VAULT_KEY` set in-process before importing vault-touching modules: `process.env.CIPHER_VAULT_KEY = '11'.repeat(32)`.
- Plain-text replies only; no attachments; replies only (no new compositions) — v1 scope.
- Commit after every task with a `feat:`/`test:` message ending in the Claude co-author trailer.

---

### Task 1: Mail tables + DB methods

**Files:**
- Modify: `src/core/database.js` (add `_createMailTables()` + mail methods; call from `initialize()` after `_createCipherTables()`)
- Test: `_mail_db_test.mjs` (repo root)

**Interfaces:**
- Produces (used by Tasks 3–6):
  - `upsertMailMessage({account, uid, messageId, fromAddr, fromName, subject, preview, body, receivedAt, isEdu, isVip, isAutomated})` → row id (string). Idempotent on `(account, uid)`; re-upsert returns existing id, does not duplicate.
  - `getMailMessage(id)` → row or undefined
  - `setMailBody(id, body)`
  - `listRecentMail({sinceHours = 48, minCount = 30} = {})` → rows newest-first: everything within `sinceHours`, padded to at least `minCount` overall
  - `searchMail({query, account = null, limit = 20})` → rows (LIKE over from_addr, from_name, subject, preview)
  - `getMailSyncState(account)` → `{account, last_uid, last_sync_at, last_error}` or undefined
  - `setMailSyncState(account, {lastUid = null, lastError = null})` — updates high-water mark and/or error, stamps `last_sync_at` only on success (`lastError === null`)

- [ ] **Step 1: Write the failing test**

```js
// _mail_db_test.mjs
import { NexusDatabase } from './src/core/database.js';
import fs from 'fs';

const DB = `/tmp/nexus_mail_db_${process.pid}.db`;
try { fs.unlinkSync(DB); } catch {}
const db = new NexusDatabase(DB);
db.initialize();

// upsert + idempotency
const id1 = db.upsertMailMessage({
  account: 'k@gmail.com', uid: 101, messageId: '<m1@x>', fromAddr: 'prof@wright.edu',
  fromName: 'Prof X', subject: 'Quiz 1 grades', preview: 'Your grade is posted',
  body: null, receivedAt: new Date().toISOString(), isEdu: 1, isVip: 0, isAutomated: 0,
});
const id2 = db.upsertMailMessage({ account: 'k@gmail.com', uid: 101, messageId: '<m1@x>',
  fromAddr: 'prof@wright.edu', fromName: 'Prof X', subject: 'Quiz 1 grades',
  preview: 'x', body: null, receivedAt: new Date().toISOString(), isEdu: 1, isVip: 0, isAutomated: 0 });
if (id1 !== id2) throw new Error('upsert not idempotent on (account, uid)');

// body lazy-set
db.setMailBody(id1, 'full body here');
if (db.getMailMessage(id1).body !== 'full body here') throw new Error('setMailBody failed');

// recent: old mail beyond 48h still padded to minCount
const old = new Date(Date.now() - 90 * 3600 * 1000).toISOString();
for (let i = 0; i < 5; i++) {
  db.upsertMailMessage({ account: 'k@yahoo.com', uid: 200 + i, messageId: `<o${i}@x>`,
    fromAddr: 'deals@shop.com', fromName: 'Shop', subject: `Sale ${i}`, preview: 'buy',
    body: null, receivedAt: old, isEdu: 0, isVip: 0, isAutomated: 1 });
}
const recent = db.listRecentMail({ sinceHours: 48, minCount: 3 });
if (recent.length < 3) throw new Error(`listRecentMail padded to fewer than minCount: ${recent.length}`);
if (recent[0].uid !== 101) throw new Error('listRecentMail not newest-first');

// search
const hits = db.searchMail({ query: 'grades' });
if (hits.length !== 1 || hits[0].subject !== 'Quiz 1 grades') throw new Error('searchMail failed');
const scoped = db.searchMail({ query: 'Sale', account: 'k@gmail.com' });
if (scoped.length !== 0) throw new Error('searchMail account filter failed');

// sync state
db.setMailSyncState('k@gmail.com', { lastUid: 101 });
let st = db.getMailSyncState('k@gmail.com');
if (st.last_uid !== 101 || !st.last_sync_at) throw new Error('sync state success path failed');
db.setMailSyncState('k@gmail.com', { lastError: 'auth failed' });
st = db.getMailSyncState('k@gmail.com');
if (st.last_error !== 'auth failed' || st.last_uid !== 101) throw new Error('sync state error path failed');

db.close();
fs.unlinkSync(DB);
console.log('MAIL DB TESTS PASS ✓');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node _mail_db_test.mjs`
Expected: FAIL with `db.upsertMailMessage is not a function`

- [ ] **Step 3: Implement in `src/core/database.js`**

Add after `_createCipherTables()` and call `this._createMailTables()` from `initialize()`:

```js
  // ─── Mail: multi-account email cache ───────────────────

  _createMailTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_messages (
        id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        uid INTEGER NOT NULL,
        message_id TEXT,
        from_addr TEXT,
        from_name TEXT,
        subject TEXT,
        preview TEXT,
        body TEXT,
        received_at DATETIME,
        is_edu INTEGER DEFAULT 0,
        is_vip INTEGER DEFAULT 0,
        is_automated INTEGER DEFAULT 0,
        UNIQUE(account, uid)
      );
      CREATE TABLE IF NOT EXISTS mail_sync_state (
        account TEXT PRIMARY KEY,
        last_uid INTEGER DEFAULT 0,
        last_sync_at DATETIME,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mail_received ON mail_messages(received_at);
      CREATE INDEX IF NOT EXISTS idx_mail_account ON mail_messages(account);
    `);
  }

  upsertMailMessage({ account, uid, messageId, fromAddr, fromName, subject, preview, body, receivedAt, isEdu, isVip, isAutomated }) {
    const existing = this.db.prepare(
      'SELECT id FROM mail_messages WHERE account = ? AND uid = ?'
    ).get(account, uid);
    if (existing) return existing.id;

    const id = uuidv4();
    this.db.prepare(`
      INSERT INTO mail_messages (id, account, uid, message_id, from_addr, from_name, subject, preview, body, received_at, is_edu, is_vip, is_automated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, account, uid, messageId || null, fromAddr || null, fromName || null,
      subject || null, preview || null, body || null, receivedAt || null,
      isEdu ? 1 : 0, isVip ? 1 : 0, isAutomated ? 1 : 0);
    return id;
  }

  getMailMessage(id) {
    return this.db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(id);
  }

  setMailBody(id, body) {
    this.db.prepare('UPDATE mail_messages SET body = ? WHERE id = ?').run(body, id);
  }

  listRecentMail({ sinceHours = 48, minCount = 30 } = {}) {
    const rows = this.db.prepare(
      'SELECT * FROM mail_messages ORDER BY received_at DESC LIMIT 200'
    ).all();
    const cutoff = Date.now() - sinceHours * 3600 * 1000;
    const withinWindow = rows.filter(r => new Date(r.received_at).getTime() >= cutoff);
    return withinWindow.length >= minCount ? withinWindow : rows.slice(0, minCount);
  }

  searchMail({ query, account = null, limit = 20 }) {
    const like = `%${query}%`;
    if (account) {
      return this.db.prepare(`
        SELECT * FROM mail_messages
        WHERE account = ? AND (from_addr LIKE ? OR from_name LIKE ? OR subject LIKE ? OR preview LIKE ?)
        ORDER BY received_at DESC LIMIT ?
      `).all(account, like, like, like, like, limit);
    }
    return this.db.prepare(`
      SELECT * FROM mail_messages
      WHERE from_addr LIKE ? OR from_name LIKE ? OR subject LIKE ? OR preview LIKE ?
      ORDER BY received_at DESC LIMIT ?
    `).all(like, like, like, like, limit);
  }

  getMailSyncState(account) {
    return this.db.prepare('SELECT * FROM mail_sync_state WHERE account = ?').get(account);
  }

  setMailSyncState(account, { lastUid = null, lastError = null } = {}) {
    this.db.prepare(`
      INSERT INTO mail_sync_state (account, last_uid, last_sync_at, last_error)
      VALUES (?, COALESCE(?, 0), CASE WHEN ? IS NULL THEN CURRENT_TIMESTAMP ELSE NULL END, ?)
      ON CONFLICT(account) DO UPDATE SET
        last_uid = COALESCE(excluded.last_uid, mail_sync_state.last_uid),
        last_sync_at = CASE WHEN excluded.last_error IS NULL THEN CURRENT_TIMESTAMP ELSE mail_sync_state.last_sync_at END,
        last_error = excluded.last_error
    `).run(account, lastUid, lastError, lastError);
  }
```

Note: `uuidv4` is already imported at the top of `database.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node _mail_db_test.mjs`
Expected: `MAIL DB TESTS PASS ✓`

- [ ] **Step 5: Commit**

```bash
git add src/core/database.js _mail_db_test.mjs
git commit -m "feat: add mail_messages and mail_sync_state tables with accessors

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Triage flags + VIP config (`mail-triage.js`)

**Files:**
- Create: `src/core/mail-triage.js`
- Create: `config/mail-vips.json` (seed: `{ "vips": [] }`)
- Test: `_mail_triage_test.mjs`

**Interfaces:**
- Produces (used by Tasks 3, 6):
  - `loadVips(path = './config/mail-vips.json')` → `string[]` (lowercased entries; `[]` on missing/corrupt file)
  - `saveVips(list, path = './config/mail-vips.json')`
  - `isEduMail({ account, fromAddr })` → bool (either domain ends `.edu`)
  - `isVipSender(fromAddr, vips)` → bool (entry matches full address, or entry is a domain matching the sender's domain; case-insensitive)
  - `isAutomatedSender({ fromAddr, hasListUnsubscribe })` → bool (local part matches no-reply/noreply/donotreply/newsletter/notifications/marketing/mailer, OR `hasListUnsubscribe`)
  - `computeFlags({ account, fromAddr, hasListUnsubscribe }, vips)` → `{ isEdu, isVip, isAutomated }` (0/1 ints)

- [ ] **Step 1: Write the failing test**

```js
// _mail_triage_test.mjs
import { isEduMail, isVipSender, isAutomatedSender, computeFlags, loadVips, saveVips } from './src/core/mail-triage.js';
import fs from 'fs';

if (!isEduMail({ account: 'k@wright.edu', fromAddr: 'x@y.com' })) throw new Error('edu account not flagged');
if (!isEduMail({ account: 'k@gmail.com', fromAddr: 'prof@wright.edu' })) throw new Error('edu sender not flagged');
if (isEduMail({ account: 'k@gmail.com', fromAddr: 'x@education.com' })) throw new Error('education.com wrongly flagged');

const vips = ['mom@icloud.com', 'wright.edu'];
if (!isVipSender('Mom@iCloud.com', vips)) throw new Error('exact VIP match failed (case)');
if (!isVipSender('advisor@wright.edu', vips)) throw new Error('domain VIP match failed');
if (isVipSender('stranger@gmail.com', vips)) throw new Error('non-VIP wrongly matched');

if (!isAutomatedSender({ fromAddr: 'no-reply@github.com', hasListUnsubscribe: false })) throw new Error('no-reply not flagged');
if (!isAutomatedSender({ fromAddr: 'deals@shop.com', hasListUnsubscribe: true })) throw new Error('List-Unsubscribe not flagged');
if (isAutomatedSender({ fromAddr: 'prof@wright.edu', hasListUnsubscribe: false })) throw new Error('human wrongly flagged');

const f = computeFlags({ account: 'k@gmail.com', fromAddr: 'mom@icloud.com', hasListUnsubscribe: false }, vips);
if (f.isVip !== 1 || f.isEdu !== 0 || f.isAutomated !== 0) throw new Error('computeFlags wrong: ' + JSON.stringify(f));

const TMP = `/tmp/vips_${process.pid}.json`;
saveVips(['A@B.com'], TMP);
const loaded = loadVips(TMP);
if (loaded.length !== 1 || loaded[0] !== 'a@b.com') throw new Error('vips round-trip / lowercase failed');
if (loadVips('/tmp/definitely-missing.json').length !== 0) throw new Error('missing file should give []');
fs.unlinkSync(TMP);

console.log('MAIL TRIAGE TESTS PASS ✓');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node _mail_triage_test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/core/mail-triage.js`**

```js
/**
 * Mail triage helpers — pure functions computing importance flags.
 * Hard flags (edu / VIP) are stored on each row at sync time; the
 * conversational model does the soft "AI judgment" layer when presenting.
 */

import { readFileSync, writeFileSync } from 'fs';

const DEFAULT_VIP_PATH = './config/mail-vips.json';

const AUTOMATED_LOCAL_RE = /^(no-?reply|do-?not-?reply|newsletter|notifications?|marketing|mailer(-daemon)?|bounce|updates)/i;

function domainOf(addr) {
  const m = String(addr || '').toLowerCase().match(/@([^@\s>]+)/);
  return m ? m[1] : '';
}

export function loadVips(path = DEFAULT_VIP_PATH) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return (Array.isArray(data.vips) ? data.vips : []).map(v => String(v).toLowerCase().trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function saveVips(list, path = DEFAULT_VIP_PATH) {
  const vips = [...new Set(list.map(v => String(v).toLowerCase().trim()).filter(Boolean))];
  writeFileSync(path, JSON.stringify({ vips }, null, 2) + '\n');
  return vips;
}

export function isEduMail({ account, fromAddr }) {
  return domainOf(account).endsWith('.edu') || domainOf(fromAddr).endsWith('.edu');
}

export function isVipSender(fromAddr, vips) {
  const addr = String(fromAddr || '').toLowerCase().trim();
  const dom = domainOf(addr);
  return vips.some(v => v === addr || (!v.includes('@') && v === dom));
}

export function isAutomatedSender({ fromAddr, hasListUnsubscribe }) {
  if (hasListUnsubscribe) return true;
  const local = String(fromAddr || '').toLowerCase().split('@')[0];
  return AUTOMATED_LOCAL_RE.test(local);
}

export function computeFlags({ account, fromAddr, hasListUnsubscribe }, vips) {
  return {
    isEdu: isEduMail({ account, fromAddr }) ? 1 : 0,
    isVip: isVipSender(fromAddr, vips) ? 1 : 0,
    isAutomated: isAutomatedSender({ fromAddr, hasListUnsubscribe }) ? 1 : 0,
  };
}
```

Also create `config/mail-vips.json`:

```json
{
  "vips": []
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node _mail_triage_test.mjs`
Expected: `MAIL TRIAGE TESTS PASS ✓`

- [ ] **Step 5: Commit**

```bash
git add src/core/mail-triage.js config/mail-vips.json _mail_triage_test.mjs
git commit -m "feat: add mail triage flags (edu/vip/automated) and VIP config

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: MailEngine — accounts, sync, send

**Files:**
- Create: `src/core/mail-engine.js`
- Test: `_mail_engine_test.mjs`
- Modify: `package.json` (deps installed in Step 0)

**Interfaces:**
- Consumes: Task 1 DB methods; Task 2 `computeFlags`/`loadVips`; `CipherVault.storeData/getData` (existing).
- Produces (used by Tasks 4–6):
  - `new MailEngine({ database, vault = null, vaultPath = './data/cipher-vault.enc', syncIntervalMs = 300000, imapFactory = null, transportFactory = null })`
  - `PROVIDER_PRESETS` — `{ gmail, yahoo, aol, office365 }`, each `{ imapHost, imapPort, smtpHost, smtpPort, label, appPasswordUrl }`
  - `addAccount({ email, password, provider = null, imapHost, imapPort, smtpHost, smtpPort })` — preset fills hosts when `provider` given; persists via vault
  - `listAccounts()` → `[{ email, imapHost, smtpHost }]` (no passwords)
  - `removeAccount(email)` → bool
  - `start()` / `stop()` — sync timer (also runs one sync ~5s after start)
  - `async syncAll()` → `{ synced: n, errors: [{account, error}] }` (never throws)
  - `async syncAccount(account)` → count of new messages stored
  - `async getBody(messageDbId)` → string (DB body, or IMAP fetch + `setMailBody` when NULL)
  - `async sendReply({ messageDbId, body })` → `{ sent: true, to, subject, from }`; throws with clear message on failure. Sets `Subject: Re: …` (no double-Re), `In-Reply-To`/`References` from stored `message_id`, sends from the receiving account.
  - `getSyncStatus()` → `[{ account, lastSyncAt, lastError }]`

- [ ] **Step 0: Install dependencies**

```bash
npm install imapflow mailparser nodemailer
```

Expected: adds 3 deps, no install errors (puppeteer skip already handled by `.puppeteerrc.cjs`).

- [ ] **Step 1: Write the failing test**

Uses fakes for both IMAP and SMTP — no network.

```js
// _mail_engine_test.mjs
process.env.CIPHER_VAULT_KEY = '11'.repeat(32);
import { MailEngine, PROVIDER_PRESETS } from './src/core/mail-engine.js';
import { NexusDatabase } from './src/core/database.js';
import fs from 'fs';

const DB = `/tmp/nexus_mail_engine_${process.pid}.db`;
const VAULT = `/tmp/nexus_mail_vault_${process.pid}.enc`;
try { fs.unlinkSync(DB); } catch {}
const db = new NexusDatabase(DB);
db.initialize();

// Fake IMAP: 2 messages, uids 5 and 6
const fakeMessages = [
  { uid: 5, envelope: { messageId: '<a@x>', from: [{ address: 'prof@wright.edu', name: 'Prof X' }], subject: 'Exam moved', date: new Date() },
    source: Buffer.from('From: Prof X <prof@wright.edu>\r\nSubject: Exam moved\r\n\r\nThe exam moved to Friday.') },
  { uid: 6, envelope: { messageId: '<b@x>', from: [{ address: 'no-reply@shop.com', name: 'Shop' }], subject: '50% off', date: new Date() },
    source: Buffer.from('From: Shop <no-reply@shop.com>\r\nList-Unsubscribe: <mailto:u@shop.com>\r\nSubject: 50% off\r\n\r\nBuy now!') },
];
const imapFactory = () => ({
  connected: false,
  async connect() { this.connected = true; },
  async getMailboxLock() { return { release() {} }; },
  async status() { return { uidNext: 7 }; },
  fetch(range, opts) {
    const startUid = parseInt(String(range.uid).split(':')[0]);
    const msgs = fakeMessages.filter(m => m.uid >= startUid);
    return (async function* () { for (const m of msgs) yield m; })();
  },
  async logout() { this.connected = false; },
});

// Fake SMTP transport records what would be sent
const sentMails = [];
const transportFactory = () => ({ async sendMail(opts) { sentMails.push(opts); return { messageId: '<sent@x>' }; } });

const engine = new MailEngine({ database: db, vaultPath: VAULT, imapFactory, transportFactory });

// accounts
engine.addAccount({ email: 'k@gmail.com', password: 'app-pass', provider: 'gmail' });
const accounts = engine.listAccounts();
if (accounts.length !== 1 || accounts[0].email !== 'k@gmail.com') throw new Error('addAccount/listAccounts failed');
if (accounts[0].imapHost !== PROVIDER_PRESETS.gmail.imapHost) throw new Error('preset not applied');
if (JSON.stringify(accounts[0]).includes('app-pass')) throw new Error('listAccounts leaked password');

// persistence across engine instances (vault round-trip)
const engine2 = new MailEngine({ database: db, vaultPath: VAULT, imapFactory, transportFactory });
if (engine2.listAccounts().length !== 1) throw new Error('accounts not persisted in vault');

// sync stores messages with flags and advances high-water mark
const n = await engine.syncAccount(engine._accounts[0]);
if (n !== 2) throw new Error(`expected 2 new messages, got ${n}`);
const recent = db.listRecentMail({});
const exam = recent.find(r => r.subject === 'Exam moved');
const promo = recent.find(r => r.subject === '50% off');
if (!exam || exam.is_edu !== 1 || exam.is_automated !== 0) throw new Error('edu flags wrong: ' + JSON.stringify(exam));
if (!promo || promo.is_automated !== 1) throw new Error('promo flags wrong: ' + JSON.stringify(promo));
if (!exam.preview.includes('exam moved to Friday')) throw new Error('preview not parsed: ' + exam.preview);
if (db.getMailSyncState('k@gmail.com').last_uid !== 6) throw new Error('high-water mark not advanced');

// re-sync is a no-op
const n2 = await engine.syncAccount(engine._accounts[0]);
if (n2 !== 0) throw new Error('re-sync duplicated messages');

// reply threading + headers
const res = await engine.sendReply({ messageDbId: exam.id, body: 'Thanks, see you Friday.' });
if (!res.sent) throw new Error('sendReply did not send');
const sent = sentMails[0];
if (sent.to !== 'prof@wright.edu') throw new Error('reply to wrong recipient: ' + sent.to);
if (sent.subject !== 'Re: Exam moved') throw new Error('reply subject wrong: ' + sent.subject);
if (sent.inReplyTo !== '<a@x>' || !sent.references.includes('<a@x>')) throw new Error('threading headers missing');
if (sent.from !== 'k@gmail.com') throw new Error('reply not from receiving account');

// syncAll never throws on per-account failure
engine._accounts[0].imapHost = 'x'; // irrelevant for fake, force error instead:
engine._imapFactory = () => ({ async connect() { throw new Error('auth boom'); }, async logout() {} });
const all = await engine.syncAll();
if (all.errors.length !== 1 || !db.getMailSyncState('k@gmail.com').last_error.includes('auth boom')) {
  throw new Error('syncAll error not recorded');
}

// removeAccount
if (!engine.removeAccount('k@gmail.com') || engine.listAccounts().length !== 0) throw new Error('removeAccount failed');

db.close();
fs.unlinkSync(DB); try { fs.unlinkSync(VAULT); } catch {}
console.log('MAIL ENGINE TESTS PASS ✓');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node _mail_engine_test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/core/mail-engine.js`**

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node _mail_engine_test.mjs`
Expected: `MAIL ENGINE TESTS PASS ✓`

- [ ] **Step 5: Commit**

```bash
git add src/core/mail-engine.js _mail_engine_test.mjs package.json package-lock.json
git commit -m "feat: add MailEngine (vault-backed accounts, IMAP sync, SMTP replies)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Mail tools in the tool registry

**Files:**
- Modify: `src/core/tools.js` (5 new schemas in `getToolsSchema`; 5 new `ToolExecutor` methods + `case` entries in `execute()`)
- Test: `_mail_tools_test.mjs`

**Interfaces:**
- Consumes: `this._mailEngine` (a `MailEngine`, injected by index.js in Task 6; when absent every mail tool returns `{error: 'Email is not enabled…'}`), Task 1 DB methods via `this._mailEngine.db`, Task 2 `loadVips`/`saveVips`.
- Produces: tools `check_mailbox`, `read_email`, `search_email`, `reply_to_email`, `manage_vip_senders` callable by the model. `reply_to_email` executes `MailEngine.sendReply` — the approval gate lives in Task 5, not here.

- [ ] **Step 1: Write the failing test**

```js
// _mail_tools_test.mjs
process.env.CIPHER_VAULT_KEY = '11'.repeat(32);
import { ToolExecutor, getToolsSchema } from './src/core/tools.js';
import { MailEngine } from './src/core/mail-engine.js';
import { NexusDatabase } from './src/core/database.js';
import fs from 'fs';

const DB = `/tmp/nexus_mail_tools_${process.pid}.db`;
const VAULT = `/tmp/nexus_mail_tools_vault_${process.pid}.enc`;
const VIPS = `/tmp/nexus_mail_tools_vips_${process.pid}.json`;
fs.writeFileSync(VIPS, JSON.stringify({ vips: [] }));
const db = new NexusDatabase(DB); db.initialize();

// schemas registered
const names = getToolsSchema('openai').map(t => t.function.name);
for (const n of ['check_mailbox', 'read_email', 'search_email', 'reply_to_email', 'manage_vip_senders']) {
  if (!names.includes(n)) throw new Error(`schema missing: ${n}`);
}

// executor without engine → clean error
const bare = new ToolExecutor(null);
const noEngine = JSON.parse(await bare.execute({ name: 'check_mailbox', arguments: '{}' }));
if (!noEngine.error || !noEngine.error.includes('not enabled')) throw new Error('missing-engine error wrong: ' + JSON.stringify(noEngine));

// with engine + seeded mail
const sent = [];
const engine = new MailEngine({ database: db, vaultPath: VAULT, vipPath: VIPS,
  imapFactory: () => { throw new Error('no imap in this test'); },
  transportFactory: () => ({ async sendMail(o) { sent.push(o); return {}; } }) });
engine.addAccount({ email: 'k@gmail.com', password: 'p', provider: 'gmail' });
const mid = db.upsertMailMessage({ account: 'k@gmail.com', uid: 1, messageId: '<t@x>',
  fromAddr: 'prof@wright.edu', fromName: 'Prof X', subject: 'Office hours', preview: 'Come by at 3pm',
  body: 'Come by at 3pm today.', receivedAt: new Date().toISOString(), isEdu: 1, isVip: 0, isAutomated: 0 });
db.setMailSyncState('k@gmail.com', { lastUid: 1 });

const ex = new ToolExecutor(null);
ex._mailEngine = engine;

const box = JSON.parse(await ex.execute({ name: 'check_mailbox', arguments: '{}' }));
if (!box.messages || box.messages.length !== 1) throw new Error('check_mailbox messages wrong');
if (box.messages[0].is_edu !== 1 || box.messages[0].id !== mid) throw new Error('check_mailbox row shape wrong');
if (!Array.isArray(box.accounts)) throw new Error('check_mailbox missing accounts status');

const rd = JSON.parse(await ex.execute({ name: 'read_email', arguments: JSON.stringify({ message_id: mid }) }));
if (rd.body !== 'Come by at 3pm today.') throw new Error('read_email body wrong');

const sr = JSON.parse(await ex.execute({ name: 'search_email', arguments: JSON.stringify({ query: 'Office' }) }));
if (!sr.results || sr.results.length !== 1) throw new Error('search_email failed');

const rep = JSON.parse(await ex.execute({ name: 'reply_to_email', arguments: JSON.stringify({ message_id: mid, draft_body: 'Thanks!' }) }));
if (rep.status !== 'success' || sent.length !== 1 || sent[0].subject !== 'Re: Office hours') {
  throw new Error('reply_to_email failed: ' + JSON.stringify(rep));
}

const vip = JSON.parse(await ex.execute({ name: 'manage_vip_senders', arguments: JSON.stringify({ action: 'add', entry: 'mom@icloud.com' }) }));
if (!vip.vips || vip.vips[0] !== 'mom@icloud.com') throw new Error('vip add failed');
const vipList = JSON.parse(await ex.execute({ name: 'manage_vip_senders', arguments: JSON.stringify({ action: 'list' }) }));
if (vipList.vips.length !== 1) throw new Error('vip list failed');
const vipRm = JSON.parse(await ex.execute({ name: 'manage_vip_senders', arguments: JSON.stringify({ action: 'remove', entry: 'mom@icloud.com' }) }));
if (vipRm.vips.length !== 0) throw new Error('vip remove failed');

db.close();
for (const f of [DB, VAULT, VIPS]) { try { fs.unlinkSync(f); } catch {} }
console.log('MAIL TOOLS TESTS PASS ✓');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node _mail_tools_test.mjs`
Expected: FAIL with `schema missing: check_mailbox`

- [ ] **Step 3: Implement in `src/core/tools.js`**

Add to the `schemas` array in `getToolsSchema` (before the closing `]`):

```js
    {
      type: 'function',
      function: {
        name: 'check_mailbox',
        description: 'List recent emails across ALL of the user\'s connected accounts (.edu, Gmail, AOL, Yahoo). Call this whenever the user asks about their email, inbox, or "anything important". Each message carries flags: is_edu and is_vip mean ALWAYS IMPORTANT; is_automated means promotional/newsletter (usually LOW priority). For unflagged mail, judge importance yourself: real humans outrank automated senders; deadlines, grades, money, and time-sensitive requests rank high; promos and social notifications rank low. Present results as two groups: Important and Less important. NEVER report email unprompted.',
        parameters: {
          type: 'object',
          properties: {
            since_hours: { type: 'integer', description: 'Look-back window in hours (default 48).' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_email',
        description: 'Read the full body of one email, by the id returned from check_mailbox or search_email.',
        parameters: {
          type: 'object',
          properties: {
            message_id: { type: 'string', description: 'The database id of the email.' }
          },
          required: ['message_id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_email',
        description: 'Search cached emails by sender, name, or subject text. Optionally restrict to one account.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Text to search for.' },
            account: { type: 'string', description: 'Optional: only this account (email address).' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'reply_to_email',
        description: 'Draft a reply to an email. The draft is shown to the user for approval BEFORE anything is sent — the system enforces this, so write the best complete draft you can. Plain text only.',
        parameters: {
          type: 'object',
          properties: {
            message_id: { type: 'string', description: 'The database id of the email being replied to.' },
            draft_body: { type: 'string', description: 'The complete plain-text reply body.' }
          },
          required: ['message_id', 'draft_body']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'manage_vip_senders',
        description: 'Manage the VIP sender list. VIP emails are always ranked important. Entries are full addresses (mom@icloud.com) or bare domains (wright.edu).',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'remove', 'list'] },
            entry: { type: 'string', description: 'Address or domain (not needed for list).' }
          },
          required: ['action']
        }
      }
    }
```

Add `case` entries in `execute()`:

```js
        case 'check_mailbox':
          return await this.checkMailbox(params.since_hours);
        case 'read_email':
          return await this.readEmail(params.message_id);
        case 'search_email':
          return await this.searchEmail(params.query, params.account);
        case 'reply_to_email':
          return await this.replyToEmail(params.message_id, params.draft_body);
        case 'manage_vip_senders':
          return await this.manageVipSenders(params.action, params.entry);
```

Add methods to `ToolExecutor` (import `loadVips, saveVips` from `./mail-triage.js` at top of file):

```js
  // ─── Email tools (MailEngine injected by index.js) ────

  _requireMail() {
    if (!this._mailEngine) {
      return JSON.stringify({ error: 'Email is not enabled. Set MAIL_ENABLED=true and add accounts with: node src/mail-cli.js add-account' });
    }
    return null;
  }

  async checkMailbox(sinceHours) {
    const gate = this._requireMail(); if (gate) return gate;
    const rows = this._mailEngine.db.listRecentMail({ sinceHours: sinceHours || 48 });
    const messages = rows.map(r => ({
      id: r.id, account: r.account, from: r.from_addr, from_name: r.from_name,
      subject: r.subject, preview: r.preview, received_at: r.received_at,
      is_edu: r.is_edu, is_vip: r.is_vip, is_automated: r.is_automated,
    }));
    return JSON.stringify({ messages, accounts: this._mailEngine.getSyncStatus() });
  }

  async readEmail(messageId) {
    const gate = this._requireMail(); if (gate) return gate;
    if (!messageId) return JSON.stringify({ error: 'message_id is required' });
    try {
      const row = this._mailEngine.db.getMailMessage(messageId);
      if (!row) return JSON.stringify({ error: `No email with id ${messageId}` });
      const body = await this._mailEngine.getBody(messageId);
      return JSON.stringify({ from: row.from_addr, subject: row.subject, account: row.account,
        received_at: row.received_at, body: (body || '').slice(0, 20000) });
    } catch (e) {
      return JSON.stringify({ error: `Failed to read email: ${e.message}` });
    }
  }

  async searchEmail(query, account) {
    const gate = this._requireMail(); if (gate) return gate;
    if (!query) return JSON.stringify({ error: 'query is required' });
    const rows = this._mailEngine.db.searchMail({ query, account: account || null });
    return JSON.stringify({ results: rows.map(r => ({ id: r.id, account: r.account,
      from: r.from_addr, subject: r.subject, preview: r.preview, received_at: r.received_at })) });
  }

  async replyToEmail(messageId, draftBody) {
    const gate = this._requireMail(); if (gate) return gate;
    try {
      const res = await this._mailEngine.sendReply({ messageDbId: messageId, body: draftBody });
      this._audit('reply_to_email', { ok: true, to: res.to, subject: res.subject });
      return JSON.stringify({ status: 'success', message: `Reply sent to ${res.to} (${res.subject}) from ${res.from}.` });
    } catch (e) {
      this._audit('reply_to_email', { ok: false, error: e.message });
      return JSON.stringify({ error: `Failed to send reply: ${e.message}` });
    }
  }

  async manageVipSenders(action, entry) {
    const gate = this._requireMail(); if (gate) return gate;
    const path = this._mailEngine.vipPath;
    let vips = loadVips(path);
    if (action === 'add') {
      if (!entry) return JSON.stringify({ error: 'entry is required for add' });
      vips = saveVips([...vips, entry], path);
    } else if (action === 'remove') {
      if (!entry) return JSON.stringify({ error: 'entry is required for remove' });
      vips = saveVips(vips.filter(v => v !== String(entry).toLowerCase().trim()), path);
    }
    return JSON.stringify({ vips });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node _mail_tools_test.mjs`
Expected: `MAIL TOOLS TESTS PASS ✓`

- [ ] **Step 5: Commit**

```bash
git add src/core/tools.js _mail_tools_test.mjs
git commit -m "feat: register mailbox/read/search/reply/vip tools

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Generalize the approval gate to cover `reply_to_email`

**Files:**
- Modify: `src/core/conversation-manager.js`
- Test: `_mail_approval_test.mjs`

**Interfaces:**
- Consumes: existing pending-tool-call machinery (`setPendingToolCall`, `_classifyApproval`, `_tryResumePending`, `_handleToolLoop`), Task 1 `getMailMessage`.
- Produces: a module-level `APPROVAL_GATED_TOOLS` map. Every intercept/resume site consults it instead of hard-coding `install_npm_package`. Pending rows keep the same shape (`tool_name` now varies).

- [ ] **Step 1: Write the failing test**

```js
// _mail_approval_test.mjs
process.env.CIPHER_VAULT_KEY = '11'.repeat(32);
import { ConversationManager } from './src/core/conversation-manager.js';
import { NexusDatabase } from './src/core/database.js';
import fs from 'fs';

const DB = `/tmp/nexus_mail_approval_${process.pid}.db`;
for (const ws of ['test_u9']) {
  fs.mkdirSync(`data/workspaces/${ws}`, { recursive: true });
  fs.writeFileSync(`data/workspaces/${ws}/USER.md`, '# Test\n');
}
const db = new NexusDatabase(DB); db.initialize();

const engine = {
  model: 'gpt-4o-mini', provider: 'openai', _queue: [],
  enqueue(r) { this._queue.push(r); },
  chat: async () => engine._queue.shift() ?? { content: '(idle)', tool_calls: null },
  chatStream: async () => engine._queue.shift() ?? { content: '(idle)', tool_calls: null },
};
const cm = new ConversationManager(db, engine);

// stub the actual send + seed the email row the prompt formatter reads
const sends = [];
cm.toolExecutor.replyToEmail = async (id, body) => { sends.push({ id, body }); return JSON.stringify({ status: 'success' }); };
const mid = db.upsertMailMessage({ account: 'k@gmail.com', uid: 9, messageId: '<p@x>',
  fromAddr: 'prof@wright.edu', fromName: 'Prof X', subject: 'Project deadline', preview: '...',
  body: null, receivedAt: new Date().toISOString(), isEdu: 1, isVip: 0, isAutomated: 0 });

// model proposes a reply → must be intercepted, not sent
engine.enqueue({ content: '', tool_calls: [{ id: 'r1', type: 'function',
  function: { name: 'reply_to_email', arguments: JSON.stringify({ message_id: mid, draft_body: 'I will submit by Friday.' }) } }] });
const r1 = await cm.processMessage('reply that I will submit by Friday', 'test', 'u9', 'T');
if (sends.length !== 0) throw new Error('BUG: reply sent before approval');
if (!r1.content.includes('prof@wright.edu') || !r1.content.includes('I will submit by Friday.')) {
  throw new Error('approval prompt missing draft/recipient: ' + r1.content);
}

// ambiguous keeps pending
const r2 = await cm.processMessage('hmm let me think', 'test', 'u9', 'T');
if (sends.length !== 0) throw new Error('BUG: reply sent on ambiguous');
const sess = db.getOrCreateSession('test', 'u9', 'T');
if (!db.getPendingToolCall(sess.conversation_id)) throw new Error('pending cleared by ambiguous reply');

// yes → sends
engine.enqueue({ content: 'Sent it!', tool_calls: null });
const r3 = await cm.processMessage('yes', 'test', 'u9', 'T');
if (sends.length !== 1 || sends[0].body !== 'I will submit by Friday.') throw new Error('approved reply did not send');

// deny path on a second draft
engine.enqueue({ content: '', tool_calls: [{ id: 'r2', type: 'function',
  function: { name: 'reply_to_email', arguments: JSON.stringify({ message_id: mid, draft_body: 'Another draft' }) } }] });
await cm.processMessage('draft another reply', 'test', 'u9', 'T');
engine.enqueue({ content: 'OK, not sending.', tool_calls: null });
await cm.processMessage('no', 'test', 'u9', 'T');
if (sends.length !== 1) throw new Error('denied reply was sent');

// install gate still works (regression)
cm.toolExecutor.installNpmPackage = async (pkg) => JSON.stringify({ status: 'success', pkg });
engine.enqueue({ content: '', tool_calls: [{ id: 'i1', type: 'function',
  function: { name: 'install_npm_package', arguments: JSON.stringify({ package_name: 'left-pad' }) } }] });
const r4 = await cm.processMessage('install left-pad', 'test', 'u9', 'T');
if (!r4.content.includes('left-pad')) throw new Error('install gate regressed');

db.close(); fs.unlinkSync(DB);
fs.rmSync('data/workspaces/test_u9', { recursive: true, force: true });
console.log('MAIL APPROVAL TESTS PASS ✓');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node _mail_approval_test.mjs`
Expected: FAIL with `BUG: reply sent before approval` (reply_to_email is not yet gated)

- [ ] **Step 3: Implement in `src/core/conversation-manager.js`**

Add module-level map after the constants:

```js
// Tools that must never run without an explicit human yes. Each entry
// formats the approval prompt shown to the user. `db` and parsed `args`
// are provided; formatters must never throw on malformed args.
const APPROVAL_GATED_TOOLS = {
  install_npm_package: {
    prompt: (args) => {
      const pkg = args.package_name || 'an unknown package';
      return `I need to install the package \`${pkg}\` to complete this task. Do you approve? (Reply Yes/No)`;
    },
    denialResult: () => JSON.stringify({ error: 'User denied installation.' }),
    reprompt: (args) => `I still need approval to install \`${args.package_name || 'the package'}\`. Please reply with **Yes** to approve or **No** to deny.`,
  },
  reply_to_email: {
    prompt: (args, db) => {
      const row = args.message_id ? db.getMailMessage?.(args.message_id) : null;
      const to = row ? `${row.from_name ? row.from_name + ' ' : ''}<${row.from_addr}>` : 'the sender';
      const subject = row?.subject || '(unknown subject)';
      return `Here's my draft reply to ${to} regarding "${subject}":\n\n${args.draft_body || '(empty draft)'}\n\nSend it? (Reply Yes/No)`;
    },
    denialResult: () => JSON.stringify({ error: 'User declined to send the reply. Do not resend it; ask what to change instead.' }),
    reprompt: () => `I still need your approval to send that email reply. Please reply with **Yes** to send or **No** to cancel.`,
  },
};
```

Then rewire the three places that hard-code `install_npm_package`:

1. `_askForInstallApproval` → rename to `_askForApproval` and generalize:

```js
  _askForApproval({ call, remainingOtherCalls, contextMessages, conversationId, platform, onChunk }) {
    let argsObj = {};
    try { argsObj = JSON.parse(call.function.arguments || '{}'); } catch {}
    const gate = APPROVAL_GATED_TOOLS[call.function.name];

    const msg = gate.prompt(argsObj, this.db);
    this.db.addMessage(conversationId, 'assistant', msg, platform);
    if (onChunk) onChunk(msg);

    this.db.setPendingToolCall(conversationId, {
      tool_name: call.function.name,
      call_id: call.id,
      args: call.function.arguments,
      context: contextMessages,
      other_calls: remainingOtherCalls || [],
    });

    return { content: msg, usage: { totalTokens: 0 } };
  }
```

2. In `_tryResumePending`: the ambiguous branch becomes

```js
    if (decision === 'ambiguous') {
      let argsObj = {};
      try { argsObj = JSON.parse(pending.args || '{}'); } catch {}
      const gate = APPROVAL_GATED_TOOLS[pending.tool_name] || APPROVAL_GATED_TOOLS.install_npm_package;
      const msg = gate.reprompt(argsObj);
      this.db.addMessage(conversationId, 'assistant', msg, platform);
      if (onChunk) onChunk(msg);
      return { content: msg, conversationId, usage: { totalTokens: 0 } };
    }
```

the denial result becomes

```js
    const gate = APPROVAL_GATED_TOOLS[pending.tool_name] || APPROVAL_GATED_TOOLS.install_npm_package;
    const approvedResult = decision === 'yes'
      ? await this.toolExecutor.execute(
          { name: pending.tool_name, arguments: pending.args },
          { platform, platformUserId }
        )
      : gate.denialResult();
```

and the sibling re-intercept loop checks the map:

```js
    for (let i = 0; i < otherCalls.length; i++) {
      const call = otherCalls[i];
      if (APPROVAL_GATED_TOOLS[call.function?.name]) {
        return this._askForApproval({
          call,
          remainingOtherCalls: otherCalls.slice(i + 1),
          contextMessages, conversationId, platform, onChunk,
        });
      }
      const otherRes = await this.toolExecutor.execute(call.function, { platform, platformUserId });
      this._pushToolResult(contextMessages, call, otherRes);
    }
```

3. In `_handleToolLoop`, the intercept becomes:

```js
      const gatedIdx = response.tool_calls.findIndex(c => APPROVAL_GATED_TOOLS[c.function?.name]);

      if (gatedIdx !== -1) {
        const intercepted = response.tool_calls[gatedIdx];
        contextMessages.push({
          role: 'assistant',
          content: response.content || '',
          tool_calls: response.tool_calls,
        });
        return this._askForApproval({
          call: intercepted,
          remainingOtherCalls: response.tool_calls.filter((_, idx) => idx !== gatedIdx),
          contextMessages, conversationId, platform, onChunk,
        });
      }
```

(Delete the old `installIdx` block and `_askForInstallApproval`; keep comments about batching semantics.)

- [ ] **Step 4: Run both approval test suites**

Run: `node _mail_approval_test.mjs && node _audit_test.mjs`
Expected: `MAIL APPROVAL TESTS PASS ✓` and `ALL AUDIT TESTS PASSED ✓` (install gate must not regress)

- [ ] **Step 5: Commit**

```bash
git add src/core/conversation-manager.js _mail_approval_test.mjs
git commit -m "feat: generalize approval gate; reply_to_email requires human yes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Boot wiring + mail CLI + env docs

**Files:**
- Create: `src/mail-cli.js`
- Modify: `src/index.js` (construct/start MailEngine when `MAIL_ENABLED=true`, inject into `cm.toolExecutor._mailEngine`, stop on shutdown)
- Modify: `package.json` (script `"mail": "node src/mail-cli.js"`)
- Modify: `.env.example` (MAIL block)

**Interfaces:**
- Consumes: `MailEngine`, `PROVIDER_PRESETS` (Task 3).
- Produces: `npm run mail -- add-account|list-accounts|remove-account|test|sync-now`; a booted app where mail tools work end-to-end.

- [ ] **Step 1: Implement `src/mail-cli.js`**

```js
#!/usr/bin/env node
/**
 * Mail CLI — manage email accounts for Nexus.
 *   node src/mail-cli.js add-account      — interactive: provider, address, app password
 *   node src/mail-cli.js list-accounts
 *   node src/mail-cli.js remove-account <email>
 *   node src/mail-cli.js test <email>     — live IMAP + SMTP connection check
 *   node src/mail-cli.js sync-now         — one full sync cycle
 */
import 'dotenv/config';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { MailEngine, PROVIDER_PRESETS } from './core/mail-engine.js';
import { NexusDatabase } from './core/database.js';

const command = process.argv[2];

function requireVaultKey() {
  if (!process.env.CIPHER_VAULT_KEY) {
    console.log(chalk.red('  ✗ CIPHER_VAULT_KEY not set in .env — credentials must be encrypted.'));
    console.log(chalk.gray('    Generate one: node src/cipher-cli.js generate-key'));
    process.exit(1);
  }
}

function makeEngine() {
  const db = new NexusDatabase('./data/nexus.db');
  db.initialize();
  return { db, engine: new MailEngine({ database: db }) };
}

async function addAccount() {
  requireVaultKey();
  const { provider } = await inquirer.prompt([{
    type: 'list', name: 'provider', message: 'Email provider:',
    choices: [
      ...Object.entries(PROVIDER_PRESETS).map(([value, p]) => ({ name: p.label, value })),
      { name: 'Custom (enter IMAP/SMTP hosts manually)', value: 'custom' },
    ],
  }]);

  if (provider !== 'custom') {
    const p = PROVIDER_PRESETS[provider];
    console.log(chalk.gray(`\n  You need an APP PASSWORD (not your normal password).`));
    console.log(chalk.gray(`  Create one here: ${p.appPasswordUrl}\n`));
    if (provider === 'office365') {
      console.log(chalk.yellow('  Note: many colleges block IMAP passwords. If "test" fails later,'));
      console.log(chalk.yellow('  enable forwarding from your college webmail to your Gmail instead —'));
      console.log(chalk.yellow('  forwarded .edu mail is still ranked always-important.\n'));
    }
  }

  const answers = await inquirer.prompt([
    { type: 'input', name: 'email', message: 'Email address:', validate: v => v.includes('@') || 'Enter a valid address' },
    { type: 'password', name: 'password', message: 'App password:', mask: '•', validate: v => v ? true : 'Required' },
    ...(provider === 'custom' ? [
      { type: 'input', name: 'imapHost', message: 'IMAP host:' },
      { type: 'input', name: 'imapPort', message: 'IMAP port:', default: '993' },
      { type: 'input', name: 'smtpHost', message: 'SMTP host:' },
      { type: 'input', name: 'smtpPort', message: 'SMTP port:', default: '465' },
    ] : []),
  ]);

  const { engine, db } = makeEngine();
  const acct = engine.addAccount({
    email: answers.email, password: answers.password,
    provider: provider === 'custom' ? null : provider,
    imapHost: answers.imapHost, imapPort: answers.imapPort && parseInt(answers.imapPort),
    smtpHost: answers.smtpHost, smtpPort: answers.smtpPort && parseInt(answers.smtpPort),
  });
  console.log(chalk.green(`\n  ✓ Stored ${acct.email} (encrypted). Run: node src/mail-cli.js test ${acct.email}`));
  db.close();
}

async function testAccount(email) {
  requireVaultKey();
  if (!email) { console.log(chalk.red('  Usage: node src/mail-cli.js test <email>')); process.exit(1); }
  const { engine, db } = makeEngine();
  const acct = engine._accounts.find(a => a.email === String(email).toLowerCase().trim());
  if (!acct) { console.log(chalk.red(`  ✗ No account ${email}. Add it first.`)); db.close(); process.exit(1); }

  process.stdout.write('  IMAP… ');
  try {
    const client = engine._imapFactory(acct);
    await client.connect();
    await client.logout();
    console.log(chalk.green('OK'));
  } catch (e) {
    console.log(chalk.red(`FAILED — ${e.message}`));
    if (acct.imapHost.includes('office365')) {
      console.log(chalk.yellow('  Your college likely blocks IMAP. Use webmail forwarding to Gmail instead.'));
    } else {
      console.log(chalk.yellow('  Check that this is an APP password, not your normal login password.'));
    }
  }

  process.stdout.write('  SMTP… ');
  try {
    await engine._transportFactory(acct).verify();
    console.log(chalk.green('OK'));
  } catch (e) {
    console.log(chalk.red(`FAILED — ${e.message}`));
  }
  db.close();
}

async function main() {
  switch (command) {
    case 'add-account': await addAccount(); break;
    case 'list-accounts': {
      requireVaultKey();
      const { engine, db } = makeEngine();
      const list = engine.listAccounts();
      if (!list.length) console.log(chalk.gray('  No accounts configured.'));
      for (const a of list) console.log(`  • ${a.email}  (imap: ${a.imapHost}, smtp: ${a.smtpHost})`);
      db.close(); break;
    }
    case 'remove-account': {
      requireVaultKey();
      const { engine, db } = makeEngine();
      console.log(engine.removeAccount(process.argv[3]) ? chalk.green('  ✓ Removed') : chalk.red('  ✗ Not found'));
      db.close(); break;
    }
    case 'test': await testAccount(process.argv[3]); break;
    case 'sync-now': {
      requireVaultKey();
      const { engine, db } = makeEngine();
      const res = await engine.syncAll();
      console.log(chalk.green(`  ✓ Synced ${res.synced} new message(s)`));
      for (const e of res.errors) console.log(chalk.red(`  ✗ ${e.account}: ${e.error}`));
      db.close(); break;
    }
    default:
      console.log('  Commands: add-account | list-accounts | remove-account <email> | test <email> | sync-now');
  }
}
main().catch(e => { console.error(chalk.red(`  ✗ ${e.message}`)); process.exit(1); });
```

- [ ] **Step 2: Wire boot in `src/index.js`**

After the Cipher block (same dynamic-import pattern):

```js
  // ─── Start MailEngine — multi-account email ───────────
  if (process.env.MAIL_ENABLED === 'true') {
    import('./core/mail-engine.js').then(({ MailEngine }) => {
      const mailEngine = new MailEngine({ database: db });
      global.__mailEngine = mailEngine;
      cm.toolExecutor._mailEngine = mailEngine;
      mailEngine.start();
    }).catch(e => console.error('  ✗ MailEngine failed to load:', e.message));
  } else {
    console.log('  \x1b[90m○ Email: disabled (set MAIL_ENABLED=true in .env)\x1b[0m');
  }
```

In `shutdown()` next to the Cipher stop:

```js
    if (global.__mailEngine) {
      try { global.__mailEngine.stop(); } catch (e) { console.error('  Error stopping MailEngine:', e.message); }
    }
```

- [ ] **Step 3: package.json script + .env.example**

`package.json` scripts: add `"mail": "node src/mail-cli.js"`.

`.env.example`, after the Cipher block:

```env
# ═══ Email — multi-account read/reply/triage ═══
MAIL_ENABLED=false
MAIL_SYNC_INTERVAL=300               # Seconds between silent inbox syncs
# Accounts are added via: node src/mail-cli.js add-account
# (stored AES-256-GCM encrypted in the vault — requires CIPHER_VAULT_KEY)
# VIP senders live in config/mail-vips.json, or tell the AI "add X as VIP".
```

- [ ] **Step 4: Verify boot + full test suite**

Run: `for t in _mail_db_test.mjs _mail_triage_test.mjs _mail_engine_test.mjs _mail_tools_test.mjs _mail_approval_test.mjs _audit_test.mjs; do node $t || exit 1; done`
Expected: five `PASS ✓` lines + `ALL AUDIT TESTS PASSED ✓`

Boot check (temp .env with `MAIL_ENABLED=true`, fake `CIPHER_VAULT_KEY`, no accounts): expect `✓ MailEngine started (0 account(s), …)` and clean startup; then remove temp .env.

- [ ] **Step 5: Commit**

```bash
git add src/mail-cli.js src/index.js package.json .env.example
git commit -m "feat: wire MailEngine into boot; add mail CLI and env docs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: README section + push

**Files:**
- Modify: `README.md` (feature section + setup steps)

- [ ] **Step 1: Add README section**

After the "Cipher — Academic Automation Agent" feature block, add:

```markdown
### Email — Read, Triage, Reply (Multi-Account)
Connect all your inboxes — college **.edu**, **Gmail**, **AOL**, **Yahoo** — over IMAP with app passwords, encrypted at rest in the same AES-256-GCM vault as your portal credentials. Nexus silently syncs new mail into its local database and stays quiet until *you* ask:

> *"Anything important in my email?"*

It answers in two groups — **Important** (VIP senders, anything `.edu`, humans with deadlines/grades/money) and **Less important** (promos, newsletters, automated mail). Replies are drafted by the AI but **never sent without your explicit Yes**.

```bash
node src/mail-cli.js add-account     # interactive, per-provider app-password help
node src/mail-cli.js test you@gmail.com
# then set MAIL_ENABLED=true in .env
```
```

- [ ] **Step 2: Final verification**

Run: the full suite command from Task 6 Step 4 once more, plus `node --check` on every modified file.
Expected: all pass.

- [ ] **Step 3: Commit and push**

```bash
git add README.md
git commit -m "docs: document email integration

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push origin main
```

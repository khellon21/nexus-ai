// MailEngine tests (fake IMAP + SMTP, no network) — run with: node _mail_engine_test.mjs
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
  fetch(range) {
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

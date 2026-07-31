// Mail tools tests — run with: node _mail_tools_test.mjs
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

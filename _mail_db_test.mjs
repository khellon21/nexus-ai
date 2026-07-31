// Mail DB layer tests — run with: node _mail_db_test.mjs
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

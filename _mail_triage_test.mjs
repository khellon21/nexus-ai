// Mail triage tests — run with: node _mail_triage_test.mjs
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

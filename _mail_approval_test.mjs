// Approval-gate tests for reply_to_email — run with: node _mail_approval_test.mjs
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

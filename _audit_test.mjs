// Behavioral audit: drive ConversationManager against a stub engine so we
// can assert the hardened install-approval flow without hitting a real LLM.
import { ConversationManager } from './src/core/conversation-manager.js';
import { NexusDatabase } from './src/core/database.js';
import fs from 'fs';

const DB_PATH = `/tmp/nexus_audit_${process.pid}.db`;
try { fs.unlinkSync(DB_PATH); } catch {}

const db = new NexusDatabase(DB_PATH);
db.initialize();

// Stub engine that returns whatever the test sets on `nextResponse`.
// `chat()` / `chatStream()` pop one queued response per call.
const engine = {
  model: 'gpt-4o-mini',
  provider: 'openai',
  _queue: [],
  enqueue(resp) { this._queue.push(resp); },
  chat: async () => engine._queue.shift() ?? { content: '(engine idle)', tool_calls: null },
  chatStream: async () => engine._queue.shift() ?? { content: '(engine idle)', tool_calls: null },
};

const cm = new ConversationManager(db, engine);

// Intercept npm install execution so the test doesn't mutate the real
// node_modules. We still want to prove the call was made (or not made).
const installCalls = [];
cm.toolExecutor.installNpmPackage = async (pkg) => {
  installCalls.push(pkg);
  return JSON.stringify({ status: 'success', stub: true, pkg });
};
// Shadow other tools to pure stubs so we can see a non-install sibling run.
cm.toolExecutor.getTime = async () => JSON.stringify({ time: 'stubbed' });

// ─── Test 1: two installs batched together ────────────────────
console.log('\n=== TEST 1: two install_npm_package calls in one batch ===');
engine.enqueue({
  content: 'I need two packages.',
  tool_calls: [
    { id: 'a', type: 'function', function: { name: 'install_npm_package', arguments: JSON.stringify({ package_name: 'left-pad' }) } },
    { id: 'b', type: 'function', function: { name: 'get_current_time_and_date', arguments: '{}' } },
    { id: 'c', type: 'function', function: { name: 'install_npm_package', arguments: JSON.stringify({ package_name: 'chalk' }) } },
  ],
});

// Kickoff.
let r1 = await cm.processMessage('install both please', 'test', 'u1', 'Tester');
console.log('first response:', r1.content);
console.log('installs executed so far:', installCalls);
if (installCalls.length !== 0) throw new Error('BUG: install ran before approval');

// Approve first.
engine.enqueue({ content: '(never called — resumes into approval #2)', tool_calls: null });
let r2 = await cm.processMessage('yes', 'test', 'u1', 'Tester');
console.log('after first yes:', r2.content);
console.log('installs executed:', installCalls);
if (installCalls.length !== 1 || installCalls[0] !== 'left-pad') throw new Error(`BUG: expected only left-pad, got ${JSON.stringify(installCalls)}`);
if (!r2.content.includes('chalk')) throw new Error('BUG: second install should have re-prompted for approval');

// Deny second.
engine.enqueue({ content: 'OK I routed around it.', tool_calls: null });
let r3 = await cm.processMessage('no', 'test', 'u1', 'Tester');
console.log('after no:', r3.content);
console.log('final installs executed:', installCalls);
if (installCalls.length !== 1) throw new Error('BUG: denied install still ran');

console.log('TEST 1 PASS ✓');

// ─── Test 2: ambiguous reply keeps pending state ──────────────
console.log('\n=== TEST 2: ambiguous reply must re-prompt, not silently deny ===');
installCalls.length = 0;

engine.enqueue({
  content: 'Installing one thing.',
  tool_calls: [
    { id: 'x', type: 'function', function: { name: 'install_npm_package', arguments: JSON.stringify({ package_name: 'lodash' }) } },
  ],
});

let q1 = await cm.processMessage('add lodash', 'test', 'u2', 'Tester2');
console.log('q1:', q1.content);

let q2 = await cm.processMessage('hmm, not sure yet', 'test', 'u2', 'Tester2');
console.log('q2 (ambiguous):', q2.content);
if (!q2.content.toLowerCase().includes('still need approval')) throw new Error('BUG: ambiguous reply should re-prompt');
if (installCalls.length !== 0) throw new Error('BUG: install ran on ambiguous reply');

// Verify pending is still queued.
const sess = db.getOrCreateSession('test', 'u2', 'Tester2');
const stillPending = db.getPendingToolCall(sess.conversation_id);
if (!stillPending) throw new Error('BUG: pending tool call was cleared by ambiguous reply');
console.log('pending preserved ✓');

engine.enqueue({ content: 'Done.', tool_calls: null });
let q3 = await cm.processMessage('yes', 'test', 'u2', 'Tester2');
console.log('q3 (after yes):', q3.content);
if (installCalls.length !== 1 || installCalls[0] !== 'lodash') throw new Error('BUG: install did not run on explicit yes');
console.log('TEST 2 PASS ✓');

// ─── Test 3: edit_source_file atomicity ────────────────────────
console.log('\n=== TEST 3: edit_source_file is atomic and writes via tmp+rename ===');
const target = `/tmp/nexus_edit_${process.pid}.txt`;
fs.writeFileSync(target, 'original-content');
const resStr = await cm.toolExecutor.editSourceFile(target, 'new-content');
const parsed = JSON.parse(resStr);
if (parsed.status !== 'success') throw new Error('edit failed: ' + resStr);
if (fs.readFileSync(target, 'utf-8') !== 'new-content') throw new Error('content mismatch');
// Confirm no leftover tmp files in /tmp that match the pattern.
const leftovers = fs.readdirSync('/tmp').filter(n => n.startsWith(`.nexus_edit_${process.pid}`) && n.endsWith('.tmp'));
if (leftovers.length !== 0) throw new Error('leftover tmp files: ' + leftovers.join(','));
console.log('TEST 3 PASS ✓');

// ─── Test 4: read_source_file caps oversized files ────────────
console.log('\n=== TEST 4: read_source_file truncates oversized files ===');
const big = `/tmp/nexus_big_${process.pid}.txt`;
fs.writeFileSync(big, 'x'.repeat(600 * 1024)); // 600KB > 512KB cap
const readStr = await cm.toolExecutor.readSourceFile(big);
const readParsed = JSON.parse(readStr);
if (!readParsed.truncated) throw new Error('BUG: oversized file not truncated');
if (readParsed.content.length !== 512 * 1024) throw new Error(`BUG: unexpected truncate size ${readParsed.content.length}`);
console.log('TEST 4 PASS ✓');

// Cleanup
db.close();
try { fs.unlinkSync(DB_PATH); } catch {}
try { fs.unlinkSync(target); } catch {}
try { fs.unlinkSync(big); } catch {}

console.log('\nALL AUDIT TESTS PASSED ✓');

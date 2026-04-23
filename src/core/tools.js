/**
 * Core Tools Registry
 * Defines tool schemas and execution logic.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import util from 'util';
import simpleGit from 'simple-git';
import { search, SafeSearchType } from 'duck-duck-scrape';

const execAsync = util.promisify(exec);

// ─── Hardening constants (audit pass) ─────────────────────────
// Subprocess deadlines — a stuck auth prompt or hanging remote must not
// freeze the whole tool loop. 120s is generous for a typical `npm install`
// and more than enough for `git push` on a healthy network.
const NPM_TIMEOUT_MS = Number(process.env.NEXUS_NPM_TIMEOUT_MS || 120_000);
const GIT_TIMEOUT_MS = Number(process.env.NEXUS_GIT_TIMEOUT_MS || 60_000);

// Cap how much file content the model can pull back into its context window.
// Models that try to read a 50MB log shouldn't blow the session.
const READ_FILE_MAX_BYTES = Number(process.env.NEXUS_READ_MAX_BYTES || 512 * 1024);

// Soft cap on search snippet length to keep tool outputs compact.
const SEARCH_SNIPPET_MAX_CHARS = 400;
const SEARCH_TIMEOUT_MS = 15_000;

/**
 * exec() wrapper that enforces a hard timeout via AbortController. When the
 * timer fires, the child process receives SIGTERM and we surface a concise
 * timeout error instead of hanging the loop. Stdout/stderr are still captured.
 */
async function execWithTimeout(command, { cwd = process.cwd(), timeoutMs = 60_000, env } = {}) {
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Node ≥ 15: passing `signal` into exec honours AbortController.
    const result = await execAsync(command, {
      cwd,
      signal: controller.signal,
      env: { ...process.env, ...(env || {}) },
      // Large enough to capture reasonable output without OOM-ing.
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '' };
  } catch (err) {
    const aborted = controller.signal.aborted || err.name === 'AbortError' || err.code === 'ABORT_ERR';
    return {
      ok: false,
      aborted,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      message: aborted
        ? `Command exceeded ${timeoutMs}ms and was aborted`
        : (err.message || String(err)),
    };
  } finally {
    clearTimeout(killer);
  }
}

// ─── Epic 2: Pure-JS embedding + Cosine similarity ─────────────
// Rationale: cloud vector DBs are overkill for a personal assistant on
// low-end hardware, and importing a neural embedding runtime (e.g. onnx)
// adds ~200MB and cold-start latency. A character-n-gram feature-hashing
// vectorizer gives us deterministic, dependency-free embeddings that are
// "good enough" for short factual recall — e.g. matching "user's dog is
// named Mochi" against a later query like "what's my dog called?".
//
// If you later want real semantic embeddings, replace `embed()` with a
// fetch call to a Python service (e.g. a /embed endpoint powered by
// sentence-transformers) — nothing else needs to change.

const EMBEDDING_DIM = 384;

/**
 * Normalize text for deterministic feature extraction.
 */
function _normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stable 32-bit FNV-1a hash — fast, no deps, good dispersion.
 */
function _fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Generate a fixed-dimension embedding using hashed character trigrams
 * + hashed word tokens. Vector is L2-normalized so that dot product ==
 * cosine similarity for fast retrieval.
 *
 * @param {string} text
 * @returns {number[]} length EMBEDDING_DIM
 */
export function embed(text) {
  const vec = new Float32Array(EMBEDDING_DIM);
  const norm = _normalize(text);
  if (!norm) return Array.from(vec);

  // Character trigrams (robust to typos / inflection).
  const padded = ` ${norm} `;
  for (let i = 0; i < padded.length - 2; i++) {
    const gram = padded.slice(i, i + 3);
    vec[_fnv1a(gram) % EMBEDDING_DIM] += 1;
  }

  // Word-level tokens (boosts exact semantic matches).
  for (const word of norm.split(' ')) {
    if (!word) continue;
    vec[_fnv1a('w:' + word) % EMBEDDING_DIM] += 2;
  }

  // L2-normalize
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const mag = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= mag;

  return Array.from(vec);
}

/**
 * Cosine similarity between two equal-length number arrays.
 * Returns a value in [-1, 1]. Safe on zero-magnitude inputs (returns 0).
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export const getToolsSchema = (provider) => {
  const schemas = [
    {
      type: 'function',
      function: {
        name: 'manage_workspace_file',
        description: 'Read, write, or append to files in your private user workspace. Use this to update USER.md, SOUL.md, tracking projects, or preferences. ONLY .md files are supported.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['read', 'write', 'append'], description: 'The action to perform on the file.' },
            filename: { type: 'string', description: 'The filename, e.g. "USER.md" or "PROJECT.md".' },
            content: { type: 'string', description: 'The text to write or append (not needed for read).' }
          },
          required: ['action', 'filename']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'save_core_memory',
        // Epic 2: autonomous long-term memory. The AI decides when a fact
        // is durable enough to be worth remembering across sessions.
        description: "Save a durable fact about the user or their world to long-term memory. Use this whenever the user shares a stable personal preference, relationship, goal, or identifying detail (e.g. \"I'm vegetarian\", \"my dog's name is Mochi\", \"I ship to 123 Main St\"). Do NOT use for short-lived conversational context — only for facts worth recalling in future unrelated conversations.",
        parameters: {
          type: 'object',
          properties: {
            fact: { type: 'string', description: 'A single concise sentence stating the fact to remember.' },
            category: { type: 'string', description: 'A short bucket name such as "preference", "relationship", "goal", "identity", "routine".' }
          },
          required: ['fact', 'category']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_current_time_and_date',
        description: 'Get the exact current local time and date. Use this whenever the user asks about time, date, or schedules.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'send_urgent_notification',
        description: 'Push an immediate alert/notification to Khellon’s devices. Use only for important or exciting updates.',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The urgent message to send.' }
          },
          required: ['message']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'take_screenshot',
        description: 'Capture a screenshot of the host machine (the computer this agent is running on) and send it to the user as a photo. OWNER-ONLY — only the trusted owner (identified by OWNER_TELEGRAM_USER_ID) may invoke this. If any other user requests it, the tool will refuse. Use this whenever the owner asks to see what\'s on their screen.',
        parameters: {
          type: 'object',
          properties: {
            display_index: {
              type: 'integer',
              description: 'Optional display number (1 = primary, 2 = secondary…). Defaults to the primary display. Ignored on Linux Wayland.',
              minimum: 1
            },
            caption: {
              type: 'string',
              description: 'Optional short caption to accompany the screenshot in the chat.'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_navigate',
        description: 'Open a local Chrome browser and navigate to a URL. Use this to open any website, log into portals, or do web searches (like duckduckgo.com). Returns the new tab ID.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The absolute URL to navigate to (e.g., https://news.ycombinator.com)' }
          },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_snapshot',
        description: 'Returns the interactive accessibility tree of the current webpage. Use this to "see" what buttons, inputs, or links are on the screen. It gives you "ref" IDs needed to click or type into elements.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_action',
        description: 'Perform an action (click or fill) on a webpage element using its "ref" ID obtained from browser_snapshot. Example: { action: "click", ref: "e1" } or { action: "fill", ref: "e2", text: "my username" }',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['click', 'fill', 'press'], description: 'The type of action to perform.' },
            ref: { type: 'string', description: 'The reference ID of the element (e.g., e5).' },
            text: { type: 'string', description: 'The text to type or the key to press (only required for "fill" or "press").' }
          },
          required: ['action', 'ref']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_extract_text',
        description: 'Extracts the visible, readable content text from the current webpage. Use this to quickly read the contents of an article or announcement without worrying about HTML boilerplate.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'cipher_scan_portal',
        description: 'Trigger Cipher to immediately scan the university portal for new assignments and deadlines. Returns a summary of found assignments.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'cipher_list_assignments',
        description: 'Get a list of ALL tracked college assignments (both upcoming and past). The response includes an "allAssignments" array with every assignment\'s title, course, due date, completion status, score, and grade. Search through ALL items in allAssignments to find a specific assignment by name. MUST use this tool whenever the user asks about grades, scores, assignments, homework, quizzes, or exams.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'cipher_schedule_submission',
        description: 'Schedule a file to be automatically submitted to a portal assignment dropbox at a specific time.',
        parameters: {
          type: 'object',
          properties: {
            assignmentId: { type: 'string', description: 'The ID of the assignment to submit to (from cipher_list_assignments)' },
            filePath: { type: 'string', description: 'The absolute path to the file to submit' },
            scheduledAt: { type: 'string', description: 'ISO 8601 timestamp for when to submit (e.g. 2026-04-14T10:00:00). Use "now" for immediate submission.' }
          },
          required: ['assignmentId', 'filePath']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'cipher_calendar_info',
        description: 'Get the calendar sync URL and setup instructions. Returns the ICS feed URL that users can subscribe to in Apple Calendar, Google Calendar, or Outlook to see all their assignment deadlines.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_internet',
        description: 'Search the internet for information, documentation, or tutorials if you get stuck.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query to look up on DuckDuckGo.' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'create_directory',
        description: 'Create a new directory (and any necessary parent directories) in the project workspace.',
        parameters: {
          type: 'object',
          properties: {
            dirPath: { type: 'string', description: 'The absolute or relative path of the directory to create.' }
          },
          required: ['dirPath']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_source_file',
        description: 'Read the contents of any file in the project workspace.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'The absolute or relative path of the file to read.' }
          },
          required: ['filePath']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'edit_source_file',
        description: 'Edit or create a file in the project workspace by providing its COMPLETE, fully updated content to replace the file.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'The absolute or relative path of the file to overwrite or create.' },
            content: { type: 'string', description: 'The complete new content of the file. Do NOT just pass a substring, pass the entire file content.' }
          },
          required: ['filePath', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'git_commit_and_push',
        description: 'Commit and push local modifications to the GitHub remote repository.',
        parameters: {
          type: 'object',
          properties: {
            commit_message: { type: 'string', description: 'The commit message describing your changes.' }
          },
          required: ['commit_message']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'install_npm_package',
        description: 'Install a required NPM package. This action requires human permission, so the loop will pause and ask the user to approve.',
        parameters: {
          type: 'object',
          properties: {
            package_name: { type: 'string', description: 'The exact name of the NPM package to install.' }
          },
          required: ['package_name']
        }
      }
    }
  ];

  // Format translation for Gemini
  if (provider === 'gemini') {
    return schemas.map(s => ({
      name: s.function.name,
      description: s.function.description,
      parameters: s.function.parameters
    }));
  }

  return schemas;
};

export class ToolExecutor {
  constructor(conversationManager = null) {
    this.conversationManager = conversationManager;
    // Browser instance state
    this.profileId = null;
    this.instanceId = null;
    this.tabId = null;
    // Injected by index.js after Telegram adapter starts
    this.telegramBot = null;
    this.telegramChatId = process.env.CIPHER_TELEGRAM_CHAT_ID || null;
  }

  async execute(call, context = {}) {
    const { name, arguments: args } = call;
    let params = {};
    try {
      if (typeof args === 'string') {
          params = args ? JSON.parse(args) : {};
      } else {
          params = args || {};
      }
    } catch {
      params = {};
    }

    try {
      switch (name) {
        case 'manage_workspace_file':
          return await this.manageWorkspaceFile(params.action, params.filename, params.content, context);
        case 'save_core_memory':
          return await this.saveCoreMemory(params.fact, params.category, context);
        case 'get_current_time_and_date':
          return await this.getTime();
        case 'send_urgent_notification':
          return await this.sendNotification(params.message);
        case 'take_screenshot':
          return await this.takeScreenshot(params.display_index, params.caption, context);
        case 'browser_navigate':
          return await this.browserNavigate(params.url);
        case 'browser_snapshot':
          return await this.browserSnapshot();
        case 'browser_action':
          return await this.browserAction(params.action, params.ref, params.text);
        case 'browser_extract_text':
          return await this.browserExtractText();
        case 'cipher_scan_portal':
          return await this.cipherScanPortal();
        case 'cipher_list_assignments':
          return await this.cipherListAssignments();
        case 'cipher_schedule_submission':
          return await this.cipherScheduleSubmission(params.assignmentId, params.filePath, params.scheduledAt);
        case 'cipher_calendar_info':
          return await this.cipherCalendarInfo();
        case 'search_internet':
          return await this.searchInternet(params.query);
        case 'create_directory':
          return await this.createDirectory(params.dirPath);
        case 'read_source_file':
          return await this.readSourceFile(params.filePath);
        case 'edit_source_file':
          return await this.editSourceFile(params.filePath, params.content);
        case 'git_commit_and_push':
          return await this.gitCommitAndPush(params.commit_message);
        case 'install_npm_package':
          return await this.installNpmPackage(params.package_name);
        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  }

  // ─── Tool Implementations ─────────────────────────────

  async manageWorkspaceFile(action, filename, content, context) {
    if (!context.platform || !context.platformUserId) {
      return JSON.stringify({ error: 'Missing user context. Cannot determine workspace.' });
    }
    
    // Sanitize parameters
    const safePlatform = path.basename(String(context.platform));
    const safeUserId = path.basename(String(context.platformUserId));
    const safeFilename = path.basename(String(filename));
    
    if (!safeFilename.endsWith('.md')) {
      return JSON.stringify({ error: 'Can only manage .md files in the workspace.' });
    }

    const workspaceDir = path.join(process.cwd(), 'data', 'workspaces', `${safePlatform}_${safeUserId}`);
    const filePath = path.join(workspaceDir, safeFilename);

    try {
      // Ensure the directory exists before modifying anything
      await fs.mkdir(workspaceDir, { recursive: true });

      switch (action) {
        case 'read':
          try {
            const data = await fs.readFile(filePath, 'utf-8');
            return JSON.stringify({ status: 'success', content: data });
          } catch (e) {
            return JSON.stringify({ error: `File not found or unreadable: ${safeFilename}` });
          }
        case 'write':
          if (content === undefined) return JSON.stringify({ error: 'Missing content to write.' });
          await fs.writeFile(filePath, content, 'utf-8');
          return JSON.stringify({ status: 'success', message: `Wrote to ${safeFilename}` });
        case 'append':
          if (content === undefined) return JSON.stringify({ error: 'Missing content to append.' });
          await fs.appendFile(filePath, `\n${content}`, 'utf-8');
          return JSON.stringify({ status: 'success', message: `Appended to ${safeFilename}` });
        default:
          return JSON.stringify({ error: `Invalid action: ${action}` });
      }
    } catch (e) {
      return JSON.stringify({ error: `Filesystem error: ${e.message}` });
    }
  }

  async getTime() {
    const now = new Date();
    return JSON.stringify({
      currentTime: now.toLocaleTimeString(),
      currentDate: now.toDateString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    });
  }

  /**
   * Epic 2: Persist a fact into the long-term semantic memory store.
   * The vector is computed here from the fact content and saved alongside it;
   * cosine search happens later inside ConversationManager._injectMemories().
   */
  async saveCoreMemory(fact, category, context = {}) {
    if (!fact || !String(fact).trim()) {
      return JSON.stringify({ error: 'fact is required and must be non-empty' });
    }
    const db = this.conversationManager?.db;
    if (!db) {
      return JSON.stringify({ error: 'Database not available in ToolExecutor context.' });
    }

    try {
      const vector = embed(fact);
      const id = db.addMemory({
        content: String(fact).trim(),
        category: category || 'general',
        vector,
        platform: context.platform || null,
        platformUserId: context.platformUserId || null
      });

      console.log(`\x1b[34m  [Memory] Saved (${category || 'general'}): ${fact.slice(0, 80)}\x1b[0m`);
      return JSON.stringify({ status: 'success', id, message: 'Remembered.' });
    } catch (e) {
      return JSON.stringify({ error: `Failed to save memory: ${e.message}` });
    }
  }

  async browserNavigate(url) {
    console.log(`\x1b[36m  [Browser] Navigating to: ${url}\x1b[0m`);
    
    // 1. Create agent profile if necessary
    if (!this.profileId) {
      try {
        const pReq = await fetch('http://localhost:9867/profiles', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'nexus-agent'})});
        const pRes = await pReq.json();
        this.profileId = pRes.id;
      } catch (e) {
        return JSON.stringify({ error: `Failed to connect to PinchTab daemon. Is it running? (${e.message})`});
      }
    }
    
    // 2. Start headless instance if necessary
    if (!this.instanceId) {
      const iReq = await fetch('http://localhost:9867/instances/start', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({profileId: this.profileId, mode: 'headless'})});
      const iRes = await iReq.json();
      this.instanceId = iRes.id;
    }
    
    // 3. Open a tab
    const tReq = await fetch(`http://localhost:9867/instances/${this.instanceId}/tabs/open`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({url})});
    const tRes = await tReq.json();
    this.tabId = tRes.tabId;
    
    // Optional delay to let page stabilize before we reply
    await new Promise(r => setTimeout(r, 2000));

    return JSON.stringify({ status: "success", message: `Navigated to ${url}. Tab ID: ${this.tabId}` });
  }

  async browserSnapshot() {
    if (!this.tabId) return JSON.stringify({ error: 'No active browser tab. Use browser_navigate first.' });
    console.log(`\x1b[36m  [Browser] Taking interactive snapshot...\x1b[0m`);
    const res = await fetch(`http://localhost:9867/tabs/${this.tabId}/snapshot?filter=interactive`);
    if (!res.ok) return JSON.stringify({ error: await res.text() });
    const data = await res.json();
    return JSON.stringify(data);
  }

  async browserAction(action, ref, text) {
    if (!this.tabId) return JSON.stringify({ error: 'No active browser tab.' });
    console.log(`\x1b[36m  [Browser] Action: ${action} on ${ref}\x1b[0m`);
    const body = { kind: action, ref };
    if (text !== undefined) body.value = text;
    
    const res = await fetch(`http://localhost:9867/tabs/${this.tabId}/action`, {
        method: 'POST', 
        headers: {'Content-Type': 'application/json'}, 
        body: JSON.stringify(body)
    });
    if (!res.ok) return JSON.stringify({ error: await res.text() });
    
    // Let page react
    await new Promise(r => setTimeout(r, 1000));
    return JSON.stringify({ status: "success", message: `Performed ${action} on ${ref}` });
  }

  async browserExtractText() {
    if (!this.tabId) return JSON.stringify({ error: 'No active browser tab.' });
    console.log(`\x1b[36m  [Browser] Extracting text...\x1b[0m`);
    const res = await fetch(`http://localhost:9867/tabs/${this.tabId}/text`);
    if (!res.ok) return JSON.stringify({ error: await res.text() });
    const text = await res.text();
    return JSON.stringify({ text });
  }

  async sendNotification(message) {
    console.log(`\x1b[31m  [Tool] URGENT NOTIFICATION TO KHELLON: ${message}\x1b[0m`);

    const delivered = [];
    const errors = [];

    // ── 1. Telegram ──────────────────────────────────────────────
    const bot = this.telegramBot;
    const chatId = this.telegramChatId || process.env.CIPHER_TELEGRAM_CHAT_ID;
    if (bot && chatId) {
      try {
        const text = `🔔 *NEXUS ALERT*\n\n${message}`;
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        delivered.push('telegram');
        console.log(`\x1b[32m  [Tool] Notification delivered → Telegram (${chatId})\x1b[0m`);
      } catch (e) {
        errors.push(`telegram: ${e.message}`);
        console.error(`\x1b[31m  [Tool] Telegram notification failed: ${e.message}\x1b[0m`);
      }
    } else {
      errors.push('telegram: bot not initialised or CIPHER_TELEGRAM_CHAT_ID not set');
    }

    // ── 2. macOS Notification Center ─────────────────────────────
    if (process.platform === 'darwin' && process.env.CIPHER_MACOS_NOTIFICATIONS !== 'false') {
      try {
        const safeMsg = message.replace(/"/g, '\\"').replace(/'/g, "\\'").substring(0, 200);
        const script = `display notification "${safeMsg}" with title "Nexus AI" subtitle "Urgent Alert"`;
        await execAsync(`osascript -e '${script}'`);
        delivered.push('macos');
      } catch (e) {
        errors.push(`macos: ${e.message}`);
      }
    }

    return JSON.stringify({
      status: delivered.length > 0 ? 'success' : 'partial_failure',
      delivered_to: delivered.length > 0 ? delivered : 'none',
      errors: errors.length > 0 ? errors : undefined,
      timestamp: new Date().toISOString()
    });
  }

  // ─── Cipher Tool Implementations ──────────────────────

  async cipherScanPortal() {
    console.log(`\x1b[35m  [Cipher Tool] Triggering portal scan...\x1b[0m`);
    if (!this._cipherScheduler) {
      return JSON.stringify({ error: 'Cipher scheduler not initialized. Check CIPHER_ENABLED in .env.' });
    }

    try {
      await this._cipherScheduler.manualScan();
      const status = this._cipherScheduler.getAssignmentStatus();
      return JSON.stringify({
        status: 'success',
        message: `Scan complete. Found ${status.total} assignments.`,
        ...status
      });
    } catch (e) {
      return JSON.stringify({ error: `Scan failed: ${e.message}` });
    }
  }

  async cipherListAssignments() {
    console.log(`\x1b[35m  [Cipher Tool] Listing assignments...\x1b[0m`);
    if (!this._cipherScheduler) {
      return JSON.stringify({ error: 'Cipher scheduler not initialized.' });
    }

    const status = this._cipherScheduler.getAssignmentStatus();
    return JSON.stringify(status);
  }

  async cipherScheduleSubmission(assignmentId, filePath, scheduledAt) {
    console.log(`\x1b[35m  [Cipher Tool] Scheduling submission...\x1b[0m`);
    if (!this._cipherScheduler) {
      return JSON.stringify({ error: 'Cipher scheduler not initialized.' });
    }

    try {
      const when = scheduledAt === 'now' ? new Date().toISOString() : (scheduledAt || new Date().toISOString());
      const submissionId = this._cipherScheduler.scheduleSubmission(assignmentId, filePath, when);
      return JSON.stringify({
        status: 'success',
        message: `Submission queued for ${when}`,
        submissionId
      });
    } catch (e) {
      return JSON.stringify({ error: `Failed to schedule: ${e.message}` });
    }
  }

  async cipherCalendarInfo() {
    console.log(`\x1b[35m  [Cipher Tool] Calendar info requested...\x1b[0m`);
    const port = process.env.PORT || 3000;
    const icsUrl = `http://localhost:${port}/api/calendar/assignments.ics`;
    
    return JSON.stringify({
      icsUrl,
      instructions: {
        apple: `Open Calendar app → File → New Calendar Subscription → Enter URL: ${icsUrl}`,
        google: `Open Google Calendar → Settings (gear icon) → Add calendar → From URL → Paste: ${icsUrl}`,
        outlook: `Open Outlook → Add calendar → Subscribe from web → Paste: ${icsUrl}`
      },
      note: 'The ICS feed auto-updates with your latest assignments. Subscribe once and it stays synced.'
    });
  }

  // ─── Agent Autonomy Tools ──────────────────────────────

  // ─── Agent Autonomy Tools (audit-hardened) ────────────────────
  // Shared helper: write an audit-log entry when the DB is reachable. Never
  // throws — audit failures should not surface to the model as tool errors.
  _audit(eventType, details) {
    try {
      this.conversationManager?.db?.logAuditEvent?.(eventType, JSON.stringify(details));
    } catch { /* swallow — audit is best-effort */ }
  }

  async searchInternet(query) {
    if (!query || !String(query).trim()) {
      return JSON.stringify({ error: 'Empty search query' });
    }
    console.log(`\x1b[36m  [Tool] Searching internet: ${query}\x1b[0m`);

    // ── Primary: duck-duck-scrape JSON endpoint ──
    const runDDS = () => {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Search timed out')), SEARCH_TIMEOUT_MS));
      return Promise.race([
        // NOTE: SafeSearchType is an enum — passing the raw string 'off' makes
        // duck-duck-scrape's sanityCheck throw before any request goes out.
        search(query, { safeSearch: SafeSearchType.OFF }),
        timeout,
      ]);
    };

    let primaryErr = null;
    try {
      const results = await runDDS();
      const topResults = (results.noResults ? [] : results.results.slice(0, 5)).map(r => ({
        title: r.title,
        url: r.url,
        description: (r.description || '').slice(0, SEARCH_SNIPPET_MAX_CHARS),
      }));
      if (topResults.length) {
        return JSON.stringify({ results: topResults, message: 'Success' });
      }
      // Fall through to HTML fallback if we got nothing back.
      primaryErr = new Error('No results');
    } catch (e) {
      primaryErr = e;
    }

    // ── Fallback: plain HTML scraping (no VQD token required) ──
    try {
      const htmlResults = await this._searchInternetHtmlFallback(query);
      if (htmlResults.length) {
        return JSON.stringify({
          results: htmlResults,
          message: 'Success (via HTML fallback)',
        });
      }
      return JSON.stringify({
        results: [],
        message: 'No results found',
      });
    } catch (e) {
      return JSON.stringify({
        error: `Search failed: ${primaryErr?.message || 'unknown'} / fallback: ${e.message}`,
        hint: 'DuckDuckGo scraping is best-effort; both the JSON VQD endpoint and the HTML endpoint failed. Try again shortly or rephrase the query.',
      });
    }
  }

  /**
   * Minimal HTML-endpoint scraper used as a fallback when the primary
   * duck-duck-scrape JSON path fails (VQD token errors, rate limiting, etc.).
   * No external dependency — just fetch + regex on the results page.
   */
  async _searchInternetHtmlFallback(query) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SEARCH_TIMEOUT_MS);
    try {
      const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();

      // Parse result blocks. DDG's HTML layout: each result has
      //   <a class="result__a" href="...">Title</a>
      //   ...<a class="result__snippet" ...>Snippet text</a>
      const results = [];
      const blockRe =
        /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
      const stripTags = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const decode = (s) =>
        s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
         .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'");

      let match;
      while ((match = blockRe.exec(html)) && results.length < 5) {
        let href = decode(match[1]);
        // DDG wraps URLs in a redirect: //duckduckgo.com/l/?uddg=<encoded>&rut=...
        const uddg = href.match(/[?&]uddg=([^&]+)/);
        if (uddg) {
          try { href = decodeURIComponent(uddg[1]); } catch { /* keep raw */ }
        }
        if (href.startsWith('//')) href = 'https:' + href;
        const title = decode(stripTags(match[2]));
        const snippet = decode(stripTags(match[3])).slice(0, SEARCH_SNIPPET_MAX_CHARS);
        if (title && href) {
          results.push({ title, url: href, description: snippet });
        }
      }
      return results;
    } finally {
      clearTimeout(timer);
    }
  }

  async createDirectory(dirPath) {
    if (!dirPath || typeof dirPath !== 'string') {
      return JSON.stringify({ error: 'dirPath is required', cwd: process.cwd() });
    }
    try {
      await fs.mkdir(dirPath, { recursive: true });
      this._audit('create_directory', { dirPath, cwd: process.cwd() });
      return JSON.stringify({
        status: 'success',
        cwd: process.cwd(),
        message: `Created directory: ${dirPath}`,
      });
    } catch (e) {
      return JSON.stringify({ error: `Failed to create directory: ${e.message}`, cwd: process.cwd() });
    }
  }

  async readSourceFile(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      return JSON.stringify({ error: 'filePath is required', cwd: process.cwd() });
    }
    try {
      // Stat first so we can reject oversized reads before loading them.
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        return JSON.stringify({ error: `Not a regular file: ${filePath}`, cwd: process.cwd() });
      }

      let truncated = false;
      let data;
      if (stat.size > READ_FILE_MAX_BYTES) {
        // Stream-read only the first READ_FILE_MAX_BYTES to keep the context
        // window sane. The model is told the file was truncated.
        const fh = await fs.open(filePath, 'r');
        try {
          const buf = Buffer.alloc(READ_FILE_MAX_BYTES);
          await fh.read(buf, 0, READ_FILE_MAX_BYTES, 0);
          data = buf.toString('utf-8');
        } finally {
          await fh.close();
        }
        truncated = true;
      } else {
        data = await fs.readFile(filePath, 'utf-8');
      }

      return JSON.stringify({
        status: 'success',
        cwd: process.cwd(),
        content: data,
        truncated,
        originalSize: stat.size,
        note: truncated
          ? `File was truncated to first ${READ_FILE_MAX_BYTES} bytes of ${stat.size}.`
          : undefined,
      });
    } catch (e) {
      return JSON.stringify({ error: `Failed to read file: ${e.message}`, cwd: process.cwd() });
    }
  }

  /**
   * Atomic full-file replacement. Writes to a tempfile in the same directory
   * as the target (so rename stays atomic on POSIX) and then renames over
   * the target. If anything fails mid-write, the original file is untouched.
   */
  async editSourceFile(filePath, content) {
    if (!filePath || typeof filePath !== 'string') {
      return JSON.stringify({ error: 'filePath is required', cwd: process.cwd() });
    }
    if (content === undefined || content === null) {
      return JSON.stringify({ error: 'content is required', cwd: process.cwd() });
    }

    const absPath = path.resolve(filePath);
    const dir = path.dirname(absPath);
    // Random suffix keeps concurrent edits from colliding.
    const tmpPath = path.join(dir, `.${path.basename(absPath)}.${process.pid}.${Date.now()}.tmp`);

    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tmpPath, content, 'utf-8');
      await fs.rename(tmpPath, absPath);

      this._audit('edit_source_file', {
        filePath,
        cwd: process.cwd(),
        bytes: Buffer.byteLength(content, 'utf-8'),
      });

      return JSON.stringify({
        status: 'success',
        cwd: process.cwd(),
        message: `File updated completely: ${filePath}`,
      });
    } catch (e) {
      // Clean up dangling tempfile so the directory doesn't accumulate cruft.
      try { await fs.unlink(tmpPath); } catch { /* tempfile may not exist */ }
      return JSON.stringify({ error: `Failed to write file: ${e.message}`, cwd: process.cwd() });
    }
  }

  async gitCommitAndPush(commitMessage) {
    const cwd = process.cwd();
    try {
      const git = simpleGit(cwd);
      const status = await git.status();
      if (status.isClean()) {
        return JSON.stringify({ status: 'success', message: 'No changes detected to commit.' });
      }
      await git.add('.');
      await git.commit(commitMessage || 'Automated commit by Nexus AI');

      // simple-git doesn't expose a per-call timeout, so we shell out to
      // `git push` via our bounded exec wrapper. This prevents a stuck
      // credential prompt from hanging the whole tool loop indefinitely.
      const push = await execWithTimeout('git push', {
        cwd,
        timeoutMs: GIT_TIMEOUT_MS,
        // Ensure pushes never block on interactive auth prompts.
        env: { GIT_TERMINAL_PROMPT: '0' },
      });

      if (!push.ok) {
        this._audit('git_commit_and_push', { ok: false, error: push.message, commitMessage });
        return JSON.stringify({
          error: `Git push failed: ${push.message}`,
          stdout: push.stdout.slice(0, 1000),
          stderr: push.stderr.slice(0, 1000),
          aborted: push.aborted || false,
        });
      }

      this._audit('git_commit_and_push', { ok: true, commitMessage });
      return JSON.stringify({
        status: 'success',
        message: `Committed and pushed: "${commitMessage}"`,
        stdout: push.stdout.slice(0, 1000),
        stderr: push.stderr.slice(0, 1000),
      });
    } catch (e) {
      this._audit('git_commit_and_push', { ok: false, error: e.message });
      return JSON.stringify({ error: `Git operation failed: ${e.message}` });
    }
  }

  async installNpmPackage(packageName) {
    if (!packageName) return JSON.stringify({ error: 'Empty package name' });

    // Allow scoped packages (@scope/pkg), version pins (pkg@1.2.3), but
    // strip any shell metachars. If stripping changes the input we refuse
    // so the model doesn't think it installed a silently-rewritten package.
    const safePackageName = String(packageName).replace(/[^a-zA-Z0-9_\-\.\@\/]/g, '');
    if (safePackageName !== packageName) {
      return JSON.stringify({
        error: `Unsafe package name provided. Attempted: ${packageName}. Sanitized: ${safePackageName}`,
      });
    }

    console.log(`\x1b[36m  [Tool] Installing NPM package: ${safePackageName}\x1b[0m`);

    const result = await execWithTimeout(
      `npm install --no-fund --no-audit ${safePackageName}`,
      {
        cwd: process.cwd(),
        timeoutMs: NPM_TIMEOUT_MS,
        // Disable colorized output and interactive prompts for cleaner logs.
        env: { CI: '1', npm_config_progress: 'false', npm_config_color: 'false' },
      }
    );

    if (!result.ok) {
      this._audit('install_npm_package', { ok: false, pkg: safePackageName, error: result.message });
      return JSON.stringify({
        error: `NPM install failed: ${result.message}`,
        stdout: result.stdout.slice(0, 1000),
        stderr: result.stderr.slice(0, 1000),
        aborted: result.aborted || false,
      });
    }

    this._audit('install_npm_package', { ok: true, pkg: safePackageName });
    return JSON.stringify({
      status: 'success',
      stdout: result.stdout.slice(0, 1000),
      stderr: result.stderr.slice(0, 1000),
    });
  }

  // ─── Screen Capture (owner-only) ───────────────────────
  //
  // Security model (decided with Khellon, 2026-04-23):
  //   • Only the owner — identified by `OWNER_TELEGRAM_USER_ID` env var —
  //     can trigger a screenshot. Any other user is silently refused.
  //   • If OWNER_TELEGRAM_USER_ID is unset, screenshots are disabled for
  //     everyone (fail-closed) so an unconfigured install can never leak
  //     the host's screen.
  //   • The captured PNG is delivered out-of-band through the adapter's
  //     registered media channel (sendPhoto for Telegram) — the LLM never
  //     sees the image bytes, only a status string.
  //
  // Platform dispatch:
  //   • darwin  → `screencapture -x [-D n] <path>`
  //   • linux   → `grim` (Wayland) → `scrot` → `import` (ImageMagick)
  //   • win32   → inline PowerShell using System.Drawing
  async takeScreenshot(displayIndex, caption, context = {}) {
    const platform = context.platform;
    const userId   = context.platformUserId ? String(context.platformUserId) : null;

    // ── Step 1: Owner gate ───────────────────────────────
    const ownerId = process.env.OWNER_TELEGRAM_USER_ID
      ? String(process.env.OWNER_TELEGRAM_USER_ID).trim()
      : null;

    if (!ownerId) {
      return JSON.stringify({
        error: 'Screenshot is disabled on this install. The host has not set OWNER_TELEGRAM_USER_ID in .env, so no one can capture the screen. Ask the host to configure their Telegram user ID and restart Nexus.',
      });
    }

    // Only the platform we trust (telegram) is owner-gated right now. Other
    // platforms (web UI, etc.) are denied until a parallel gate is added.
    if (platform !== 'telegram') {
      return JSON.stringify({
        error: `Screenshot is restricted to the Telegram owner. This request came from platform=${platform || 'unknown'}, which is not yet supported.`,
      });
    }

    if (!userId || userId !== ownerId) {
      this._audit('take_screenshot_denied', { platform, userId, reason: 'not-owner' });
      return JSON.stringify({
        error: 'Permission denied. Only the host owner can request a screenshot of this machine.',
      });
    }

    // ── Step 2: Platform-specific capture to a tempfile ──
    const outPath = path.join(
      os.tmpdir(),
      `nexus-screenshot-${process.pid}-${Date.now()}.png`
    );
    const hostOs = process.platform;
    const display = Number.isInteger(displayIndex) && displayIndex >= 1
      ? displayIndex
      : null;

    let capture;
    try {
      if (hostOs === 'darwin') {
        // -x disables the shutter sound, -D selects display (1-indexed).
        const displayFlag = display ? ` -D ${display}` : '';
        capture = await execWithTimeout(
          `screencapture -x${displayFlag} ${JSON.stringify(outPath)}`,
          { timeoutMs: 15_000 }
        );
      } else if (hostOs === 'linux') {
        capture = await this._linuxCapture(outPath);
      } else if (hostOs === 'win32') {
        capture = await this._windowsCapture(outPath);
      } else {
        return JSON.stringify({
          error: `Screenshot is not supported on host OS "${hostOs}". Supported: darwin, linux, win32.`,
        });
      }

      if (!capture.ok) {
        this._audit('take_screenshot', { ok: false, error: capture.message });
        return JSON.stringify({
          error: `Screen capture command failed: ${capture.message}`,
          stderr: (capture.stderr || '').slice(0, 500),
          hint: hostOs === 'linux'
            ? 'Install one of: grim (Wayland), scrot, or ImageMagick (for `import`).'
            : undefined,
        });
      }

      // ── Step 3: Load bytes & validate ──────────────────
      const buf = await fs.readFile(outPath);
      if (!buf || buf.length < 100) {
        return JSON.stringify({
          error: `Screenshot produced an empty/invalid file (${buf?.length || 0} bytes).`,
        });
      }

      // ── Step 4: Deliver via adapter media channel ──────
      const cm = this.conversationManager;
      const channel = cm?.mediaChannels?.[platform];
      if (typeof channel !== 'function') {
        return JSON.stringify({
          error: 'No media channel is registered for this adapter. The screenshot was captured but cannot be delivered. Restart the bot so the adapter can register its channel.',
        });
      }

      try {
        await channel({
          platformUserId: userId,
          buffer: buf,
          filename: 'screenshot.png',
          mimeType: 'image/png',
          caption: caption ? String(caption).slice(0, 256) : undefined,
        });
      } catch (deliveryErr) {
        this._audit('take_screenshot', { ok: false, error: 'delivery: ' + deliveryErr.message });
        return JSON.stringify({
          error: `Screenshot was captured but delivery to the chat failed: ${deliveryErr.message}`,
        });
      }

      this._audit('take_screenshot', {
        ok: true,
        os: hostOs,
        bytes: buf.length,
        display: display || 'primary',
      });

      return JSON.stringify({
        status: 'success',
        message: 'Screenshot captured and sent to the user as a photo.',
        os: hostOs,
        bytes: buf.length,
        display: display || 'primary',
      });
    } finally {
      // Best-effort cleanup — we don't want to leave PNGs lying around.
      fs.unlink(outPath).catch(() => { /* tempfile may not exist */ });
    }
  }

  /**
   * Linux capture: try grim (Wayland), then scrot, then ImageMagick's
   * `import`. Return the first one that succeeds. We deliberately try
   * them in order rather than detecting the session type because some
   * Wayland compositors still ship scrot as a fallback.
   */
  async _linuxCapture(outPath) {
    const candidates = [
      { cmd: `grim ${JSON.stringify(outPath)}`, name: 'grim' },
      { cmd: `scrot -o ${JSON.stringify(outPath)}`, name: 'scrot' },
      { cmd: `import -window root ${JSON.stringify(outPath)}`, name: 'imagemagick' },
    ];
    const errors = [];
    for (const c of candidates) {
      const result = await execWithTimeout(c.cmd, { timeoutMs: 15_000 });
      if (result.ok) return result;
      errors.push(`${c.name}: ${result.message}`);
    }
    return {
      ok: false,
      message: `All capture backends failed. Tried ${errors.join(' | ')}`,
      stderr: errors.join('\n'),
    };
  }

  /**
   * Windows capture: PowerShell one-liner using System.Drawing to grab
   * the virtual screen (all monitors combined) and save to PNG.
   */
  async _windowsCapture(outPath) {
    const escaped = outPath.replace(/'/g, "''");
    const script =
      `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ` +
      `$b = [System.Windows.Forms.SystemInformation]::VirtualScreen; ` +
      `$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; ` +
      `$g = [System.Drawing.Graphics]::FromImage($bmp); ` +
      `$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); ` +
      `$bmp.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png); ` +
      `$g.Dispose(); $bmp.Dispose();`;
    return execWithTimeout(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`,
      { timeoutMs: 20_000 }
    );
  }
}

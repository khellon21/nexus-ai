# 🧠 Nexus AI — Complete Codebase Guide

> **A private, local, always-on AI assistant with autonomous sub-agents (Cipher for academic automation, God Mode for self-directed research and code editing), a fully local voice microservice, and long-term memory.**

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Directory Structure](#2-directory-structure)
3. [Entry Point — `src/index.js`](#3-entry-point--srcindexjs)
4. [Web Server — `src/server.js`](#4-web-server--srcserverjs)
5. [Core: AI Engine — `src/core/ai-engine.js`](#5-core-ai-engine--srccoreai-enginejs)
6. [Core: Conversation Manager — `src/core/conversation-manager.js`](#6-core-conversation-manager--srccoreconversation-managerjs)
7. [Core: Database — `src/core/database.js`](#7-core-database--srccoredatabasejs)
8. [Core: Tools — `src/core/tools.js`](#8-core-tools--srccoretools js)
9. [Core: Background Monitor — `src/core/background-monitor.js`](#9-core-background-monitor--srccorebackground-monitorjs)
9a. [Core: Memory — `src/core/memory.js`](#9a-core-memory--srccorememoryjs)
9b. [Core: Voice Process Manager — `src/core/voice-process-manager.js`](#9b-core-voice-process-manager--srccorevoice-process-managerjs)
9c. [Services: Voice Microservice — `services/tts/server.py`](#9c-services-voice-microservice--servicesttsserverpy)
10. [Cipher: Vault — `src/core/cipher-vault.js`](#10-cipher-vault--srccorecipher-vaultjs)
11. [Cipher: Portal Navigator — `src/core/portal-navigator.js`](#11-cipher-portal-navigator--srccoreportal-navigatorjs)
12. [Cipher: Scheduler — `src/core/cipher-scheduler.js`](#12-cipher-scheduler--srccorecipher-schedulerjs)
13. [Cipher: Submitter — `src/core/cipher-submitter.js`](#13-cipher-submitter--srccorecipher-submitterjs)
14. [Cipher: Notifier — `src/core/cipher-notifier.js`](#14-cipher-notifier--srccorecipher-notifierjs)
15. [Cipher: CLI — `src/cipher-cli.js`](#15-cipher-cli--srccipherclijs)
16. [Platform Adapters](#16-platform-adapters)
    - [Telegram](#161-telegram-adapter--srcadapterstelgramjs)
    - [Discord](#162-discord-adapter--srcadaptersdiscordjs)
    - [Slack](#163-slack-adapter--srcadaptersslackjs)
    - [WhatsApp](#164-whatsapp-adapter--srcadapterswhatsappjs)
    - [iMessage](#165-imessage-adapter--srcadaptersimessagejs)
    - [Voice](#166-voice-adapter--srcadaptersvoicejs)
17. [Configuration Files](#17-configuration-files)
18. [Database Schema](#18-database-schema)
19. [Environment Variables Reference](#19-environment-variables-reference)
20. [How Everything Connects — Data Flow Diagrams](#20-how-everything-connects--data-flow-diagrams)
21. [PM2 Process Management](#21-pm2-process-management)
22. [Key Design Decisions](#22-key-design-decisions)

---

## 1. Project Overview

**Nexus AI** is a fully self-hosted personal AI assistant that:
- Runs entirely on your machine — no cloud service stores your chats
- Connects to **multiple chat platforms** simultaneously (Telegram, Discord, Slack, WhatsApp, iMessage, Web)
- Supports **four AI providers**: OpenAI, Anthropic Claude, Google Gemini, and NVIDIA NIM — with automatic routing, schema translation, and streaming for each
- Has an embedded **agentic tool loop** — the AI can use "tools" to fetch time, browse the web, search the internet, read and edit its own source files, commit and push to git, install npm packages (with human-in-the-loop approval), check the course portal, and more
- Maintains **long-term memory** — a local SQLite-backed RAG store that embeds, retrieves, and injects relevant memories into the system prompt before every turn
- Speaks and listens through a **fully local voice microservice** (`services/tts/server.py`) supervised by `VoiceProcessManager` — Faster-Whisper for STT, VoxCPM2 for TTS, auto-start/auto-sleep/lazy-wake lifecycle
- Includes two autonomous sub-agents:
  - **Cipher** — a Playwright-based academic automation agent that logs into your university portal (Wright State's D2L Brightspace), extracts course assignments, grades, and deadlines, and notifies you proactively
  - **God Mode** — a self-directed agent that can research online, edit its own codebase atomically, and ship commits, subject to an explicit HITL gate on `npm install`

---

## 2. Directory Structure

```
nexus-ai/
├── src/
│   ├── index.js                  ← main entry point, orchestrates everything
│   ├── server.js                 ← Express REST + WebSocket server
│   ├── wizard.js                 ← interactive CLI setup wizard
│   ├── cipher-cli.js             ← CLI tools for Cipher (scan, keygen, etc.)
│   ├── core/
│   │   ├── ai-engine.js          ← multi-provider AI calls (OpenAI, Anthropic, Gemini, NVIDIA)
│   │   ├── conversation-manager.js ← per-user session + tool loop + memory injection
│   │   ├── database.js           ← SQLite wrapper (chats + Cipher + memory embeddings)
│   │   ├── tools.js              ← AI tool registry (browser, search, memory, God Mode, Cipher)
│   │   ├── memory.js             ← Long-term RAG memory (embed + cosine similarity)
│   │   ├── background-monitor.js ← periodic autonomous AI checks
│   │   ├── voice-process-manager.js ← Python voice service lifecycle supervisor
│   │   ├── cipher-vault.js       ← AES-256-GCM credential encryption
│   │   ├── portal-navigator.js   ← Playwright browser automation (SSO + scraping)
│   │   ├── cipher-scheduler.js   ← orchestrates all Cipher jobs
│   │   ├── cipher-submitter.js   ← automated file upload to portal
│   │   └── cipher-notifier.js    ← multi-channel alert dispatcher
│   └── adapters/
│       ├── telegram.js           ← Telegram integration (send-text-first voice UX)
│       ├── discord.js            ← Discord bot
│       ├── slack.js              ← Slack Socket Mode
│       ├── whatsapp.js           ← WhatsApp Web (QR-based)
│       ├── imessage.js           ← macOS iMessage via AppleScript polling
│       └── voice.js              ← Thin wrapper over AIEngine voice methods
├── services/
│   └── tts/
│       └── server.py             ← FastAPI local voice service — Faster-Whisper + VoxCPM2
├── public/
│   ├── index.html                ← Web dashboard HTML
│   ├── css/styles.css            ← Web dashboard styles
│   └── js/app.js                 ← Web dashboard frontend JS
├── config/
│   ├── default.json              ← Default system config
│   ├── cipher-portal.json        ← Portal URL, selectors, SSO config
│   └── cipher-submissions.json   ← Auto-submission mappings
├── data/
│   ├── nexus.db                  ← SQLite database (all chats + assignments)
│   └── cipher-vault.enc          ← AES-256-GCM encrypted portal credentials
├── logs/                         ← PM2 output + error logs
├── .env                          ← runtime secrets (API keys, tokens)
├── .env.example                  ← template for .env
├── package.json                  ← npm scripts + dependencies
└── ecosystem.config.cjs          ← PM2 process definitions
```

---

## 3. Entry Point — `src/index.js`

**File:** `src/index.js`  
**Role:** The main bootstrap file. Starts everything in order.

### What it does step by step:

1. **Loads `.env`** via `dotenv/config`
2. **Validates setup** — checks that at least one AI provider key exists (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `NVIDIA_API_KEY`). If none are set, it exits with a helpful message.
3. **Creates `AIEngine`** — initializes the AI backend with the configured provider and model. Provider is auto-detected from the model string (`claude-*` → Anthropic, `gemini-*` → Gemini, `<vendor>/<model>` → NVIDIA NIM, otherwise OpenAI).
4. **Creates `NexusDatabase`** — opens (or creates) the SQLite database at `./data/nexus.db`.
5. **Creates `ConversationManager`** — links the AI engine + database. Context window defaults to 20 messages. Injects long-term memories into the system prompt on every turn.
6. **Starts `BackgroundMonitor`** — async import, runs an autonomous AI check every 15 minutes. The prompt now mandates `search_internet` for news queries and forbids `browser_navigate` to invented domains.
7. **Starts `CipherScheduler` (if `CIPHER_ENABLED=true`)** — initializes the academic agent. It defers actual start by 10 seconds to allow the Telegram adapter to connect first (so the Telegram Bot instance can be injected for notifications).
8. **Creates `VoiceProcessManager` (unless `VOICE_ENABLED=false`)** — constructs the supervisor for the Python voice microservice, attaches it to the `AIEngine` via `ai.setVoiceManager(...)`, exposes it at `globalThis.__voiceManager` for adapter UX hooks, and calls `voiceManager.start()` fire-and-forget so the rest of boot is not blocked on model loading. Logs `✓ VoiceProcessManager attached (port 8808, idle 120s)`.
9. **Initializes `VoiceAdapter`** — thin wrapper that delegates to `AIEngine.transcribeAudio` / `AIEngine.textToSpeech`, which in turn call the local Python service.
10. **Starts all platform adapters** sequentially — Telegram, Discord, Slack, WhatsApp, iMessage. Each returns `true/false` based on whether it connected successfully.
11. **Starts the Express + WebSocket server** on the configured `PORT` (default 3000).
12. **Prints the startup banner** — lists the provider, model name, and which platforms are active.
13. **Registers graceful shutdown handlers** — listens for `SIGINT` and `SIGTERM`. On shutdown, it stops all adapters, stops Cipher, calls `voiceManager.shutdown({ reason: signal })` to terminate the Python child cleanly (SIGTERM escalating to SIGKILL after 5 s), closes the web server, and closes the database.

### Key design points:
- **Cipher deferred start.** The Cipher scheduler's Telegram bot injection happens inside a `setTimeout(() => ..., 10000)` — it waits 10 seconds after app start so Telegram has time to authenticate and expose its `.bot` instance.
- **Voice never blocks boot.** `voiceManager.start()` returns immediately; the actual `uvicorn` spawn + health poll happens in the background. If spawning fails (missing `python3`, missing `uvicorn`, port clash), the error is surfaced in the console with a diagnostic hint but does not prevent the rest of Nexus from coming up.

---

## 4. Web Server — `src/server.js`

**File:** `src/server.js`  
**Role:** HTTP REST API + WebSocket server for the web dashboard.

### Framework:
- **Express.js** for HTTP endpoints
- **ws** (WebSocket) for real-time streaming chat
- **multer** for file uploads (voice audio)

### REST API Endpoints:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/conversations` | List all conversations (paginated, optional platform filter) |
| `GET` | `/api/conversations/:id` | Get a specific conversation and its messages |
| `POST` | `/api/conversations` | Create a new conversation |
| `DELETE` | `/api/conversations/:id` | Delete a conversation |
| `POST` | `/api/chat` | Send a message (non-streaming), returns full response |
| `POST` | `/api/voice/transcribe` | Upload audio → returns transcribed text (Whisper) |
| `POST` | `/api/voice/synthesize` | Text → returns MP3 audio (TTS) |
| `GET` | `/api/status` | Returns AI provider info, platform status, uptime, memory |
| `GET` | `/api/search?q=...` | Full-text search across all messages |
| `GET` | `/api/stats` | Database stats (total conversations, messages, tokens, platform breakdown) |

### WebSocket (`/ws`):

The WebSocket server handles **streaming chat**. Protocol:

1. Client sends `{ "type": "chat", "message": "...", "conversationId": "..." }`
2. Server responds with a stream of events:
   - `{ "type": "conversation_created", "conversationId": "..." }` — if no conversation ID was given
   - `{ "type": "user_message_stored", ... }` — acknowledgement
   - `{ "type": "chunk", "content": "..." }` — streaming token
   - `{ "type": "done", ... }` — final assembled message
   - `{ "type": "title_updated", ... }` — after AI auto-generates a title
   - `{ "type": "error", "error": "..." }` — on failure

All messages are stored in SQLite before and after streaming.

---

## 5. Core: AI Engine — `src/core/ai-engine.js`

**File:** `src/core/ai-engine.js`
**Role:** Unified interface to four different AI providers, plus the gateway to the local voice microservice.

### Class: `AIEngine` (extends `EventEmitter`)

#### Constructor config:
- `model` — e.g. `gpt-4o-mini`, `claude-3-5-sonnet-latest`, `gemini-2.5-pro`, `meta/llama-3.1-70b-instruct`
- `provider` — `openai`, `anthropic`, `gemini`, or `nvidia`
- `systemPrompt` — injected at the start of every conversation
- `maxTokens` — default 4096
- `temperature` — default 0.7
- `voiceManager` *(optional)* — a `VoiceProcessManager` instance; if supplied, voice calls lazy-wake the Python microservice before firing

#### Provider Detection:
```js
function detectProvider(model) {
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gemini')) return 'gemini';
  if (model.includes('/')) return 'nvidia';      // e.g. "meta/llama-3.1-70b"
  return 'openai';
}
```

#### `initialize()`
- Creates `openaiClient` (OpenAI SDK) if `OPENAI_API_KEY` is set
- Creates `anthropicClient` (Anthropic SDK) if `ANTHROPIC_API_KEY` is set
- Creates `geminiClient` and `geminiModel` (Google GenAI SDK) if `GEMINI_API_KEY` is set
- Creates `nvidiaClient` — an OpenAI SDK instance pointing to `https://integrate.api.nvidia.com/v1` (NVIDIA NIM uses the OpenAI-compatible API format)
- Validates that the chosen provider has its key configured

#### `chat(messages, options)` — Non-streaming
- Delegates to `_openaiChat()`, `_anthropicChat()`, or `_geminiChat()` based on detected provider
- Always prepends the system prompt as the first message (Anthropic treats this as the top-level `system` field, not a message)
- Includes all registered tools in the request via `getToolsSchema(<provider>)`
- Returns: `{ content, tool_calls, model, provider, usage: { promptTokens, completionTokens, totalTokens } }`

#### `chatStream(messages, onChunk, options)` — Streaming
- For OpenAI / NVIDIA: `stream: true` with delta assembly of tokens + `tool_calls`
- For Anthropic: uses `messages.stream()` and listens for `content_block_delta`, `message_delta`, and `tool_use` events
- For Gemini: `sendMessageStream()` with `for await` text chunks
- `onChunk(delta, fullString)` fires on every token for real-time display

#### Anthropic Format Translation
Anthropic's Messages API differs from OpenAI in several ways; the engine normalizes:
- **System prompt** lives in the top-level `system` field, *not* in the messages array
- **Tool schemas** use `input_schema` instead of OpenAI's `parameters`; the translator in `getToolsSchema('anthropic')` renames the field and strips `type: 'function'` wrappers
- **Tool calls** arrive as `content` blocks of type `tool_use` with `id`, `name`, and `input`; the engine rewrites them into OpenAI-style `tool_calls` (`{ id, function: { name, arguments } }`) so the downstream `ToolExecutor` remains provider-agnostic
- **Tool results** are returned as `content: [{ type: 'tool_result', tool_use_id, content }]` blocks rather than a separate `role: 'tool'` message
- Streaming responses emit `tool_use` over multiple `input_json_delta` frames — the engine accumulates partial JSON and finalizes on the `message_stop` event

#### Gemini Format Translation
Gemini uses yet another shape; the engine translates:
- `role: 'tool'` → `role: 'function'` with `functionResponse`
- `role: 'assistant'` with `tool_calls` → `role: 'model'` with `functionCall` parts
- Tool schemas reformatted from `{ type, function: { name, ... } }` to `{ name, description, parameters }`

#### Embeddings — `embed(text)`
Returns a vector for the given text, used by the long-term memory subsystem:
- OpenAI: `text-embedding-3-small` (1536 dim)
- Anthropic: falls back to OpenAI embeddings if an OpenAI key is present; otherwise emits a warning and returns `null`
- Gemini: `text-embedding-004`
- NVIDIA: uses the NIM-hosted `nvidia/nv-embed-v1` model

#### Voice Methods (delegate to local `services/tts/server.py`):
- `transcribeAudio(buffer, filename)` → POSTs multipart to `http://127.0.0.1:8808/transcribe`, returns transcription string
- `textToSpeech(text, options)` → POSTs JSON to `/generate`, returns a WAV buffer
- Before each call, `_ensureVoiceReady()` invokes `voiceManager.ensureAwake()` so a sleeping Python process is respawned on demand
- After a successful round-trip, `voiceManager.markActivity()` resets the idle timer
- On fetch failure, `_reportVoiceFetchFailure(err)` tears down the child so the next call gets a fresh process (self-healing)
- If no voice manager is attached (e.g. `VOICE_ENABLED=false`), calls hit the direct URL and surface a clear error with a `pip install` hint

#### `setVoiceManager(manager)`
Attaches a `VoiceProcessManager` post-construction (used by `src/index.js` during boot).

#### Validation Methods:
- `validateOpenAIKey(apiKey)` — test calls `models.list()`
- `validateAnthropicKey(apiKey)` — sends a minimal `messages.create` probe
- `validateGeminiKey(apiKey)` — calls `model.generateContent('Hello')`
- `getProviderInfo()` — returns current provider/model info for the `/api/status` endpoint

---

## 6. Core: Conversation Manager — `src/core/conversation-manager.js`

**File:** `src/core/conversation-manager.js`  
**Role:** Central brain that ties together the database, AI engine, and tool executor for every message flow.

### Class: `ConversationManager`

#### Constructor:
Takes a `database`, `aiEngine`, and options. Instantiates a `ToolExecutor` internally.

#### Core Logic — The Tool Loop

Every message goes through an **agentic tool loop**. Here's the flow:

```
User sends message
    ↓
Store user message in DB
    ↓
Get last 20 messages from DB as context
    ↓
Call AI with context + tool definitions
    ↓
If AI returns tool_calls:
    ↓
    Execute each tool via ToolExecutor
    ↓
    Append tool result to context
    ↓
    Call AI again (LOOP)
    ↓
If AI returns regular text:
    ↓
Store assistant response in DB
    ↓
Return response
```

This loop continues until the AI produces a response without any tool calls.

#### Message Processing Methods:

| Method | Used By | Streaming |
|--------|---------|-----------|
| `processMessage()` | Telegram, Discord, Slack, WhatsApp, iMessage, BackgroundMonitor | No |
| `processMessageStream()` | (available, not yet wired to adapters) | Yes |
| `processWebMessage()` | Web dashboard REST POST `/api/chat` | No |
| `processWebMessageStream()` | Web dashboard WebSocket | Yes |

All four methods follow the same tool loop pattern, differing only in how they handle streaming output and where they look up the conversation ID.

#### Session/Conversation Handling:
- For platform messages: calls `db.getOrCreateSession(platform, platformUserId)` — this ensures the same user always continues their existing conversation, not a new one
- For web messages: uses a `conversationId` passed from the frontend

#### Auto-Title Generation:
If a conversation is new (≤2 messages), it fires a background async AI request to generate a short 4-6 word title from the first message. The title is stored in the DB and pushed back to WebSocket clients via a `title_updated` event.

---

## 7. Core: Database — `src/core/database.js`

**File:** `src/core/database.js`  
**Role:** SQLite wrapper providing all read/write operations. Uses `better-sqlite3` (synchronous, fast).

### Class: `NexusDatabase`

#### Database Settings:
```sql
PRAGMA journal_mode = WAL;    -- write-ahead logging for concurrency
PRAGMA foreign_keys = ON;     -- enforce FK constraints
```

### Tables:

#### `conversations`
| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (UUID) | Primary key |
| `title` | TEXT | Auto-generated or default |
| `platform` | TEXT | `web`, `telegram`, `discord`, etc. |
| `platform_user_id` | TEXT | User ID on the platform |
| `created_at` | DATETIME | |
| `updated_at` | DATETIME | Updated on every new message |
| `is_archived` | INTEGER | Soft delete |
| `metadata` | TEXT (JSON) | Extensible |

#### `messages`
| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (UUID) | Primary key |
| `conversation_id` | TEXT | FK to conversations |
| `role` | TEXT | `user`, `assistant`, or `system` |
| `content` | TEXT | Message body |
| `platform` | TEXT | Origin platform |
| `tokens_used` | INTEGER | Token count for this message |
| `created_at` | DATETIME | |

#### `platform_sessions`
Maps a `(platform, platform_user_id)` pair to a `conversation_id`. This is how the system remembers that Telegram user `12345` maps to conversation `abc-def-ghi`.

#### Cipher Tables (see Section 18 for complete schema)
- `cipher_assignments` — all extracted assignments with due dates, scores, completion status
- `cipher_submissions` — queued and executed file submissions
- `cipher_audit_log` — full event log of every Cipher action

### Key Methods:

| Method | Description |
|--------|-------------|
| `createConversation()` | Creates a new UUID-identified conversation |
| `getOrCreateSession()` | Gets or creates a platform session + linked conversation |
| `addMessage()` | Inserts a message and bumps `updated_at` on the conversation |
| `getRecentMessages(id, count)` | Returns last N messages in chronological order |
| `searchMessages(query)` | LIKE-based full-text search |
| `getStats()` | Counts for dashboard stats widget |
| `upsertAssignment(data)` | Insert-or-update by title + course_id |
| `getPendingAssignments()` | Assignments not submitted and due within 24+ hours |
| `getUrgentAssignments(hours)` | Assignments due within N hours |
| `queueSubmission()` | Add a file submission to the queue |
| `getPendingSubmissions()` | Submissions whose scheduled time has passed |
| `logAuditEvent()` | Write to the Cipher audit log |

---

## 8. Core: Tools — `src/core/tools.js`

**File:** `src/core/tools.js`
**Role:** Defines what "tools" (functions) the AI can call, and executes them.

### Registered AI Tools:

| Tool Name | Category | Description |
|-----------|----------|-------------|
| `get_current_time_and_date` | Utility | Returns current local time, date, and timezone |
| `send_urgent_notification` | Utility | Pushes an alert via the primary adapter (Telegram by default) |
| `search_internet` | Research | DuckDuckGo search with HTML-page fallback for rate-limited queries |
| `browser_navigate` | Browser | Opens a URL in a headless Chrome via the **PinchTab** local daemon |
| `browser_snapshot` | Browser | Returns the accessibility tree (interactive element refs) from the open tab |
| `browser_action` | Browser | Clicks or fills an element using its `ref` ID from a snapshot |
| `browser_extract_text` | Browser | Extracts the full readable text from the current tab |
| `save_core_memory` | Memory | Persists a durable fact about the user/project into the long-term RAG store |
| `read_source_file` | God Mode | Reads a file from the workspace, capped at 512 KB |
| `edit_source_file` | God Mode | Atomically writes or patches a file (temp-write + rename) |
| `create_directory` | God Mode | Recursive `mkdir` inside the workspace |
| `git_commit_and_push` | God Mode | Stages, commits, and pushes via a 60 s-timeout `git` child process |
| `install_npm_package` | God Mode (HITL) | Runs `npm install <pkg>` **only after explicit user approval** |
| `cipher_scan_portal` | Cipher | Triggers an immediate Cipher portal scan |
| `cipher_list_assignments` | Cipher | Returns all assignments (upcoming + past) with scores |
| `cipher_schedule_submission` | Cipher | Queues a file for automatic submission at a specific time |

### `search_internet` — DuckDuckGo with HTML Fallback

Backed by `duck-duck-scrape`. Two critical hardening details:

1. **`SafeSearchType` enum, not a string.** The library's internal `sanityCheck` throws synchronously if `safeSearch: 'off'` is passed as a bare string. The tool now imports `SafeSearchType` and passes `SafeSearchType.OFF`.
2. **HTML fallback.** When the primary VQD-token endpoint returns `Failed to get the VQD for query ...` (a common rate-limit symptom), `_searchInternetHtmlFallback()` fetches `https://html.duckduckgo.com/html/?q=...` with a Firefox User-Agent, regex-extracts up to 5 results from `class="result__a"` / `class="result__snippet"` blocks, and decodes the `uddg=` redirect URLs back into real destinations.

Return shape: `{ results: [{ title, url, snippet }, ...], source: 'ddg-api' | 'ddg-html' }`.

### How the Browser Tools Work:

The browser tools connect to a **PinchTab** daemon running on `http://localhost:9867`. PinchTab is a local browser control service. The tool executor:
1. Creates a profile via `POST /profiles`
2. Starts a headless instance via `POST /instances/start`
3. Opens a tab via `POST /instances/:id/tabs/open`
4. Takes snapshots, performs actions, and extracts text through that tab

The `profileId`, `instanceId`, and `tabId` are stored as instance variables on the `ToolExecutor`, persisting across tool calls within the same session.

### God Mode Tools — Self-Directed Code & Git Operations

Registered when `GOD_MODE_ENABLED=true`. All file operations are clamped to `GOD_MODE_WORKSPACE` (default `.`). Every successful invocation writes an entry to the `god_mode_audit` SQLite table (`event_type`, `tool`, `args_digest`, `result_summary`, `timestamp`).

| Tool | Hardening |
|---|---|
| `read_source_file` | Resolves paths against the workspace root, rejects anything that escapes via `..`, truncates reads at **512 KB** with a `[truncated]` marker |
| `edit_source_file` | Validates `mode ∈ {overwrite, append, patch}`; writes to `<path>.tmp-<pid>-<ts>` then `fs.rename` for **atomic commit** so a crashed edit never leaves a half-written file |
| `create_directory` | `mkdir -p`-style; also clamped to workspace root |
| `git_commit_and_push` | Runs `git add -A && git commit -m ... && git push` as a `spawn`-ed child with a **60-second `AbortController` timeout**; buffers stdout/stderr for the audit log |
| `install_npm_package` | Two-phase HITL: emits a `pending_approval` event with `{ package, reason }`, awaits an explicit `yes` / `no` reply on the user's primary adapter; ambiguous replies trigger a clarifying re-prompt rather than a silent default. 120-second timeout on the `npm install` child. |

**Double-intercept guard.** If the model proposes multiple `install_npm_package` calls in a single batch, only the first one enters the approval loop — subsequent ones are auto-denied with *"already pending; resolve first install first"* until the pending request clears. This avoids a race where a `yes` to package A could accidentally authorize package B.

### `save_core_memory`

Writes a memory to the `core_memory` table through `src/core/memory.js`. Each memory is embedded on insert using the configured provider's embedding model. On every new conversation turn, `ConversationManager` retrieves the top-k (default 5) most-similar memories via cosine similarity and prepends them to the system prompt under a `### Persistent memories` heading.

### Schema Formats:
- **OpenAI / NVIDIA** — `{ type: 'function', function: { name, description, parameters } }`
- **Anthropic** — `{ name, description, input_schema }` (no `type: 'function'` wrapper; `parameters` → `input_schema`)
- **Gemini** — `{ name, description, parameters }`
- `getToolsSchema(provider)` performs the translation and filters out God Mode tools when `GOD_MODE_ENABLED` is false
- `ToolExecutor` parses JSON arguments before dispatching, handling both string-encoded and object-encoded argument formats

### `ToolExecutor` class:
All tool execution is handled by a single `execute(call)` method that dispatches to private methods based on `call.name`. Any error thrown inside a tool is caught and returned as `{ error: "..." }` JSON — the AI receives this and handles it gracefully. Every tool invocation (success or failure) is also emitted as a `tool_invoked` event for the dashboard activity feed.

---

## 9. Core: Background Monitor — `src/core/background-monitor.js`

**File:** `src/core/background-monitor.js`
**Role:** Autonomous periodic AI agent that checks news/portal without user input.

### Behavior:
- Runs every **15 minutes** by default
- Sends a special silent-trigger prompt to the AI through the `ConversationManager`, using a dedicated session (`platform = 'system'`, `platformUserId = 'background-worker'`) so it never mixes with user conversations
- The prompt mandates `search_internet` for any news query (no more hallucinated URLs like `technologynews.com`), limits the model to a single tool call per check, and forbids `browser_navigate` to domains that were not returned by a prior `search_internet` or `cipher_*` call
- If something critical is found, the AI calls `send_urgent_notification` which pushes an alert over the primary adapter

This is what makes Nexus AI **proactive** — it doesn't wait for you to ask; it checks things automatically.

### Why the prompt was rewritten
An earlier version of the monitor would emit logs such as `[Browser] Navigating to: https://www.technologynews.com` — a domain the model invented out of thin air. PinchTab would fail the fetch, the monitor would swallow the error, and the user would see an "I apologize for the inconvenience" reply. The rewritten prompt now starts with an explicit allowlist rule (*"Only navigate to URLs that `search_internet` returned in this same check"*) and caps tool depth at one, which eliminated the class of failure.

---

## 9a. Core: Memory — `src/core/memory.js`

**File:** `src/core/memory.js`
**Role:** Long-term memory (RAG) store for durable facts about the user, preferences, and project state.

### Storage

A new `core_memory` SQLite table:

```sql
core_memory (
  id          TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  embedding   BLOB NOT NULL,     -- Float32Array serialized as raw bytes
  source      TEXT,              -- 'save_core_memory' | 'auto' | etc.
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used   DATETIME
)
```

Embeddings are stored as raw `Float32Array` byte blobs for compact storage and fast vectorization at recall time.

### Public API

| Method | Description |
|---|---|
| `save(content, source)` | Embeds the text via `AIEngine.embed(...)` and inserts the row |
| `recall(query, k = 5)` | Embeds the query, computes cosine similarity against every stored memory, returns the top-k with a minimum-similarity threshold (default 0.35) |
| `list(limit)` | Non-semantic chronological listing (for dashboard UI) |
| `delete(id)` | Manual removal |

### Injection into the system prompt

Inside `ConversationManager.processMessage`:

```
1. Fetch last 20 messages.
2. Run memory.recall(userMessage, k=5) on the latest user turn.
3. If any memories match above threshold, prepend them to the system prompt:

   ### Persistent memories
   - [2026-04-10] Khellon's timezone is America/New_York.
   - [2026-04-18] Khellon prefers concise, bulleted replies for technical questions.
   ...

4. Send the augmented message list to ai.chat().
5. After the response, update `last_used` on each recalled memory for LRU-style aging.
```

### The `save_core_memory` tool

Exposed to the AI so it can proactively persist facts whenever the user shares something durable:

```json
{
  "name": "save_core_memory",
  "description": "Store a persistent fact about the user so it can be recalled in future conversations.",
  "parameters": {
    "type": "object",
    "properties": {
      "content": { "type": "string", "description": "The fact to remember, written in third person." }
    },
    "required": ["content"]
  }
}
```

The AI is instructed (in the default system prompt) to call this tool when the user says things like *"remember that..."*, *"I prefer..."*, or discloses contact details, project constraints, or workflow preferences.

---

## 9b. Core: Voice Process Manager — `src/core/voice-process-manager.js`

**File:** `src/core/voice-process-manager.js`
**Role:** Lifecycle supervisor for the Python voice microservice (`services/tts/server.py`). Auto-starts the service at boot, keeps it warm, sleeps it after idle, respawns it on demand, and surfaces actionable diagnostic errors.

### Why this exists

Before the manager, running voice required the user to `python services/tts/server.py` in a separate terminal. If they didn't, every voice call died with a vague `fetch failed`. The manager removes that entire failure mode — Python starts and stops in the same process tree as `npm start`, idle cost is reclaimed automatically, and cold-start feedback is surfaced in the chat UI.

### Class: `VoiceProcessManager` (extends `EventEmitter`)

#### Constructor options
| Option | Default | Description |
|---|---|---|
| `port` | `8808` | Port the Python service binds on `127.0.0.1` |
| `idleMs` | `120000` (2 min) | Sleep the child after this many ms of no activity |
| `wakeTimeoutMs` | `60000` | Max time to wait for `/health` during cold start |
| `healthPollMs` | `250` | Interval between `/health` probes while waking |
| `pythonBin` | — | Explicit Python binary override; otherwise auto-resolved |
| `cwd` | project root | Working dir for the Python subprocess |

#### Public API
| Method | Returns | Description |
|---|---|---|
| `start()` | `Promise<{ coldStart: boolean, baseUrl: string }>` | Called once at boot; spawns the child and waits for `/health` |
| `ensureAwake()` | `Promise<{ coldStart, baseUrl }>` | Coalesced wake — multiple concurrent callers share a single spawn |
| `markActivity()` | `void` | Resets the idle timer after each successful request |
| `shutdown({ reason })` | `Promise<void>` | `SIGTERM` → `SIGKILL` escalation; resolves when the child exits |
| `isRunning` *(getter)* | `boolean` | `true` iff the child has not exited |

#### Events
- `waking`, `awake` — cold-start begin/end
- `sleeping`, `slept` — idle teardown begin/end
- `exit` — child exited (either voluntarily via shutdown or crash)

### Python binary resolution — `_resolvePython()`

Tries candidates in order, running `<bin> --version` via `spawnSync` and accepting the first that exits cleanly:

1. `pythonBin` from constructor (if provided)
2. `python3`
3. `python`
4. `py` (Windows launcher)

If all four fail, `start()` rejects with `"No Python interpreter found on PATH"`.

### Cold-start flow — `_spawnChild()` + `_waitForHealth()`

```
spawn('<python>', ['-u', '-m', 'uvicorn',
                   'services.tts.server:app',
                   '--host', '127.0.0.1',
                   '--port', String(port)])
  ↓
pipe stdout/stderr through _pipeLog() with a [voice-py] prefix
(stderr in yellow, stdout in gray — so errors stand out in npm start output)
  ↓
poll GET http://127.0.0.1:<port>/health every 250 ms
  ↓
resolve when status 200, or reject after wakeTimeoutMs
```

### Concurrent wake coalescing

The first `ensureAwake()` caller creates `this._wakePromise`; all subsequent callers await the same promise until it resolves, so a burst of adapter requests produces exactly one `spawn`. The `voice_mgr_test.mjs` behavioral test exercises this with 5 concurrent callers.

### Idle teardown

Every `markActivity()` resets a `setTimeout(idleMs)` that, when it fires:
1. Emits `sleeping`
2. Sends `SIGTERM` to the child
3. After 5 s, sends `SIGKILL` if the child is still alive
4. Clears `this.child`
5. Emits `slept`

The next `ensureAwake()` respawns transparently.

### Self-healing on fetch failure

`AIEngine._reportVoiceFetchFailure(err)` calls `manager.shutdown({ reason: 'fetch-failed' })` then flips the internal `_shuttingDown` flag back off so a subsequent `ensureAwake()` can respawn. This covers the case where the Python process crashes mid-session (e.g. a VoxCPM2 model load segfault on CPU-only hardware) — the next voice call gets a fresh, healthy process instead of repeating the same dead-fetch error forever.

### Diagnostic hints — `_buildDiagnosisHint()`

A rolling 4 KB ring buffer of Python stderr is maintained. When the manager throws, it scans the buffer for known patterns and appends a targeted hint to the error message:

| Pattern detected | Hint returned |
|---|---|
| `ModuleNotFoundError: No module named 'uvicorn'` | `pip install uvicorn python-multipart` |
| `No module named 'fastapi'` | `pip install fastapi` |
| `No module named 'services'` | `Run npm start from the project root, not inside services/` |
| `address already in use` | `Port 8808 is busy — set VOICE_PORT in .env to a free port` |
| `libcudart.so` / `CUDA` errors | `GPU libs unavailable; set WHISPER_DEVICE=cpu WHISPER_COMPUTE_TYPE=int8` |

This turns opaque subprocess failures into one-line fixes.

---

## 9c. Services: Voice Microservice — `services/tts/server.py`

**File:** `services/tts/server.py`
**Role:** FastAPI process that serves local STT (Faster-Whisper) and TTS (VoxCPM2) over HTTP on `127.0.0.1:8808`.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness probe. Returns `{ status: 'ok', whisper_loaded, voxcpm_loaded, preload_in_progress }` — used by `VoiceProcessManager` to detect cold-start completion |
| `POST` | `/transcribe` | Multipart upload of an audio file (ogg/webm/mp3/wav/m4a). Returns `{ text, language, duration }` |
| `POST` | `/generate` | JSON `{ text, reference_wav_path?, cfg_value?, inference_timesteps? }`. Returns a WAV buffer with `Content-Type: audio/wav` |

### Port-first startup

The FastAPI `lifespan` hook is **deliberately empty of blocking work**. At startup it spawns a daemon thread that calls `_load_whisper_blocking()` in the background, then immediately `yield`s so `uvicorn` binds the port on the first event-loop tick. Without this, Whisper's constructor (which downloads and quantizes the model on first run) would delay the socket bind by tens of seconds, and the Node manager would time out waiting for `/health`.

VoxCPM2 is **not** preloaded — it is heavy and not every user needs TTS. It loads on the first `/generate` call.

### Lazy, thread-safe model loading

Each model has:
- A module-level `Optional` singleton (`_whisper_model`, `_voxcpm_model`)
- A `threading.Lock` guard so concurrent background-preload + request-triggered loads never construct the model twice
- An `async get_*()` wrapper that delegates to `asyncio.to_thread(_load_*_blocking)` so the event loop stays free during construction

### Request off-loading

Both endpoints run the actual inference on a worker thread via `asyncio.to_thread`. This means `/health` keeps returning `200` even during long transcriptions, so the Node manager's pings continue to succeed.

### Configuration (environment)

| Var | Default | Meaning |
|---|---|---|
| `VOICE_HOST` | `127.0.0.1` | Bind address |
| `VOICE_PORT` | `8808` | Bind port |
| `WHISPER_MODEL` | `base.en` | Any Faster-Whisper model ID |
| `WHISPER_DEVICE` | `cpu` | `cpu`, `cuda`, or `mps` |
| `WHISPER_COMPUTE_TYPE` | `int8` | `int8` / `int8_float16` / `float16` / `float32` |
| `WHISPER_BEAM_SIZE` | `1` | Increase to 5 for higher accuracy at CPU cost |
| `VOXCPM_MODEL` | `openbmb/VoxCPM2` | HuggingFace model ID |
| `VOXCPM_LOAD_DENOISER` | `false` | Only enable if your reference wav is noisy |
| `PRELOAD_WHISPER` | `true` | Set `false` to defer even Whisper to first request |
| `LOG_LEVEL` | `INFO` | Standard Python logging levels |

### Dependencies

```bash
pip install fastapi uvicorn python-multipart faster-whisper voxcpm soundfile numpy
```

Installed once; `VoiceProcessManager` auto-detects missing modules and surfaces the right `pip install` hint.

---

## 10. Cipher: Vault — `src/core/cipher-vault.js`

**File:** `src/core/cipher-vault.js`  
**Role:** Encrypts and decrypts the university portal credentials. Credentials are **never stored in plaintext**.

### Encryption Spec:
- Algorithm: **AES-256-GCM** (authenticated encryption)
- Key derivation: **scrypt** with a random 16-byte salt (unique per encryption)
- IV: random 12 bytes per encryption
- Auth tag: 16 bytes (prevents tampering)

### Binary format of the vault file:
```
[16 bytes: salt] [12 bytes: IV] [16 bytes: GCM auth tag] [N bytes: ciphertext]
```

### Environment Requirement:
`CIPHER_VAULT_KEY` must be set in `.env`. This is a 32-byte hex string (64 hex chars). Generate one with:
```bash
node src/cipher-cli.js generate-key
```

### Methods:

| Method | Description |
|--------|-------------|
| `storeCredentials(username, password)` | Encrypts `{ username, password, storedAt }` to disk |
| `getCredentials()` | Decrypts and parses credentials from disk |
| `hasCredentials()` | Checks if vault file exists |
| `storeData(key, value)` | Store additional encrypted data (e.g. session tokens) |
| `getData(key)` | Retrieve additional encrypted data |

---

## 11. Cipher: Portal Navigator — `src/core/portal-navigator.js`

**File:** `src/core/portal-navigator.js`  
**Role:** The robotic browser. Uses Playwright to log into, navigate, and scrape your university portal (Wright State Pilot / D2L Brightspace).

### State Machine:
```
IDLE → AUTHENTICATING → NAVIGATING → EXTRACTING → IDLE
                ↓                ↓
          AUTH_FAILED         ERROR
```

State transitions are logged to console and written to the audit log.

### Browser Setup:
- Launches **headless Chromium** via Playwright
- User-agent spoofed to a real Chrome Mac agent
- Viewport: 1280×800
- Screenshots saved to `./data/cipher-screenshots/` on any failure

### `login()` — Authentication Flow (SSO-aware):

This is the most complex part. Wright State uses **PingFederate SSO** + **Duo 2FA**:

1. Navigate to portal login page (e.g. `pilot.wright.edu/d2l/login`)
2. Detect if the page has auto-redirected to the SSO domain (`auth.wright.edu`)
3. If not auto-redirected, search for and click a LOGIN link/button
4. Wait for the SSO username input to appear
5. Fill username and password from the vault
6. Click submit
7. Wait up to **60 seconds** for Duo 2FA approval (user taps "Approve" on phone)
8. If Duo's "Yes, this is my device" button appears, click it automatically
9. Check the final URL and page text to confirm success
10. On failure → retry up to `maxRetries` times with **exponential backoff** (2s, 4s, 8s...)

### `extractAssignments()` — Data Extraction Flow:

1. Navigate to the D2L dashboard
2. Find all course links using `a[href*="/d2l/home/"]` selector
3. For each course:
   - Click "Assessments" or "Assignments" dropdown tab
   - Click "Dropbox" link/menu item
   - Extract rows from the Dropbox table using `tr`, `d2l-table-row`, `[role="row"]`, or `li.d2l-datalist-item`
   - For each row, extract:
     - **Title**: from the link text, or `strong`/`label`/`div` if no link (handles past quizzes with no link)
     - **Due date**: regex-matched from the row text (e.g. `"April 14, 2026 11:59 PM"`)
     - **Completion status**: e.g. `"Not Submitted"` or `"1 Submission, 1 File"`
     - **Score**: e.g. `"- / 10"` or `"8 / 10 - 80%"`
     - **Evaluation status**: e.g. `"Feedback: Unread"`
   - Falls back to positional cell parsing if regex fails
   - Falls back to `_parseAssignmentsFromText()` if table extraction yields 0 rows
4. Filter out assignments without parsed due dates (would violate DB constraint)
5. Tag each assignment with `courseId` and `courseName`

### `_parseAssignmentsFromText(text)` — Fallback Text Parser:
Scans raw page text line-by-line looking for lines that match assignment title patterns (e.g. starting with "Assignment", "Homework", "Quiz", "Lab", "#3", etc.), then scans subsequent lines for due date patterns.

### `_parseDate(dateStr)`:
Attempts to parse a date string using 3 strategies:
1. `new Date(cleaned)` — native JS parsing
2. Regex `MM/DD/YYYY`
3. Regex `YYYY-MM-DD`
4. Regex `Month DD, YYYY`

### File Submission Methods:
- `navigateToDropbox(url)` — navigates to the assignment dropbox page
- `uploadFile(filePath)` — finds `input[type="file"]` and uses Playwright's `setInputFiles()`
- `clickSubmit()` — tries multiple submit button selectors (`.d2l-button-primary`, `button[type="submit"]`, etc.)
- `getPageText()` — returns current page text for confirmation checking

---

## 12. Cipher: Scheduler — `src/core/cipher-scheduler.js`

**File:** `src/core/cipher-scheduler.js`  
**Role:** The orchestrator. Creates and manages all Cipher subsystems and schedules their periodic jobs.

### Class: `CipherScheduler`

#### Subsystems it creates:
- `PortalNavigator` — browser automation
- `CipherNotifier` — notification dispatch
- `CipherSubmitter` — automated file upload

#### Scheduled Jobs:

| Job | Timing | What it does |
|-----|--------|--------------|
| Portal scan | Every 2 hours (configurable via `CIPHER_SCAN_INTERVAL`) | Login → extract → upsert DB → audit deadlines |
| First scan delay | 30 seconds after start | Initial scan shortly after startup |
| Submission queue | Every 5 minutes | Execute any pending queued file submissions |
| Daily summary | Every hour, fires when clock matches `CIPHER_SUMMARY_HOUR` | Sends a formatted summary of all pending assignments |
| Summary startup check | 60 seconds after start | Catch-up if daily summary hour already passed |

All jobs are wrapped in `_safeRun()` which catches errors, logs them, sends an error notification, and **does not kill the scheduler** — errors in one run don't prevent the next.

### `runScan()` — Full Portal Scan:
1. `navigator.login()` — authenticate
2. `navigator.extractAssignments()` — scrape
3. Loop: `db.upsertAssignment(a)` for each assignment
4. `submitter.matchAndQueue(assignments)` — auto-queue any configured submission mappings
5. `auditDeadlines()` — check thresholds and send alerts
6. `navigator.shutdown()` — close browser (always, even on error)

### `auditDeadlines()`:
Fetches all pending assignments and for each one:
- Calculates `hoursLeft = (dueDate - now) / (1000 * 60 * 60)`
- Marks overdue assignments as `status: 'overdue'`
- For non-overdue ones, checks against configured thresholds (e.g. 48h, 24h, 6h, 1h)
- Calls `notifier.sendAlert()` for the most-urgent matching threshold
- Updates assignment status to `'notified'` after an alert is sent

### `getAssignmentStatus()` — AI Tool Response:
Formats all assignments for the AI tool `cipher_list_assignments`. Returns:
```json
{
  "total": 12,
  "upcomingCount": 4,
  "pastCount": 8,
  "upcoming": [...],
  "pastAndCompleted": [...]
}
```
Each assignment includes: title, course, dueDate, status, completionStatus, score, evaluationStatus, displayString.

### Manual Triggers:
- `manualScan()` — called by CLI `cipher-cli.js scan-now` and the `cipher_scan_portal` AI tool
- `scheduleSubmission()` — called by the `cipher_schedule_submission` AI tool

---

## 13. Cipher: Submitter — `src/core/cipher-submitter.js`

**File:** `src/core/cipher-submitter.js`  
**Role:** Handles automated file submission to portal assignment dropboxes.

### Submission Steps (9-step pipeline):
1. **Verify file exists** on disk (`existsSync`)
2. **Check for duplicate** — if assignment status is already `'submitted'`, skip
3. **Authenticate** via `navigator.login()`
4. **Navigate to dropbox** URL stored in the assignment record
5. **Upload file** via `navigator.uploadFile(filePath)`
6. **Click submit button** via `navigator.clickSubmit()`
7. **Verify confirmation** — reads page text and looks for "submitted successfully" (configurable)
8. **Update database** — marks assignment as submitted, updates submission record status
9. **Send confirmation notification** via notifier

### Queue Processing — `processQueue()`:
Fetches all pending submissions from DB (whose `scheduled_at <= now`) and calls `submit()` for each. Adds a 5-second delay between submissions to avoid overloading the portal.

### Auto-Submit Matching — `matchAndQueue(assignments)`:
After each portal scan, compares newly found assignments against `config/cipher-submissions.json` mappings. If a course and title pattern match, it automatically queues a submission. This allows fully hands-off submission!

Config example that would live in `cipher-submissions.json`:
```json
{
  "submissions": [
    {
      "enabled": true,
      "coursePattern": "CS4100",
      "assignmentPattern": "Homework 3",
      "filePath": "/Users/khellon/homework/hw3.pdf",
      "submitAt": "2026-04-14T09:00:00"
    }
  ]
}
```

---

## 14. Cipher: Notifier — `src/core/cipher-notifier.js`

**File:** `src/core/cipher-notifier.js`  
**Role:** Multi-channel notification dispatcher for deadlines, submissions, and errors.

### Channels Supported:
1. **Telegram** — sends formatted messages via the Telegram bot instance
2. **macOS Notification Center** — uses `osascript` (`display notification "..."`) with optional Basso sound for critical alerts
3. **Twilio SMS** — optional, only for HIGH and CRITICAL urgency alerts

### Urgency Levels:

| Urgency | Hours Until Deadline | Emoji |
|---------|---------------------|-------|
| LOW | > 24 hours | 🟢 |
| MEDIUM | 6–24 hours | 🟡 |
| HIGH | 1–6 hours | 🟠 |
| CRITICAL | < 1 hour | 🔴 |

### Alert Deduplication:
Uses an in-memory `Map` keyed by `"assignmentId:urgency"`. If an alert was sent within the last 4 hours (configurable), it is skipped. This prevents spamming you every 5 minutes. Old entries are cleaned up periodically.

### Message Types:

| Method | Message Type |
|--------|-------------|
| `sendAlert(assignment)` | Single assignment deadline alert |
| `sendDailySummary(assignments)` | Morning summary of all pending work |
| `sendSubmissionConfirmation(assignment, filePath)` | File submitted successfully |
| `sendErrorAlert(message)` | System errors (login failed, scan failed, etc.) |

### Message Format (example alert):
```
🟠 CIPHER — HIGH PRIORITY
━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 CS 4100-01 Algorithms
📝 Homework 3
⏰ Due: Tue, Apr 14, 2026, 11:59 PM
⏳ Time Left: 5h remaining
━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 15. Cipher: CLI — `src/cipher-cli.js`

**File:** `src/cipher-cli.js`  
**Role:** Command-line interface for managing Cipher without starting the full server.

### Commands (run via `npm run cipher -- <command>` or directly):

| Command | Description |
|---------|-------------|
| `generate-key` | Generates a random 32-byte hex key for `CIPHER_VAULT_KEY` |
| `set-credentials` | Interactive prompt to encrypt and store username/password |
| `scan-now` | Immediately triggers a full portal scan |
| `list-assignments` | Prints all assignments from the DB in a formatted table |
| `test-notify` | Sends a test notification across all configured channels |

---

## 16. Platform Adapters

All adapters follow a consistent interface:
- `async start()` → returns `true` on success, `false` on failure/skip
- `async stop()` → graceful disconnection
- `async sendMessage(id, text)` → push a message programmatically

### 16.1 Telegram Adapter — `src/adapters/telegram.js`

**Primary conversational UI for Nexus AI.**

- Uses `node-telegram-bot-api` with **polling** mode
- Ignores `/start` commands
- Shows **typing indicator** (`sendChatAction: 'typing'`) while processing
- Supports **PDF and file uploads** — downloads the file, parses text (PDF with `pdf-parse`, others as UTF-8), and appends it to the message context
- Special `DOMMatrix` polyfill to fix `pdf-parse` v2 crash on Node.js 18
- On error 409 (another instance running), logs a warning instead of crashing
- The bot instance (`this.bot`) is exposed so that `CipherScheduler` can inject it for push notifications

#### Send-text-first voice UX

Voice replies use a perceived-latency pattern: the text answer is delivered immediately via `bot.sendMessage(chatId, replyText)` before TTS synthesis begins. This gives the user an instant readable response even when the voice engine is cold-starting.

The flow:

1. Send text reply immediately.
2. Check `globalThis.__voiceManager?.isRunning`. If `false`, emit *"🎙️ Waking up voice engine, audio reply coming in a few seconds…"* — this only fires on genuine cold-starts, not on warm runs.
3. Synthesize audio via `AIEngine.textToSpeech`. The manager lazy-wakes the Python service if needed.
4. Send the resulting voice note.
5. If TTS fails, soft-fail: append `_(voice synthesis failed: <reason>)_` to the text message. The user still has the written answer.

### 16.2 Discord Adapter — `src/adapters/discord.js`

- Uses `discord.js` v14
- Listens with `GatewayIntentBits`: `Guilds`, `GuildMessages`, `DirectMessages`, `MessageContent`
- Responds to **DMs** and **@mentions** in servers
- Strips mention tags (`<@12345>`) from message text before sending to AI
- Handles Discord's **2000 character limit** by splitting long responses at natural newline/word boundaries via `_splitMessage()`
- Shows `sendTyping()` while processing

### 16.3 Slack Adapter — `src/adapters/slack.js`

- Uses `@slack/bolt` in **Socket Mode** (requires both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`)
- Listens to DMs via `app.message()`
- Listens to `@mentions` in channels via `app.event('app_mention')`
- Thread-aware: replies in-thread if the message came from a thread
- Strips mention tags (`<@ABCDEF>`) before sending to AI

### 16.4 WhatsApp Adapter — `src/adapters/whatsapp.js`

- Uses `whatsapp-web.js` with **Local Auth** (session saved to `./data/whatsapp-session`)
- On first run: displays QR code in the terminal using `qrcode-terminal`
- Ignores group messages by default (configurable via `WHATSAPP_RESPOND_GROUPS=true`)
- In groups, only responds when "nexus" is in the message body
- Ignores `status@broadcast`
- Shows **typing state** (`chat.sendStateTyping()`) while processing, clears it after responding
- Session persists between restarts (no QR re-scan needed)

### 16.5 iMessage Adapter — `src/adapters/imessage.js`

**macOS only.** Requires Full Disk Access granted to Terminal.

- Directly reads Apple's `~/Library/Messages/chat.db` SQLite database
- **Polling** every 3 seconds (configurable via `IMESSAGE_POLL_INTERVAL`)
- Tracks `lastMessageTime` using Apple Core Data epoch offset (`978307200000000000` = Jan 1, 2001)
- Keeps a `processedMessages` Set of already-handled message ROWIDs to prevent double-processing
- Set is trimmed to 500 entries when it exceeds 1000 to prevent memory leak
- Sends replies via AppleScript: `tell application "Messages" ... send "..." to targetBuddy`
- Queries only messages that are `is_from_me = 0` (received, not sent) and have non-empty text

### 16.6 Voice Adapter — `src/adapters/voice.js`

- Thin wrapper over `AIEngine.transcribeAudio()` and `AIEngine.textToSpeech()`, which in turn call the **local** Python microservice at `http://127.0.0.1:8808` (Faster-Whisper + VoxCPM2)
- `transcribe(buffer, mimeType)` — determines file extension from MIME type (`webm`, `wav`, `mp4`, `m4a`, `ogg`) and POSTs multipart to `/transcribe`
- `synthesize(text, options)` — POSTs to `/generate`; passes `reference_wav_path` through for voice-cloning when configured
- Returns `{ audio: Buffer, success: true }` or `{ success: false, error }`
- Exposed via REST API (`/api/voice/transcribe`, `/api/voice/synthesize`)
- No network egress — all model inference runs on-device

---

## 17. Configuration Files

### `config/cipher-portal.json`
Defines everything Cipher needs to navigate the portal:
```json
{
  "portalUrl": "https://pilot.wright.edu",
  "loginPage": "/d2l/login",
  "dashboardPage": "/d2l/home",
  "loginSelectors": {
    "usernameInput": "#username",
    "passwordInput": "#password",
    "submitButton": "#signOnButton",
    "loginErrorIndicator": "invalid"
  },
  "sso": {
    "enabled": true,
    "redirectDomain": "auth.wright.edu"
  },
  "navigation": {
    "maxRetries": 3,
    "retryBaseDelayMs": 2000,
    "pageLoadDelayMs": 4000,
    "actionDelayMs": 2000
  },
  "submissionSelectors": {
    "confirmationText": "submitted successfully"
  }
}
```

### `config/cipher-submissions.json`
Auto-submission mappings (optional):
```json
{
  "defaults": {
    "submitMinutesBeforeDeadline": 60
  },
  "submissions": [
    {
      "enabled": false,
      "coursePattern": "",
      "assignmentPattern": "",
      "filePath": ""
    }
  ]
}
```

### `config/default.json`
General default configuration fallback.

---

## 18. Database Schema

### Chat Tables

```sql
conversations (
  id TEXT PRIMARY KEY,              -- UUID
  title TEXT,                       -- "New Conversation" or AI-generated
  platform TEXT,                    -- web / telegram / discord / slack / whatsapp / imessage
  platform_user_id TEXT,
  created_at, updated_at DATETIME,
  is_archived INTEGER DEFAULT 0,
  metadata TEXT DEFAULT '{}'        -- extensible JSON
)

messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT → conversations(id),
  role TEXT CHECK(role IN ('user','assistant','system')),
  content TEXT,
  platform TEXT,
  tokens_used INTEGER DEFAULT 0,
  created_at DATETIME
)

platform_sessions (
  id TEXT PRIMARY KEY,
  platform TEXT,
  platform_user_id TEXT,
  conversation_id TEXT → conversations(id),
  display_name TEXT,
  last_active DATETIME,
  metadata TEXT,
  UNIQUE(platform, platform_user_id)  -- one session per user per platform
)
```

### Long-Term Memory Table

```sql
core_memory (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  embedding BLOB NOT NULL,            -- Float32Array raw bytes
  source TEXT,                         -- 'save_core_memory' / 'auto'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used DATETIME
)
```

### God Mode Audit Table

```sql
god_mode_audit (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,                  -- 'edit_source_file' / 'git_commit_and_push' / ...
  event_type TEXT NOT NULL,            -- 'invoke' / 'approved' / 'denied' / 'error'
  args_digest TEXT,                    -- SHA-256 of canonical JSON arguments
  result_summary TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

### Cipher Tables

```sql
cipher_assignments (
  id TEXT PRIMARY KEY,
  course_id TEXT,
  course_name TEXT,
  title TEXT,
  description TEXT,
  due_date DATETIME,
  dropbox_url TEXT,
  status TEXT DEFAULT 'pending',     -- pending / notified / overdue / submitted / confirmed
  last_checked DATETIME,
  submitted_at DATETIME,
  submission_file TEXT,
  completion_status TEXT,            -- "Not Submitted" / "1 Submission, 1 File"
  score TEXT,                        -- "- / 10" or "8 / 10 - 80%"
  evaluation_status TEXT,            -- "Feedback: Unread" / "Feedback: Read"
  created_at DATETIME
)

cipher_submissions (
  id TEXT PRIMARY KEY,
  assignment_id TEXT → cipher_assignments(id),
  file_path TEXT,
  scheduled_at DATETIME,
  executed_at DATETIME,
  status TEXT DEFAULT 'queued',      -- queued / confirmed / submitted / failed
  error_message TEXT
)

cipher_audit_log (
  id TEXT PRIMARY KEY,
  event_type TEXT,                   -- state_transition / login / extraction / scan_* / audit_* / notify / submit / ...
  details TEXT,                      -- JSON string with event details
  created_at DATETIME
)
```

### Indexes:
```sql
idx_messages_conversation    ON messages(conversation_id)
idx_messages_created         ON messages(created_at)
idx_conversations_platform   ON conversations(platform)
idx_platform_sessions        ON platform_sessions(platform, platform_user_id)
idx_cipher_assignments_due   ON cipher_assignments(due_date)
idx_cipher_assignments_status ON cipher_assignments(status)
idx_cipher_submissions_status ON cipher_submissions(status)
idx_cipher_audit_created     ON cipher_audit_log(created_at)
```

---

## 19. Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AI_PROVIDER` | — | auto | `openai`, `anthropic`, `gemini`, or `nvidia`. Auto-detected from `AI_MODEL` if omitted |
| `AI_MODEL` | — | `gpt-4o-mini` | Model name for the chosen provider (e.g. `claude-3-5-sonnet-latest`, `gemini-2.5-pro`, `meta/llama-3.1-70b-instruct`) |
| `OPENAI_API_KEY` | * | — | OpenAI API key (also used for embeddings fallback) |
| `ANTHROPIC_API_KEY` | * | — | Anthropic Claude API key |
| `GEMINI_API_KEY` | * | — | Google Gemini API key |
| `NVIDIA_API_KEY` | * | — | NVIDIA NIM API key |
| `PORT` | — | `3000` | Web dashboard port |
| `SYSTEM_PROMPT` | — | Default prompt | Custom AI personality/instructions |
| `TELEGRAM_ENABLED` | — | `false` | Enable Telegram bot |
| `TELEGRAM_BOT_TOKEN` | — | — | Token from BotFather |
| `DISCORD_ENABLED` | — | `false` | Enable Discord bot |
| `DISCORD_BOT_TOKEN` | — | — | Discord bot token |
| `SLACK_ENABLED` | — | `false` | Enable Slack adapter |
| `SLACK_BOT_TOKEN` | — | — | Slack bot OAuth token |
| `SLACK_APP_TOKEN` | — | — | Slack app-level token (Socket Mode) |
| `WHATSAPP_ENABLED` | — | `false` | Enable WhatsApp |
| `IMESSAGE_ENABLED` | — | `false` | Enable iMessage (macOS only) |
| **Voice microservice** | | | |
| `VOICE_ENABLED` | — | `true` | Set to `false` to skip spawning the Python voice service entirely |
| `VOICE_PORT` | — | `8808` | Port the FastAPI service binds on `127.0.0.1` |
| `VOICE_IDLE_MS` | — | `120000` | Milliseconds of inactivity before the voice process auto-sleeps |
| `WHISPER_MODEL` | — | `base.en` | Faster-Whisper model ID |
| `WHISPER_DEVICE` | — | `cpu` | `cpu`, `cuda`, or `mps` |
| `WHISPER_COMPUTE_TYPE` | — | `int8` | CPU sweet spot; use `float16` on GPU |
| `WHISPER_BEAM_SIZE` | — | `1` | 5 for higher accuracy at CPU cost |
| `VOXCPM_MODEL` | — | `openbmb/VoxCPM2` | HuggingFace model ID for TTS |
| `VOXCPM_LOAD_DENOISER` | — | `false` | Enable if reference wav is noisy |
| `PRELOAD_WHISPER` | — | `true` | Start the background preload thread on boot |
| **God Mode** | | | |
| `GOD_MODE_ENABLED` | — | `false` | Register `read_source_file`, `edit_source_file`, `git_commit_and_push`, `install_npm_package` on the AI tool schema |
| `GOD_MODE_WORKSPACE` | — | `.` | Root directory that file operations are clamped to |
| **Cipher** | | | |
| `CIPHER_ENABLED` | — | `false` | Enable academic agent |
| `CIPHER_VAULT_KEY` | * | — | 64-char hex key for credential encryption |
| `CIPHER_SCAN_INTERVAL` | — | `7200` | Seconds between portal scans |
| `CIPHER_TELEGRAM_CHAT_ID` | — | — | Your Telegram chat ID for Cipher alerts |
| `CIPHER_ALERT_THRESHOLDS` | — | `48,24,6,1` | Alert hours before deadline |
| `CIPHER_MACOS_NOTIFICATIONS` | — | `true` | Enable macOS Notification Center |
| `CIPHER_SUMMARY_HOUR` | — | `8` | Hour of day for daily summary (0-23) |
| `CIPHER_TWILIO_SID` | — | — | Twilio account SID (optional SMS) |
| `CIPHER_TWILIO_AUTH` | — | — | Twilio auth token |
| `CIPHER_TWILIO_FROM` | — | — | Twilio from number |
| `CIPHER_TWILIO_TO` | — | — | Your phone number for SMS |

*At least one AI provider key is required.

---

## 20. How Everything Connects — Data Flow Diagrams

### User Message Flow (e.g. Telegram)
```
User sends message on Telegram
        ↓
TelegramAdapter.bot.on('message')
        ↓
Shows typing indicator
        ↓
(If PDF/file) → Download → Parse text → Append to message
        ↓
ConversationManager.processMessage(text, 'telegram', userId, displayName)
        ↓
db.getOrCreateSession() → gets/creates conversationId
        ↓
db.addMessage(conversationId, 'user', text)
        ↓
db.getRecentMessages(conversationId, 20)  ← context window
        ↓
ai.chat(contextMessages)  ← includes tool definitions
        ↓
┌── AI returns text? ──────────────────┐
│                                      ↓
│ AI returns tool_calls?          Store response
│        ↓                        in DB → return
│ toolExecutor.execute(call)
│        ↓
│ Append result to contextMessages
│        ↓
│ ai.chat(contextMessages) again ←───┘
│        ↓ (loop ends when no tool_calls)
└──────────────────────────────────────
        ↓
db.addMessage(conversationId, 'assistant', content)
        ↓
Return { content, conversationId }
        ↓
bot.sendMessage(chatId, response.content)
```

### Cipher Background Scan Flow
```
CipherScheduler.start()
        ↓
[Every 2 hours] runScan()
        ↓
navigator.login()
  → Navigate to portal
  → Handle SSO (PingFederate)
  → Fill credentials from CipherVault
  → Wait for Duo 2FA
        ↓
navigator.extractAssignments()
  → Navigate dashboard
  → Find course links
  → For each course:
      Click Assessments → Dropbox
      Scrape table rows
      Parse title, due date, score, completion
        ↓
For each assignment:
  db.upsertAssignment(assignment)
        ↓
submitter.matchAndQueue(assignments)
  → Check cipher-submissions.json mappings
  → Auto-queue matched assignments
        ↓
auditDeadlines()
  → Get pending from DB
  → Compare hours-left vs thresholds
  → notifier.sendAlert()
      → Telegram message
      → macOS notification
      → Twilio SMS (if HIGH/CRITICAL)
        ↓
navigator.shutdown()  ← always closes browser
```

### Tool Call Loop (detailed)
```
ai.chat(messages)
    ↓
Response has tool_calls: [{ id, function: { name, arguments } }]
    ↓
For each tool call:
    toolExecutor.execute({ name, arguments })
        ↓
        switch(name):
          cipher_list_assignments:
            → cipherScheduler.getAssignmentStatus()
            → returns JSON of all assignments

          browser_navigate:
            → POST /profiles (PinchTab)
            → POST /instances/start
            → POST /tabs/open?url=...
            → returns "Navigated to X"

          browser_snapshot:
            → GET /tabs/:id/snapshot?filter=interactive
            → returns accessibility tree with ref IDs

          browser_action:
            → POST /tabs/:id/action { kind, ref, value }
            → returns "success"
    ↓
Append { role: 'tool', content: resultJSON } to messages
    ↓
ai.chat(messages) again
    ↓
... repeat until no tool_calls
```

---

## 21. PM2 Process Management

**File:** `ecosystem.config.cjs`

| Setting | Value |
|---------|-------|
| App name | `nexus-ai` |
| Script | `src/index.js` |
| Node args | `--experimental-vm-modules` |
| Auto-restart | Yes |
| Max restarts | 10 |
| Restart delay | 5 seconds |
| Max memory | 500 MB |
| Error log | `./logs/error.log` |
| Output log | `./logs/output.log` |

### Common PM2 Commands:
```bash
pm2 start ecosystem.config.cjs   # Start
pm2 stop nexus-ai                 # Stop
pm2 restart nexus-ai              # Restart
pm2 logs nexus-ai                 # Tail logs
pm2 monit                         # Live dashboard
pm2 startup && pm2 save           # Auto-start on boot
```

---

## 22. Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **SQLite instead of a cloud DB** | All data stays local; zero infrastructure; fast synchronous reads via `better-sqlite3` |
| **AES-256-GCM for credentials** | Authenticated encryption prevents tampered vault from being decrypted; unique salt + IV per encryption prevents replay |
| **Single tool loop (not parallel)** | Tools often depend on each other (navigate → snapshot → action); sequential execution is safer |
| **Exponential backoff on login retries** | Portal may temporarily block rapid retries; backoff reduces detection + rate limiting |
| **Defer Cipher start by 10s** | Telegram adapter needs time to authenticate and expose its bot instance for Cipher to inject |
| **WAL mode on SQLite** | Allows concurrent reads + writes without blocking; important since background monitor and main server run simultaneously |
| **PinchTab-based browser tools** | Allows AI to use a persistent browsing session without spawning a new process per query; avoids the overhead of Playwright for quick page reads |
| **Separate Playwright browser for Cipher** | Cipher's portal scraping is separate from AI tool browsing; Cipher needs a persistent logged-in session |
| **Deduplication cooldown in Notifier** | Prevents alert spam when the scheduler runs every 2 hours but thresholds might trigger repeatedly |
| **Per-platform session tracking** | Each platform user gets their own conversation history, so Telegram history is separate from Discord history |
| **Graceful shutdown handlers** | SIGINT/SIGTERM stop adapters, Cipher, the voice manager, and close DB before exit — prevents corrupt WAL files and orphaned Python processes |
| **Supervised Python voice service** | Avoids forcing users into a second terminal; idle-sleep reclaims model RAM; lazy-wake keeps the first cold-start cheap; `python3`/`python`/`py` fallback makes the boot path portable across OSes |
| **Port bound before models** | Uvicorn binds `127.0.0.1:8808` on the first event-loop tick; heavy model construction happens on a daemon thread so `/health` answers immediately and the Node manager never times out on cold start |
| **Self-healing on fetch failure** | A single failed `/transcribe` or `/generate` tears down the Python child; the next voice request respawns it. This eliminates the "same error forever" failure mode when VoxCPM2 crashes mid-session |
| **Send-text-first voice UX** | The text reply is sent before TTS synthesis begins, so the user has an instant readable answer even when the voice engine is cold-starting |
| **Atomic file edits in God Mode** | `edit_source_file` writes to a `.tmp-<pid>-<ts>` sibling then renames; a crashed edit never leaves a half-written source file |
| **HITL on `npm install`** | Arbitrary package installs are the highest-impact God Mode tool; gating on explicit `yes` / `no` (with ambiguous replies re-prompted) prevents silent supply-chain incidents |
| **Provider-agnostic tool translator** | Tool schemas and call shapes differ across OpenAI, Anthropic, Gemini, and NVIDIA. Centralizing translation in `getToolsSchema(provider)` + the engine's message normalizer keeps `ToolExecutor` and the conversation loop identical regardless of backend |
| **Embeddings via the active provider** | Memories use the same vendor that's handling chat, so RAG and generation share a key and don't require a second credential surface |

---

## 23. Setup Wizard — `src/wizard.js`

**File:** `src/wizard.js`  
**Run with:** `npm run setup`  
**Role:** Interactive CLI wizard that guides you through full first-time configuration and writes the `.env` file.

### Libraries:
- **inquirer** — interactive CLI prompts (list, password, checkbox, confirm, input, editor)
- **chalk** — colored terminal output
- **ora** — animated spinners for async operations (e.g. "Validating OpenAI key...")

### Wizard Flow (6 steps):

#### Step 1 — AI Provider
- Choose from: OpenAI, Google Gemini, NVIDIA NIM, or All
- For each chosen provider, prompts for the API key (masked input)
- Validates the key **live** before accepting it:
  - OpenAI: calls `client.models.list()`
  - Gemini: calls `model.generateContent('Hi')` — accepts the key even on 429 (quota error) to avoid blocking setup
  - NVIDIA: calls `client.models.list()` via NIM endpoint
- Shows an animated spinner during validation
- After valid keys are collected, presents a model selection list filtered to only show models for the providers you configured (e.g. if only Gemini key given, only Gemini models shown)

#### Step 2 — Chat Platforms (checkbox multi-select)
- Telegram, Discord, Slack, WhatsApp, iMessage (all off by default for fresh install)
- Pre-checks any that were already enabled in an existing `.env`

#### Step 3 — Platform Credentials
For each selected platform, collects required tokens:
- **Telegram**: Bot Token (masked password input)
- **Discord**: Bot Token (masked)
- **Slack**: Bot Token (`xoxb-...`) + App Token (`xapp-...`) for Socket Mode
- **WhatsApp**: No credentials needed — QR scan happens at runtime
- **iMessage**: No credentials needed — checks macOS platform, gives Full Disk Access instructions

#### Step 4 — Voice Settings
- Only shown if OpenAI key is configured (Whisper + TTS require it)
- Confirm/deny voice enable
- Voice character selection: Alloy, Echo, Fable, Onyx, Nova, Shimmer

#### Step 5 — Cipher Academic Agent
This is the most detailed section:

1. **Enable/disable Cipher**
2. **Portal platform selection**: D2L Brightspace, Canvas LMS, Blackboard, or Custom
3. **Portal URL** input (must start with `https://`)
4. **Platform presets**: Each LMS (D2L, Canvas, Blackboard) has a built-in preset containing login page, dashboard page, all CSS selectors for login fields, course navigation, assignment lists, file inputs, and submit buttons. These presets are baked into the wizard and written to `config/cipher-portal.json`
5. **SSO redirect domain** — optional prompt for advanced users who know their SSO URL
6. **Custom selectors** — if "Custom / Other" was selected, prompts for each selector individually
7. **Portal credentials** — username and password (masked)
   - Auto-generates a 32-byte vault key if not already configured
   - Immediately encrypts credentials via `CipherVault.storeCredentials()` and verifies the round-trip
8. **Notification settings**:
   - Telegram Chat ID for alerts
   - Scan interval (minimum 300 seconds = 5 minutes)
   - Alert thresholds (hours before deadline)
   - Daily summary hour (0-23)

#### Step 6 — Personality (System Prompt)
- Optional: opens a text editor (`process.env.EDITOR`) to customize the AI system prompt
- Default prompt instructs the AI to use browser tools to check the portal and news autonomously

#### Step 7 — Port
- Dashboard port selection (default 3000)

#### .env File Generation
After all prompts complete, assembles all values into a formatted `.env` file and writes it with `writeFileSync`. Uses the existing `.env` as defaults — re-running the wizard is non-destructive for values you don't change.

#### Summary Output
Prints a colorized summary showing:
- Configured provider + model
- Dashboard URL
- API key status for each provider (● / ○)
- Platform enable status
- Cipher status + portal URL + alert configuration
- Next steps to run the app

---

## 24. Web Dashboard — `public/`

### HTML — `public/index.html`

The dashboard is a single-page app. The layout:
- **Sidebar** (left): Logo, New Chat button, conversation list (scrollable), connected platform status dots, footer settings/stats buttons
- **Main area** (right): Top bar with title + model badge + clear button, welcome screen (shown when no chat is active), messages area, input area (textarea + voice button + send button)
- **Settings Modal**: overlay with AI model selector (currently display-only) and stats grid (conversations, messages, tokens, uptime)

### JavaScript — `public/js/app.js`

Pure vanilla JavaScript, no framework.

#### State Variables:
| Variable | Description |
|----------|-------------|
| `ws` | Active WebSocket connection |
| `currentConversationId` | UUID of selected conversation |
| `isStreaming` | Prevents sending while AI is responding |
| `isRecording` | Voice recording state |
| `mediaRecorder` | MediaRecorder API instance |
| `audioChunks` | Accumulated audio Blob chunks |
| `conversations` | Cached list from `/api/conversations` |

#### Initialization (DOMContentLoaded):
1. `connectWebSocket()` — connect to `/ws`
2. `loadConversations()` — fetch and render conversation list
3. `fetchPlatformStatus()` — poll `/api/status` every 30 seconds for live dots
4. Auto-resize textarea listener on input

#### WebSocket Client:
Handles all server push events: `conversation_created`, `chunk` (streaming token), `done`, `title_updated`, `error`. Auto-reconnects after 3 seconds on disconnect.

#### Streaming Chat Flow:
1. User presses Enter or clicks send → `sendMessage()`
2. Appends user message to DOM immediately
3. Shows typing indicator (3 animated dots)
4. Sends WebSocket message → server streams back chunks
5. `appendStreamChunk()` — accumulates raw text in `data-raw-text` attribute, re-renders formatted HTML on every chunk
6. `finishStream()` — removes typing ID from element, marks finished

#### Voice Recording:
- `startRecording()`: requests mic via `navigator.mediaDevices.getUserMedia`, creates `MediaRecorder`, records to `audioChunks`
- `stopRecording()`: stops recorder, triggers `onstop` → creates Blob → calls `transcribeAudio()`
- `transcribeAudio()`: POSTs audio as FormData to `/api/voice/transcribe` → puts transcribed text into input → auto-sends
- `speakResponse(text)`: POSTs to `/api/voice/synthesize` → receives MP3 Blob → creates `Audio` object → plays

#### Markdown Renderer (`formatMarkdown`):
Simple inline markdown renderer that handles: fenced code blocks, inline code, bold (`**...**`), italic (`*...*`), links (`[...](...)`) and line breaks/paragraphs. Applies `escapeHtml()` first to prevent XSS.

#### Conversation Management:
- `loadConversations()` — fetches list, renders items in sidebar with platform icon, truncated title, relative time, delete button
- `loadConversation(id)` — fetches messages, renders them, updates top bar title
- `newChat()` — resets state, shows welcome screen
- `deleteConversation(id)` — DELETE API call, resets UI if it was the active one
- `updateConversationTitle()` — live update after `title_updated` WebSocket event

#### Formatters:
| Function | Purpose |
|----------|---------|
| `formatTime(dateStr)` | Relative time: "now", "5m", "3h", "2d", "Apr 14" |
| `formatNumber(num)` | Compact numbers: "1.2K", "3.4M" |
| `formatUptime(seconds)` | "2h 14m" or "3d 5h" |
| `getPlatformIcon(platform)` | Maps platform name → emoji |
| `getModelDisplayName(model)` | Maps model ID → human name |

#### CSS — `public/css/styles.css`
23KB of dark-mode-first styling. Includes:
- CSS custom properties (variables) for the color system
- Glassmorphism sidebar with blur backdrop
- Animated typing indicator (3 bouncing dots)
- Message bubble layout (user right, assistant left with ✦ avatar)
- Responsive mobile layout with hamburger menu + overlay sidebar
- Smooth transitions on all interactive elements
- Platform status dots with green/grey glow effect

---

## 25. npm Scripts Reference

| Script | Command | What it runs |
|--------|---------|--------------|
| `npm start` | `node src/index.js` | Production start |
| `npm run dev` | `node --watch src/index.js` | Dev mode with auto-restart on file change |
| `npm run setup` | `node src/wizard.js` | Interactive setup wizard |
| `npm run wizard` | `node src/wizard.js` | Same as setup |
| `npm run cipher` | `node src/cipher-cli.js` | Cipher CLI (requires subcommand) |
| `npm run cipher:keygen` | `node src/cipher-cli.js generate-key` | Generate new vault key |
| `npm run cipher:scan` | `node src/cipher-cli.js scan-now` | Immediate portal scan |
| `npm run cipher:list` | `node src/cipher-cli.js list-assignments` | List all assignments from DB |

---

*This guide was generated from a full reading of the Nexus AI codebase and is kept in sync with each major feature change. Covered: `src/index.js`, `src/server.js`, `src/wizard.js`, `src/cipher-cli.js`, all core modules (`ai-engine.js`, `conversation-manager.js`, `database.js`, `tools.js`, `memory.js`, `background-monitor.js`, `voice-process-manager.js`, `cipher-*`), all six platform adapters, the Python voice microservice (`services/tts/server.py`), the web dashboard frontend, and every configuration file.*

# 🧠 Nexus AI — Complete Codebase Guide

> **A private, local, always-on AI assistant with an autonomous academic automation agent (Cipher)**

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
- Supports **three AI providers**: OpenAI, Google Gemini, and NVIDIA NIM
- Has an embedded **tool-calling loop** — the AI can use "tools" to fetch time, browse the web, check your course portal, etc.
- Has a sub-agent called **Cipher** — a Playwright-based academic automation agent that logs into your university portal (Wright State's D2L Brightspace), extracts course assignments, grades, and deadlines, and notifies you proactively

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
│   │   ├── ai-engine.js          ← multi-provider AI calls (OpenAI, Gemini, NVIDIA)
│   │   ├── conversation-manager.js ← per-user session + tool loop
│   │   ├── database.js           ← SQLite wrapper (chats + Cipher tables)
│   │   ├── tools.js              ← AI tool definitions + execution
│   │   ├── background-monitor.js ← periodic autonomous AI checks
│   │   ├── cipher-vault.js       ← AES-256-GCM credential encryption
│   │   ├── portal-navigator.js   ← Playwright browser automation (SSO + scraping)
│   │   ├── cipher-scheduler.js   ← orchestrates all Cipher jobs
│   │   ├── cipher-submitter.js   ← automated file upload to portal
│   │   └── cipher-notifier.js    ← multi-channel alert dispatcher
│   └── adapters/
│       ├── telegram.js           ← Telegram integration (primary UI)
│       ├── discord.js            ← Discord bot
│       ├── slack.js              ← Slack Socket Mode
│       ├── whatsapp.js           ← WhatsApp Web (QR-based)
│       ├── imessage.js           ← macOS iMessage via AppleScript polling
│       └── voice.js              ← OpenAI Whisper STT + TTS
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
2. **Validates setup** — checks that at least one AI provider key exists (`OPENAI_API_KEY`, `GEMINI_API_KEY`, or `NVIDIA_API_KEY`). If none are set, it exits with a helpful message.
3. **Creates `AIEngine`** — initializes the AI backend with the configured provider and model.
4. **Creates `NexusDatabase`** — opens (or creates) the SQLite database at `./data/nexus.db`.
5. **Creates `ConversationManager`** — links the AI engine + database. Context window defaults to 20 messages.
6. **Starts `BackgroundMonitor`** — async import, runs an autonomous AI check every 15 minutes.
7. **Starts `CipherScheduler` (if `CIPHER_ENABLED=true`)** — initializes the academic agent. It defers actual start by 10 seconds to allow the Telegram adapter to connect first (so the Telegram Bot instance can be injected for notifications).
8. **Initializes `VoiceAdapter`** — sets up Whisper STT + TTS if enabled.
9. **Starts all platform adapters** sequentially — Telegram, Discord, Slack, WhatsApp, iMessage. Each returns `true/false` based on whether it connected successfully.
10. **Starts the Express + WebSocket server** on the configured `PORT` (default 3000).
11. **Prints the startup banner** — lists the provider, model name, and which platforms are active.
12. **Registers graceful shutdown handlers** — listens for `SIGINT` and `SIGTERM`. On shutdown, it stops all adapters, stops Cipher, closes the web server, and closes the database cleanly.

### Key design point:
The Cipher scheduler's Telegram bot injection happens inside a `setTimeout(() => ..., 10000)` — it waits 10 seconds after app start so Telegram has time to authenticate and expose its `.bot` instance.

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
**Role:** Unified interface to three different AI providers.

### Class: `AIEngine` (extends `EventEmitter`)

#### Constructor config:
- `model` — e.g. `gpt-4o-mini`, `gemini-2.5-pro`, `meta/llama-3.1-70b-instruct`
- `provider` — `openai`, `gemini`, or `nvidia`
- `systemPrompt` — injected at the start of every conversation
- `maxTokens` — default 4096
- `temperature` — default 0.7

#### Provider Detection:
```js
function detectProvider(model) {
  if (model.startsWith('gemini')) return 'gemini';
  if (model.includes('/')) return 'nvidia';      // e.g. "meta/llama-3.1-70b"
  return 'openai';
}
```

#### `initialize()`
- Creates `openaiClient` (OpenAI SDK) if `OPENAI_API_KEY` is set
- Creates `geminiClient` and `geminiModel` (Google GenAI SDK) if `GEMINI_API_KEY` is set
- Creates `nvidiaClient` — actually an OpenAI SDK instance but pointing to `https://integrate.api.nvidia.com/v1` (NVIDIA NIM uses the OpenAI-compatible API format)
- Validates that the chosen provider has its key configured

#### `chat(messages, options)` — Non-streaming
- Delegates to `_geminiChat()` or `_openaiChat()` based on detected provider
- Always prepends the system prompt as the first message
- Includes all registered tools in the request (`getToolsSchema('openai')` or `'gemini'`)
- Returns: `{ content, tool_calls, model, provider, usage: { promptTokens, completionTokens, totalTokens } }`

#### `chatStream(messages, onChunk, options)` — Streaming
- Same flow but uses streaming APIs
- For OpenAI/NVIDIA: uses `stream: true` in the create call, assembles tokens + tool_calls from delta chunks
- For Gemini: uses `sendMessageStream()`, collects text chunks via `for await`
- Calls `onChunk(delta, fullString)` on every token for real-time display

#### Gemini Format Translation
Gemini uses a different message format than OpenAI. The AI engine translates:
- `role: 'tool'` → `role: 'function'` with `functionResponse`
- `role: 'assistant'` with `tool_calls` → `role: 'model'` with `functionCall` parts
- Tool call schemas are reformatted from OpenAI's `{ type, function: { name, ... } }` to Gemini's `{ name, description, parameters }`

#### Voice Methods (always use OpenAI):
- `transcribeAudio(buffer, filename)` → calls `whisper-1` model, returns text string
- `textToSpeech(text, options)` → calls `tts-1` model with specified voice, returns MP3 buffer

#### Validation Methods:
- `validateOpenAIKey(apiKey)` — test calls `models.list()`
- `validateGeminiKey(apiKey)` — test calls `model.generateContent('Hello')`
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

| Tool Name | Description |
|-----------|-------------|
| `get_current_time_and_date` | Returns current local time, date, and timezone |
| `send_urgent_notification` | Pushes an alert (logged in console; can be extended to send via Telegram) |
| `browser_navigate` | Opens a URL in a headless Chrome via the **PinchTab** local daemon |
| `browser_snapshot` | Returns the accessibility tree (interactive element refs) from the open tab |
| `browser_action` | Clicks or fills an element using its `ref` ID from a snapshot |
| `browser_extract_text` | Extracts the full readable text from the current tab |
| `cipher_scan_portal` | Triggers an immediate Cipher portal scan |
| `cipher_list_assignments` | Returns all assignments (upcoming + past) with scores |
| `cipher_schedule_submission` | Queues a file for automatic submission at a specific time |

### How the Browser Tools Work:

The browser tools connect to a **PinchTab** daemon running on `http://localhost:9867`. PinchTab is a local browser control service. The tool executor:
1. Creates a profile via `POST /profiles`
2. Starts a headless instance via `POST /instances/start`
3. Opens a tab via `POST /instances/:id/tabs/open`
4. Takes snapshots, performs actions, and extracts text through that tab

The `profileId`, `instanceId`, and `tabId` are stored as instance variables on the `ToolExecutor`, persisting across tool calls within the same session.

### Schema Formats:
- For **OpenAI/NVIDIA**: schemas use `{ type: 'function', function: { name, description, parameters } }`
- For **Gemini**: schemas are flattened to `{ name, description, parameters }` — the `getToolsSchema('gemini')` function handles this translation
- The `ToolExecutor` parses JSON arguments before dispatching, handling both string-encoded and object-encoded argument formats

### `ToolExecutor` class:
All tool execution is handled by a single `execute(call)` method that dispatches to private methods based on `call.name`. Any error thrown inside a tool is caught and returned as `{ error: "..." }` JSON — the AI receives this and handles it gracefully.

---

## 9. Core: Background Monitor — `src/core/background-monitor.js`

**File:** `src/core/background-monitor.js`  
**Role:** Autonomous periodic AI agent that checks news/portal without user input.

### Behavior:
- Runs every **15 minutes** by default
- Sends a special system prompt to the AI through the `ConversationManager`, pretending to be the "system" user
- The prompt instructs the AI to use `browser_navigate` + `browser_extract_text` to visit the college portal or read tech news headlines
- If something critical is found, the AI calls `send_urgent_notification`
- Uses a dedicated session with `platform = 'system'` and `platformUserId = 'background-worker'` so it doesn't mix with user conversations

This is what makes Nexus AI **proactive** — it doesn't wait for you to ask; it checks things automatically.

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

- Wraps `AIEngine.transcribeAudio()` and `AIEngine.textToSpeech()`
- `transcribe(buffer, mimeType)` — determines file extension from MIME type (`webm`, `wav`, `mp4`) and calls Whisper
- `synthesize(text, options)` — calls TTS with configured voice and model
- Returns `{ audio: Buffer, success: true }` or `{ success: false, error }`
- Exposed via REST API (`/api/voice/transcribe`, `/api/voice/synthesize`)

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
| `AI_PROVIDER` | ✓ | `openai` | `openai`, `gemini`, or `nvidia` |
| `OPENAI_API_KEY` | * | — | OpenAI API key |
| `GEMINI_API_KEY` | * | — | Google Gemini API key |
| `NVIDIA_API_KEY` | * | — | NVIDIA NIM API key |
| `AI_MODEL` | — | `gpt-4o-mini` | Model name for the chosen provider |
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
| `VOICE_ENABLED` | — | `true` | Enable voice (requires OpenAI key) |
| `VOICE_MODEL` | — | `tts-1` | OpenAI TTS model |
| `VOICE_NAME` | — | `alloy` | Voice character |
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
| **Graceful shutdown handlers** | SIGINT/SIGTERM stop adapters, Cipher, and close DB before exit — prevents corrupt WAL files and keeps Telegram from seeing "conflict" errors on next start |

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

*This guide was auto-generated by reading every source file in the Nexus AI codebase. All 20+ files were analyzed including `src/index.js`, `src/server.js`, `src/wizard.js`, `src/cipher-cli.js`, all 10 core modules, all 6 platform adapters, the web dashboard frontend, and all configuration files.*

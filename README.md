# ✦ Nexus AI

**Your Private AI Assistant — Local, Fast, Always-On.**

Nexus AI is a self-hosted personal AI assistant that runs on your own machine. It routes conversations through the AI provider of your choice (OpenAI, Anthropic Claude, Google Gemini, or NVIDIA NIM), exposes a premium web dashboard, bridges to every major chat platform you already use, speaks and listens through a fully local voice microservice, and includes **two autonomous sub-agents** — **Cipher** for academic automation and **God Mode** for self-directed research, code editing, and system operations.

Your data never leaves your computer.

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-18%2B-green)
![Python](https://img.shields.io/badge/python-3.10%2B-yellow)
![Playwright](https://img.shields.io/badge/playwright-ready-orange)

---

## ⚡ One-Line Install

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/khellon21/nexus-ai/main/install.sh | bash
```

**Windows (PowerShell):**
```powershell
powershell -c "irm https://raw.githubusercontent.com/khellon21/nexus-ai/main/install.ps1 | iex"
```

---

## Core Features

### Multi-Provider AI
Route every conversation through the backend that fits the task. Nexus speaks natively to:
- **OpenAI** (GPT-4o / GPT-4o-mini)
- **Anthropic Claude** (claude-3-5-sonnet, claude-opus, claude-haiku) — full Messages API with `tool_use` / `tool_result` translation
- **Google Gemini** (gemini-1.5, gemini-2.5)
- **NVIDIA NIM** (Qwen, Llama, and every OpenAI-compatible open-weights model on build.nvidia.com)

A single `AI_MODEL` environment variable is enough — the engine auto-detects the provider, translates tool-call schemas, and exposes streaming, non-streaming, and embeddings to every adapter.

### Fully Local Voice (STT + TTS)
A dedicated FastAPI microservice at `services/tts/server.py` serves both speech-to-text and text-to-speech **on-device**, with zero cloud round-trips:

- **Faster-Whisper** (`base.en`, `int8` quantization) for transcription
- **VoxCPM2** for neural TTS with optional voice cloning

The Node.js runtime spawns and supervises this Python service through the new `VoiceProcessManager` — it auto-starts at boot, sleeps the process after two minutes of idle to free RAM, and lazy-wakes it the instant the next voice request arrives. You never run `python` in a separate terminal.

### Long-Term Memory (Local RAG)
A built-in `save_core_memory` tool lets the AI remember facts across sessions. Memories are embedded with the configured provider's embedding model, stored in SQLite, and retrieved via cosine similarity before every chat turn — then injected into the system prompt so the assistant always has context about you, your preferences, and your ongoing projects.

### God Mode — Autonomous Agent Tools
When enabled, Nexus can research, write code, and operate its own repository without supervision:

- `search_internet` — DuckDuckGo search with an HTML fallback when the VQD token flow is rate-limited
- `read_source_file` / `edit_source_file` — sandboxed reads (512 KB cap) and atomic writes
- `create_directory` — scaffolds new folders
- `git_commit_and_push` — commits and pushes via a 60-second-timeout `git` child process
- `install_npm_package` — **gated by human-in-the-loop approval** with resilient reply parsing (ambiguous replies re-prompt instead of silently failing)

Combined with the existing browser tools (PinchTab), Nexus can open a page, read it, write the summary to disk, and commit the result in one conversation.

### Cipher — Academic Automation Agent
A Playwright-based autonomous agent that seamlessly logs into your university portal (Wright State Pilot / D2L Brightspace), handles **Duo 2FA**, and pulls your coursework, grades, submission statuses, and deadlines directly into the local SQLite database. You can ask *"What was my score on Quiz 1 in Discrete Structures?"* on Telegram anytime.

See [`Cipher.md`](./Cipher.md) for architecture, state machines, and the full tool registry.

### Everywhere You Already Chat
Deeply integrated with **Telegram** (primary UI — supports PDFs, voice notes, and send-text-first replies) with first-class adapters for **Discord**, **Slack** (Socket Mode), **WhatsApp** (QR-based), **iMessage** (macOS Full Disk Access), and a premium **web dashboard** (port `3000`).

### Always-On
Background monitor runs every 15 minutes, using `search_internet` (not hallucinated URLs) to check news or your portal proactively. Run Nexus under PM2 for 24/7 uptime.

---

## Prerequisites

- **Node.js 18+**
- **Python 3.10+** with `pip` (for the voice microservice; auto-detects `python3` → `python` → `py`)
- **An API key** from at least one provider — OpenAI, Anthropic, Google Gemini, or [NVIDIA NIM](https://build.nvidia.com)
- **Playwright browsers** — required for Cipher (`npx playwright install chromium` handles it)

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/khellon21/nexus-ai.git
cd nexus-ai
npm install
npx playwright install chromium

# 2. Install the voice microservice dependencies (once)
pip install fastapi uvicorn python-multipart faster-whisper voxcpm soundfile numpy

# 3. Configure — interactive wizard for API keys, platforms, and Cipher
npm run setup

# 4. Start everything with a single command
npm start
```

`npm start` brings up the AI engine, web dashboard, every enabled chat adapter, the Cipher scheduler, the background monitor, and the Python voice service — all in one process tree. **You do not run Python manually.**

---

## Voice Microservice Lifecycle

The voice service is owned by `src/core/voice-process-manager.js`. On boot you will see:

```
✓ VoiceProcessManager attached (port 8808, idle 120s)
```

From there the lifecycle is fully automatic:

| Phase | Behavior |
|---|---|
| **Cold start** | Spawns `python -m uvicorn services.tts.server:app` with `python3` → `python` → `py` fallback. Polls `/health` every 250 ms up to 60 s. Adapters emit *"🎙️ Waking up voice engine, audio reply coming in a few seconds…"* the first time. |
| **Warm** | Each transcribe / synthesize call calls `markActivity()` to reset the idle timer. |
| **Sleep** | After 2 minutes of inactivity, the manager sends `SIGTERM` (escalating to `SIGKILL` after 5 s) and frees the model RAM. |
| **Lazy wake** | The next voice request respawns the service — transparent to the caller. |
| **Self-heal** | If a `fetch` to `/transcribe` or `/generate` fails, the manager tears down the child so the next call gets a fresh process. |
| **Diagnosis** | Missing `uvicorn` / `fastapi` / a busy port — the manager tails stderr and returns a targeted `pip install` hint instead of a bare stack trace. |

Tune the behavior via `.env`:

```env
VOICE_ENABLED=true
VOICE_PORT=8808
VOICE_IDLE_MS=120000         # 2 min idle → sleep
WHISPER_MODEL=base.en        # or small.en, distil-large-v3, etc.
WHISPER_COMPUTE_TYPE=int8    # int8 is the CPU sweet spot
VOXCPM_MODEL=openbmb/VoxCPM2
VOXCPM_LOAD_DENOISER=false   # set true if your mic reference is noisy
```

On the Python side, `services/tts/server.py` binds the port **immediately** and preloads Whisper on a background thread so `/health` answers on the first tick. VoxCPM2 loads lazily on the first `/generate` to keep startup cheap.

---

## Setting Up Cipher (Academic Automation)

1. **Enable in `.env`:**
   ```env
   CIPHER_ENABLED=true
   ```

2. **Store credentials securely** (AES-256-GCM, encrypted at rest):
   ```bash
   node src/cipher-cli.js set-credentials
   ```

3. **Run a manual scan** to verify the portal flow:
   ```bash
   node src/cipher-cli.js scan-now
   ```
   Approve Duo 2FA on your phone when prompted — Cipher detects the approval and continues automatically.

4. **Ask the AI.** Once the database is synced:
   > *"What assignments do I have due this week?"*
   > *"What was my score on Homework 2?"*
   > *"Queue hw3.pdf for submission tomorrow at 9 AM."*

---

## Telegram Integration (Primary UI)

1. Message [@BotFather](https://t.me/botfather) on Telegram.
2. Send `/newbot` and follow the prompts to obtain a Bot Token.
3. Paste it into the wizard or set `TELEGRAM_BOT_TOKEN` in `.env`.
4. Chat with your bot. Voice notes are transcribed locally; replies are sent as **text first**, then as synthesized audio — so you get an instant answer even when the voice engine is cold-starting.

---

## Enabling God Mode

God Mode tools (file editing, git, npm install) are registered on the AI tool schema whenever `GOD_MODE_ENABLED=true`. When the AI proposes an `install_npm_package` call, the approval handler sends a prompt over your primary adapter and waits for an explicit *yes* / *no*. Ambiguous replies trigger a re-prompt rather than defaulting either way.

```env
GOD_MODE_ENABLED=true
GOD_MODE_WORKSPACE=.         # root that read/edit_source_file is clamped to
```

---

## Running in the Background (PM2)

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 monit
pm2 logs nexus-ai
pm2 startup && pm2 save       # auto-start on reboot
```

PM2 will also restart the Node process if the voice manager or any adapter crashes — up to 10 times with a 5-second cooldown, bounded at 500 MB RSS.

---

## System Architecture

```
nexus-ai/
├── src/
│   ├── index.js                     # Entry point — boots AI, DB, adapters, voice, Cipher
│   ├── server.js                    # Express REST + WebSocket dashboard server
│   ├── wizard.js                    # Interactive setup wizard
│   ├── cipher-cli.js                # Cipher CLI (keygen, set-credentials, scan-now, …)
│   ├── core/
│   │   ├── ai-engine.js             # Unified OpenAI / Anthropic / Gemini / NVIDIA client
│   │   ├── conversation-manager.js  # Per-user session + agentic tool loop
│   │   ├── database.js              # SQLite (chats, Cipher, memory embeddings)
│   │   ├── tools.js                 # Tool registry (browser, search, memory, God Mode, Cipher)
│   │   ├── memory.js                # Long-term memory: embed + cosine-similarity recall
│   │   ├── background-monitor.js    # Autonomous 15-minute check-in
│   │   ├── voice-process-manager.js # Python voice service lifecycle supervisor
│   │   ├── cipher-vault.js          # AES-256-GCM credential vault
│   │   ├── portal-navigator.js      # Playwright SSO + D2L scraping
│   │   ├── cipher-scheduler.js      # Orchestrator for all Cipher jobs
│   │   ├── cipher-submitter.js      # Automated dropbox file upload
│   │   └── cipher-notifier.js       # Telegram + macOS + SMS dispatcher
│   └── adapters/
│       ├── telegram.js              # Telegram bot (send-text-first voice UX)
│       ├── discord.js, slack.js,
│       ├── whatsapp.js, imessage.js
│       └── voice.js                 # Thin wrapper over AIEngine voice methods
├── services/
│   └── tts/
│       └── server.py                # FastAPI — /health, /transcribe, /generate
├── public/                          # Web dashboard (HTML/CSS/vanilla JS)
├── config/
│   ├── default.json
│   ├── cipher-portal.json           # Portal selectors + SSO redirect domain
│   └── cipher-submissions.json      # Auto-submit file→dropbox mappings
├── data/
│   ├── nexus.db                     # SQLite (chats + assignments + memory)
│   └── cipher-vault.enc             # Encrypted credentials
├── .env, .env.example
└── ecosystem.config.cjs             # PM2 configuration
```

For a full file-by-file walkthrough — data flows, schema, environment variables, and design decisions — see [`GUIDE.md`](./GUIDE.md).

---

## Troubleshooting

**"Voice service unreachable at http://localhost:8808 (fetch failed)"**
The Python service is started automatically by Nexus — do **not** launch it manually. Check the `npm start` output for lines prefixed `[voice-py]`. The most common cause is missing Python dependencies:

```bash
pip install fastapi uvicorn python-multipart faster-whisper voxcpm soundfile numpy
```

**The AI replied "I'm experiencing technical difficulties" to a search query.**
This was a `duck-duck-scrape` enum bug (fixed). If you see it on current code, the DuckDuckGo endpoint is throttling — the `search_internet` tool now falls back to the HTML endpoint automatically. No action required.

**Cipher login hangs at Duo 2FA.**
Approve the push on your phone. Cipher waits up to 60 seconds. If the browser closes before you approve, increase `pageLoadDelayMs` in `config/cipher-portal.json`.

---

## License

MIT — use it however you want. All your portal data, chat logs, voice recordings, embeddings, and grades stay on your local disk. Nothing is uploaded anywhere.

# ✦ Nexus AI with Cipher Academic Automation

**Your Private AI Assistant — Local, Fast, Always-On**

Nexus AI is a self-hosted personal AI assistant powered by NVIDIA NIM, OpenAI, and Google Gemini that connects to all your chat platforms. Think of it as your own private ChatGPT that you control, with your data never leaving your machine.

**✨ NEW: Cipher Academic Agent**  
Nexus AI now features **Cipher**, a specialized Playwright-based autonomous agent that seamlessly logs into your university portal (e.g., Wright State Pilot/D2L), handles Duo 2FA securely, and pulls your coursework, grades, submission statuses, and upcoming deadlines directly into your localized SQLite database. The AI can then natively answer chat messages like *"What is my score on Quiz 1 in Discrete Structures?"* anytime via Telegram!

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-18%2B-green)
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

## ✨ Core Features

- 🔒 **Fully Local** — All conversations stored in SQLite on your machine.
- 🧠 **Multi-Model Powered** — Use OpenAI, Gemini, or open-weights like Qwen 3 Coder 480B via NVIDIA NIM.
- 🎓 **Cipher Academic Agent** — Automatically crawls your college portal (D2L Brightspace), extracts assignments & grades, handles secure SSO + Duo 2FA, and alerts you before deadlines.
- 💬 **Multi-Platform Supported** — Integrated deeply with Telegram (and expandable to WhatsApp, Discord, Slack, iMessage).
- 🎙️ **Voice Options** — Speak to your assistant (Whisper STT + OpenAI TTS).
- 🖥️ **Premium Dashboard** — Beautiful dark-mode web UI for AI management (port `8080`).
- ⚡ **Always-On** — Continuously monitors via background jobs and PM2.

---

## 🚀 Quick Start & Setup

### Prerequisites
- **Node.js 18+**
- **API Key** — OpenAI, Google Gemini, or [NVIDIA NIM](https://build.nvidia.com)
- **Playwright browsers** — Required for Cipher (running `npx playwright install` handles this)

### Install & Initialization

```bash
# Clone or download this project
cd nexus-ai

# Install dependencies and Playwright browsers
npm install
npx playwright install chromium

# Run the setup wizard to configure the AI Provider, API keys, and Telegram integration
npm run setup

# Start Nexus AI server in development mode
npm run dev
```

---

## 🎓 Setting Up Cipher (Academic Automation)

Cipher works in the background to scrape your college portal. To enable it:

1. **Enable Cipher in `.env`**:  
   Ensure `CIPHER_ENABLED=true` in your `.env` configuration.
   
2. **Set Credentials Securely**:  
   Run the CLI to encrypt and securely store your SSO credentials:
   ```bash
   node src/cipher-cli.js set-credentials
   ```
   
3. **Trigger a Manual Scan**:  
   To test the automation immediately, run a manual scan:
   ```bash
   node src/cipher-cli.js scan-now
   ```
   *Note: During the scan, it will detect Duo 2FA. Approve the login manually on your phone, and Cipher will automatically detect the approval and continue crawling!*

4. **Ask the AI!**  
   Once the database is synced, you can go to Telegram and ask:
   > *"What assignments do I have due this week?"* or *"What was my score on Homework 2?"*

---

## 📱 Telegram Integration (Primary UI)

Telegram acts as the main conversational UI for Nexus.
1. Message [@BotFather](https://t.me/botfather) on Telegram.
2. Send `/newbot` and follow the prompts to get your Token.
3. Paste the token during the `npm run setup` wizard, or manually add it to your `.env` as `TELEGRAM_BOT_TOKEN`.
4. Chat with your bot directly! It knows exactly what tools to use for your college work natively.

---

## 🏃 Running in Background

Use **PM2** to keep Nexus AI and the Cipher agent running 24/7 so it can scrape deadlines and notify you seamlessly:

```bash
# Install PM2 globally
npm install -g pm2

# Start Nexus AI
pm2 start ecosystem.config.cjs

# Monitor
pm2 monit

# View logs
pm2 logs nexus-ai

# Auto-start on boot
pm2 startup
pm2 save
```

---

## 📁 System Architecture

```
nexus-ai/
├── src/
│   ├── index.js              # Main entry point & Web Dashboard 
│   ├── cipher-cli.js         # Command line tooling for Academic scanning
│   ├── core/
│   │   ├── ai-engine.js      # Provider Integration (Nvidia NIM, OpenAI)
│   │   ├── database.js       # Core SQLite database access
│   │   ├── tools.js          # Definitions for agentic tools (e.g., cipher_list_assignments)
│   │   ├── portal-navigator.js # Playwright DOM crawling for D2L portals
│   │   └── cipher-scheduler.js # Background polling loops and deadline logic
│   └── adapters/
│       └── telegram.js       # Telegram integration bridge
├── data/                     # SQLite database (auto-generated)
├── .vault/                   # Secure 256-bit encrypted credentials
├── config/                   
└── ecosystem.config.cjs      # PM2 layout
```

---

## 📄 License

MIT — Use it however you want. All your portal data, chat logs, and grades physically never leave your local machine SQLite database.

# ✦ Nexus AI

**Your Private AI Assistant — Local, Fast, Always-On**

Nexus AI is a self-hosted personal AI assistant powered by NVIDIA NIM, OpenAI, and Google Gemini that connects to all your chat platforms. Think of it as your own private ChatGPT that you control, with your data never leaving your machine. It features autonomous web browsing using PinchTab and fully processes documents globally.

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-18%2B-green)
![Platforms](https://img.shields.io/badge/platforms-5-violet)

---

## ✨ Features

- 🔒 **Fully Local** — All conversations stored in SQLite on your machine
- 🧠 **Multi-Model Powered** — Use OpenAI, Gemini 2.5, or high-performance open-weights like Qwen 3 Coder 480B via NVIDIA NIM
- 🌐 **Deep Web Browsing** — Autonomous navigation and physical DOM interaction powered by PinchTab headless orchestration
- 📄 **Document Parsing** — Automatic PDF and text extraction directly through Telegram messages
- 💬 **Multi-Platform** — WhatsApp, Telegram, Discord, Slack, iMessage
- 🎙️ **Voice** — Speak to your assistant (Whisper STT + OpenAI TTS)
- 🖥️ **Premium Dashboard** — Beautiful dark-mode web interface
- ⚡ **Always-On** — PM2 background process with scheduled monitoring loops
- 🔧 **Easy Setup** — Interactive CLI wizard guides you through everything

---

## 🚀 Quick Start

### Prerequisites
- **Node.js 18+** — [Download](https://nodejs.org)
- **API Key** — OpenAI, Google Gemini, or [NVIDIA NIM](https://build.nvidia.com)
- **PinchTab (Optional)** — Required for autonomous background web scraping

### Install & Setup

```bash
# Clone or download this project
cd nexus-ai

# Install dependencies
npm install

# Run the setup wizard
npm run setup

# Start Nexus AI
npm start
```

The setup wizard will walk you through:
1. ✅ AI Provider Selection (NVIDIA, Gemini, OpenAI)
2. 🔌 Platform selection & credentials
3. 🎙️ Voice configuration
4. 🧠 AI personality customization

### Access the Dashboard

Open **http://localhost:3000** in your browser.

---

## 📱 Platform Setup

### Telegram
1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token into the setup wizard

### Discord
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a New Application → Bot section → Create Bot
3. Enable **Message Content Intent** and **Server Members Intent**
4. Copy the bot token into the setup wizard
5. Invite the bot to your server using OAuth2 URL Generator (scope: `bot`, permissions: `Send Messages`)

### Slack
1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App
2. Enable **Socket Mode** and create an App-Level Token (scope: `connections:write`)
3. Add Bot Token Scopes: `chat:write`, `app_mentions:read`, `im:history`, `im:read`, `im:write`
4. Install to workspace and copy both tokens

### WhatsApp
1. No credentials needed!
2. When you start Nexus AI, a QR code appears in the terminal
3. Open WhatsApp → Settings → Linked Devices → Link a Device
4. Scan the QR code

### iMessage (macOS only)
1. No credentials needed
2. Grant **Full Disk Access** to Terminal:
   - System Preferences → Security & Privacy → Privacy → Full Disk Access
3. Enable iMessage in the setup wizard

---

## 🎙️ Voice

Voice works through the web dashboard:
- Click the **microphone button** to start recording
- Your speech is transcribed via OpenAI Whisper
- The AI response can be read aloud via Text-to-Speech

Voice options: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`

---

## 🏃 Running in Background

Use PM2 to keep Nexus AI running 24/7:

```bash
# Install PM2 globally
npm install -g pm2

# Start Nexus AI
pm2 start ecosystem.config.js

# Monitor
pm2 monit

# View logs
pm2 logs nexus-ai

# Auto-start on boot
pm2 startup
pm2 save
```

---

## 📁 Project Structure

```
nexus-ai/
├── src/
│   ├── index.js              # Main entry point
│   ├── wizard.js             # CLI setup wizard
│   ├── server.js             # Express + WebSocket server
│   ├── core/
│   │   ├── ai-engine.js      # OpenAI integration
│   │   ├── database.js       # SQLite storage
│   │   └── conversation-manager.js
│   └── adapters/
│       ├── telegram.js       # Telegram bot
│       ├── discord.js        # Discord bot
│       ├── slack.js          # Slack app
│       ├── whatsapp.js       # WhatsApp client
│       ├── imessage.js       # iMessage (macOS)
│       └── voice.js          # Voice STT/TTS
├── public/                   # Web dashboard
├── config/                   # Default config
├── data/                     # SQLite DB (auto-created)
└── ecosystem.config.js       # PM2 config
```

---

## ⚙️ Configuration

Edit `.env` directly or re-run `npm run setup`:

| Variable | Description | Default |
|----------|-------------|---------|
| `AI_PROVIDER` | AI Provider | `openai` (or `gemini`, `nvidia`) |
| `AI_MODEL` | AI model to use | `gpt-4o-mini` |
| `PORT` | Web dashboard port | `3000` |
| `VOICE_ENABLED` | Enable voice features | `true` |
| `VOICE_NAME` | TTS voice selection | `alloy` |

---

## 📄 License

MIT — Use it however you want. Your data, your rules.

# ✦ Nexus AI: The Complete User Guide

Welcome to **Nexus AI**, your private, local-first AI assistant. This guide will walk you through every step to get your assistant running, connecting your college portal, and automating your life.

---

## 🚀 1. Installation

Getting Nexus AI on your server or local machine is designed to be one-step.

### macOS / Linux
```bash
curl -fsSL https://raw.githubusercontent.com/khellon21/nexus-ai/main/install.sh | sudo bash
```

### Windows (PowerShell)
```powershell
powershell -c "irm https://raw.githubusercontent.com/khellon21/nexus-ai/main/install.ps1 | iex"
```

> [!IMPORTANT]
> **Linux Users:** If you install to `/root/` (default via `sudo`), move it to your home directory to avoid permission issues:
> `sudo mv /root/nexus-ai ~/nexus-ai && sudo chown -R $USER:$USER ~/nexus-ai`

---

## 🛠️ 2. The Setup Wizard

Once installed, run the unified setup wizard. **This is the only command you need to configure everything.**

```bash
cd nexus-ai
npm run setup
```

### What's in the Wizard?
1.  **AI Provider:** Choose between **OpenAI**, **Google Gemini**, or **NVIDIA NIM** (highly recommended for high-performance open models like Qwen 480B).
2.  **Platforms:** Enable **Telegram**, **Discord**, **WhatsApp**, **Slack**, or **iMessage**.
3.  **Cipher Academic Agent:** The core automation engine for students.
4.  **Personality:** Set the "System Prompt" to define how your AI speaks and behaves.

---

## 🎓 3. Cipher Academic Agent

Cipher is your personal academic assistant. It autonomously navigates your college portal to fetch assignments and grades.

### Setup Flow
During `npm run setup`, you will:
-   **Select Platform:** Choose **D2L Brightspace** (Pilot), **Canvas**, **Blackboard**, or **Custom**.
-   **Enter Portal URL:** e.g., `https://pilot.wright.edu`.
-   **Encrypt Credentials:** Enter your username and password. They are encrypted with **AES-256-GCM** and stored only on your machine.
-   **Connect Telegram:** Provide your Chat ID to receive instant alerts for new grades or upcoming deadlines.

### Manual Commands
You can also manage Cipher via the CLI:
-   **Scan Now:** `npm run cipher -- scan-now` (Triggers an immediate crawl)
-   **List Assignments:** `npm run cipher -- list-assignments` (View what's in your local DB)
-   **Test Notifications:** `npm run cipher -- test-notify` (Ensures Telegram alerts work)

> [!TIP]
> **Duo 2FA:** When Cipher scans, it may trigger a Duo push. Simply approve it on your phone; Cipher will detect the approval and continue automatically.

---

## 📱 4. Connecting Telegram

The best way to use Nexus AI is via Telegram.

1.  Message [@BotFather](https://t.me/botfather) and create a `/newbot`.
2.  Copy the **API Token** and paste it into the setup wizard.
3.  Message [@userinfobot](https://t.me/userinfobot) to get your **Chat ID** (required for Cipher alerts).
4.  Start chatting! Ask: *"What's due this week?"* or *"Summarize my recent grades."*

---

## ⚡ 5. 24/7 Always-On Mode

To keep Nexus AI running even when you close your terminal, use **PM2**.

```bash
# Install PM2
npm install -g pm2

# Start Nexus AI
pm2 start ecosystem.config.cjs

# View Real-time Logs
pm2 logs nexus-ai

# Ensure it starts on system reboot
pm2 startup
pm2 save
```

---

## 🎨 6. Web Dashboard

Nexus AI comes with a premium web-based dashboard. 

-   **Access:** `http://your-server-ip:3000` (or `localhost:3000`)
-   **Features:** View conversation history, monitor adapter status, and tweak AI settings on the fly.

---

## ❓ Troubleshooting

### "DOMMatrix is not defined"
Nexus AI includes a built-in polyfill for Node.js 18. Ensure you are on the latest version of the code (`git pull`).

### "Permission Denied"
If you cannot `cd` into the directory, it was likely installed as root. Run:
`sudo chown -R ubuntu:ubuntu ~/nexus-ai` (replace `ubuntu` with your username).

### Missing Playwright Chrome
If Cipher fails or the install script skipped Chrome, run:
`npx playwright install chromium`

---

**All data stays local. Your data, your rules.** ✦

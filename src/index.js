import 'dotenv/config';
import { AIEngine } from './core/ai-engine.js';
import { NexusDatabase } from './core/database.js';
import { ConversationManager } from './core/conversation-manager.js';
import { TelegramAdapter } from './adapters/telegram.js';
import { DiscordAdapter } from './adapters/discord.js';
import { SlackAdapter } from './adapters/slack.js';
import { WhatsAppAdapter } from './adapters/whatsapp.js';
import { IMessageAdapter } from './adapters/imessage.js';
import { VoiceAdapter } from './adapters/voice.js';
import { createWebServer } from './server.js';
import { existsSync } from 'fs';

// ─── ASCII Banner ────────────────────────────────────────

const banner = `
\x1b[35m
  ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗     █████╗ ██╗
  ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝    ██╔══██╗██║
  ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗    ███████║██║
  ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║    ██╔══██║██║
  ██║ ╚████║███████╗██╔╝ ╚██╗╚██████╔╝███████║    ██║  ██║██║
  ╚═╝  ╚═══╝╚══════╝╚═╝   ╚═╝ ╚═════╝ ╚══════╝    ╚═╝  ╚═╝╚═╝
\x1b[0m
  \x1b[90mYour Private AI Assistant — Local, Fast, Always-On\x1b[0m
`;

// ─── Main ────────────────────────────────────────────────

async function main() {
  console.log(banner);

  // Check for .env file
  if (!existsSync('.env')) {
    console.log('\x1b[33m  ⚠ No .env file found. Run "npm run setup" to configure Nexus AI.\x1b[0m\n');
    process.exit(1);
  }

  const hasOpenAI = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'sk-your-key-here';
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const hasNVIDIA = !!process.env.NVIDIA_API_KEY;
  
  if (!hasOpenAI && !hasGemini && !hasNVIDIA) {
    console.log('\x1b[33m  ⚠ No AI provider configured. Run "npm run setup" to set up OpenAI, Gemini, or NVIDIA.\x1b[0m\n');
    process.exit(1);
  }

  console.log('  Starting Nexus AI...\n');

  // ─── Initialize Core ─────────────────────────────────
  const ai = new AIEngine({
    model: process.env.AI_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    provider: process.env.AI_PROVIDER || (hasGemini && !hasOpenAI && !hasNVIDIA ? 'gemini' : (hasNVIDIA ? 'nvidia' : 'openai')),
    systemPrompt: process.env.SYSTEM_PROMPT
  });
  ai.initialize();

  const db = new NexusDatabase('./data/nexus.db');
  db.initialize();

  const cm = new ConversationManager(db, ai, { contextWindow: 20 });

  // ─── Start Background Monitor ────────────────────────
  import('./core/background-monitor.js').then(({ BackgroundMonitor }) => {
    const monitor = new BackgroundMonitor(cm);
    monitor.start();
  }).catch(e => console.error("Failed to load background monitor:", e));

  // ─── Initialize Voice ─────────────────────────────────
  const voice = new VoiceAdapter(ai);
  voice.initialize();

  // ─── Start Platform Adapters ──────────────────────────
  console.log('\n  Connecting platforms...\n');

  const adapters = {};
  const adapterStatus = {};

  // Telegram
  if (process.env.TELEGRAM_ENABLED === 'true') {
    adapters.telegram = new TelegramAdapter(cm);
    adapterStatus.telegram = await adapters.telegram.start();
  } else {
    adapterStatus.telegram = false;
  }

  // Discord
  if (process.env.DISCORD_ENABLED === 'true') {
    adapters.discord = new DiscordAdapter(cm);
    adapterStatus.discord = await adapters.discord.start();
  } else {
    adapterStatus.discord = false;
  }

  // Slack
  if (process.env.SLACK_ENABLED === 'true') {
    adapters.slack = new SlackAdapter(cm);
    adapterStatus.slack = await adapters.slack.start();
  } else {
    adapterStatus.slack = false;
  }

  // WhatsApp
  if (process.env.WHATSAPP_ENABLED === 'true') {
    adapters.whatsapp = new WhatsAppAdapter(cm);
    adapterStatus.whatsapp = await adapters.whatsapp.start();
  } else {
    adapterStatus.whatsapp = false;
  }

  // iMessage
  if (process.env.IMESSAGE_ENABLED === 'true') {
    adapters.imessage = new IMessageAdapter(cm);
    adapterStatus.imessage = await adapters.imessage.start();
  } else {
    adapterStatus.imessage = false;
  }

  // ─── Start Web Server ────────────────────────────────
  const port = parseInt(process.env.PORT) || 3000;

  const { server } = createWebServer(cm, voice, () => adapterStatus);

  server.listen(port, () => {
    console.log(`\n  ┌─────────────────────────────────────────────┐`);
    console.log(`  │                                             │`);
    console.log(`  │   \x1b[35m✦ Nexus AI is running!\x1b[0m                    │`);
    console.log(`  │                                             │`);
    console.log(`  │   Dashboard: \x1b[36mhttp://localhost:${port}\x1b[0m${' '.repeat(13 - port.toString().length)}│`);
    const rawProvider = process.env.AI_PROVIDER || 'openai';
    const providerTag = rawProvider === 'gemini' ? '🔷 Gemini' : rawProvider === 'nvidia' ? '🟢 NVIDIA' : '🟢 OpenAI';
    console.log(`  │   Provider:  \x1b[33m${providerTag.padEnd(28)}\x1b[0m│`);
    console.log(`  │   Model:     \x1b[33m${ai.model.padEnd(28)}\x1b[0m│`);
    console.log(`  │                                             │`);
    console.log(`  │   Platforms:                                │`);
    Object.entries(adapterStatus).forEach(([name, status]) => {
      const icon = status ? '\x1b[32m●\x1b[0m' : '\x1b[90m○\x1b[0m';
      const label = name.charAt(0).toUpperCase() + name.slice(1);
      console.log(`  │     ${icon} ${label.padEnd(38)}│`);
    });
    console.log(`  │     \x1b[32m●\x1b[0m ${'Web Dashboard'.padEnd(38)}│`);
    if (voice.enabled) {
      console.log(`  │     \x1b[32m●\x1b[0m ${'Voice (Whisper + TTS)'.padEnd(38)}│`);
    }
    console.log(`  │                                             │`);
    console.log(`  │   \x1b[90mAll data stays local on your machine.\x1b[0m       │`);
    console.log(`  │                                             │`);
    console.log(`  └─────────────────────────────────────────────┘\n`);
  });

  // ─── Graceful Shutdown ────────────────────────────────

  const shutdown = async (signal) => {
    console.log(`\n  Shutting down (${signal})...`);

    for (const [name, adapter] of Object.entries(adapters)) {
      try {
        await adapter.stop();
      } catch (e) {
        console.error(`  Error stopping ${name}:`, e.message);
      }
    }

    server.close();
    db.close();
    console.log('  Nexus AI stopped. Goodbye! 👋\n');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    console.error('  ✗ Uncaught error:', error.message);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('  ✗ Unhandled rejection:', reason);
  });
}

main().catch((error) => {
  console.error('\n  ✗ Fatal error:', error.message);
  console.error('  Run "npm run setup" to reconfigure.\n');
  process.exit(1);
});

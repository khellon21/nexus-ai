import TelegramBot from 'node-telegram-bot-api';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Lazy-load pdf-parse to avoid DOMMatrix crash on Node.js 18
let pdfParse = null;
function getPdfParse() {
  if (!pdfParse) {
    // Polyfill DOMMatrix for Node.js (required by pdf-parse v2)
    if (typeof globalThis.DOMMatrix === 'undefined') {
      globalThis.DOMMatrix = class DOMMatrix {
        constructor(init) {
          const values = [1, 0, 0, 1, 0, 0];
          if (Array.isArray(init)) {
            for (let i = 0; i < Math.min(init.length, 6); i++) values[i] = init[i];
          }
          this.a = values[0]; this.b = values[1];
          this.c = values[2]; this.d = values[3];
          this.e = values[4]; this.f = values[5];
        }
        isIdentity = true;
        is2D = true;
        translate() { return new DOMMatrix(); }
        scale() { return new DOMMatrix(); }
        multiply() { return new DOMMatrix(); }
        inverse() { return new DOMMatrix(); }
        transformPoint(p) { return p; }
      };
    }
    pdfParse = require('pdf-parse');
  }
  return pdfParse;
}

export class TelegramAdapter {
  /**
   * @param {import('../core/conversation-manager.js').ConversationManager} conversationManager
   * @param {object} [options]
   * @param {import('../core/ai-engine.js').AIEngine} [options.aiEngine]
   *        Needed for the Voice-In/Voice-Out flow (Epic 4). Optional for
   *        backwards compatibility — when omitted, voice notes are ignored
   *        gracefully.
   */
  constructor(conversationManager, options = {}) {
    this.cm = conversationManager;
    // Prefer an explicitly-passed engine, else the one hanging off the CM.
    this.ai = options.aiEngine || conversationManager?.ai || null;
    this.bot = null;
    this.platform = 'telegram';
  }

  async start() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.log('  ⚠ Telegram: No bot token configured, skipping');
      return false;
    }

    try {
      this.bot = new TelegramBot(token, { polling: true });

      this.bot.on('message', async (msg) => {
        if (msg.text && msg.text.startsWith('/start')) return;

        // Epic 4: accept voice notes in addition to text + documents.
        if (!msg.text && !msg.document && !msg.voice) return;

        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();
        const displayName = msg.from.first_name || msg.from.username || 'Telegram User';

        let promptText = msg.text || '';
        // When we handle a voice note successfully, we reply with audio — not
        // plain text. Track this so we can switch output mode.
        let replyAsVoice = false;

        // ─── Epic 4: Voice-In path ───────────────────────────────
        if (msg.voice) {
          if (!this.ai) {
            await this.bot.sendMessage(chatId, '⚠️ Voice messages require the AI engine to be attached. Skipping.');
            return;
          }

          try {
            this.bot.sendChatAction(chatId, 'typing');

            // 1) Download the voice note from Telegram.
            const fileLink = await this.bot.getFileLink(msg.voice.file_id);
            const fileRes = await fetch(fileLink);
            if (!fileRes.ok) throw new Error(`Telegram file fetch failed: ${fileRes.status}`);
            const audioBuf = Buffer.from(await fileRes.arrayBuffer());

            // 2) Transcribe via local Faster-Whisper (Epic 3).
            //    Telegram voice notes are always OGG/Opus — hint with .ogg.
            const transcript = await this.ai.transcribeAudio(audioBuf, 'voice.ogg');
            if (!transcript || !transcript.trim()) {
              await this.bot.sendMessage(chatId, "⚠️ Sorry, I couldn't hear anything in that voice note.");
              return;
            }

            console.log(`  🎤 [Telegram] Voice transcript: ${transcript.substring(0, 120)}`);
            promptText = transcript;
            replyAsVoice = true;
          } catch (err) {
            console.error('Voice-in error:', err.message);
            await this.bot.sendMessage(chatId, `⚠️ Voice transcription failed: ${err.message}`);
            return;
          }
        }

        // Show typing indicator (covers the text + document path too).
        this.bot.sendChatAction(chatId, 'typing');

        // ─── Document handling (unchanged) ──────────────────────
        if (msg.document) {
          try {
            const fileLink = await this.bot.getFileLink(msg.document.file_id);
            const fileRes = await fetch(fileLink);
            const buffer = await fileRes.arrayBuffer();

            if (msg.document.mime_type === 'application/pdf') {
              const pdfData = await getPdfParse()(Buffer.from(buffer));
              promptText += `\n\n[User uploaded PDF: ${msg.document.file_name}]\n${pdfData.text.substring(0, 150000)}`;
            } else {
              const textData = Buffer.from(buffer).toString('utf-8');
              promptText += `\n\n[User uploaded file: ${msg.document.file_name}]\n${textData.substring(0, 150000)}`;
            }
          } catch (err) {
            console.error('Document parsing error:', err.message);
            await this.bot.sendMessage(chatId, '⚠️ Sorry, I could not read that document.');
            return;
          }
        }

        if (!promptText.trim()) return;

        // ─── LLM round-trip ─────────────────────────────────────
        let response;
        try {
          response = await this.cm.processMessage(
            promptText, this.platform, userId, displayName
          );
        } catch (error) {
          console.error('Telegram error:', error.message);
          await this.bot.sendMessage(chatId, '⚠️ Sorry, I encountered an error. Please try again.');
          return;
        }

        const replyText = response?.content?.trim();
        if (!replyText) return;

        // ─── Epic 4: Voice-Out path ────────────────────────────
        if (replyAsVoice) {
          try {
            this.bot.sendChatAction(chatId, 'record_voice');
            const wavBuf = await this.ai.textToSpeech(replyText);

            // `sendVoice` accepts a Buffer directly. Telegram clients prefer
            // OGG/Opus for the voice-note UI, but they will still play WAV;
            // if you want the proper waveform bubble, add an ffmpeg transcode
            // step inside services/tts/server.py that returns OGG/Opus.
            await this.bot.sendVoice(chatId, wavBuf, {}, {
              filename: 'reply.wav',
              contentType: 'audio/wav'
            });
            return;
          } catch (err) {
            console.error('Voice-out error:', err.message);
            // Graceful fallback: send the text so the user still gets the reply.
            await this.bot.sendMessage(
              chatId,
              `${replyText}\n\n_(voice synthesis failed: ${err.message})_`,
              { parse_mode: 'Markdown' }
            );
            return;
          }
        }

        // ─── Text reply (original behaviour) ───────────────────
        await this.bot.sendMessage(chatId, replyText);
      });

      let lastConflictWarn = 0;
      this.bot.on('polling_error', (error) => {
        if (error.code === 'ETELEGRAM' && error.response?.statusCode === 409) {
          const now = Date.now();
          if (now - lastConflictWarn > 60000) { // Only warn once per minute
            lastConflictWarn = now;
            console.log('  ⚠ Telegram: Another bot instance is polling with this token (409 conflict)');
          }
        } else if (error.code !== 'EFATAL') {
          console.error('  ✗ Telegram polling error:', error.message || error.code);
        }
      });

      const me = await this.bot.getMe();
      console.log(`  ✓ Telegram connected as @${me.username}`);
      return true;
    } catch (error) {
      console.error('  ✗ Telegram failed to start:', error.message);
      return false;
    }
  }

  async stop() {
    if (this.bot) {
      await this.bot.stopPolling();
      console.log('  ✓ Telegram disconnected');
    }
  }

  async sendMessage(userId, text) {
    if (this.bot) {
      await this.bot.sendMessage(userId, text);
    }
  }
}

export default TelegramAdapter;

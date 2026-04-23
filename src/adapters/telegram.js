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
      this.bot = new TelegramBot(token, {
        polling: {
          interval: 300,
          autoStart: true,
          params: { timeout: 10, allowed_updates: ['message'] }
        }
      });

      // Clear any stale webhook / long-poll session from a previous crashed instance.
      // This is the definitive fix for Telegram 409 "Conflict" errors.
      try {
        await this.bot.deleteWebhook({ drop_pending_updates: true });
      } catch (_) { /* non-fatal */ }

      // Register this adapter as the 'telegram' media channel so tools like
      // `take_screenshot` can push image/voice payloads directly to the chat
      // without routing bytes through the LLM. For Telegram private chats the
      // user ID equals the chat ID, so we can sendPhoto straight to it.
      if (this.cm && typeof this.cm.registerMediaChannel === 'function') {
        this.cm.registerMediaChannel('telegram', async ({ platformUserId, buffer, filename, mimeType, caption }) => {
          if (!this.bot) throw new Error('Telegram bot not initialized');
          if (!buffer || !buffer.length) throw new Error('Empty media buffer');
          const chatId = platformUserId;
          const opts = caption ? { caption } : {};
          const isImage = (mimeType || '').startsWith('image/');
          const isAudio = (mimeType || '').startsWith('audio/');
          if (isImage) {
            await this.bot.sendPhoto(chatId, buffer, opts, {
              filename: filename || 'image.png',
              contentType: mimeType || 'image/png',
            });
          } else if (isAudio) {
            await this.bot.sendVoice(chatId, buffer, opts, {
              filename: filename || 'audio.ogg',
              contentType: mimeType || 'audio/ogg',
            });
          } else {
            await this.bot.sendDocument(chatId, buffer, opts, {
              filename: filename || 'file.bin',
              contentType: mimeType || 'application/octet-stream',
            });
          }
        });
      }

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

        // ─── Latency mitigation: streaming + typing refresh + throttled edits ──
        //
        // Previously Telegram used the non-streaming processMessage(), which
        // meant the user sat on a stale "typing…" indicator for the entire
        // LLM round-trip. Telegram's chat action expires after ~5 seconds,
        // so even the spinner would vanish while the model was still working,
        // making it look like the bot had silently died.
        //
        // The fix below does three things:
        //   (1) refreshes sendChatAction('typing') every 4 seconds, so the
        //       indicator stays alive for the full round-trip;
        //   (2) sends a single placeholder message on the first token, then
        //       edits it with the latest buffer on a ~1.2s throttle (Telegram
        //       rate-limits message edits to roughly once per second per chat);
        //   (3) falls back to a single sendMessage() if streaming produced
        //       nothing (e.g. pure tool turn with empty final text).
        //
        // We DO NOT stream voice replies — TTS still happens once, on the
        // final text, after the stream resolves.

        const TYPING_REFRESH_MS = 4000;
        const EDIT_THROTTLE_MS  = 1200;
        const TELEGRAM_MAX_CHARS = 4000; // 4096 is the hard limit; leave headroom.

        let sentMsgId   = null;
        let displayed   = '';   // content currently rendered in the Telegram message
        let buffer      = '';   // latest content from onChunk
        let lastEditAt  = 0;
        let editTimer   = null;
        let editInFlight = false;
        let finished    = false;

        const typingInterval = setInterval(() => {
          this.bot.sendChatAction(chatId, 'typing').catch(() => { /* best-effort */ });
        }, TYPING_REFRESH_MS);

        const flushEdit = async () => {
          editTimer = null;
          if (editInFlight) return;
          const snapshot = buffer;
          if (!snapshot || snapshot === displayed) return;
          editInFlight = true;
          lastEditAt = Date.now();
          const text = snapshot.slice(0, TELEGRAM_MAX_CHARS);
          try {
            if (!sentMsgId) {
              const m = await this.bot.sendMessage(chatId, text);
              sentMsgId = m.message_id;
              displayed = text;
            } else {
              await this.bot.editMessageText(text, {
                chat_id: chatId,
                message_id: sentMsgId,
              });
              displayed = text;
            }
          } catch (e) {
            // "message is not modified" / 429 flood control / network blips are
            // all non-fatal here — the final authoritative edit runs after the
            // stream resolves, so any dropped intermediate frame is fine.
          } finally {
            editInFlight = false;
            // If more content arrived during the edit, schedule another pass.
            if (!finished && buffer !== displayed) scheduleEdit();
          }
        };

        const scheduleEdit = () => {
          if (finished || editTimer || editInFlight) return;
          const elapsed = Date.now() - lastEditAt;
          const delay   = Math.max(0, EDIT_THROTTLE_MS - elapsed);
          editTimer = setTimeout(flushEdit, delay);
        };

        const onChunk = (chunkOrFull, fullText) => {
          // Streaming path from ai-engine gives (delta, fullText).
          // Single-shot notices (e.g. install approval prompt) call onChunk(msg)
          // with just one argument — treat that as the full new buffer.
          if (fullText !== undefined) {
            buffer = fullText;
          } else if (typeof chunkOrFull === 'string') {
            // Append with a paragraph break if we already had streamed content.
            buffer = buffer ? `${buffer}\n\n${chunkOrFull}` : chunkOrFull;
          }
          scheduleEdit();
        };

        let response;
        try {
          response = await this.cm.processMessageStream(
            promptText, this.platform, userId, onChunk, displayName
          );
        } catch (error) {
          console.error('Telegram error:', error.message);
          clearInterval(typingInterval);
          if (editTimer) { clearTimeout(editTimer); editTimer = null; }
          finished = true;
          const errMsg = '⚠️ Sorry, I encountered an error. Please try again.';
          try {
            if (sentMsgId) {
              await this.bot.editMessageText(errMsg, { chat_id: chatId, message_id: sentMsgId });
            } else {
              await this.bot.sendMessage(chatId, errMsg);
            }
          } catch { /* swallow — user already sees the placeholder if any */ }
          return;
        } finally {
          clearInterval(typingInterval);
          finished = true;
          if (editTimer) { clearTimeout(editTimer); editTimer = null; }
        }

        const replyText = (response?.content || buffer || '').trim();
        if (!replyText) {
          // Nothing to show (e.g. pure tool-only turn). Leave the placeholder
          // alone if one exists; otherwise we silently drop.
          return;
        }

        // Final authoritative render — this supersedes any intermediate edits.
        const finalText = replyText.slice(0, TELEGRAM_MAX_CHARS);
        try {
          if (sentMsgId) {
            if (finalText !== displayed) {
              await this.bot.editMessageText(finalText, {
                chat_id: chatId,
                message_id: sentMsgId,
              });
              displayed = finalText;
            }
          } else {
            const m = await this.bot.sendMessage(chatId, finalText);
            sentMsgId = m.message_id;
            displayed = finalText;
          }
        } catch (e) {
          // Likely "message is not modified" — already in sync. Ignore.
        }

        // ─── Voice-out path ─────────────────────────────────────
        //
        // The text is already on-screen (streamed above). Now, if this turn
        // started from a voice note, generate audio and send it as a follow-up.
        // TTS failures are non-fatal because the user already has the text.
        if (replyAsVoice) {
          const voiceMgr = globalThis.__voiceManager;
          const wasAsleep = voiceMgr ? !voiceMgr.isRunning : false;
          if (wasAsleep) {
            this.bot.sendMessage(
              chatId,
              '🎙️ Waking up voice engine, audio reply coming in a few seconds…'
            ).catch(() => { /* non-critical */ });
          }

          try {
            this.bot.sendChatAction(chatId, 'record_voice');
            const wavBuf = await this.ai.textToSpeech(replyText);
            await this.bot.sendVoice(chatId, wavBuf, {}, {
              filename: 'reply.wav',
              contentType: 'audio/wav'
            });
          } catch (err) {
            console.error('Voice-out error:', err.message);
            await this.bot.sendMessage(
              chatId,
              `_(voice synthesis failed: ${err.message})_`,
              { parse_mode: 'Markdown' }
            ).catch(() => { /* best-effort */ });
          }
        }
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
      // Clear the media channel so tool calls that arrive after shutdown
      // don't try to reach a dead bot instance.
      if (this.cm && typeof this.cm.registerMediaChannel === 'function') {
        this.cm.registerMediaChannel('telegram', null);
      }
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

import TelegramBot from 'node-telegram-bot-api';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

export class TelegramAdapter {
  constructor(conversationManager) {
    this.cm = conversationManager;
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
        if (!msg.text && !msg.document) return;
        
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();
        const displayName = msg.from.first_name || msg.from.username || 'Telegram User';

        let promptText = msg.text || '';

        // Show typing indicator
        this.bot.sendChatAction(chatId, 'typing');

        // Handle document reading
        if (msg.document) {
          try {
            const fileLink = await this.bot.getFileLink(msg.document.file_id);
            const fileRes = await fetch(fileLink);
            const buffer = await fileRes.arrayBuffer();
            
            if (msg.document.mime_type === 'application/pdf') {
              const pdfData = await pdfParse(Buffer.from(buffer));
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

        try {
          const response = await this.cm.processMessage(
            promptText, this.platform, userId, displayName
          );
          if (response.content && response.content.trim()) {
            await this.bot.sendMessage(chatId, response.content);
          }
        } catch (error) {
          console.error('Telegram error:', error.message);
          await this.bot.sendMessage(chatId, '⚠️ Sorry, I encountered an error. Please try again.');
        }
      });

      this.bot.on('polling_error', (error) => {
        if (error.code === 'ETELEGRAM' && error.response?.statusCode === 409) {
          console.log('  ⚠ Telegram: Another instance is running');
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

import TelegramBot from 'node-telegram-bot-api';

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
        if (!msg.text || msg.text.startsWith('/start')) return;
        
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();
        const displayName = msg.from.first_name || msg.from.username || 'Telegram User';

        // Show typing indicator
        this.bot.sendChatAction(chatId, 'typing');

        try {
          const response = await this.cm.processMessage(
            msg.text, this.platform, userId, displayName
          );
          await this.bot.sendMessage(chatId, response.content, { parse_mode: 'Markdown' });
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
      await this.bot.sendMessage(userId, text, { parse_mode: 'Markdown' });
    }
  }
}

export default TelegramAdapter;

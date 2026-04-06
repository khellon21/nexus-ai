import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';

export class WhatsAppAdapter {
  constructor(conversationManager) {
    this.cm = conversationManager;
    this.client = null;
    this.platform = 'whatsapp';
    this.isReady = false;
  }

  async start() {
    try {
      this.client = new Client({
        authStrategy: new LocalAuth({ dataPath: './data/whatsapp-session' }),
        puppeteer: {
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
      });

      this.client.on('qr', (qr) => {
        console.log('\n  📱 WhatsApp: Scan this QR code with your phone:\n');
        qrcode.generate(qr, { small: true });
        console.log('  Open WhatsApp → Settings → Linked Devices → Link a Device\n');
      });

      this.client.on('ready', () => {
        this.isReady = true;
        console.log('  ✓ WhatsApp connected and ready');
      });

      this.client.on('authenticated', () => {
        console.log('  ✓ WhatsApp authenticated');
      });

      this.client.on('auth_failure', (msg) => {
        console.error('  ✗ WhatsApp auth failed:', msg);
        this.isReady = false;
      });

      this.client.on('disconnected', (reason) => {
        console.log('  ⚠ WhatsApp disconnected:', reason);
        this.isReady = false;
      });

      this.client.on('message', async (message) => {
        // Skip group messages unless configured
        if (message.from.includes('@g.us')) {
          const respondToGroups = process.env.WHATSAPP_RESPOND_GROUPS === 'true';
          if (!respondToGroups) return;
          // In groups, only respond when mentioned
          if (!message.body.toLowerCase().includes('nexus')) return;
        }

        // Skip status broadcasts
        if (message.from === 'status@broadcast') return;

        const text = message.body;
        if (!text || text.length === 0) return;

        const userId = message.from;
        const contact = await message.getContact();
        const displayName = contact.pushname || contact.name || 'WhatsApp User';

        try {
          // Show typing indicator
          const chat = await message.getChat();
          await chat.sendStateTyping();

          const response = await this.cm.processMessage(
            text, this.platform, userId, displayName
          );

          await chat.clearState();
          await message.reply(response.content);
        } catch (error) {
          console.error('WhatsApp error:', error.message);
          await message.reply('⚠️ Sorry, I encountered an error. Please try again.');
        }
      });

      await this.client.initialize();
      return true;
    } catch (error) {
      console.error('  ✗ WhatsApp failed to start:', error.message);
      return false;
    }
  }

  async stop() {
    if (this.client) {
      await this.client.destroy();
      this.isReady = false;
      console.log('  ✓ WhatsApp disconnected');
    }
  }

  async sendMessage(chatId, text) {
    if (this.client && this.isReady) {
      await this.client.sendMessage(chatId, text);
    }
  }
}

export default WhatsAppAdapter;

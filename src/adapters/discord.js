import { Client, GatewayIntentBits, Partials } from 'discord.js';

export class DiscordAdapter {
  constructor(conversationManager) {
    this.cm = conversationManager;
    this.client = null;
    this.platform = 'discord';
  }

  async start() {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      console.log('  ⚠ Discord: No bot token configured, skipping');
      return false;
    }

    try {
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Channel, Partials.Message]
      });

      this.client.on('messageCreate', async (message) => {
        // Ignore bot messages
        if (message.author.bot) return;

        // Respond to DMs or when mentioned
        const isDM = !message.guild;
        const isMentioned = message.mentions.has(this.client.user);

        if (!isDM && !isMentioned) return;

        let text = message.content;
        if (isMentioned) {
          text = text.replace(/<@!?\d+>/g, '').trim();
        }
        if (!text) return;

        const userId = message.author.id;
        const displayName = message.author.displayName || message.author.username;

        try {
          await message.channel.sendTyping();

          const response = await this.cm.processMessage(
            text, this.platform, userId, displayName
          );

          // Discord has a 2000 character limit
          const chunks = this._splitMessage(response.content, 2000);
          for (const chunk of chunks) {
            await message.reply(chunk);
          }
        } catch (error) {
          console.error('Discord error:', error.message);
          await message.reply('⚠️ Sorry, I encountered an error. Please try again.');
        }
      });

      await this.client.login(token);
      console.log(`  ✓ Discord connected as ${this.client.user.tag}`);
      return true;
    } catch (error) {
      console.error('  ✗ Discord failed to start:', error.message);
      return false;
    }
  }

  _splitMessage(text, maxLength) {
    if (text.length <= maxLength) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('\n', maxLength);
      if (splitAt === -1 || splitAt < maxLength / 2) {
        splitAt = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitAt === -1) splitAt = maxLength;
      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt).trim();
    }
    return chunks;
  }

  async stop() {
    if (this.client) {
      await this.client.destroy();
      console.log('  ✓ Discord disconnected');
    }
  }

  async sendMessage(channelId, text) {
    if (this.client) {
      const channel = await this.client.channels.fetch(channelId);
      if (channel) {
        const chunks = this._splitMessage(text, 2000);
        for (const chunk of chunks) {
          await channel.send(chunk);
        }
      }
    }
  }
}

export default DiscordAdapter;

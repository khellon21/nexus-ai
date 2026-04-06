import pkg from '@slack/bolt';
const { App } = pkg;

export class SlackAdapter {
  constructor(conversationManager) {
    this.cm = conversationManager;
    this.app = null;
    this.platform = 'slack';
  }

  async start() {
    const botToken = process.env.SLACK_BOT_TOKEN;
    const appToken = process.env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      console.log('  ⚠ Slack: Missing bot or app token, skipping');
      return false;
    }

    try {
      this.app = new App({
        token: botToken,
        appToken: appToken,
        socketMode: true
      });

      // Handle direct messages
      this.app.message(async ({ message, say }) => {
        if (message.subtype || message.bot_id) return;

        const userId = message.user;
        const text = message.text;
        if (!text) return;

        try {
          const response = await this.cm.processMessage(
            text, this.platform, userId, null
          );
          
          // Reply in thread if it's a thread, otherwise just reply
          const replyOptions = { text: response.content };
          if (message.thread_ts) {
            replyOptions.thread_ts = message.thread_ts;
          }
          await say(replyOptions);
        } catch (error) {
          console.error('Slack error:', error.message);
          await say('⚠️ Sorry, I encountered an error. Please try again.');
        }
      });

      // Handle @mentions in channels
      this.app.event('app_mention', async ({ event, say }) => {
        const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
        if (!text) return;

        const userId = event.user;

        try {
          const response = await this.cm.processMessage(
            text, this.platform, userId, null
          );
          await say({
            text: response.content,
            thread_ts: event.thread_ts || event.ts
          });
        } catch (error) {
          console.error('Slack mention error:', error.message);
          await say({
            text: '⚠️ Sorry, I encountered an error. Please try again.',
            thread_ts: event.thread_ts || event.ts
          });
        }
      });

      await this.app.start();
      console.log('  ✓ Slack connected (Socket Mode)');
      return true;
    } catch (error) {
      console.error('  ✗ Slack failed to start:', error.message);
      return false;
    }
  }

  async stop() {
    if (this.app) {
      await this.app.stop();
      console.log('  ✓ Slack disconnected');
    }
  }

  async sendMessage(channelId, text) {
    if (this.app) {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text
      });
    }
  }
}

export default SlackAdapter;

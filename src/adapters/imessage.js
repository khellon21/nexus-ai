import { execSync, exec } from 'child_process';
import { existsSync } from 'fs';
import { platform } from 'os';

export class IMessageAdapter {
  constructor(conversationManager) {
    this.cm = conversationManager;
    this.platform = 'imessage';
    this.pollInterval = null;
    this.lastMessageTime = null;
    this.processedMessages = new Set();
    this.chatDbPath = `${process.env.HOME}/Library/Messages/chat.db`;
  }

  async start() {
    if (platform() !== 'darwin') {
      console.log('  ⚠ iMessage: Only available on macOS, skipping');
      return false;
    }

    if (!existsSync(this.chatDbPath)) {
      console.log('  ⚠ iMessage: Cannot access chat.db. Grant Full Disk Access to Terminal.');
      return false;
    }

    try {
      // Test access to chat.db
      execSync(`sqlite3 "${this.chatDbPath}" "SELECT 1" 2>/dev/null`);
    } catch {
      console.log('  ⚠ iMessage: Cannot read chat.db. Grant Full Disk Access:');
      console.log('    System Preferences → Security & Privacy → Full Disk Access → Terminal');
      return false;
    }

    // Set the baseline to now (only process new messages)
    this.lastMessageTime = Math.floor(Date.now() / 1000) * 1000000000 + 978307200000000000;

    const pollMs = parseInt(process.env.IMESSAGE_POLL_INTERVAL) || 3000;
    this.pollInterval = setInterval(() => this._pollMessages(), pollMs);

    console.log(`  ✓ iMessage connected (polling every ${pollMs / 1000}s)`);
    return true;
  }

  async _pollMessages() {
    try {
      const query = `
        SELECT
          m.ROWID,
          m.text,
          m.is_from_me,
          m.date,
          h.id as handle_id,
          h.service
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE m.date > ${this.lastMessageTime}
          AND m.is_from_me = 0
          AND m.text IS NOT NULL
          AND m.text != ''
        ORDER BY m.date ASC
        LIMIT 10;
      `;

      const result = execSync(
        `sqlite3 -separator '|||' "${this.chatDbPath}" "${query}" 2>/dev/null`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();

      if (!result) return;

      const lines = result.split('\n').filter(l => l.trim());
      for (const line of lines) {
        const parts = line.split('|||');
        if (parts.length < 6) continue;

        const [rowId, text, , date, handleId] = parts;

        // Skip if already processed
        if (this.processedMessages.has(rowId)) continue;
        this.processedMessages.add(rowId);

        // Update last message time
        const msgDate = parseInt(date);
        if (msgDate > this.lastMessageTime) {
          this.lastMessageTime = msgDate;
        }

        // Process the message
        if (text && handleId) {
          try {
            const response = await this.cm.processMessage(
              text, this.platform, handleId, null
            );
            await this._sendMessage(handleId, response.content);
          } catch (error) {
            console.error('iMessage processing error:', error.message);
          }
        }
      }

      // Prevent memory leak — keep only last 1000 message IDs
      if (this.processedMessages.size > 1000) {
        const arr = Array.from(this.processedMessages);
        this.processedMessages = new Set(arr.slice(-500));
      }
    } catch (error) {
      // Silently handle polling errors (e.g., db locked)
      if (!error.message.includes('SQLITE_BUSY')) {
        // Only log non-busy errors occasionally
      }
    }
  }

  async _sendMessage(handleId, text) {
    // Escape single quotes and backslashes for AppleScript
    const escapedText = text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');

    const script = `
      tell application "Messages"
        set targetService to 1st account whose service type = iMessage
        set targetBuddy to participant "${handleId}" of targetService
        send "${escapedText}" to targetBuddy
      end tell
    `;

    try {
      exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (error) => {
        if (error) {
          console.error('iMessage send error:', error.message);
        }
      });
    } catch (error) {
      console.error('iMessage send error:', error.message);
    }
  }

  async stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      console.log('  ✓ iMessage disconnected');
    }
  }

  async sendMessage(handleId, text) {
    await this._sendMessage(handleId, text);
  }
}

export default IMessageAdapter;

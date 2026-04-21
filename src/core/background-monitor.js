export class BackgroundMonitor {
  constructor(conversationManager, intervalMs = 15 * 60 * 1000) {
    this.conversationManager = conversationManager;
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    console.log(`  \x1b[35m[System]\x1b[0m Started background monitoring loop (every ${this.intervalMs / 60000} minutes)`);
    
    // Run first check after a short delay
    setTimeout(() => this.runCheck(), 10000);
    
    // Schedule subsequent checks
    this.timer = setInterval(() => this.runCheck(), this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log(`  \x1b[35m[System]\x1b[0m Stopped background monitoring loop`);
    }
  }

  async runCheck() {
    console.log(`  \x1b[35m[System]\x1b[0m Running scheduled background check...`);
    try {
      const prompt = `[SILENT SYSTEM TRIGGER] Check for anything that Khellon needs to know about right now.

Rules:
- For news/headlines: use the 'search_internet' tool with a concrete query (e.g. "top world news today"). Do NOT guess URLs and do NOT call 'browser_navigate' on invented domains like technologynews.com — such domains do not exist.
- Only call 'browser_navigate' if you have a real, known URL (e.g. the user's college portal if its URL is stored in long-term memory).
- Call each tool AT MOST ONCE per check. If the first call fails or returns no useful data, stop — do not retry in a loop.
- If you find something genuinely critical, call 'send_urgent_notification'. Otherwise do nothing.
- Reply with at most a one-line status log (or nothing). Never chat.`;
      
      // We use a dedicated system-level conversation so it doesn't clutter user chats
      await this.conversationManager.processMessage(prompt, 'system', 'background-worker', 'System Monitor');
      
      // We don't need to log the AI's internal text response unless debugging, 
      // because tool executions are already logged in tools.js
    } catch (e) {
      console.error(`  \x1b[31m[System Error]\x1b[0m Background check failed: ${e.message}`);
    }
  }
}

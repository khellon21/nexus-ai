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
      const prompt = `[SILENT SYSTEM TRIGGER] Use your 'browser_navigate' and 'browser_extract_text' tools to visit my college portal (or check recent technology news if you don't know the portal URL). Read the top headlines. If there are any critical updates, execute 'send_urgent_notification' to alert Khellon. Otherwise, stop immediately to save tokens. Do not respond with text unless you are returning a brief status log.`;
      
      // We use a dedicated system-level conversation so it doesn't clutter user chats
      await this.conversationManager.processMessage(prompt, 'system', 'background-worker', 'System Monitor');
      
      // We don't need to log the AI's internal text response unless debugging, 
      // because tool executions are already logged in tools.js
    } catch (e) {
      console.error(`  \x1b[31m[System Error]\x1b[0m Background check failed: ${e.message}`);
    }
  }
}

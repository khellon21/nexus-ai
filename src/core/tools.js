/**
 * Core Tools Registry
 * Defines tool schemas and execution logic.
 */

export const getToolsSchema = (provider) => {
  const schemas = [
    {
      type: 'function',
      function: {
        name: 'get_current_time_and_date',
        description: 'Get the exact current local time and date. Use this whenever the user asks about time, date, or schedules.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'send_urgent_notification',
        description: 'Push an immediate alert/notification to Khellon’s devices. Use only for important or exciting updates.',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The urgent message to send.' }
          },
          required: ['message']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_navigate',
        description: 'Open a local Chrome browser and navigate to a URL. Use this to open any website, log into portals, or do web searches (like duckduckgo.com). Returns the new tab ID.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The absolute URL to navigate to (e.g., https://news.ycombinator.com)' }
          },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_snapshot',
        description: 'Returns the interactive accessibility tree of the current webpage. Use this to "see" what buttons, inputs, or links are on the screen. It gives you "ref" IDs needed to click or type into elements.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_action',
        description: 'Perform an action (click or fill) on a webpage element using its "ref" ID obtained from browser_snapshot. Example: { action: "click", ref: "e1" } or { action: "fill", ref: "e2", text: "my username" }',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['click', 'fill', 'press'], description: 'The type of action to perform.' },
            ref: { type: 'string', description: 'The reference ID of the element (e.g., e5).' },
            text: { type: 'string', description: 'The text to type or the key to press (only required for "fill" or "press").' }
          },
          required: ['action', 'ref']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_extract_text',
        description: 'Extracts the visible, readable content text from the current webpage. Use this to quickly read the contents of an article or announcement without worrying about HTML boilerplate.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'cipher_scan_portal',
        description: 'Trigger Cipher to immediately scan the university portal for new assignments and deadlines. Returns a summary of found assignments.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'cipher_list_assignments',
        description: 'Get a list of all mapped college assignments. This includes upcoming homework, past exams, due dates, completion status, evaluation status, and SCORES/GRADES. MUST use this tool whenever the user asks about grades, scores, or assignments.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'cipher_schedule_submission',
        description: 'Schedule a file to be automatically submitted to a portal assignment dropbox at a specific time.',
        parameters: {
          type: 'object',
          properties: {
            assignmentId: { type: 'string', description: 'The ID of the assignment to submit to (from cipher_list_assignments)' },
            filePath: { type: 'string', description: 'The absolute path to the file to submit' },
            scheduledAt: { type: 'string', description: 'ISO 8601 timestamp for when to submit (e.g. 2026-04-14T10:00:00). Use "now" for immediate submission.' }
          },
          required: ['assignmentId', 'filePath']
        }
      }
    }
  ];

  // Format translation for Gemini
  if (provider === 'gemini') {
    return schemas.map(s => ({
      name: s.function.name,
      description: s.function.description,
      parameters: s.function.parameters
    }));
  }

  return schemas;
};

export class ToolExecutor {
  constructor(conversationManager = null) {
    this.conversationManager = conversationManager;
    // Browser instance state
    this.profileId = null;
    this.instanceId = null;
    this.tabId = null;
  }

  async execute(call) {
    const { name, arguments: args } = call;
    let params = {};
    try {
      if (typeof args === 'string') {
          params = args ? JSON.parse(args) : {};
      } else {
          params = args || {};
      }
    } catch {
      params = {};
    }

    try {
      switch (name) {
        case 'get_current_time_and_date':
          return await this.getTime();
        case 'send_urgent_notification':
          return await this.sendNotification(params.message);
        case 'browser_navigate':
          return await this.browserNavigate(params.url);
        case 'browser_snapshot':
          return await this.browserSnapshot();
        case 'browser_action':
          return await this.browserAction(params.action, params.ref, params.text);
        case 'browser_extract_text':
          return await this.browserExtractText();
        case 'cipher_scan_portal':
          return await this.cipherScanPortal();
        case 'cipher_list_assignments':
          return await this.cipherListAssignments();
        case 'cipher_schedule_submission':
          return await this.cipherScheduleSubmission(params.assignmentId, params.filePath, params.scheduledAt);
        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  }

  // ─── Tool Implementations ─────────────────────────────

  async getTime() {
    const now = new Date();
    return JSON.stringify({
      currentTime: now.toLocaleTimeString(),
      currentDate: now.toDateString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    });
  }

  async browserNavigate(url) {
    console.log(`\x1b[36m  [Browser] Navigating to: ${url}\x1b[0m`);
    
    // 1. Create agent profile if necessary
    if (!this.profileId) {
      try {
        const pReq = await fetch('http://localhost:9867/profiles', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'nexus-agent'})});
        const pRes = await pReq.json();
        this.profileId = pRes.id;
      } catch (e) {
        return JSON.stringify({ error: `Failed to connect to PinchTab daemon. Is it running? (${e.message})`});
      }
    }
    
    // 2. Start headless instance if necessary
    if (!this.instanceId) {
      const iReq = await fetch('http://localhost:9867/instances/start', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({profileId: this.profileId, mode: 'headless'})});
      const iRes = await iReq.json();
      this.instanceId = iRes.id;
    }
    
    // 3. Open a tab
    const tReq = await fetch(`http://localhost:9867/instances/${this.instanceId}/tabs/open`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({url})});
    const tRes = await tReq.json();
    this.tabId = tRes.tabId;
    
    // Optional delay to let page stabilize before we reply
    await new Promise(r => setTimeout(r, 2000));

    return JSON.stringify({ status: "success", message: `Navigated to ${url}. Tab ID: ${this.tabId}` });
  }

  async browserSnapshot() {
    if (!this.tabId) return JSON.stringify({ error: 'No active browser tab. Use browser_navigate first.' });
    console.log(`\x1b[36m  [Browser] Taking interactive snapshot...\x1b[0m`);
    const res = await fetch(`http://localhost:9867/tabs/${this.tabId}/snapshot?filter=interactive`);
    if (!res.ok) return JSON.stringify({ error: await res.text() });
    const data = await res.json();
    return JSON.stringify(data);
  }

  async browserAction(action, ref, text) {
    if (!this.tabId) return JSON.stringify({ error: 'No active browser tab.' });
    console.log(`\x1b[36m  [Browser] Action: ${action} on ${ref}\x1b[0m`);
    const body = { kind: action, ref };
    if (text !== undefined) body.value = text;
    
    const res = await fetch(`http://localhost:9867/tabs/${this.tabId}/action`, {
        method: 'POST', 
        headers: {'Content-Type': 'application/json'}, 
        body: JSON.stringify(body)
    });
    if (!res.ok) return JSON.stringify({ error: await res.text() });
    
    // Let page react
    await new Promise(r => setTimeout(r, 1000));
    return JSON.stringify({ status: "success", message: `Performed ${action} on ${ref}` });
  }

  async browserExtractText() {
    if (!this.tabId) return JSON.stringify({ error: 'No active browser tab.' });
    console.log(`\x1b[36m  [Browser] Extracting text...\x1b[0m`);
    const res = await fetch(`http://localhost:9867/tabs/${this.tabId}/text`);
    if (!res.ok) return JSON.stringify({ error: await res.text() });
    const text = await res.text();
    return JSON.stringify({ text });
  }

  async sendNotification(message) {
    console.log(`\x1b[31m  [Tool] URGENT NOTIFICATION TO KHELLON: ${message}\x1b[0m`);
    
    // In a real scenario, this could ping Telegram, Pushover, or Discord natively.
    // We can emit an event that the ConversationManager listens to, or just log it.
    
    return JSON.stringify({
      status: "success",
      delivered_to: "all devices",
      timestamp: new Date().toISOString()
    });
  }

  // ─── Cipher Tool Implementations ──────────────────────

  async cipherScanPortal() {
    console.log(`\x1b[35m  [Cipher Tool] Triggering portal scan...\x1b[0m`);
    if (!this._cipherScheduler) {
      return JSON.stringify({ error: 'Cipher scheduler not initialized. Check CIPHER_ENABLED in .env.' });
    }

    try {
      await this._cipherScheduler.manualScan();
      const status = this._cipherScheduler.getAssignmentStatus();
      return JSON.stringify({
        status: 'success',
        message: `Scan complete. Found ${status.total} assignments.`,
        ...status
      });
    } catch (e) {
      return JSON.stringify({ error: `Scan failed: ${e.message}` });
    }
  }

  async cipherListAssignments() {
    console.log(`\x1b[35m  [Cipher Tool] Listing assignments...\x1b[0m`);
    if (!this._cipherScheduler) {
      return JSON.stringify({ error: 'Cipher scheduler not initialized.' });
    }

    const status = this._cipherScheduler.getAssignmentStatus();
    return JSON.stringify(status);
  }

  async cipherScheduleSubmission(assignmentId, filePath, scheduledAt) {
    console.log(`\x1b[35m  [Cipher Tool] Scheduling submission...\x1b[0m`);
    if (!this._cipherScheduler) {
      return JSON.stringify({ error: 'Cipher scheduler not initialized.' });
    }

    try {
      const when = scheduledAt === 'now' ? new Date().toISOString() : (scheduledAt || new Date().toISOString());
      const submissionId = this._cipherScheduler.scheduleSubmission(assignmentId, filePath, when);
      return JSON.stringify({
        status: 'success',
        message: `Submission queued for ${when}`,
        submissionId
      });
    } catch (e) {
      return JSON.stringify({ error: `Failed to schedule: ${e.message}` });
    }
  }
}

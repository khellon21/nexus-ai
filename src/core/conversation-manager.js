import { ToolExecutor, embed, cosineSimilarity } from './tools.js';
import { PromptLoader } from './prompt-loader.js';

// Epic 2: how many retrieved memories to inject into the system prompt.
const MEMORY_TOP_K = 3;
const MEMORY_MIN_SCORE = 0.15; // cosine-sim floor — below this we treat as irrelevant

export class ConversationManager {
  constructor(database, aiEngine, options = {}) {
    this.db = database;
    this.ai = aiEngine;
    this.toolExecutor = new ToolExecutor(this);
    this.contextWindow = options.contextWindow || 20;
    this.autoTitle = options.autoTitle !== false;
  }

  // ─── Helpers ───────────────────────────────────────────

  /**
   * Detect whether the currently-selected model routes to Anthropic.
   * Used to pick the correct tool-result message shape (Epic 1).
   */
  _isClaude() {
    const model = this.ai?.model || '';
    return model.startsWith('claude') || this.ai?.provider === 'anthropic';
  }

  /**
   * Epic 2: retrieve the top-K memories most similar to `query` and return
   * a string block ready to inject into the system prompt.
   * Returns '' if there are no relevant memories.
   */
  _retrieveMemoryBlock(query, platform, platformUserId) {
    try {
      const memories = this.db.listMemories({ platform, platformUserId, limit: 500 });
      if (!memories.length) return '';

      const queryVec = embed(query);
      const scored = memories
        .map(m => ({ ...m, score: cosineSimilarity(queryVec, m.vector) }))
        .filter(m => m.score >= MEMORY_MIN_SCORE)
        .sort((a, b) => b.score - a.score)
        .slice(0, MEMORY_TOP_K);

      if (!scored.length) return '';

      const lines = scored.map(m =>
        `  • [${m.category || 'general'}] ${m.content} (score=${m.score.toFixed(2)})`
      );
      return `\n\n--- RELEVANT LONG-TERM MEMORIES ---\n` +
             `You previously stored these facts. Use them if relevant; do not re-ask.\n` +
             lines.join('\n') + `\n--- END MEMORIES ---\n`;
    } catch (e) {
      console.error('[Memory] retrieval failed:', e.message);
      return '';
    }
  }

  /**
   * Epic 1 helper: push a tool result into the context in whichever shape
   * the current provider expects. For Claude, we use the native
   * `{role:'user', content:[{type:'tool_result', ...}]}` shape requested
   * by the task spec. For everyone else, OpenAI-style stays the standard.
   */
  _pushToolResult(contextMessages, call, resultString) {
    if (this._isClaude()) {
      contextMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: call.id,
          content: resultString
        }]
      });
    } else {
      contextMessages.push({
        role: 'tool',
        name: call.function.name,
        tool_call_id: call.id,
        content: resultString
      });
    }
  }

  // ─── Install-approval helpers (audit hardening) ───────

  /**
   * Classify a user reply to a pending install approval prompt.
   * Returns 'yes' | 'no' | 'ambiguous'. Ambiguous replies must keep the
   * pending state alive so we don't silently deny the install.
   */
  _classifyApproval(text) {
    const t = String(text || '').trim().toLowerCase();
    if (/^(y|yes|yeah|yep|yup|sure|ok(ay)?|approve(d)?|go( ahead)?|do it|please(?: do)?|confirm(ed)?)[\s.!]*$/.test(t)) return 'yes';
    if (/^(n|no|nope|nah|deny|denied|decline(d)?|cancel|stop|abort|don'?t|do not)[\s.!]*$/.test(t)) return 'no';
    return 'ambiguous';
  }

  /**
   * Persist an install approval prompt, surface the message to the user,
   * and halt the tool loop. Reused by both the initial intercept path and
   * the "another install showed up during resume" re-intercept path so
   * approval can never be bypassed by batching installs.
   */
  _askForInstallApproval({ call, remainingOtherCalls, contextMessages, conversationId, platform, onChunk }) {
    let argsObj = {};
    try { argsObj = JSON.parse(call.function.arguments || '{}'); } catch {}
    const pkg = argsObj.package_name || 'an unknown package';

    const msg = `I need to install the package \`${pkg}\` to complete this task. Do you approve? (Reply Yes/No)`;
    this.db.addMessage(conversationId, 'assistant', msg, platform);
    if (onChunk) onChunk(msg);

    this.db.setPendingToolCall(conversationId, {
      tool_name: 'install_npm_package',
      call_id: call.id,
      args: call.function.arguments,
      context: contextMessages,
      other_calls: remainingOtherCalls || [],
    });

    return { content: msg, usage: { totalTokens: 0 } };
  }

  // ─── Pending Tool Resumption ───────────────────────────

  async _tryResumePending(text, conversationId, platform, platformUserId, onChunk = null) {
    const pending = this.db.getPendingToolCall(conversationId);
    if (!pending) return null;

    // Persist the user's reply to the transcript regardless of what we
    // decide to do with it — the conversation history should always
    // reflect what the user actually said.
    this.db.addMessage(conversationId, 'user', text, platform);

    const decision = this._classifyApproval(text);

    // Ambiguous reply: keep pending state intact, re-prompt, and return.
    // This prevents "let me think" / "maybe later" from being silently
    // treated as a denial that clears the queued call.
    if (decision === 'ambiguous') {
      let argsObj = {};
      try { argsObj = JSON.parse(pending.args || '{}'); } catch {}
      const pkg = argsObj.package_name || 'the package';
      const msg = `I still need approval to install \`${pkg}\`. Please reply with **Yes** to approve or **No** to deny.`;
      this.db.addMessage(conversationId, 'assistant', msg, platform);
      if (onChunk) onChunk(msg);
      // Intentionally leave the pending row in place.
      return { content: msg, conversationId, usage: { totalTokens: 0 } };
    }

    // Clear pending only once we have an unambiguous verdict.
    this.db.clearPendingToolCall(conversationId);

    const contextMessages = pending.context;
    const approvedResult = decision === 'yes'
      ? await this.toolExecutor.execute(
          { name: pending.tool_name, arguments: pending.args },
          { platform, platformUserId }
        )
      : JSON.stringify({ error: 'User denied installation.' });

    this._pushToolResult(
      contextMessages,
      { id: pending.call_id, function: { name: pending.tool_name } },
      approvedResult
    );

    // Iterate any sibling tool_calls that were batched with the install.
    // CRITICAL: if another install_npm_package lurks in other_calls, we
    // MUST NOT execute it — halt again and request approval, preserving
    // the still-unprocessed calls for the next resume.
    const otherCalls = pending.other_calls || [];
    for (let i = 0; i < otherCalls.length; i++) {
      const call = otherCalls[i];
      if (call.function?.name === 'install_npm_package') {
        return this._askForInstallApproval({
          call,
          remainingOtherCalls: otherCalls.slice(i + 1),
          contextMessages,
          conversationId,
          platform,
          onChunk,
        });
      }
      const otherRes = await this.toolExecutor.execute(call.function, { platform, platformUserId });
      this._pushToolResult(contextMessages, call, otherRes);
    }

    const initialResponse = onChunk
      ? await this.ai.chatStream(contextMessages, onChunk)
      : await this.ai.chat(contextMessages);
    const finalResponse = await this._handleToolLoop(
      initialResponse, contextMessages, conversationId, platform, platformUserId, onChunk
    );

    return {
      content: finalResponse.content,
      conversationId,
      usage: finalResponse.usage || { totalTokens: 0 },
    };
  }

  // ─── Autonomous Tool Loop ──────────────────────────────

  async _handleToolLoop(initialResponse, contextMessages, conversationId, platform, platformUserId, onChunk = null) {
    let response = initialResponse;
    while (response.tool_calls && response.tool_calls.length > 0) {
      const installIdx = response.tool_calls.findIndex(c => c.function?.name === 'install_npm_package');

      if (installIdx !== -1) {
        const interceptedNPM = response.tool_calls[installIdx];

        // Record the assistant turn (with its full tool_calls list) so the
        // context we save is a valid suffix when the model resumes.
        contextMessages.push({
          role: 'assistant',
          content: response.content || '',
          tool_calls: response.tool_calls,
        });

        return this._askForInstallApproval({
          call: interceptedNPM,
          // Everything BEFORE the install in the batch has already been
          // scheduled by the model but not yet executed — keep them (in
          // order) so they run on resume AFTER the install result. And
          // everything after the install stays too; _tryResumePending
          // walks the full list and re-intercepts if it hits another install.
          remainingOtherCalls: response.tool_calls.filter((_, idx) => idx !== installIdx),
          contextMessages,
          conversationId,
          platform,
          onChunk,
        });
      }

      // Record assistant turn (with tool_calls) in standard shape — the
      // AIEngine translates into provider-specific shapes at send time.
      contextMessages.push({
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.tool_calls
      });

      for (const call of response.tool_calls) {
        const resultString = await this.toolExecutor.execute(call.function, { platform, platformUserId });
        this._pushToolResult(contextMessages, call, resultString);
      }

      if (onChunk) {
         response = await this.ai.chatStream(contextMessages, onChunk);
      } else {
         response = await this.ai.chat(contextMessages);
      }
    }

    this.db.addMessage(conversationId, 'assistant', response.content, platform, response.usage?.totalTokens || 0);
    return response;
  }

  // ─── Inbound Message Handlers ──────────────────────────

  async processMessage(text, platform, platformUserId, displayName = null) {
    const session = this.db.getOrCreateSession(platform, platformUserId, displayName);
    const conversationId = session.conversation_id;

    const pendingRes = await this._tryResumePending(text, conversationId, platform, platformUserId);
    if (pendingRes) {
      if (this.autoTitle && this.db.getRecentMessages(conversationId, 4).length <= 4) {
        this._generateTitle(conversationId, text).catch(() => {});
      }
      return pendingRes;
    }

    const isNewUser = !PromptLoader.hasUserFile(platform, platformUserId);
    if (isNewUser) {
      const recent = this.db.getRecentMessages(conversationId, 2);
      if (recent.length === 0) {
        this.db.addMessage(conversationId, 'user', text, platform);
        const welcomeStr = 'Welcome to Nexus AI. To complete your system setup and personalize your experience, could you please provide your name, your local timezone, and the name you would prefer to call me?';
        this.db.addMessage(conversationId, 'assistant', welcomeStr, platform);
        return { content: welcomeStr, conversationId, usage: { totalTokens: 0 } };
      }
    }

    this.db.addMessage(conversationId, 'user', text, platform);
    const recentMessages = this.db.getRecentMessages(conversationId, this.contextWindow);
    const contextMessages = recentMessages.map(m => ({ role: m.role, content: m.content }));

    let systemContent = isNewUser
      ? 'You are currently onboarding a new user. The user has replied to your formal setup question. Your ONLY TASK is to use the manage_workspace_file tool to create USER.md (storing their name and timezone) and SOUL.md (storing the name they assigned to you, and your identity). You must use the tool. Start now.'
      : await PromptLoader.getSystemPrompt(platform, platformUserId);

    // Epic 2: inject retrieved memories BEFORE the model call.
    systemContent += this._retrieveMemoryBlock(text, platform, platformUserId);

    contextMessages.unshift({ role: 'system', content: systemContent });

    const initialResponse = await this.ai.chat(contextMessages);
    const finalResponse = await this._handleToolLoop(initialResponse, contextMessages, conversationId, platform, platformUserId);

    if (this.autoTitle && recentMessages.length <= 2) {
      this._generateTitle(conversationId, text).catch(() => {});
    }

    return { content: finalResponse.content, conversationId, usage: finalResponse.usage || { totalTokens: 0 } };
  }

  async processMessageStream(text, platform, platformUserId, onChunk, displayName = null) {
    const session = this.db.getOrCreateSession(platform, platformUserId, displayName);
    const conversationId = session.conversation_id;

    const pendingRes = await this._tryResumePending(text, conversationId, platform, platformUserId, onChunk);
    if (pendingRes) {
      if (this.autoTitle && this.db.getRecentMessages(conversationId, 4).length <= 4) {
        this._generateTitle(conversationId, text).catch(() => {});
      }
      return pendingRes;
    }

    const isNewUser = !PromptLoader.hasUserFile(platform, platformUserId);
    if (isNewUser) {
      const recent = this.db.getRecentMessages(conversationId, 2);
      if (recent.length === 0) {
        this.db.addMessage(conversationId, 'user', text, platform);
        const welcomeStr = 'Welcome to Nexus AI. To complete your system setup and personalize your experience, could you please provide your name, your local timezone, and the name you would prefer to call me?';
        this.db.addMessage(conversationId, 'assistant', welcomeStr, platform);
        if (onChunk) onChunk(welcomeStr);
        return { content: welcomeStr, conversationId };
      }
    }

    this.db.addMessage(conversationId, 'user', text, platform);
    const recentMessages = this.db.getRecentMessages(conversationId, this.contextWindow);
    const contextMessages = recentMessages.map(m => ({ role: m.role, content: m.content }));

    let systemContent = isNewUser
      ? 'You are currently onboarding a new user. The user has replied to your formal setup question. Your ONLY TASK is to use the manage_workspace_file tool to create USER.md (storing their name and timezone) and SOUL.md (storing the name they assigned to you, and your identity). You must use the tool. Start now.'
      : await PromptLoader.getSystemPrompt(platform, platformUserId);

    systemContent += this._retrieveMemoryBlock(text, platform, platformUserId);

    contextMessages.unshift({ role: 'system', content: systemContent });

    const initialResponse = await this.ai.chatStream(contextMessages, onChunk);
    const finalResponse = await this._handleToolLoop(initialResponse, contextMessages, conversationId, platform, platformUserId, onChunk);

    if (this.autoTitle && recentMessages.length <= 2) {
      this._generateTitle(conversationId, text).catch(() => {});
    }

    return { content: finalResponse.content, conversationId };
  }

  async processWebMessage(text, conversationId = null) {
    if (!conversationId) {
      conversationId = this.db.createConversation('web', null, 'New Conversation');
    }

    const pendingRes = await this._tryResumePending(text, conversationId, 'web', null);
    if (pendingRes) {
      const conv = this.db.getConversation(conversationId);
      if (this.autoTitle && conv.title === 'New Conversation') {
        this._generateTitle(conversationId, text).catch(() => {});
      }
      return pendingRes;
    }

    this.db.addMessage(conversationId, 'user', text, 'web');
    const recentMessages = this.db.getRecentMessages(conversationId, this.contextWindow);
    const contextMessages = recentMessages.map(m => ({ role: m.role, content: m.content }));

    let systemContent = await PromptLoader.getSystemPrompt('web', null);
    systemContent += this._retrieveMemoryBlock(text, 'web', null);
    contextMessages.unshift({ role: 'system', content: systemContent });

    const initialResponse = await this.ai.chat(contextMessages);
    const finalResponse = await this._handleToolLoop(initialResponse, contextMessages, conversationId, 'web', null);

    const conv = this.db.getConversation(conversationId);
    if (this.autoTitle && conv.title === 'New Conversation') {
      this._generateTitle(conversationId, text).catch(() => {});
    }

    return { content: finalResponse.content, conversationId, usage: finalResponse.usage || { totalTokens: 0 } };
  }

  async processWebMessageStream(text, conversationId, onChunk) {
    if (!conversationId) {
      conversationId = this.db.createConversation('web', null, 'New Conversation');
    }

    const pendingRes = await this._tryResumePending(text, conversationId, 'web', null, onChunk);
    if (pendingRes) {
      const conv = this.db.getConversation(conversationId);
      if (this.autoTitle && conv.title === 'New Conversation') {
        this._generateTitle(conversationId, text).catch(() => {});
      }
      return pendingRes;
    }

    this.db.addMessage(conversationId, 'user', text, 'web');
    const recentMessages = this.db.getRecentMessages(conversationId, this.contextWindow);
    const contextMessages = recentMessages.map(m => ({ role: m.role, content: m.content }));

    let systemContent = await PromptLoader.getSystemPrompt('web', null);
    systemContent += this._retrieveMemoryBlock(text, 'web', null);
    contextMessages.unshift({ role: 'system', content: systemContent });

    const initialResponse = await this.ai.chatStream(contextMessages, onChunk);
    const finalResponse = await this._handleToolLoop(initialResponse, contextMessages, conversationId, 'web', null, onChunk);

    const conv = this.db.getConversation(conversationId);
    if (this.autoTitle && conv.title === 'New Conversation') {
      this._generateTitle(conversationId, text).catch(() => {});
    }

    return { content: finalResponse.content, conversationId };
  }

  async _generateTitle(conversationId, firstMessage) {
    try {
      const response = await this.ai.chat([
        { role: 'user', content: `Generate a short, concise title (4-6 words max) for a conversation that starts with: "${firstMessage.substring(0, 200)}". Reply with ONLY the title, no quotes or punctuation.` }
      ], { maxTokens: 20, temperature: 0.3 });

      const title = response.content.trim().replace(/["'.]/g, '');
      if (title && title.length < 60) {
        this.db.updateConversationTitle(conversationId, title);
      }
    } catch (e) {
      // Non-critical — just keep default title
    }
  }

  getConversationHistory(conversationId) {
    return this.db.getMessages(conversationId);
  }

  listConversations(limit, offset, platform) {
    return this.db.listConversations(limit, offset, platform);
  }

  deleteConversation(conversationId) {
    this.db.deleteConversation(conversationId);
  }

  searchMessages(query) {
    return this.db.searchMessages(query);
  }
}

export default ConversationManager;

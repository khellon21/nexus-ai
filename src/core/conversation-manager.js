import { ToolExecutor } from './tools.js';

export class ConversationManager {
  constructor(database, aiEngine, options = {}) {
    this.db = database;
    this.ai = aiEngine;
    this.toolExecutor = new ToolExecutor(this);
    this.contextWindow = options.contextWindow || 20;
    this.autoTitle = options.autoTitle !== false;
  }

  async processMessage(text, platform, platformUserId, displayName = null) {
    // Get or create the session/conversation
    const session = this.db.getOrCreateSession(platform, platformUserId, displayName);
    const conversationId = session.conversation_id;

    // Store the user message
    this.db.addMessage(conversationId, 'user', text, platform);

    // Get conversation context
    const recentMessages = this.db.getRecentMessages(conversationId, this.contextWindow);
    const contextMessages = recentMessages.map(m => ({
      role: m.role,
      content: m.content
    }));

    // Tool loop
    let response = await this.ai.chat(contextMessages);
    
    while (response.tool_calls && response.tool_calls.length > 0) {
      // Append assistant's tool call message
      contextMessages.push({
        role: 'assistant',
        content: response.content || "",
        tool_calls: response.tool_calls
      });

      // Execute all tools
      for (const call of response.tool_calls) {
        const resultString = await this.toolExecutor.execute(call.function);
        contextMessages.push({
          role: 'tool',
          name: call.function.name,
          tool_call_id: call.id,
          content: resultString
        });
      }

      // Call AI again with tool results
      response = await this.ai.chat(contextMessages);
    }

    // Store the assistant response
    this.db.addMessage(conversationId, 'assistant', response.content, platform, response.usage.totalTokens);

    // Auto-generate title for new conversations
    if (this.autoTitle && recentMessages.length <= 2) {
      this._generateTitle(conversationId, text).catch(() => {});
    }

    return {
      content: response.content,
      conversationId,
      usage: response.usage
    };
  }

  async processMessageStream(text, platform, platformUserId, onChunk, displayName = null) {
    const session = this.db.getOrCreateSession(platform, platformUserId, displayName);
    const conversationId = session.conversation_id;

    this.db.addMessage(conversationId, 'user', text, platform);

    const recentMessages = this.db.getRecentMessages(conversationId, this.contextWindow);
    const contextMessages = recentMessages.map(m => ({
      role: m.role,
      content: m.content
    }));

    let response = await this.ai.chatStream(contextMessages, onChunk);

    // If tools are called during stream (which usually breaks streaming in some libs, but we fallback)
    // Most standard SDKs don't stream tool calls well in simple wrapeprs, 
    // but if tool_calls are returned, we handle them recursively using regular chat to resolve tools first.
    while (response.tool_calls && response.tool_calls.length > 0) {
      contextMessages.push({
        role: 'assistant',
        content: response.content || "",
        tool_calls: response.tool_calls
      });

      for (const call of response.tool_calls) {
        const resultString = await this.toolExecutor.execute(call.function);
        contextMessages.push({
          role: 'tool',
          name: call.function.name,
          tool_call_id: call.id,
          content: resultString
        });
      }
      // Re-stream the final answer
      response = await this.ai.chatStream(contextMessages, onChunk);
    }

    this.db.addMessage(conversationId, 'assistant', response.content, platform);

    if (this.autoTitle && recentMessages.length <= 2) {
      this._generateTitle(conversationId, text).catch(() => {});
    }

    return {
      content: response.content,
      conversationId
    };
  }

  async processWebMessage(text, conversationId = null) {
    if (!conversationId) {
      conversationId = this.db.createConversation('web', null, 'New Conversation');
    }

    this.db.addMessage(conversationId, 'user', text, 'web');

    const recentMessages = this.db.getRecentMessages(conversationId, this.contextWindow);
    const contextMessages = recentMessages.map(m => ({
      role: m.role,
      content: m.content
    }));

    let response = await this.ai.chat(contextMessages);
    
    while (response.tool_calls && response.tool_calls.length > 0) {
      contextMessages.push({
        role: 'assistant',
        content: response.content || "",
        tool_calls: response.tool_calls
      });

      for (const call of response.tool_calls) {
        const resultString = await this.toolExecutor.execute(call.function);
        contextMessages.push({
          role: 'tool',
          name: call.function.name,
          tool_call_id: call.id,
          content: resultString
        });
      }

      response = await this.ai.chat(contextMessages);
    }

    this.db.addMessage(conversationId, 'assistant', response.content, 'web', response.usage?.totalTokens || 0);

    const conv = this.db.getConversation(conversationId);
    if (this.autoTitle && conv.title === 'New Conversation') {
      this._generateTitle(conversationId, text).catch(() => {});
    }

    return {
      content: response.content,
      conversationId,
      usage: response.usage
    };
  }

  async processWebMessageStream(text, conversationId, onChunk) {
    if (!conversationId) {
      conversationId = this.db.createConversation('web', null, 'New Conversation');
    }

    this.db.addMessage(conversationId, 'user', text, 'web');

    const recentMessages = this.db.getRecentMessages(conversationId, this.contextWindow);
    const contextMessages = recentMessages.map(m => ({
      role: m.role,
      content: m.content
    }));

    let response = await this.ai.chatStream(contextMessages, onChunk);

    while (response.tool_calls && response.tool_calls.length > 0) {
      contextMessages.push({
        role: 'assistant',
        content: response.content || "",
        tool_calls: response.tool_calls
      });

      for (const call of response.tool_calls) {
        const resultString = await this.toolExecutor.execute(call.function);
        contextMessages.push({
          role: 'tool',
          name: call.function.name,
          tool_call_id: call.id,
          content: resultString
        });
      }

      response = await this.ai.chatStream(contextMessages, onChunk);
    }

    this.db.addMessage(conversationId, 'assistant', response.content, 'web');

    const conv = this.db.getConversation(conversationId);
    if (this.autoTitle && conv.title === 'New Conversation') {
      this._generateTitle(conversationId, text).catch(() => {});
    }

    return {
      content: response.content,
      conversationId
    };
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

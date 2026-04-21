import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import { EventEmitter } from 'events';
import { getToolsSchema } from './tools.js';

// ─── Provider Detection ─────────────────────────────────
function detectProvider(model) {
  if (!model) return 'openai';
  // Epic 1: Any `claude-*` model is routed to Anthropic.
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gemini')) return 'gemini';
  if (model.includes('/')) return 'nvidia';
  return 'openai';
}

// Voice microservice base URL (Epics 3 & 4).
const VOICE_SERVICE_URL =
  process.env.VOICE_SERVICE_URL || 'http://localhost:8808';

export class AIEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    this.openaiClient = null;
    this.geminiClient = null;
    this.nvidiaClient = null;
    this.anthropicClient = null; // Epic 1
    this.geminiModel = null;
    this.model = config.model || process.env.AI_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
    this.provider = config.provider || process.env.AI_PROVIDER || detectProvider(this.model);
    this.maxTokens = config.maxTokens || 4096;
    this.temperature = config.temperature || 0.7;
    this.systemPrompt = config.systemPrompt || process.env.SYSTEM_PROMPT ||
      'You are Nexus, a helpful, friendly, and knowledgeable personal AI assistant. You are concise but thorough.';

    // Optional lifecycle supervisor for the local Python voice service.
    // When set, every transcribe/synthesize call will (a) wait for the
    // service to be reachable, and (b) reset the service's idle timer.
    // Injected via setVoiceManager() from src/index.js so the engine
    // stays constructable without a manager for tests.
    this.voiceManager = config.voiceManager || null;
  }

  /** Attach/replace the VoiceProcessManager after construction. */
  setVoiceManager(manager) {
    this.voiceManager = manager || null;
  }

  initialize() {
    // Initialize OpenAI if we have a key (kept as a fallback even when another provider is primary).
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey && openaiKey !== 'sk-your-key-here') {
      this.openaiClient = new OpenAI({ apiKey: openaiKey });
    }

    // Initialize Gemini if configured
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      this.geminiClient = new GoogleGenerativeAI(geminiKey);
      this.geminiModel = this.geminiClient.getGenerativeModel({
        model: this.provider === 'gemini' ? this.model : 'gemini-2.0-flash'
      });
    }

    // Initialize NVIDIA if configured
    const nvidiaKey = process.env.NVIDIA_API_KEY;
    if (nvidiaKey) {
      this.nvidiaClient = new OpenAI({
        apiKey: nvidiaKey,
        baseURL: 'https://integrate.api.nvidia.com/v1'
      });
    }

    // Epic 1: Initialize Anthropic (Claude) if configured.
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey && anthropicKey !== 'sk-ant-your-key-here') {
      this.anthropicClient = new Anthropic({ apiKey: anthropicKey });
    }

    // Validate that the chosen provider has credentials
    if (this.provider === 'openai' && !this.openaiClient) {
      throw new Error('OpenAI provider selected but OPENAI_API_KEY is not set. Run `npm run setup`.');
    }
    if (this.provider === 'gemini' && !this.geminiClient) {
      throw new Error('Gemini provider selected but GEMINI_API_KEY is not set. Run `npm run setup`.');
    }
    if (this.provider === 'nvidia' && !this.nvidiaClient) {
      throw new Error('NVIDIA provider selected but NVIDIA_API_KEY is not set. Run `npm run setup`.');
    }
    if (this.provider === 'anthropic' && !this.anthropicClient) {
      throw new Error('Anthropic provider selected but ANTHROPIC_API_KEY is not set. Run `npm run setup`.');
    }

    const providerLabel =
      this.provider === 'gemini' ? 'Google Gemini'
        : this.provider === 'nvidia' ? 'NVIDIA NIM'
          : this.provider === 'anthropic' ? 'Anthropic Claude'
            : 'OpenAI';
    console.log(`  ✓ AI Engine initialized (${providerLabel}: ${this.model})`);
  }

  // ─── Chat (non-streaming) ─────────────────────────────

  async chat(messages, options = {}) {
    const model = options.model || this.model;
    const provider = detectProvider(model);

    if (provider === 'gemini') return this._geminiChat(messages, { ...options, model });
    if (provider === 'anthropic') return this._claudeChat(messages, { ...options, model }); // Epic 1
    return this._openaiChat(messages, provider, { ...options, model });
  }

  async _openaiChat(messages, provider, options = {}) {
    const client = provider === 'nvidia' ? this.nvidiaClient : this.openaiClient;
    if (!client) throw new Error(`${provider} client not initialized`);

    // If caller already injected a `system` role message (e.g., from the
    // ConversationManager with dynamic memory), use it. Otherwise fall back
    // to the engine's default system prompt.
    const hasSystem = messages.some(m => m.role === 'system');
    const formattedMessages = hasSystem
      ? messages.map(m => ({ ...m }))
      : [{ role: 'system', content: this.systemPrompt }, ...messages.map(m => {
        const msg = { role: m.role, content: m.content };
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        if (m.name) msg.name = m.name;
        return msg;
      })];

    const tools = getToolsSchema('openai');

    try {
      const response = await client.chat.completions.create({
        model: options.model || this.model,
        messages: formattedMessages,
        max_tokens: options.maxTokens || this.maxTokens,
        temperature: options.temperature || this.temperature,
        tools: tools,
        tool_choice: 'auto'
      });

      const messageObj = response.choices[0]?.message;
      const reply = messageObj?.content || '';
      const usage = response.usage;
      const toolCalls = messageObj?.tool_calls || null;

      return {
        content: reply,
        tool_calls: toolCalls,
        model: response.model,
        provider: provider,
        usage: {
          promptTokens: usage?.prompt_tokens || 0,
          completionTokens: usage?.completion_tokens || 0,
          totalTokens: usage?.total_tokens || 0
        }
      };
    } catch (error) {
      if (error.status === 401) throw new Error(`Invalid ${provider === 'nvidia' ? 'NVIDIA' : 'OpenAI'} API key. Run \`npm run setup\`.`);
      if (error.status === 429) throw new Error(`${provider === 'nvidia' ? 'NVIDIA NIM' : 'OpenAI'} rate limit reached. Please wait.`);
      throw error;
    }
  }

  async _geminiChat(messages, options = {}) {
    if (!this.geminiClient) throw new Error('Gemini client not initialized');

    const modelName = options.model || this.model;
    const genModel = this.geminiClient.getGenerativeModel({ model: modelName });

    // Extract system content — prefer a caller-injected system message, otherwise use default.
    const systemMessages = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const systemInstruction = systemMessages || this.systemPrompt;

    // Build Gemini conversation history (system is passed separately)
    const history = [];
    const geminiMessages = messages.filter(m => m.role !== 'system');

    for (const msg of geminiMessages) {
      if (msg.role === 'tool') {
        history.push({
          role: 'function',
          parts: [{ functionResponse: { name: msg.name, response: { content: msg.content } } }]
        });
      } else if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const parts = [];
          if (msg.content) parts.push({ text: msg.content });
          for (const call of msg.tool_calls) {
            try {
              parts.push({ functionCall: { name: call.function.name, args: JSON.parse(call.function.arguments || '{}') } });
            } catch (e) {}
          }
          history.push({ role: 'model', parts });
        } else {
          history.push({ role: 'model', parts: [{ text: msg.content || '' }] });
        }
      } else {
        history.push({ role: 'user', parts: [{ text: msg.content || '' }] });
      }
    }

    const lastMsg = history.length > 0 && (history[history.length - 1].role === 'user' || history[history.length - 1].role === 'function')
      ? history.pop() : null;

    if (!lastMsg) throw new Error('No user message to send');

    const tools = getToolsSchema('gemini');

    try {
      const chat = genModel.startChat({
        history,
        systemInstruction: { parts: [{ text: systemInstruction }] },
        tools: [{ functionDeclarations: tools }],
        generationConfig: {
          maxOutputTokens: options.maxTokens || this.maxTokens,
          temperature: options.temperature || this.temperature,
        }
      });

      const result = await chat.sendMessage(lastMsg.parts);
      const text = result.response.text();
      const functionCalls = result.response.functionCalls();
      const usageMetadata = result.response.usageMetadata || {};

      let formattedToolCalls = null;
      if (functionCalls && functionCalls.length > 0) {
        formattedToolCalls = functionCalls.map(fc => ({
          id: Math.random().toString(36).substring(7),
          type: 'function',
          function: {
            name: fc.name,
            arguments: JSON.stringify(fc.args)
          }
        }));
      }

      return {
        content: text,
        tool_calls: formattedToolCalls,
        model: modelName,
        provider: 'gemini',
        usage: {
          promptTokens: usageMetadata.promptTokenCount || 0,
          completionTokens: usageMetadata.candidatesTokenCount || 0,
          totalTokens: usageMetadata.totalTokenCount || 0
        }
      };
    } catch (error) {
      if (error.message?.includes('API_KEY_INVALID')) {
        throw new Error('Invalid Gemini API key. Run `npm run setup`.');
      }
      if (error.message?.includes('429')) {
        throw new Error('Google Gemini API Quota Exceeded.\n\nYour account is restricted to a "Limit: 0". To fix this, you must go to https://aistudio.google.com/ and set up a billing account (you will still receive the free tier, but a card is required for verification in your region).');
      }
      if (error.message?.includes('RESOURCE_EXHAUSTED')) {
        throw new Error('Gemini rate limit reached. Please wait.');
      }
      throw error;
    }
  }

  // ─── Epic 1: Anthropic (Claude) Chat ─────────────────────────────
  /**
   * Claude chat completion. This handles the full round-trip between
   * Nexus's internal OpenAI-style message format and Anthropic's
   * tool_use / tool_result content-block format.
   *
   * Incoming messages we may see:
   *   { role: 'system', content: '...' }                        ← extracted into `system`
   *   { role: 'user', content: '...' }
   *   { role: 'assistant', content: '...', tool_calls: [...] }  ← translated to `tool_use` blocks
   *   { role: 'tool', tool_call_id, name, content }             ← translated to `tool_result`
   *   { role: 'user', content: [{type:'tool_result', ...}] }    ← ConversationManager pre-formatted (Epic 1)
   */
  async _claudeChat(messages, options = {}) {
    if (!this.anthropicClient) throw new Error('Anthropic client not initialized');

    // 1) Extract system prompt(s) — Anthropic takes `system` as a top-level param.
    const systemParts = messages.filter(m => m.role === 'system').map(m => m.content).filter(Boolean);
    const systemPrompt = systemParts.length ? systemParts.join('\n\n') : this.systemPrompt;

    // 2) Translate the remaining messages into Anthropic's shape.
    const anthropicMessages = [];
    for (const msg of messages) {
      if (msg.role === 'system') continue;

      // Tool result emitted in OpenAI-style by legacy code paths.
      if (msg.role === 'tool') {
        anthropicMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
          }]
        });
        continue;
      }

      // Assistant turn: may include text + tool_use blocks.
      if (msg.role === 'assistant') {
        const blocks = [];
        if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
          blocks.push({ type: 'text', text: msg.content });
        } else if (Array.isArray(msg.content)) {
          // Already in Anthropic block format — trust it.
          blocks.push(...msg.content);
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const call of msg.tool_calls) {
            let input = {};
            try { input = JSON.parse(call.function.arguments || '{}'); } catch (e) {}
            blocks.push({
              type: 'tool_use',
              id: call.id,
              name: call.function.name,
              input
            });
          }
        }
        if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
        anthropicMessages.push({ role: 'assistant', content: blocks });
        continue;
      }

      // User turn. Content may already be a tool_result block array (from
      // ConversationManager's Claude-aware tool loop, per Epic 1 spec).
      if (msg.role === 'user') {
        anthropicMessages.push({
          role: 'user',
          content: Array.isArray(msg.content)
            ? msg.content
            : (msg.content ?? '')
        });
      }
    }

    // 3) Translate Nexus's standard tool schemas into Anthropic's `input_schema` shape.
    const tools = this._mapToolsForClaude(getToolsSchema('openai'));

    try {
      const response = await this.anthropicClient.messages.create({
        model: options.model || this.model,
        max_tokens: options.maxTokens || this.maxTokens,
        temperature: options.temperature ?? this.temperature,
        system: systemPrompt,
        messages: anthropicMessages,
        tools
      });

      // 4) Unwrap Claude's response → Nexus's {content, tool_calls} shape.
      let text = '';
      let toolCalls = null;
      if (Array.isArray(response.content)) {
        for (const block of response.content) {
          if (block.type === 'text') text += block.text;
          if (block.type === 'tool_use') {
            toolCalls = toolCalls || [];
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input ?? {})
              }
            });
          }
        }
      }

      // Claude signals "I want to call tools" with stop_reason === 'tool_use'.
      // If that's the case but we somehow parsed no tool blocks, that's a bug upstream.
      if (response.stop_reason === 'tool_use' && !toolCalls) {
        console.warn('  ⚠ Claude returned stop_reason=tool_use but no tool_use blocks were parsed.');
      }

      const usage = response.usage || {};
      return {
        content: text,
        tool_calls: toolCalls,
        model: response.model,
        provider: 'anthropic',
        stop_reason: response.stop_reason,
        usage: {
          promptTokens: usage.input_tokens || 0,
          completionTokens: usage.output_tokens || 0,
          totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
        }
      };
    } catch (error) {
      if (error.status === 401) throw new Error('Invalid Anthropic API key. Run `npm run setup`.');
      if (error.status === 429) throw new Error('Anthropic rate limit reached. Please wait.');
      if (error.status === 400) throw new Error(`Anthropic request rejected: ${error.message}`);
      throw error;
    }
  }

  /**
   * Map Nexus's OpenAI-style tool schemas to Anthropic's `input_schema` format.
   * OpenAI: { type:'function', function:{ name, description, parameters } }
   * Claude: { name, description, input_schema }
   */
  _mapToolsForClaude(openaiTools) {
    return openaiTools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      // Anthropic expects a JSON Schema under `input_schema`.
      input_schema: t.function.parameters && Object.keys(t.function.parameters).length
        ? t.function.parameters
        : { type: 'object', properties: {} }
    }));
  }

  // ─── Chat Stream ──────────────────────────────────────

  async chatStream(messages, onChunk, options = {}) {
    const model = options.model || this.model;
    const provider = detectProvider(model);

    if (provider === 'gemini') return this._geminiChatStream(messages, onChunk, { ...options, model });
    if (provider === 'anthropic') return this._claudeChatStream(messages, onChunk, { ...options, model });
    return this._openaiChatStream(messages, provider, onChunk, { ...options, model });
  }

  async _openaiChatStream(messages, provider, onChunk, options = {}) {
    const client = provider === 'nvidia' ? this.nvidiaClient : this.openaiClient;
    if (!client) throw new Error(`${provider} client not initialized`);

    const hasSystem = messages.some(m => m.role === 'system');
    const formattedMessages = hasSystem
      ? messages.map(m => ({ ...m }))
      : [{ role: 'system', content: this.systemPrompt }, ...messages.map(m => {
        const msg = { role: m.role, content: m.content };
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        if (m.name) msg.name = m.name;
        return msg;
      })];

    try {
      const stream = await client.chat.completions.create({
        model: options.model || this.model,
        messages: formattedMessages,
        max_tokens: options.maxTokens || this.maxTokens,
        temperature: options.temperature || this.temperature,
        tools: getToolsSchema('openai'),
        tool_choice: 'auto',
        stream: true
      });

      let fullContent = '';
      let toolCallsList = [];

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          fullContent += delta.content;
          if (onChunk) onChunk(delta.content, fullContent);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallsList[idx]) {
              toolCallsList[idx] = { id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments || '' } };
            } else {
              toolCallsList[idx].function.arguments += (tc.function.arguments || '');
            }
          }
        }
      }

      const formattedToolCalls = toolCallsList.length > 0 ? toolCallsList.filter(Boolean) : null;
      return { content: fullContent, tool_calls: formattedToolCalls, provider: 'openai' };
    } catch (error) {
      if (error.status === 401) throw new Error('Invalid OpenAI API key. Run `npm run setup`.');
      throw error;
    }
  }

  async _geminiChatStream(messages, onChunk, options = {}) {
    if (!this.geminiClient) throw new Error('Gemini client not initialized');

    const modelName = options.model || this.model;
    const genModel = this.geminiClient.getGenerativeModel({ model: modelName });

    const systemMessages = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const systemInstruction = systemMessages || this.systemPrompt;

    const history = [];
    const geminiMessages = messages.filter(m => m.role !== 'system');

    for (const msg of geminiMessages) {
      if (msg.role === 'tool') {
        history.push({
          role: 'function',
          parts: [{ functionResponse: { name: msg.name, response: { content: msg.content } } }]
        });
      } else if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const parts = [];
          if (msg.content) parts.push({ text: msg.content });
          for (const call of msg.tool_calls) {
            try {
              parts.push({ functionCall: { name: call.function.name, args: JSON.parse(call.function.arguments || '{}') } });
            } catch (e) {}
          }
          history.push({ role: 'model', parts });
        } else {
          history.push({ role: 'model', parts: [{ text: msg.content || '' }] });
        }
      } else {
        history.push({ role: 'user', parts: [{ text: msg.content || '' }] });
      }
    }

    const lastMsg = history.length > 0 && (history[history.length - 1].role === 'user' || history[history.length - 1].role === 'function')
      ? history.pop() : null;

    if (!lastMsg) throw new Error('No user message to send');

    const tools = getToolsSchema('gemini');

    try {
      const chat = genModel.startChat({
        history,
        systemInstruction: { parts: [{ text: systemInstruction }] },
        tools: [{ functionDeclarations: tools }],
        generationConfig: {
          maxOutputTokens: options.maxTokens || this.maxTokens,
          temperature: options.temperature || this.temperature,
        }
      });

      const result = await chat.sendMessageStream(lastMsg.parts);

      let fullContent = '';
      let functionCalls = [];

      for await (const chunk of result.stream) {
        const fCalls = chunk.functionCalls();
        if (fCalls && fCalls.length > 0) functionCalls.push(...fCalls);
        try {
          const text = chunk.text();
          if (text) {
            fullContent += text;
            if (onChunk) onChunk(text, fullContent);
          }
        } catch (e) {} // chunk.text() throws if it's only a function call
      }

      let formattedToolCalls = null;
      if (functionCalls.length > 0) {
        formattedToolCalls = functionCalls.map(fc => ({
          id: Math.random().toString(36).substring(7),
          type: 'function',
          function: { name: fc.name, arguments: JSON.stringify(fc.args) }
        }));
      }

      return { content: fullContent, tool_calls: formattedToolCalls, provider: 'gemini' };
    } catch (error) {
      if (error.message?.includes('API_KEY_INVALID')) {
        throw new Error('Invalid Gemini API key. Run `npm run setup`.');
      }
      if (error.message?.includes('429')) {
        throw new Error('Google Gemini API Quota Exceeded.\n\nYour account is restricted to a "Limit: 0". To fix this, you must go to https://aistudio.google.com/ and set up a billing account (you will still receive the free tier, but a card is required for verification in your region).');
      }
      throw error;
    }
  }

  /**
   * Epic 1: Claude streaming. We use the SDK's `.stream()` helper so we can
   * incrementally forward text deltas to `onChunk`, then assemble the
   * final response in the same standard {content, tool_calls} shape.
   */
  async _claudeChatStream(messages, onChunk, options = {}) {
    if (!this.anthropicClient) throw new Error('Anthropic client not initialized');

    // Reuse the same translation logic as non-streaming by calling into it
    // with a controlled options object, and piping deltas out. Simpler:
    // just call the SDK directly here.
    const systemParts = messages.filter(m => m.role === 'system').map(m => m.content).filter(Boolean);
    const systemPrompt = systemParts.length ? systemParts.join('\n\n') : this.systemPrompt;

    const anthropicMessages = [];
    for (const msg of messages) {
      if (msg.role === 'system') continue;
      if (msg.role === 'tool') {
        anthropicMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
          }]
        });
        continue;
      }
      if (msg.role === 'assistant') {
        const blocks = [];
        if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
          blocks.push({ type: 'text', text: msg.content });
        } else if (Array.isArray(msg.content)) {
          blocks.push(...msg.content);
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const call of msg.tool_calls) {
            let input = {};
            try { input = JSON.parse(call.function.arguments || '{}'); } catch (e) {}
            blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
          }
        }
        if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
        anthropicMessages.push({ role: 'assistant', content: blocks });
        continue;
      }
      if (msg.role === 'user') {
        anthropicMessages.push({
          role: 'user',
          content: Array.isArray(msg.content) ? msg.content : (msg.content ?? '')
        });
      }
    }

    const tools = this._mapToolsForClaude(getToolsSchema('openai'));

    try {
      const stream = this.anthropicClient.messages.stream({
        model: options.model || this.model,
        max_tokens: options.maxTokens || this.maxTokens,
        temperature: options.temperature ?? this.temperature,
        system: systemPrompt,
        messages: anthropicMessages,
        tools
      });

      let fullContent = '';
      stream.on('text', (chunkText) => {
        fullContent += chunkText;
        if (onChunk) onChunk(chunkText, fullContent);
      });

      const final = await stream.finalMessage();

      let toolCalls = null;
      if (Array.isArray(final.content)) {
        for (const block of final.content) {
          if (block.type === 'tool_use') {
            toolCalls = toolCalls || [];
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input ?? {})
              }
            });
          }
        }
      }

      const usage = final.usage || {};
      return {
        content: fullContent,
        tool_calls: toolCalls,
        provider: 'anthropic',
        stop_reason: final.stop_reason,
        usage: {
          promptTokens: usage.input_tokens || 0,
          completionTokens: usage.output_tokens || 0,
          totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
        }
      };
    } catch (error) {
      if (error.status === 401) throw new Error('Invalid Anthropic API key. Run `npm run setup`.');
      if (error.status === 429) throw new Error('Anthropic rate limit reached. Please wait.');
      throw error;
    }
  }

  // ─── Voice ─────────────────────────────────────────────
  // Epics 3 & 4: STT and TTS are now served by a local FastAPI microservice
  // at VOICE_SERVICE_URL (default http://localhost:8808). No cloud keys required.

  /**
   * Epic 3: Transcribe audio via the local Faster-Whisper service.
   * @param {Buffer|Uint8Array} audioBuffer - raw bytes of an audio file.
   * @param {string} filename - filename hint for MIME detection (e.g. voice.ogg).
   * @returns {Promise<string>} transcribed text.
   */
  async transcribeAudio(audioBuffer, filename = 'audio.webm') {
    // If a lifecycle manager is attached, ensure the Python service is awake
    // (lazy-spawn + /health ping) before we send any bytes at it.
    const baseUrl = await this._ensureVoiceReady();

    // Build multipart form data compatible with UploadFile on the Python side.
    const form = new FormData();
    const mime = this._guessAudioMime(filename);
    form.append('file', new Blob([audioBuffer], { type: mime }), filename);

    let resp;
    try {
      resp = await fetch(`${baseUrl}/transcribe`, {
        method: 'POST',
        body: form
      });
    } catch (err) {
      // Connection failed — the child may have died between our health ping
      // and this request (e.g. a VoxCPM import segfault). Tell the manager
      // so the next call triggers a fresh cold-start instead of hitting the
      // same corpse again.
      await this._reportVoiceFetchFailure(err);
      throw new Error(
        `Voice service unreachable at ${baseUrl} (${err.message}). ` +
        `The Python TTS/STT service is started automatically by Nexus — ` +
        `do NOT launch it manually. Check your npm start logs for [voice-py] ` +
        `errors. Most common cause: \`pip install fastapi uvicorn python-multipart ` +
        `faster-whisper voxcpm soundfile numpy\` hasn't been run.`
      );
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`STT failed (${resp.status}): ${body}`);
    }

    const data = await resp.json();
    // Reset the idle-shutdown timer ONLY after a successful round-trip — a
    // failed request shouldn't keep a stuck service alive.
    this.voiceManager?.markActivity?.();
    return data.text || '';
  }

  /**
   * Epic 4: Synthesize speech via the local VoxCPM2 service.
   * @param {string} text
   * @param {object} options
   * @param {string} [options.referenceWavPath] absolute path to a reference wav for voice cloning.
   * @returns {Promise<Buffer>} WAV audio bytes.
   */
  async textToSpeech(text, options = {}) {
    if (!text || !text.trim()) throw new Error('textToSpeech requires non-empty text');

    const baseUrl = await this._ensureVoiceReady();

    let resp;
    try {
      resp = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          reference_wav_path: options.referenceWavPath || null,
          cfg_value: options.cfgValue ?? 2.0,
          inference_timesteps: options.inferenceTimesteps ?? 10
        })
      });
    } catch (err) {
      await this._reportVoiceFetchFailure(err);
      throw new Error(
        `Voice service unreachable at ${baseUrl} (${err.message}). ` +
        `The Python TTS/STT service is started automatically by Nexus — ` +
        `do NOT launch it manually. Check your npm start logs for [voice-py] ` +
        `errors. Most common cause: \`pip install fastapi uvicorn python-multipart ` +
        `faster-whisper voxcpm soundfile numpy\` hasn't been run.`
      );
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`TTS failed (${resp.status}): ${body}`);
    }

    const arrayBuf = await resp.arrayBuffer();
    this.voiceManager?.markActivity?.();
    return Buffer.from(arrayBuf);
  }

  /**
   * Self-healing hook: when a voice fetch fails mid-session (ECONNREFUSED,
   * connection reset, etc.), ask the manager to tear down whatever corpse
   * is still on file so the next ensureAwake() respawns cleanly instead
   * of assuming the process is still healthy. No-op without a manager.
   */
  async _reportVoiceFetchFailure(err) {
    const mgr = this.voiceManager;
    if (!mgr) return;
    // Only bother killing if we still think the child is alive — otherwise
    // the manager already knows and the next ensureAwake will respawn.
    if (mgr.isRunning) {
      try {
        await mgr.shutdown({ reason: 'fetch-failed' });
        // Allow a fresh cold start next time.
        mgr._shuttingDown = false;
      } catch { /* best-effort */ }
    }
  }

  /**
   * If a VoiceProcessManager is attached, block until the service is
   * reachable and return its baseUrl. Otherwise fall back to the
   * environment-configured VOICE_SERVICE_URL (legacy path).
   */
  async _ensureVoiceReady() {
    if (this.voiceManager) {
      try {
        const { baseUrl } = await this.voiceManager.ensureAwake();
        return baseUrl;
      } catch (err) {
        // Surface the manager's diagnostic message (stderr, hint, etc.) rather
        // than letting the caller fall through to a generic "fetch failed".
        throw new Error(`Voice service cold-start failed — ${err.message}`);
      }
    }
    return VOICE_SERVICE_URL;
  }

  _guessAudioMime(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    return {
      ogg: 'audio/ogg',
      oga: 'audio/ogg',
      opus: 'audio/ogg',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      webm: 'audio/webm',
      m4a: 'audio/mp4',
    }[ext] || 'application/octet-stream';
  }

  // ─── Validation ────────────────────────────────────────

  async validateOpenAIKey(apiKey) {
    try {
      const testClient = new OpenAI({ apiKey });
      await testClient.models.list();
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  async validateGeminiKey(apiKey) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      await model.generateContent('Hello');
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  async validateAnthropicKey(apiKey) {
    try {
      const testClient = new Anthropic({ apiKey });
      // A tiny `messages.create` is the cheapest validity probe.
      await testClient.messages.create({
        model: 'claude-3-5-haiku-latest',
        max_tokens: 4,
        messages: [{ role: 'user', content: 'hi' }]
      });
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  // Keep backwards compat
  async validateApiKey(apiKey) {
    return this.validateOpenAIKey(apiKey);
  }

  // ─── Info ──────────────────────────────────────────────

  getProviderInfo() {
    return {
      provider: this.provider,
      model: this.model,
      hasOpenAI: !!this.openaiClient,
      hasGemini: !!this.geminiClient,
      hasAnthropic: !!this.anthropicClient,
      voiceServiceUrl: VOICE_SERVICE_URL
    };
  }
}

export default AIEngine;

import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { EventEmitter } from 'events';
import { getToolsSchema } from './tools.js';

// ─── Provider Detection ─────────────────────────────────
function detectProvider(model) {
  if (model.startsWith('gemini')) return 'gemini';
  if (model.includes('/')) return 'nvidia';
  return 'openai';
}

export class AIEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    this.openaiClient = null;
    this.geminiClient = null;
    this.nvidiaClient = null;
    this.geminiModel = null;
    this.model = config.model || process.env.AI_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
    this.provider = config.provider || process.env.AI_PROVIDER || detectProvider(this.model);
    this.maxTokens = config.maxTokens || 4096;
    this.temperature = config.temperature || 0.7;
    this.systemPrompt = config.systemPrompt || process.env.SYSTEM_PROMPT || 
      'You are Nexus, a helpful, friendly, and knowledgeable personal AI assistant. You are concise but thorough.';
  }

  initialize() {
    // Initialize OpenAI if we have a key (needed for voice even when using Gemini)
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

    const providerLabel = this.provider === 'gemini' ? 'Google Gemini' : (this.provider === 'nvidia' ? 'NVIDIA NIM' : 'OpenAI');
    console.log(`  ✓ AI Engine initialized (${providerLabel}: ${this.model})`);
  }

  // ─── Chat (non-streaming) ─────────────────────────────

  async chat(messages, options = {}) {
    const model = options.model || this.model;
    const provider = detectProvider(model);

    if (provider === 'gemini') {
      return this._geminiChat(messages, { ...options, model });
    }
    return this._openaiChat(messages, provider, { ...options, model });
  }

  async _openaiChat(messages, provider, options = {}) {
    const client = provider === 'nvidia' ? this.nvidiaClient : this.openaiClient;
    if (!client) throw new Error(`${provider} client not initialized`);

    const systemMessage = { role: 'system', content: this.systemPrompt };
    const formattedMessages = [systemMessage, ...messages.map(m => {
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
        tool_choice: "auto"
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

    // Build Gemini conversation history
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

    // Pop the last message to use as the prompt (can be user text or function response)
    const lastMsg = history.length > 0 && (history[history.length - 1].role === 'user' || history[history.length - 1].role === 'function')
      ? history.pop() : null;

    if (!lastMsg) throw new Error('No user message to send');

    const tools = getToolsSchema('gemini');

    try {
      const chat = genModel.startChat({
        history,
        systemInstruction: { parts: [{ text: this.systemPrompt }] },
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

  // ─── Chat Stream ──────────────────────────────────────

  async chatStream(messages, onChunk, options = {}) {
    const model = options.model || this.model;
    const provider = detectProvider(model);

    if (provider === 'gemini') {
      return this._geminiChatStream(messages, onChunk, { ...options, model });
    }
    return this._openaiChatStream(messages, provider, onChunk, { ...options, model });
  }

  async _openaiChatStream(messages, provider, onChunk, options = {}) {
    const client = provider === 'nvidia' ? this.nvidiaClient : this.openaiClient;
    if (!client) throw new Error(`${provider} client not initialized`);

    const systemMessage = { role: 'system', content: this.systemPrompt };
    const formattedMessages = [systemMessage, ...messages.map(m => {
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
        tool_choice: "auto",
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
        systemInstruction: { parts: [{ text: this.systemPrompt }] },
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
        if (fCalls && fCalls.length > 0) {
           functionCalls.push(...fCalls);
        }
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

  // ─── Voice (always uses OpenAI — Whisper + TTS) ────────

  async transcribeAudio(audioBuffer, filename = 'audio.webm') {
    if (!this.openaiClient) {
      throw new Error('Voice requires an OpenAI API key (for Whisper). Add OPENAI_API_KEY in .env.');
    }

    const file = new File([audioBuffer], filename, { type: 'audio/webm' });
    
    const transcription = await this.openaiClient.audio.transcriptions.create({
      model: 'whisper-1',
      file: file,
    });

    return transcription.text;
  }

  async textToSpeech(text, options = {}) {
    if (!this.openaiClient) {
      throw new Error('Voice requires an OpenAI API key (for TTS). Add OPENAI_API_KEY in .env.');
    }

    const voice = options.voice || process.env.VOICE_NAME || 'alloy';
    const model = options.model || process.env.VOICE_MODEL || 'tts-1';

    const response = await this.openaiClient.audio.speech.create({
      model,
      voice,
      input: text,
      response_format: 'mp3'
    });

    return Buffer.from(await response.arrayBuffer());
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
      hasGemini: !!this.geminiClient
    };
  }
}

export default AIEngine;

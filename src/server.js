import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function createWebServer(conversationManager, voiceAdapter, adapterStatuses) {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Middleware
  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(join(__dirname, '..', 'public')));

  const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 } // 25MB max for audio
  });

  // ─── REST API ──────────────────────────────────────────

  // List conversations
  app.get('/api/conversations', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const offset = parseInt(req.query.offset) || 0;
      const platform = req.query.platform || null;
      const conversations = conversationManager.listConversations(limit, offset, platform);
      res.json({ conversations });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get conversation messages
  app.get('/api/conversations/:id', (req, res) => {
    try {
      const messages = conversationManager.getConversationHistory(req.params.id);
      const conversation = conversationManager.db.getConversation(req.params.id);
      res.json({ conversation, messages });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Create new conversation
  app.post('/api/conversations', (req, res) => {
    try {
      const id = conversationManager.db.createConversation('web', null, req.body.title || 'New Conversation');
      res.json({ id });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Delete conversation
  app.delete('/api/conversations/:id', (req, res) => {
    try {
      conversationManager.deleteConversation(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Send message (non-streaming)
  app.post('/api/chat', async (req, res) => {
    try {
      const { message, conversationId } = req.body;
      if (!message) return res.status(400).json({ error: 'Message is required' });

      const response = await conversationManager.processWebMessage(message, conversationId);
      res.json(response);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Voice transcription
  app.post('/api/voice/transcribe', upload.single('audio'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No audio file provided' });
      if (!voiceAdapter || !voiceAdapter.enabled) {
        return res.status(400).json({ error: 'Voice is not enabled' });
      }

      const result = await voiceAdapter.transcribe(req.file.buffer, req.file.mimetype);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Text-to-speech
  app.post('/api/voice/synthesize', async (req, res) => {
    try {
      const { text, voice } = req.body;
      if (!text) return res.status(400).json({ error: 'Text is required' });
      if (!voiceAdapter || !voiceAdapter.enabled) {
        return res.status(400).json({ error: 'Voice is not enabled' });
      }

      const result = await voiceAdapter.synthesize(text, { voice });
      if (result.success) {
        res.set('Content-Type', 'audio/mpeg');
        res.send(result.audio);
      } else {
        res.status(500).json({ error: result.error });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Platform status
  app.get('/api/status', (req, res) => {
    const aiInfo = conversationManager.ai.getProviderInfo
      ? conversationManager.ai.getProviderInfo()
      : { provider: 'openai', model: 'unknown' };

    res.json({
      platforms: adapterStatuses(),
      ai: aiInfo,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    });
  });

  // Search messages
  app.get('/api/search', (req, res) => {
    try {
      const query = req.query.q;
      if (!query) return res.status(400).json({ error: 'Query parameter "q" is required' });
      const results = conversationManager.searchMessages(query);
      res.json({ results });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Stats
  app.get('/api/stats', (req, res) => {
    try {
      const stats = conversationManager.db.getStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── WebSocket (streaming chat) ────────────────────────

  wss.on('connection', (ws) => {
    console.log('  ↔ WebSocket client connected');

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'chat') {
          const { message, conversationId } = msg;
          
          // Send back new conversation ID if needed
          let activeConvId = conversationId;
          if (!activeConvId) {
            activeConvId = conversationManager.db.createConversation('web', null, 'New Conversation');
            ws.send(JSON.stringify({ type: 'conversation_created', conversationId: activeConvId }));
          }

          // Store user message and notify
          conversationManager.db.addMessage(activeConvId, 'user', message, 'web');
          ws.send(JSON.stringify({ type: 'user_message_stored', conversationId: activeConvId }));

          // Stream AI response
          const recentMessages = conversationManager.db.getRecentMessages(activeConvId, 20);
          const contextMessages = recentMessages.map(m => ({
            role: m.role,
            content: m.content
          }));

          let fullContent = '';
          try {
            await conversationManager.ai.chatStream(contextMessages, (chunk, full) => {
              fullContent = full;
              ws.send(JSON.stringify({ type: 'chunk', content: chunk }));
            });

            // Store assistant message
            conversationManager.db.addMessage(activeConvId, 'assistant', fullContent, 'web');
            ws.send(JSON.stringify({ type: 'done', conversationId: activeConvId, content: fullContent }));

            // Auto-title
            if (recentMessages.length <= 1) {
              conversationManager._generateTitle(activeConvId, message).then(() => {
                const conv = conversationManager.db.getConversation(activeConvId);
                if (conv) {
                  ws.send(JSON.stringify({ type: 'title_updated', conversationId: activeConvId, title: conv.title }));
                }
              }).catch(() => {});
            }
          } catch (aiError) {
            ws.send(JSON.stringify({ type: 'error', error: aiError.message }));
          }
        }
      } catch (error) {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid message format' }));
      }
    });

    ws.on('close', () => {
      console.log('  ↔ WebSocket client disconnected');
    });
  });

  return { app, server, wss };
}

export default createWebServer;

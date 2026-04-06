import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { v4 as uuidv4 } from 'uuid';

export class NexusDatabase {
  constructor(dbPath = './data/nexus.db') {
    this.dbPath = dbPath;
    this.db = null;
  }

  initialize() {
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._createTables();
    console.log('  ✓ Database initialized');
  }

  _createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT DEFAULT 'New Conversation',
        platform TEXT NOT NULL DEFAULT 'web',
        platform_user_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_archived INTEGER DEFAULT 0,
        metadata TEXT DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        platform TEXT DEFAULT 'web',
        tokens_used INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS platform_sessions (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        platform_user_id TEXT NOT NULL,
        conversation_id TEXT,
        display_name TEXT,
        last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
        metadata TEXT DEFAULT '{}',
        FOREIGN KEY (conversation_id) REFERENCES conversations(id),
        UNIQUE(platform, platform_user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_conversations_platform ON conversations(platform);
      CREATE INDEX IF NOT EXISTS idx_platform_sessions ON platform_sessions(platform, platform_user_id);
    `);
  }

  // ─── Conversations ─────────────────────────────────────

  createConversation(platform = 'web', platformUserId = null, title = null) {
    const id = uuidv4();
    const stmt = this.db.prepare(`
      INSERT INTO conversations (id, title, platform, platform_user_id)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(id, title || 'New Conversation', platform, platformUserId);
    return id;
  }

  getConversation(id) {
    return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  }

  listConversations(limit = 50, offset = 0, platform = null) {
    if (platform) {
      return this.db.prepare(`
        SELECT c.*, 
          (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count,
          (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message
        FROM conversations c
        WHERE c.platform = ? AND c.is_archived = 0
        ORDER BY c.updated_at DESC
        LIMIT ? OFFSET ?
      `).all(platform, limit, offset);
    }
    return this.db.prepare(`
      SELECT c.*, 
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count,
        (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message
      FROM conversations c
      WHERE c.is_archived = 0
      ORDER BY c.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  updateConversationTitle(id, title) {
    this.db.prepare('UPDATE conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(title, id);
  }

  deleteConversation(id) {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  // ─── Messages ──────────────────────────────────────────

  addMessage(conversationId, role, content, platform = 'web', tokensUsed = 0) {
    const id = uuidv4();
    this.db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, platform, tokens_used)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, conversationId, role, content, platform, tokensUsed);
    
    this.db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversationId);
    return id;
  }

  getMessages(conversationId, limit = 100) {
    return this.db.prepare(`
      SELECT * FROM messages 
      WHERE conversation_id = ? 
      ORDER BY created_at ASC 
      LIMIT ?
    `).all(conversationId, limit);
  }

  getRecentMessages(conversationId, count = 20) {
    const messages = this.db.prepare(`
      SELECT * FROM messages 
      WHERE conversation_id = ? 
      ORDER BY created_at DESC 
      LIMIT ?
    `).all(conversationId, count);
    return messages.reverse();
  }

  // ─── Platform Sessions ─────────────────────────────────

  getOrCreateSession(platform, platformUserId, displayName = null) {
    let session = this.db.prepare(
      'SELECT * FROM platform_sessions WHERE platform = ? AND platform_user_id = ?'
    ).get(platform, platformUserId);

    if (!session) {
      const conversationId = this.createConversation(platform, platformUserId, 
        displayName ? `${displayName} (${platform})` : `${platform} chat`);
      const id = uuidv4();
      this.db.prepare(`
        INSERT INTO platform_sessions (id, platform, platform_user_id, conversation_id, display_name)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, platform, platformUserId, conversationId, displayName);
      session = this.db.prepare('SELECT * FROM platform_sessions WHERE id = ?').get(id);
    } else {
      this.db.prepare(
        'UPDATE platform_sessions SET last_active = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(session.id);
    }

    return session;
  }

  // ─── Search ────────────────────────────────────────────

  searchMessages(query, limit = 20) {
    return this.db.prepare(`
      SELECT m.*, c.title as conversation_title, c.platform as conversation_platform
      FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE m.content LIKE ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(`%${query}%`, limit);
  }

  // ─── Stats ─────────────────────────────────────────────

  getStats() {
    const conversations = this.db.prepare('SELECT COUNT(*) as count FROM conversations').get();
    const messages = this.db.prepare('SELECT COUNT(*) as count FROM messages').get();
    const tokens = this.db.prepare('SELECT SUM(tokens_used) as total FROM messages').get();
    const platforms = this.db.prepare(
      'SELECT platform, COUNT(*) as count FROM conversations GROUP BY platform'
    ).all();

    return {
      totalConversations: conversations.count,
      totalMessages: messages.count,
      totalTokensUsed: tokens.total || 0,
      platformBreakdown: platforms
    };
  }

  close() {
    if (this.db) {
      this.db.close();
      console.log('  ✓ Database closed');
    }
  }
}

export default NexusDatabase;

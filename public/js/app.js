/* ═══════════════════════════════════════════════════════
   NEXUS AI — Frontend Application
   Real-time WebSocket chat with voice support
   ═══════════════════════════════════════════════════════ */

// ─── State ─────────────────────────────────────────────
let ws = null;
let currentConversationId = null;
let isStreaming = false;
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let conversations = [];

// ─── Initialization ────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  connectWebSocket();
  loadConversations();
  fetchPlatformStatus();
  
  // Auto-resize textarea
  const input = document.getElementById('message-input');
  input.addEventListener('input', () => {
    updateSendButton();
    autoResize(input);
  });

  // Refresh platform status every 30s
  setInterval(fetchPlatformStatus, 30000);
});

// ─── Model Display Helpers ─────────────────────────────
function getModelDisplayName(model) {
  const names = {
    'gpt-4o-mini': 'GPT-4o Mini',
    'gpt-4o': 'GPT-4o',
    'gpt-4-turbo': 'GPT-4 Turbo',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'gemini-2.5-flash': 'Gemini 2.5 Flash',
    'gemini-2.0-flash': 'Gemini 2.0 Flash',
    'gemini-2.0-flash-lite': 'Gemini 2.0 Flash Lite'
  };
  return names[model] || model;
}

function isGeminiModel(model) {
  return model && model.startsWith('gemini');
}

// ─── WebSocket ─────────────────────────────────────────
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    console.log('✦ Connected to Nexus AI');
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'conversation_created':
        currentConversationId = msg.conversationId;
        loadConversations();
        break;

      case 'user_message_stored':
        break;

      case 'chunk':
        appendStreamChunk(msg.content);
        break;

      case 'done':
        finishStream(msg.conversationId);
        break;

      case 'title_updated':
        updateConversationTitle(msg.conversationId, msg.title);
        break;

      case 'error':
        showError(msg.error);
        break;
    }
  };

  ws.onclose = () => {
    console.log('✦ Disconnected — reconnecting in 3s...');
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = () => {
    console.error('✦ WebSocket error');
  };
}

// ─── Chat ──────────────────────────────────────────────
function sendMessage() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text || isStreaming) return;

  // Show the message area, hide welcome
  showChatUI();

  // Add user message to UI
  addMessageToUI('user', text);

  // Send via WebSocket
  ws.send(JSON.stringify({
    type: 'chat',
    message: text,
    conversationId: currentConversationId
  }));

  // Clear input
  input.value = '';
  autoResize(input);
  updateSendButton();

  // Show typing indicator
  showTyping();
  isStreaming = true;
}

function sendSuggestion(text) {
  const input = document.getElementById('message-input');
  input.value = text;
  sendMessage();
}

function addMessageToUI(role, content) {
  const messagesArea = document.getElementById('messages-area');
  const msg = document.createElement('div');
  msg.className = `message ${role}`;
  msg.innerHTML = `
    <div class="message-avatar">${role === 'assistant' ? '✦' : '👤'}</div>
    <div class="message-content">${role === 'assistant' ? formatMarkdown(content) : escapeHtml(content)}</div>
  `;
  messagesArea.appendChild(msg);
  scrollToBottom();
}

function showTyping() {
  const messagesArea = document.getElementById('messages-area');
  const typing = document.createElement('div');
  typing.className = 'message assistant';
  typing.id = 'typing-message';
  typing.innerHTML = `
    <div class="message-avatar">✦</div>
    <div class="message-content">
      <div class="typing-indicator"><span></span><span></span><span></span></div>
    </div>
  `;
  messagesArea.appendChild(typing);
  scrollToBottom();
}

function appendStreamChunk(chunk) {
  const typing = document.getElementById('typing-message');
  if (!typing) return;

  let contentEl = typing.querySelector('.message-content');
  const indicator = contentEl.querySelector('.typing-indicator');
  if (indicator) {
    contentEl.innerHTML = '';
  }

  // Accumulate raw text in data attribute
  let rawText = typing.dataset.rawText || '';
  rawText += chunk;
  typing.dataset.rawText = rawText;

  contentEl.innerHTML = formatMarkdown(rawText);
  scrollToBottom();
}

function finishStream(conversationId) {
  const typing = document.getElementById('typing-message');
  if (typing) {
    typing.removeAttribute('id');
    delete typing.dataset.rawText;
  }
  isStreaming = false;
  currentConversationId = conversationId;
  loadConversations();
}

function showError(error) {
  const typing = document.getElementById('typing-message');
  if (typing) typing.remove();
  
  isStreaming = false;
  addMessageToUI('assistant', `⚠️ Error: ${error}`);
}

// ─── Conversation Management ───────────────────────────
async function loadConversations() {
  try {
    const res = await fetch('/api/conversations');
    const data = await res.json();
    conversations = data.conversations || [];
    renderConversationList();
  } catch (e) {
    console.error('Failed to load conversations:', e);
  }
}

function renderConversationList() {
  const list = document.getElementById('conversation-list');
  
  if (!conversations.length) {
    list.innerHTML = '<div class="empty-conversations">No conversations yet.<br>Start a new chat!</div>';
    return;
  }

  list.innerHTML = conversations.map(conv => `
    <div class="conversation-item ${conv.id === currentConversationId ? 'active' : ''}" 
         onclick="loadConversation('${conv.id}')">
      <span class="conv-icon">${getPlatformIcon(conv.platform)}</span>
      <span class="conv-title">${escapeHtml(conv.title)}</span>
      <span class="conv-time">${formatTime(conv.updated_at)}</span>
      <button class="conv-delete" onclick="event.stopPropagation(); deleteConversation('${conv.id}')" title="Delete">✕</button>
    </div>
  `).join('');
}

async function loadConversation(id) {
  try {
    const res = await fetch(`/api/conversations/${id}`);
    const data = await res.json();
    
    currentConversationId = id;

    // Update UI
    showChatUI();
    const messagesArea = document.getElementById('messages-area');
    messagesArea.innerHTML = '';

    // Update title
    const title = data.conversation?.title || 'Conversation';
    document.getElementById('top-bar-title').textContent = title;

    // Render messages
    (data.messages || []).forEach(msg => {
      addMessageToUI(msg.role, msg.content);
    });

    // Mark active in sidebar
    renderConversationList();

    // Close mobile sidebar
    closeSidebar();
  } catch (e) {
    console.error('Failed to load conversation:', e);
  }
}

function newChat() {
  currentConversationId = null;
  document.getElementById('welcome-screen').style.display = 'flex';
  document.getElementById('messages-area').classList.remove('visible');
  document.getElementById('messages-area').innerHTML = '';
  document.getElementById('top-bar-title').textContent = 'Nexus AI';
  renderConversationList();
  closeSidebar();
}

async function deleteConversation(id) {
  try {
    await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    if (currentConversationId === id) {
      newChat();
    }
    loadConversations();
  } catch (e) {
    console.error('Failed to delete conversation:', e);
  }
}

function clearChat() {
  if (currentConversationId) {
    deleteConversation(currentConversationId);
  }
}

function updateConversationTitle(convId, title) {
  const conv = conversations.find(c => c.id === convId);
  if (conv) {
    conv.title = title;
    renderConversationList();
    if (convId === currentConversationId) {
      document.getElementById('top-bar-title').textContent = title;
    }
  }
}

// ─── Voice ─────────────────────────────────────────────
async function toggleVoice() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      stream.getTracks().forEach(t => t.stop());
      await transcribeAudio(audioBlob);
    };

    mediaRecorder.start();
    isRecording = true;
    document.getElementById('voice-btn').classList.add('recording');
  } catch (e) {
    console.error('Microphone access denied:', e);
    alert('Please allow microphone access to use voice input.');
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
  isRecording = false;
  document.getElementById('voice-btn').classList.remove('recording');
}

async function transcribeAudio(audioBlob) {
  try {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');

    const res = await fetch('/api/voice/transcribe', {
      method: 'POST',
      body: formData
    });

    const data = await res.json();
    if (data.success && data.text) {
      const input = document.getElementById('message-input');
      input.value = data.text;
      autoResize(input);
      updateSendButton();
      // Auto-send after transcription
      sendMessage();
    }
  } catch (e) {
    console.error('Transcription failed:', e);
  }
}

async function speakResponse(text) {
  try {
    const res = await fetch('/api/voice/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.substring(0, 500) })
    });

    if (res.ok) {
      const blob = await res.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      audio.play();
    }
  } catch (e) {
    console.error('TTS failed:', e);
  }
}

// ─── Platform Status ───────────────────────────────────
async function fetchPlatformStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    if (data.platforms) {
      Object.entries(data.platforms).forEach(([name, connected]) => {
        const dot = document.getElementById(`dot-${name}`);
        if (dot) {
          dot.classList.toggle('connected', connected);
        }
      });
    }

    // Update model badge with provider info
    if (data.ai) {
      const badge = document.getElementById('model-badge');
      const displayName = getModelDisplayName(data.ai.model);
      const isGemini = data.ai.provider === 'gemini';
      badge.textContent = displayName;
      badge.style.background = isGemini ? 'rgba(66, 133, 244, 0.1)' : 'rgba(0, 210, 255, 0.1)';
      badge.style.color = isGemini ? '#8ab4f8' : 'var(--secondary)';
      badge.style.borderColor = isGemini ? 'rgba(66, 133, 244, 0.15)' : 'rgba(0, 210, 255, 0.15)';
    }
  } catch (e) {
    // Server might not be ready yet
  }
}

// ─── Stats ─────────────────────────────────────────────
async function fetchStats() {
  openSettings();
  try {
    const [statsRes, statusRes] = await Promise.all([
      fetch('/api/stats'),
      fetch('/api/status')
    ]);
    const stats = await statsRes.json();
    const status = await statusRes.json();

    document.getElementById('stat-conversations').textContent = stats.totalConversations || 0;
    document.getElementById('stat-messages').textContent = stats.totalMessages || 0;
    document.getElementById('stat-tokens').textContent = formatNumber(stats.totalTokensUsed || 0);
    document.getElementById('stat-uptime').textContent = formatUptime(status.uptime || 0);
  } catch (e) {
    console.error('Failed to fetch stats:', e);
  }
}

// ─── Settings Modal ────────────────────────────────────
function openSettings() {
  document.getElementById('settings-modal').classList.add('visible');
  fetchStats();
}

function closeSettings() {
  document.getElementById('settings-modal').classList.remove('visible');
}

// Close modal on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSettings();
});

// ─── Sidebar Toggle (Mobile) ───────────────────────────
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('mobile-overlay').classList.toggle('visible');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('mobile-overlay').classList.remove('visible');
}

// ─── UI Helpers ────────────────────────────────────────
function showChatUI() {
  document.getElementById('welcome-screen').style.display = 'none';
  document.getElementById('messages-area').classList.add('visible');
}

function scrollToBottom() {
  const area = document.getElementById('messages-area');
  requestAnimationFrame(() => {
    area.scrollTop = area.scrollHeight;
  });
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
}

function updateSendButton() {
  const input = document.getElementById('message-input');
  const btn = document.getElementById('send-btn');
  btn.disabled = !input.value.trim();
}

function handleKeyDown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

// ─── Formatters ────────────────────────────────────────
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatMarkdown(text) {
  if (!text) return '';
  
  let html = escapeHtml(text);

  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:var(--secondary)">$1</a>');

  // Line breaks
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');

  // Wrap in paragraphs
  if (!html.startsWith('<pre>') && !html.startsWith('<p>')) {
    html = '<p>' + html + '</p>';
  }

  return html;
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

function formatUptime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hours > 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function getPlatformIcon(platform) {
  const icons = {
    web: '🌐',
    telegram: '📱',
    discord: '🎮',
    slack: '💬',
    whatsapp: '📲',
    imessage: '🍎'
  };
  return icons[platform] || '💬';
}

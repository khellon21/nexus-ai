import NexusDatabase from './src/core/database.js';
import { ConversationManager } from './src/core/conversation-manager.js';

class MockAIEngine {
  async chat(messages) {
    if (messages[messages.length - 1].role === 'tool') {
      return { content: 'I got the tool response: ' + messages[messages.length - 1].content, usage: { totalTokens: 20 } };
    }
    const context = messages.map(m => m.content).join(' | ');
    if (context.includes('install express')) {
      return {
        content: '',
        tool_calls: [{
          id: 'call_abc123',
          function: { name: 'install_npm_package', arguments: JSON.stringify({ package_name: 'express' }) }
        }],
        usage: { totalTokens: 10 }
      };
    }
    return { content: 'Normal response', usage: { totalTokens: 5 } };
  }
}

async function runTest2() {
  const db = new NexusDatabase('./data/test.db');
  db.initialize();
  const ai = new MockAIEngine();
  const cm = new ConversationManager(db, ai);
  
  const m1 = await cm.processMessage("hello", "web", "user123");
  const m2 = await cm.processMessage("My name is John", "web", "user123");

  console.log("\n--- Sending request ---");
  const res1 = await cm.processMessage("Please install express", "web", "user123");
  console.log("AI says:", res1.content);
  
  console.log("\n--- Sending YES (approval) ---");
  const res2 = await cm.processMessage("Yes", "web", "user123");
  console.log("AI says:", res2.content);
}
runTest2().catch(console.error);

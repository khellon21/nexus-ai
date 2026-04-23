import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

export class PromptLoader {
  static getWorkspacePath(platform, platformUserId) {
    // Sanitize platform and platformUserId to prevent directory traversal
    const safePlatform = path.basename(String(platform));
    const safeUserId = path.basename(String(platformUserId));
    return path.join(process.cwd(), 'data', 'workspaces', `${safePlatform}_${safeUserId}`);
  }

  static hasUserFile(platform, platformUserId) {
    const workspacePath = this.getWorkspacePath(platform, platformUserId);
    const userFilePath = path.join(workspacePath, 'USER.md');
    return existsSync(userFilePath);
  }

  static async getSystemPrompt(platform, platformUserId) {
    const workspacePath = this.getWorkspacePath(platform, platformUserId);

    // Initial base instruction
    let systemPrompt = "You are Nexus AI, a conversational assistant operating in a Dynamic Workspace Architecture.\n";
    systemPrompt += "You have an isolated Markdown workspace that holds long-term knowledge, project notes, and user preferences. Workspace files are REFERENCE CONTEXT — not standing tasks. Read from them freely to inform your answers, but never modify them unless the user has explicitly asked for that change in their most recent message.\n\n";

    if (!existsSync(workspacePath)) {
      // No workspace yet — still append behavioral rules so the model doesn't over-reach.
      return systemPrompt + this._autonomousCapabilitiesBlock();
    }

    try {
      const files = await fs.readdir(workspacePath);
      const mdFiles = files.filter(f => f.endsWith('.md'));

      // Sort files to ensure standard ones are read first, or specific order
      const priority = ['AGENTS.md', 'SOUL.md', 'USER.md', 'MEMORY.md'];
      mdFiles.sort((a, b) => {
        const indexA = priority.indexOf(a);
        const indexB = priority.indexOf(b);
        if (indexA !== -1 && indexB !== -1) return indexA - indexB;
        if (indexA !== -1) return -1;
        if (indexB !== -1) return 1;
        return a.localeCompare(b);
      });

      let workspaceContent = "";
      for (const file of mdFiles) {
        const filePath = path.join(workspacePath, file);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          workspaceContent += `--- BEGIN ${file} ---\n${content.trim()}\n--- END ${file} ---\n\n`;
        } catch (err) {
          console.error(`Error reading workspace file ${file}:`, err.message);
        }
      }

      if (workspaceContent) {
        systemPrompt += "Your current workspace contents (READ-ONLY unless the user asks you to change something):\n\n" + workspaceContent;
      }
    } catch (err) {
      console.error(`Error reading workspace directory ${workspacePath}:`, err.message);
    }

    systemPrompt += this._autonomousCapabilitiesBlock();
    return systemPrompt;
  }

  /**
   * Describes what tools the agent may use and — critically — WHEN.
   *
   * The previous version unconditionally told the model to edit files and
   * `git_commit_and_push` without user consent, causing the AI to append
   * garbage to MATH.md on every "Hi" greeting. This version gates every
   * state-changing tool behind explicit user intent in the CURRENT message.
   */
  static _autonomousCapabilitiesBlock() {
    return [
      '',
      '--- TOOL USE POLICY ---',
      '',
      'READ-ONLY tools (use freely, no permission required):',
      '  - search_internet      — look up facts, documentation, tutorials',
      '  - read_source_file     — inspect a file in the project/workspace',
      '  - get_current_time_and_date',
      '  - cipher_list_assignments',
      '  - take_screenshot      — capture the host machine\'s screen and send it',
      '                            to the user as a photo. OWNER-ONLY: the tool',
      '                            itself enforces that only OWNER_TELEGRAM_USER_ID',
      '                            may invoke it; for any other user it returns a',
      '                            permission-denied error, so you never need to',
      '                            refuse pre-emptively. When the owner asks to',
      '                            see their screen / mac / desktop / "what\'s on',
      '                            my computer", CALL THIS TOOL — do NOT reply',
      '                            "I can\'t take screenshots", because you can.',
      '',
      'STATE-CHANGING tools (invoke ONLY when the user’s most recent message',
      'explicitly asks for the action — never on greetings, acknowledgements,',
      'small talk, or your own initiative):',
      '  - edit_source_file        — only when the user asks you to write, edit,',
      '                              update, append to, fix, or create a file.',
      '                              Supply the COMPLETE new file contents, not a diff.',
      '  - create_directory        — only when the user asks you to make a folder.',
      '  - manage_workspace_file   — only when the user shares a new fact they want',
      '                              remembered, or asks to update stored notes.',
      '  - git_commit_and_push     — only AFTER a state-changing edit that the user',
      '                              asked for, and only if the user wants it committed.',
      '                              Never commit speculative or exploratory changes.',
      '  - install_npm_package     — only when the user asks to install a package.',
      '                              Human-in-the-loop approval is required and',
      '                              enforced by the system; do not re-ask yourself.',
      '  - send_urgent_notification — only for genuinely time-critical alerts.',
      '',
      'DECISION RULE:',
      '  Before any state-changing tool call, confirm that the user’s latest',
      '  message contains a clear imperative verb directed at that action',
      '  (e.g. "add…", "write…", "edit…", "commit…", "install…", "delete…",',
      '  "remember that…"). If the intent is ambiguous or the message is a',
      '  greeting / question / casual reply, DO NOT call a state-changing tool.',
      '  Answer in plain text and, if useful, ask the user what they want done.',
      '',
      'TRANSPARENCY:',
      '  Whenever you DO make a change, your text reply must name the exact file',
      '  path, summarize the change, and explain why — so the user can verify.',
      '',
    ].join('\n');
  }
}

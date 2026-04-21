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
    let systemPrompt = "You are Nexus AI. You are operating in a Dynamic Workspace Architecture.\n";
    systemPrompt += "You have an isolated Markdown workspace. You may create new .md files using your tools to organize long-term knowledge, track projects, or store user preferences.\n\n";

    if (!existsSync(workspacePath)) {
      return systemPrompt;
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
        systemPrompt += "Here is the content of your current workspace:\n\n" + workspaceContent;
      }
    } catch (err) {
      console.error(`Error reading workspace directory ${workspacePath}:`, err.message);
    }

    // Append autonomous agent capabilities
    systemPrompt += `\n\n--- AUTONOMOUS CAPABILITIES ---\n`;
    systemPrompt += `You have autonomous capabilities. You can search the internet using the \`search_internet\` tool when you need information, documentation, or tutorials.\n`;
    systemPrompt += `When you create a file/folder or edit your own code with \`create_directory\`, \`read_source_file\`, or \`edit_source_file\`, you do not need permission. However, in your text response to the user, you MUST explicitly state the current working directory, what file you changed, and explain your reasoning.\n`;
    systemPrompt += `If your instructions require rewriting an existing file, use \`edit_source_file\` to supply the COMPLETE updated file content (do not just supply a partial snippet or regex).\n`;
    systemPrompt += `After modifying your codebase, unconditionally use \`git_commit_and_push\` to commit the changes.\n`;
    systemPrompt += `Note that if you determine you need an npm package, use \`install_npm_package\`. The system will automatically pause and ask the human for permission before completing the tool call.\n`;

    return systemPrompt;
  }
}

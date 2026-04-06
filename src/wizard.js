import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

const logo = `
${chalk.hex('#6C5CE7').bold(`
  ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗     █████╗ ██╗
  ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝    ██╔══██╗██║
  ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗    ███████║██║
  ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║    ██╔══██║██║
  ██║ ╚████║███████╗██╔╝ ╚██╗╚██████╔╝███████║    ██║  ██║██║
  ╚═╝  ╚═══╝╚══════╝╚═╝   ╚═╝ ╚═════╝ ╚══════╝    ╚═╝  ╚═╝╚═╝
`)}
  ${chalk.gray('Your Private AI Assistant — Setup Wizard')}
  ${chalk.gray('─'.repeat(50))}
`;

async function main() {
  console.clear();
  console.log(logo);

  // Load existing .env if present
  let existingConfig = {};
  if (existsSync('.env')) {
    const envContent = readFileSync('.env', 'utf-8');
    envContent.split('\n').forEach(line => {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) existingConfig[match[1].trim()] = match[2].trim();
    });
    console.log(chalk.yellow('  ⚠ Existing .env found. Values will be used as defaults.\n'));
  }

  // ─── Step 1: AI Provider ─────────────────────────────

  console.log(chalk.hex('#6C5CE7').bold('\n  ━━━ Step 1: AI Provider ━━━\n'));

  const { provider } = await inquirer.prompt([{
    type: 'list',
    name: 'provider',
    message: 'Choose your AI provider:',
    choices: [
      { name: '🟢 OpenAI       — GPT-4o, GPT-4o Mini  (requires API key)', value: 'openai' },
      { name: '🔷 Google Gemini — Gemini 2.5 Pro/Flash (requires API key)', value: 'gemini' },
      { name: '🔀 Both         — Use both providers (switch in dashboard)', value: 'both' }
    ],
    default: existingConfig.AI_PROVIDER || 'openai'
  }]);

  let openaiKey = '';
  let geminiKey = '';
  let selectedModel = '';

  // ─── OpenAI Key ──────────────────────────────────────

  if (provider === 'openai' || provider === 'both') {
    console.log(chalk.hex('#00B894').bold('\n  ━━━ OpenAI Configuration ━━━'));
    console.log(chalk.gray('  Get your key at: https://platform.openai.com/api-keys\n'));

    const { key } = await inquirer.prompt([{
      type: 'password',
      name: 'key',
      message: 'OpenAI API key:',
      mask: '•',
      default: existingConfig.OPENAI_API_KEY || undefined,
      validate: (input) => {
        if (!input || input.length < 10) return 'Please enter a valid API key';
        return true;
      }
    }]);

    const spinner = ora('  Validating OpenAI key...').start();
    try {
      const client = new OpenAI({ apiKey: key });
      await client.models.list();
      spinner.succeed(chalk.green('  OpenAI key is valid!'));
      openaiKey = key;
    } catch (error) {
      spinner.fail(chalk.red('  Invalid OpenAI key.'));
      console.log(chalk.gray(`  Error: ${error.message}\n`));
      if (provider === 'openai') process.exit(1);
      console.log(chalk.yellow('  Continuing without OpenAI...\n'));
    }
  }

  // ─── Gemini Key ──────────────────────────────────────

  if (provider === 'gemini' || provider === 'both') {
    console.log(chalk.hex('#4285F4').bold('\n  ━━━ Google Gemini Configuration ━━━'));
    console.log(chalk.gray('  Get your key at: https://aistudio.google.com/apikey\n'));

    const { key } = await inquirer.prompt([{
      type: 'password',
      name: 'key',
      message: 'Gemini API key:',
      mask: '•',
      default: existingConfig.GEMINI_API_KEY || undefined,
      validate: (input) => {
        if (!input || input.length < 10) return 'Please enter a valid API key';
        return true;
      }
    }]);

    const spinner = ora('  Validating Gemini key...').start();
    try {
      const genAI = new GoogleGenerativeAI(key);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      await model.generateContent('Hi');
      spinner.succeed(chalk.green('  Gemini key is valid and has active quota!'));
      geminiKey = key;
    } catch (error) {
      if (error.message && error.message.includes('429')) {
         spinner.warn(chalk.yellow('  Gemini key accepted, but your account has no free quota (Limit: 0).'));
         console.log(chalk.gray('  You may need to enable billing in Google AI Studio or use a supported region.'));
         // We still accept the key so the user doesn't have to restart the wizard
         geminiKey = key;
      } else {
        spinner.fail(chalk.red('  Invalid Gemini key.'));
        console.log(chalk.gray(`  Error: ${error.message}\n`));
        if (provider === 'gemini') process.exit(1);
        console.log(chalk.yellow('  Continuing without Gemini...\n'));
      }
    }
  }

  // ─── Model Selection ─────────────────────────────────

  console.log(chalk.hex('#6C5CE7').bold('\n  ━━━ Model Selection ━━━\n'));

  const modelChoices = [];

  if (openaiKey) {
    modelChoices.push(
      new inquirer.Separator(chalk.hex('#00B894')(' ── OpenAI ──')),
      { name: 'GPT-4o Mini     — Fast & affordable (recommended)', value: 'gpt-4o-mini' },
      { name: 'GPT-4o          — Most capable', value: 'gpt-4o' },
      { name: 'GPT-4 Turbo     — High quality', value: 'gpt-4-turbo' }
    );
  }

  if (geminiKey) {
    modelChoices.push(
      new inquirer.Separator(chalk.hex('#4285F4')(' ── Google Gemini ──')),
      { name: 'Gemini 2.5 Flash — Fast & intelligent (recommended)', value: 'gemini-2.5-flash' },
      { name: 'Gemini 2.5 Pro   — Most capable Gemini model', value: 'gemini-2.5-pro' },
      { name: 'Gemini 2.0 Flash — Ultra-fast responses', value: 'gemini-2.0-flash' },
      { name: 'Gemini 2.0 Flash Lite — Lightest & cheapest', value: 'gemini-2.0-flash-lite' }
    );
  }

  const defaultModel = existingConfig.AI_MODEL || existingConfig.OPENAI_MODEL || 
    (geminiKey && !openaiKey ? 'gemini-2.5-flash' : 'gpt-4o-mini');

  const { model } = await inquirer.prompt([{
    type: 'list',
    name: 'model',
    message: 'Select your default AI model:',
    choices: modelChoices,
    default: defaultModel
  }]);

  selectedModel = model;
  const activeProvider = model.startsWith('gemini') ? 'gemini' : 'openai';

  // ─── Step 2: Platform Selection ──────────────────────

  console.log(chalk.hex('#6C5CE7').bold('\n  ━━━ Step 2: Chat Platforms ━━━\n'));
  console.log(chalk.gray('  Select which platforms to connect. You can add more later.\n'));

  const { platforms } = await inquirer.prompt([{
    type: 'checkbox',
    name: 'platforms',
    message: 'Enable platforms:',
    choices: [
      { name: '📱 Telegram', value: 'telegram', checked: existingConfig.TELEGRAM_ENABLED === 'true' },
      { name: '🎮 Discord', value: 'discord', checked: existingConfig.DISCORD_ENABLED === 'true' },
      { name: '💬 Slack', value: 'slack', checked: existingConfig.SLACK_ENABLED === 'true' },
      { name: '📲 WhatsApp (QR code scan)', value: 'whatsapp', checked: existingConfig.WHATSAPP_ENABLED === 'true' },
      { name: '🍎 iMessage (macOS only)', value: 'imessage', checked: existingConfig.IMESSAGE_ENABLED === 'true' }
    ]
  }]);

  // ─── Step 3: Platform Credentials ────────────────────

  const config = {
    AI_PROVIDER: activeProvider,
    OPENAI_API_KEY: openaiKey || '',
    GEMINI_API_KEY: geminiKey || '',
    AI_MODEL: selectedModel,
    PORT: existingConfig.PORT || '3000',
    TELEGRAM_ENABLED: 'false',
    TELEGRAM_BOT_TOKEN: '',
    DISCORD_ENABLED: 'false',
    DISCORD_BOT_TOKEN: '',
    SLACK_ENABLED: 'false',
    SLACK_BOT_TOKEN: '',
    SLACK_APP_TOKEN: '',
    WHATSAPP_ENABLED: 'false',
    IMESSAGE_ENABLED: 'false',
    VOICE_ENABLED: 'true',
    VOICE_MODEL: 'tts-1',
    VOICE_NAME: 'alloy',
    SYSTEM_PROMPT: existingConfig.SYSTEM_PROMPT || 'You are Nexus, a helpful, friendly, and knowledgeable personal AI assistant. You are concise but thorough. You remember context from our conversation. You are running locally and all data stays private.'
  };

  if (platforms.includes('telegram')) {
    console.log(chalk.hex('#00D2FF').bold('\n  ━━━ Telegram Setup ━━━'));
    console.log(chalk.gray('  Create a bot via @BotFather on Telegram to get a token.\n'));

    const { token } = await inquirer.prompt([{
      type: 'password',
      name: 'token',
      message: 'Telegram Bot Token:',
      mask: '•',
      default: existingConfig.TELEGRAM_BOT_TOKEN || undefined
    }]);

    if (token) {
      config.TELEGRAM_ENABLED = 'true';
      config.TELEGRAM_BOT_TOKEN = token;
    }
  }

  if (platforms.includes('discord')) {
    console.log(chalk.hex('#00D2FF').bold('\n  ━━━ Discord Setup ━━━'));
    console.log(chalk.gray('  Create an app at discord.com/developers'));
    console.log(chalk.gray('  Enable: Message Content Intent, Server Members Intent\n'));

    const { token } = await inquirer.prompt([{
      type: 'password',
      name: 'token',
      message: 'Discord Bot Token:',
      mask: '•',
      default: existingConfig.DISCORD_BOT_TOKEN || undefined
    }]);

    if (token) {
      config.DISCORD_ENABLED = 'true';
      config.DISCORD_BOT_TOKEN = token;
    }
  }

  if (platforms.includes('slack')) {
    console.log(chalk.hex('#00D2FF').bold('\n  ━━━ Slack Setup ━━━'));
    console.log(chalk.gray('  Create a Slack App with Socket Mode at api.slack.com/apps\n'));

    const slackAnswers = await inquirer.prompt([
      {
        type: 'password',
        name: 'botToken',
        message: 'Slack Bot Token (xoxb-...):',
        mask: '•',
        default: existingConfig.SLACK_BOT_TOKEN || undefined
      },
      {
        type: 'password',
        name: 'appToken',
        message: 'Slack App Token (xapp-...):',
        mask: '•',
        default: existingConfig.SLACK_APP_TOKEN || undefined
      }
    ]);

    if (slackAnswers.botToken && slackAnswers.appToken) {
      config.SLACK_ENABLED = 'true';
      config.SLACK_BOT_TOKEN = slackAnswers.botToken;
      config.SLACK_APP_TOKEN = slackAnswers.appToken;
    }
  }

  if (platforms.includes('whatsapp')) {
    console.log(chalk.hex('#00D2FF').bold('\n  ━━━ WhatsApp Setup ━━━'));
    console.log(chalk.gray('  No credentials needed! A QR code will appear when you start Nexus.'));
    console.log(chalk.gray('  Scan it with: WhatsApp → Settings → Linked Devices → Link a Device\n'));
    config.WHATSAPP_ENABLED = 'true';
  }

  if (platforms.includes('imessage')) {
    const { platform: osPlatform } = await import('os');
    if (osPlatform() !== 'darwin') {
      console.log(chalk.red('\n  ✗ iMessage is only available on macOS. Skipping.\n'));
    } else {
      console.log(chalk.hex('#00D2FF').bold('\n  ━━━ iMessage Setup ━━━'));
      console.log(chalk.gray('  No credentials needed! Make sure Terminal has Full Disk Access:'));
      console.log(chalk.gray('  System Preferences → Security & Privacy → Full Disk Access → Terminal\n'));
      config.IMESSAGE_ENABLED = 'true';
    }
  }

  // ─── Step 4: Voice Settings ──────────────────────────

  console.log(chalk.hex('#6C5CE7').bold('\n  ━━━ Step 3: Voice Settings ━━━\n'));

  if (!openaiKey) {
    console.log(chalk.gray('  Voice requires an OpenAI API key (Whisper + TTS). Skipping.\n'));
    config.VOICE_ENABLED = 'false';
  } else {
    const voiceAnswers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'voiceEnabled',
        message: 'Enable voice input/output? (uses OpenAI Whisper + TTS)',
        default: true
      },
      {
        type: 'list',
        name: 'voiceName',
        message: 'Select voice:',
        choices: [
          { name: 'Alloy   — Neutral and balanced', value: 'alloy' },
          { name: 'Echo    — Warm and conversational', value: 'echo' },
          { name: 'Fable   — Expressive and dynamic', value: 'fable' },
          { name: 'Onyx    — Deep and authoritative', value: 'onyx' },
          { name: 'Nova    — Friendly and upbeat', value: 'nova' },
          { name: 'Shimmer — Clear and precise', value: 'shimmer' }
        ],
        default: existingConfig.VOICE_NAME || 'alloy',
        when: (answers) => answers.voiceEnabled
      }
    ]);

    config.VOICE_ENABLED = voiceAnswers.voiceEnabled ? 'true' : 'false';
    if (voiceAnswers.voiceName) config.VOICE_NAME = voiceAnswers.voiceName;
  }

  // ─── Step 5: System Prompt ───────────────────────────

  console.log(chalk.hex('#6C5CE7').bold('\n  ━━━ Step 4: Personality ━━━\n'));

  const { customizePrompt } = await inquirer.prompt([{
    type: 'confirm',
    name: 'customizePrompt',
    message: 'Customize the AI personality/system prompt?',
    default: false
  }]);

  if (customizePrompt) {
    const { systemPrompt } = await inquirer.prompt([{
      type: 'editor',
      name: 'systemPrompt',
      message: 'Enter your system prompt:',
      default: config.SYSTEM_PROMPT
    }]);
    config.SYSTEM_PROMPT = systemPrompt.trim();
  }

  // ─── Step 6: Port ────────────────────────────────────

  const { port } = await inquirer.prompt([{
    type: 'input',
    name: 'port',
    message: 'Web dashboard port:',
    default: existingConfig.PORT || '3000',
    validate: (input) => {
      const p = parseInt(input);
      if (isNaN(p) || p < 1 || p > 65535) return 'Enter a valid port number (1-65535)';
      return true;
    }
  }]);
  config.PORT = port;

  // ─── Write .env ──────────────────────────────────────

  console.log(chalk.hex('#6C5CE7').bold('\n  ━━━ Saving Configuration ━━━\n'));

  const envContent = `# ─────────────────────────────────────────────
# Nexus AI — Configuration
# Generated by setup wizard on ${new Date().toISOString()}
# ─────────────────────────────────────────────

# ═══ AI Provider ═══
AI_PROVIDER=${config.AI_PROVIDER}
AI_MODEL=${config.AI_MODEL}

# ═══ OpenAI ═══
OPENAI_API_KEY=${config.OPENAI_API_KEY}

# ═══ Google Gemini ═══
GEMINI_API_KEY=${config.GEMINI_API_KEY}

# ═══ Web Dashboard ═══
PORT=${config.PORT}

# ═══ Telegram ═══
TELEGRAM_ENABLED=${config.TELEGRAM_ENABLED}
TELEGRAM_BOT_TOKEN=${config.TELEGRAM_BOT_TOKEN}

# ═══ Discord ═══
DISCORD_ENABLED=${config.DISCORD_ENABLED}
DISCORD_BOT_TOKEN=${config.DISCORD_BOT_TOKEN}

# ═══ Slack ═══
SLACK_ENABLED=${config.SLACK_ENABLED}
SLACK_BOT_TOKEN=${config.SLACK_BOT_TOKEN}
SLACK_APP_TOKEN=${config.SLACK_APP_TOKEN}

# ═══ WhatsApp ═══
WHATSAPP_ENABLED=${config.WHATSAPP_ENABLED}

# ═══ iMessage ═══
IMESSAGE_ENABLED=${config.IMESSAGE_ENABLED}

# ═══ Voice ═══
VOICE_ENABLED=${config.VOICE_ENABLED}
VOICE_MODEL=${config.VOICE_MODEL}
VOICE_NAME=${config.VOICE_NAME}

# ═══ System Prompt ═══
SYSTEM_PROMPT=${config.SYSTEM_PROMPT}
`;

  writeFileSync('.env', envContent);
  console.log(chalk.green('  ✓ Configuration saved to .env'));

  // ─── Summary ─────────────────────────────────────────

  const providerLabel = config.AI_PROVIDER === 'gemini' 
    ? chalk.hex('#4285F4')('Google Gemini') 
    : chalk.hex('#00B894')('OpenAI');

  console.log(`
  ${chalk.hex('#6C5CE7').bold('━━━ Setup Complete! ━━━')}

  ${chalk.white.bold('Configuration Summary:')}

    Provider:  ${providerLabel}
    Model:     ${chalk.hex('#00D2FF')(config.AI_MODEL)}
    Dashboard: ${chalk.hex('#00D2FF')(`http://localhost:${config.PORT}`)}
    Voice:     ${config.VOICE_ENABLED === 'true' ? chalk.green('Enabled') : chalk.gray('Disabled')}

    API Keys:
      OpenAI:  ${openaiKey ? chalk.green('● Configured') : chalk.gray('○ Not set')}
      Gemini:  ${geminiKey ? chalk.green('● Configured') : chalk.gray('○ Not set')}

    Platforms:
      Telegram: ${config.TELEGRAM_ENABLED === 'true' ? chalk.green('● Enabled') : chalk.gray('○ Disabled')}
      Discord:  ${config.DISCORD_ENABLED === 'true' ? chalk.green('● Enabled') : chalk.gray('○ Disabled')}
      Slack:    ${config.SLACK_ENABLED === 'true' ? chalk.green('● Enabled') : chalk.gray('○ Disabled')}
      WhatsApp: ${config.WHATSAPP_ENABLED === 'true' ? chalk.green('● Enabled') : chalk.gray('○ Disabled')}
      iMessage: ${config.IMESSAGE_ENABLED === 'true' ? chalk.green('● Enabled') : chalk.gray('○ Disabled')}

  ${chalk.hex('#6C5CE7').bold('Next steps:')}

    ${chalk.white('1.')} Start Nexus AI:  ${chalk.hex('#00D2FF')('npm start')}
    ${chalk.white('2.')} Open dashboard:  ${chalk.hex('#00D2FF')(`http://localhost:${config.PORT}`)}
    ${chalk.white('3.')} Run in background: ${chalk.hex('#00D2FF')('npx pm2 start ecosystem.config.js')}

  ${chalk.gray('Run "npm run setup" anytime to reconfigure.')}
`);
}

main().catch((error) => {
  console.error(chalk.red(`\n  Error: ${error.message}\n`));
  process.exit(1);
});

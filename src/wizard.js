import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { randomBytes } from 'crypto';
import { dirname } from 'path';
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
      { name: '🟩 NVIDIA       — Llama 3.1, Nemotron  (build.nvidia.com)', value: 'nvidia' },
      { name: '🔀 All          — Setup all providers (switch in dashboard)', value: 'both' }
    ],
    default: existingConfig.AI_PROVIDER || 'openai'
  }]);

  let openaiKey = '';
  let geminiKey = '';
  let nvidiaKey = '';
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

  // ─── NVIDIA Key ──────────────────────────────────────

  if (provider === 'nvidia' || provider === 'both') {
    console.log(chalk.hex('#76B900').bold('\n  ━━━ NVIDIA NIM Configuration ━━━'));
    console.log(chalk.gray('  Get your key at: https://build.nvidia.com\n'));

    const { key } = await inquirer.prompt([{
      type: 'password',
      name: 'key',
      message: 'NVIDIA API key:',
      mask: '•',
      default: existingConfig.NVIDIA_API_KEY || undefined,
      validate: (input) => {
        if (!input || input.length < 10) return 'Please enter a valid API key';
        return true;
      }
    }]);

    const spinner = ora('  Validating NVIDIA key...').start();
    try {
      // NVIDIA uses OpenAI compatible endpoint
      const client = new OpenAI({ 
        apiKey: key, 
        baseURL: 'https://integrate.api.nvidia.com/v1' 
      });
      await client.models.list();
      spinner.succeed(chalk.green('  NVIDIA key is valid!'));
      nvidiaKey = key;
    } catch (error) {
      spinner.fail(chalk.red('  Invalid NVIDIA key.'));
      console.log(chalk.gray(`  Error: ${error.message}\n`));
      if (provider === 'nvidia') process.exit(1);
      console.log(chalk.yellow('  Continuing without NVIDIA...\n'));
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

  if (nvidiaKey) {
    modelChoices.push(
      new inquirer.Separator(chalk.hex('#76B900')(' ── NVIDIA NIM ──')),
      { name: 'Qwen 3 Coder 480B (A35B) Instruct — Powerful coding model', value: 'qwen/qwen3-coder-480b-a35b-instruct' },
      { name: 'Llama 3.1 70B Instruct  — Fast & capable open model', value: 'meta/llama-3.1-70b-instruct' },
      { name: 'Nemotron 4 340B Instruct — High-end NVIDIA model', value: 'nvidia/nemotron-4-340b-instruct' },
      { name: 'Llama 3.1 405B Instruct — Massive capable open model', value: 'meta/llama-3.1-405b-instruct' }
    );
  }

  const defaultModel = existingConfig.AI_MODEL || existingConfig.OPENAI_MODEL || 
    (geminiKey && !openaiKey && !nvidiaKey ? 'gemini-2.5-flash' : (nvidiaKey && !openaiKey && !geminiKey ? 'meta/llama-3.1-70b-instruct' : 'gpt-4o-mini'));

  const { model } = await inquirer.prompt([{
    type: 'list',
    name: 'model',
    message: 'Select your default AI model:',
    choices: modelChoices,
    default: defaultModel
  }]);

  selectedModel = model;
  const activeProvider = model.startsWith('gemini') ? 'gemini' : (model.includes('/') ? 'nvidia' : 'openai');

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
    NVIDIA_API_KEY: nvidiaKey || '',
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
    SYSTEM_PROMPT: existingConfig.SYSTEM_PROMPT || "You are Khellon's personal AI assistant. You have full access to a local Chrome browser via PinchTab tools (browser_navigate, browser_snapshot, browser_action, browser_extract_text). You must use these to autonomously check his college portal and read web news online. You must autonomously maintain awareness of his college environment and trigger send_urgent_notification for important updates."
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

  // ─── Step 5: Cipher Academic Agent ──────────────────

  console.log(chalk.hex('#FF6B6B').bold('\n  ━━━ Step 4: Cipher — Academic Agent ━━━'));
  console.log(chalk.gray('  Cipher monitors your college portal for assignments, due dates,'));
  console.log(chalk.gray('  and grades — then sends alerts to your phone via Telegram.\n'));

  const { enableCipher } = await inquirer.prompt([{
    type: 'confirm',
    name: 'enableCipher',
    message: 'Enable Cipher Academic Agent?',
    default: existingConfig.CIPHER_ENABLED === 'true' || false
  }]);

  let cipherConfig = {
    enabled: false,
    vaultKey: existingConfig.CIPHER_VAULT_KEY || '',
    scanInterval: existingConfig.CIPHER_SCAN_INTERVAL || '7200',
    telegramChatId: existingConfig.CIPHER_TELEGRAM_CHAT_ID || '',
    alertThresholds: existingConfig.CIPHER_ALERT_THRESHOLDS || '48,24,6,1',
    summaryHour: existingConfig.CIPHER_SUMMARY_HOUR || '8'
  };

  let portalJson = null;

  if (enableCipher) {
    cipherConfig.enabled = true;

    // ─── Portal Platform ────────────────────────────

    console.log(chalk.hex('#FF6B6B').bold('\n  ━━━ College Portal Setup ━━━\n'));

    const { portalPlatform } = await inquirer.prompt([{
      type: 'list',
      name: 'portalPlatform',
      message: 'What platform does your college portal use?',
      choices: [
        { name: '📘 D2L Brightspace   (Pilot, MyLS, etc.)', value: 'd2l' },
        { name: '🟧 Canvas LMS        (Instructure)', value: 'canvas' },
        { name: '⬛ Blackboard Learn  (Ultra or Classic)', value: 'blackboard' },
        { name: '🔧 Custom / Other    (I\'ll enter selectors)', value: 'custom' }
      ]
    }]);

    // Load existing config if present
    let existingPortalConfig = {};
    const portalConfigPath = './config/cipher-portal.json';
    try {
      if (existsSync(portalConfigPath)) {
        existingPortalConfig = JSON.parse(readFileSync(portalConfigPath, 'utf-8'));
      }
    } catch (e) { /* ignore */ }

    // ─── Portal URL ─────────────────────────────────

    const { portalUrl } = await inquirer.prompt([{
      type: 'input',
      name: 'portalUrl',
      message: 'College portal URL (e.g. https://pilot.wright.edu):',
      default: existingPortalConfig.portalUrl || '',
      validate: (input) => {
        if (!input.startsWith('https://')) return 'URL must start with https://';
        return true;
      }
    }]);

    // ─── Platform Presets ────────────────────────────

    const platformPresets = {
      d2l: {
        loginPage: '/d2l/loginh/',
        dashboardPage: '/d2l/home',
        sso: {
          enabled: true,
          provider: 'PingFederate / SAML',
          redirectDomain: '',
          note: 'Portal redirects to SSO — Cipher handles the redirect automatically'
        },
        loginSelectors: {
          usernameInput: '#username',
          passwordInput: '#password',
          submitButton: '#signOnButton',
          loginSuccessIndicator: 'homepage',
          loginErrorIndicator: 'invalid'
        },
        navigationSelectors: {
          courseLinks: ".d2l-card a, .course-card a, a[href*='/d2l/home/']",
          assignmentHub: "a[href*='dropbox'], a[href*='assignments']",
          courseTitle: '.d2l-page-title, .d2l-heading, h1'
        },
        assignmentSelectors: {
          assignmentList: '.d2l-datalist-item, .d2l-table tr, .assignment-row',
          assignmentTitle: '.d2l-foldername, .d2l-heading, td:first-child',
          dueDate: '.d2l-dates, .d2l-textblock, .due-date',
          description: '.d2l-textblock, .description',
          dropboxLink: "a[href*='dropbox'], a[href*='submission']",
          status: '.d2l-submission-status, .status'
        },
        submissionSelectors: {
          fileInput: "input[type='file'], .d2l-file-input",
          submitButton: "button[primary], .d2l-button-primary, .submit-btn, button[type='submit']",
          confirmationText: 'submitted successfully',
          confirmationIndicator: '.d2l-submission-confirmation, .d2l-toast'
        }
      },
      canvas: {
        loginPage: '/login/canvas',
        dashboardPage: '/courses',
        sso: {
          enabled: true,
          provider: 'SAML / CAS',
          redirectDomain: '',
          note: 'Portal may redirect to institutional SSO'
        },
        loginSelectors: {
          usernameInput: '#pseudonym_session_unique_id',
          passwordInput: '#pseudonym_session_password',
          submitButton: '.Button--login',
          loginSuccessIndicator: 'dashboard',
          loginErrorIndicator: 'Invalid'
        },
        navigationSelectors: {
          courseLinks: "a.ic-DashboardCard__link, a[href*='/courses/']",
          assignmentHub: "a[href*='/assignments'], a[href*='/quizzes']",
          courseTitle: 'h2.course-title, h1'
        },
        assignmentSelectors: {
          assignmentList: '.assignment, .ig-row, tr.assignment',
          assignmentTitle: '.ig-title a, .assignment-title a',
          dueDate: '.assignment-date-due, .due_date_display',
          description: '.description, .user_content',
          dropboxLink: "a[href*='/assignments/'], a[href*='/submit']",
          status: '.submission-status, .status'
        },
        submissionSelectors: {
          fileInput: "input[type='file']",
          submitButton: "button[type='submit'], .submit_assignment_link",
          confirmationText: 'submitted',
          confirmationIndicator: '.submission_confirmation'
        }
      },
      blackboard: {
        loginPage: '/webapps/login/',
        dashboardPage: '/ultra/course',
        sso: {
          enabled: true,
          provider: 'SAML / Shibboleth',
          redirectDomain: '',
          note: 'Portal may redirect to institutional SSO'
        },
        loginSelectors: {
          usernameInput: '#user_id',
          passwordInput: '#password',
          submitButton: '#entry-login',
          loginSuccessIndicator: 'institution',
          loginErrorIndicator: 'error'
        },
        navigationSelectors: {
          courseLinks: "a[href*='listContent'], a[href*='/ultra/courses']",
          assignmentHub: "a[href*='assignment'], a[href*='assessment']",
          courseTitle: '#courseMenu_link, h1'
        },
        assignmentSelectors: {
          assignmentList: '.inventory-item, .element-card, li.clearfix',
          assignmentTitle: '.element-details h4 a, .inventory-item-title',
          dueDate: '.element-details .date, .due-date',
          description: '.vtbegenerated, .details',
          dropboxLink: "a[href*='assignment'], a[href*='attempt']",
          status: '.status, .graded-status'
        },
        submissionSelectors: {
          fileInput: "input[type='file']",
          submitButton: "button[type='submit'], #bottom_Submit",
          confirmationText: 'submitted',
          confirmationIndicator: '.receipt'
        }
      }
    };

    let preset = platformPresets[portalPlatform] || null;

    // ─── SSO Configuration ──────────────────────────

    if (preset) {
      const { ssoRedirectDomain } = await inquirer.prompt([{
        type: 'input',
        name: 'ssoRedirectDomain',
        message: 'SSO redirect domain (e.g. auth.wright.edu, leave blank if unknown):',
        default: existingPortalConfig.sso?.redirectDomain || ''
      }]);
      preset.sso.redirectDomain = ssoRedirectDomain;
    }

    // ─── Custom Selectors ───────────────────────────

    if (portalPlatform === 'custom') {
      console.log(chalk.gray('\n  Enter CSS selectors for your portal. Leave defaults if unsure.\n'));

      const customSelectors = await inquirer.prompt([
        {
          type: 'input',
          name: 'loginPage',
          message: 'Login page path (e.g. /login):',
          default: existingPortalConfig.loginPage || '/login'
        },
        {
          type: 'input',
          name: 'dashboardPage',
          message: 'Dashboard page path (after login):',
          default: existingPortalConfig.dashboardPage || '/dashboard'
        },
        {
          type: 'input',
          name: 'usernameInput',
          message: 'Username input selector:',
          default: existingPortalConfig.loginSelectors?.usernameInput || '#username'
        },
        {
          type: 'input',
          name: 'passwordInput',
          message: 'Password input selector:',
          default: existingPortalConfig.loginSelectors?.passwordInput || '#password'
        },
        {
          type: 'input',
          name: 'submitButton',
          message: 'Login submit button selector:',
          default: existingPortalConfig.loginSelectors?.submitButton || 'button[type="submit"]'
        }
      ]);

      preset = {
        loginPage: customSelectors.loginPage,
        dashboardPage: customSelectors.dashboardPage,
        sso: { enabled: false, provider: 'Custom', redirectDomain: '', note: '' },
        loginSelectors: {
          usernameInput: customSelectors.usernameInput,
          passwordInput: customSelectors.passwordInput,
          submitButton: customSelectors.submitButton,
          loginSuccessIndicator: 'dashboard',
          loginErrorIndicator: 'invalid'
        },
        navigationSelectors: {
          courseLinks: "a[href*='course']",
          assignmentHub: "a[href*='assignment']",
          courseTitle: 'h1'
        },
        assignmentSelectors: {
          assignmentList: 'tr, li',
          assignmentTitle: 'td:first-child a, li a',
          dueDate: '.due-date, .date',
          description: '.description',
          dropboxLink: "a[href*='submit']",
          status: '.status'
        },
        submissionSelectors: {
          fileInput: "input[type='file']",
          submitButton: "button[type='submit']",
          confirmationText: 'submitted',
          confirmationIndicator: '.confirmation'
        }
      };
    }

    // Build and save cipher-portal.json
    portalJson = {
      portalUrl: portalUrl,
      loginPage: preset.loginPage,
      dashboardPage: preset.dashboardPage,
      sso: preset.sso,
      loginSelectors: preset.loginSelectors,
      navigationSelectors: preset.navigationSelectors,
      assignmentSelectors: preset.assignmentSelectors,
      submissionSelectors: preset.submissionSelectors,
      navigation: {
        pageLoadDelayMs: 4000,
        actionDelayMs: 2000,
        maxRetries: 3,
        retryBaseDelayMs: 2000
      },
      courses: []
    };

    // ─── Portal Credentials ─────────────────────────

    console.log(chalk.hex('#FF6B6B').bold('\n  ━━━ Portal Login Credentials ━━━'));
    console.log(chalk.gray('  Your credentials are encrypted with AES-256-GCM and stored locally.'));
    console.log(chalk.gray('  They never leave your machine.\n'));

    const { portalUsername } = await inquirer.prompt([{
      type: 'input',
      name: 'portalUsername',
      message: 'Portal username (student ID or email):',
      validate: (v) => v.trim() ? true : 'Username is required'
    }]);

    const { portalPassword } = await inquirer.prompt([{
      type: 'password',
      name: 'portalPassword',
      message: 'Portal password:',
      mask: '•',
      validate: (v) => v ? true : 'Password is required'
    }]);

    // Auto-generate vault key if not present
    if (!cipherConfig.vaultKey) {
      cipherConfig.vaultKey = randomBytes(32).toString('hex');
      console.log(chalk.green('  ✓ Generated new vault encryption key'));
    }

    // Store credentials using CipherVault
    const spinner = ora('  Encrypting credentials...').start();
    try {
      // Set the key in env so CipherVault can use it
      process.env.CIPHER_VAULT_KEY = cipherConfig.vaultKey;

      const { CipherVault } = await import('./core/cipher-vault.js');
      const vault = new CipherVault();
      vault.storeCredentials(portalUsername, portalPassword);

      // Verify round-trip
      const retrieved = vault.getCredentials();
      if (retrieved.username === portalUsername) {
        spinner.succeed(chalk.green('  Credentials encrypted & verified ✓'));
      } else {
        spinner.fail(chalk.red('  Credential verification failed'));
      }
    } catch (err) {
      spinner.fail(chalk.red(`  Encryption error: ${err.message}`));
      console.log(chalk.yellow('  You can set credentials later: npm run cipher -- set-credentials'));
    }

    // ─── Notification Settings ───────────────────────

    console.log(chalk.hex('#FF6B6B').bold('\n  ━━━ Cipher Notifications ━━━\n'));

    const cipherNotifyAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'telegramChatId',
        message: 'Telegram Chat ID for alerts (message @userinfobot to get yours):',
        default: cipherConfig.telegramChatId || '',
        validate: (v) => {
          if (!v.trim()) return 'Chat ID is needed to receive alerts';
          if (!/^\d+$/.test(v.trim())) return 'Chat ID should be a number';
          return true;
        }
      },
      {
        type: 'input',
        name: 'scanInterval',
        message: 'Portal scan interval in seconds (default 7200 = 2 hours):',
        default: cipherConfig.scanInterval,
        validate: (v) => {
          const n = parseInt(v);
          if (isNaN(n) || n < 300) return 'Minimum 300 seconds (5 minutes)';
          return true;
        }
      },
      {
        type: 'input',
        name: 'alertThresholds',
        message: 'Alert hours before deadline (comma-separated):',
        default: cipherConfig.alertThresholds
      },
      {
        type: 'input',
        name: 'summaryHour',
        message: 'Daily summary notification hour (0-23):',
        default: cipherConfig.summaryHour,
        validate: (v) => {
          const n = parseInt(v);
          if (isNaN(n) || n < 0 || n > 23) return 'Enter a valid hour (0-23)';
          return true;
        }
      }
    ]);

    cipherConfig.telegramChatId = cipherNotifyAnswers.telegramChatId;
    cipherConfig.scanInterval = cipherNotifyAnswers.scanInterval;
    cipherConfig.alertThresholds = cipherNotifyAnswers.alertThresholds;
    cipherConfig.summaryHour = cipherNotifyAnswers.summaryHour;

    // Save cipher-portal.json
    const configDir = './config';
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    writeFileSync('./config/cipher-portal.json', JSON.stringify(portalJson, null, 2) + '\n');
    console.log(chalk.green('\n  ✓ Portal config saved to config/cipher-portal.json'));
  }

  // ─── Step 6: System Prompt ───────────────────────────

  console.log(chalk.hex('#6C5CE7').bold('\n  ━━━ Step 5: Personality ━━━\n'));

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

  // ─── Step 7: Port ────────────────────────────────────

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

# ═══ NVIDIA NIM ═══
NVIDIA_API_KEY=${config.NVIDIA_API_KEY || ''}

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

# ═══ Cipher — Academic Automation Agent ═══
CIPHER_ENABLED=${cipherConfig.enabled ? 'true' : 'false'}
CIPHER_VAULT_KEY=${cipherConfig.vaultKey}
CIPHER_SCAN_INTERVAL=${cipherConfig.scanInterval}
CIPHER_TELEGRAM_CHAT_ID=${cipherConfig.telegramChatId}
CIPHER_ALERT_THRESHOLDS=${cipherConfig.alertThresholds}
CIPHER_MACOS_NOTIFICATIONS=true
CIPHER_SUMMARY_HOUR=${cipherConfig.summaryHour}

# ═══ System Prompt ═══
SYSTEM_PROMPT=${config.SYSTEM_PROMPT}
`;

  writeFileSync('.env', envContent);
  console.log(chalk.green('  ✓ Configuration saved to .env'));

  // ─── Summary ─────────────────────────────────────────

  const providerLabel = config.AI_PROVIDER === 'gemini' 
    ? chalk.hex('#4285F4')('Google Gemini') 
    : config.AI_PROVIDER === 'nvidia'
    ? chalk.hex('#76B900')('NVIDIA NIM')
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
      NVIDIA:  ${nvidiaKey ? chalk.green('● Configured') : chalk.gray('○ Not set')}

    Platforms:
      Telegram: ${config.TELEGRAM_ENABLED === 'true' ? chalk.green('● Enabled') : chalk.gray('○ Disabled')}
      Discord:  ${config.DISCORD_ENABLED === 'true' ? chalk.green('● Enabled') : chalk.gray('○ Disabled')}
      Slack:    ${config.SLACK_ENABLED === 'true' ? chalk.green('● Enabled') : chalk.gray('○ Disabled')}
      WhatsApp: ${config.WHATSAPP_ENABLED === 'true' ? chalk.green('● Enabled') : chalk.gray('○ Disabled')}
      iMessage: ${config.IMESSAGE_ENABLED === 'true' ? chalk.green('● Enabled') : chalk.gray('○ Disabled')}

    Cipher Academic Agent:
      Status:  ${cipherConfig.enabled ? chalk.green('● Enabled') : chalk.gray('○ Disabled')}
      Portal:  ${portalJson ? chalk.hex('#FF6B6B')(portalJson.portalUrl) : chalk.gray('Not configured')}
      Alerts:  ${cipherConfig.telegramChatId ? chalk.green('● Chat ID set') : chalk.gray('○ Not set')}

  ${chalk.hex('#6C5CE7').bold('Next steps:')}

    ${chalk.white('1.')} Start Nexus AI:  ${chalk.hex('#00D2FF')('npm start')}
    ${chalk.white('2.')} Open dashboard:  ${chalk.hex('#00D2FF')(`http://localhost:${config.PORT}`)}
    ${chalk.white('3.')} Run in background: ${chalk.hex('#00D2FF')('npx pm2 start ecosystem.config.cjs')}${cipherConfig.enabled ? `

  ${chalk.hex('#FF6B6B').bold('Cipher commands:')}

    ${chalk.white('•')} Manual scan:       ${chalk.hex('#00D2FF')('npm run cipher -- scan-now')}
    ${chalk.white('•')} List assignments:  ${chalk.hex('#00D2FF')('npm run cipher -- list-assignments')}
    ${chalk.white('•')} Test notification: ${chalk.hex('#00D2FF')('npm run cipher -- test-notify')}` : ''}

  ${chalk.gray('Run "npm run setup" anytime to reconfigure.')}
`);
}

main().catch((error) => {
  console.error(chalk.red(`\n  Error: ${error.message}\n`));
  process.exit(1);
});

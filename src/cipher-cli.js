#!/usr/bin/env node

/**
 * Cipher CLI — Command-Line Management Interface
 * 
 * Usage:
 *   node src/cipher-cli.js set-credentials    — Encrypt and store portal login
 *   node src/cipher-cli.js scan-now           — Trigger immediate portal scan
 *   node src/cipher-cli.js list-assignments   — Show all tracked assignments
 *   node src/cipher-cli.js schedule-submit    — Queue a file for submission
 *   node src/cipher-cli.js view-log           — Show audit trail
 *   node src/cipher-cli.js test-notify        — Send a test notification
 *   node src/cipher-cli.js generate-key       — Generate a vault encryption key
 */

import 'dotenv/config';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { randomBytes } from 'crypto';

const banner = `
${chalk.magenta('  ╔═══════════════════════════════════════════╗')}
${chalk.magenta('  ║')}  ${chalk.bold.white('CIPHER')} ${chalk.gray('— Academic Automation Agent')}      ${chalk.magenta('║')}
${chalk.magenta('  ╚═══════════════════════════════════════════╝')}
`;

const command = process.argv[2];

async function main() {
  console.log(banner);

  switch (command) {
    case 'set-credentials':
      await setCredentials();
      break;
    case 'scan-now':
      await scanNow();
      break;
    case 'list-assignments':
    case 'list':
      await listAssignments();
      break;
    case 'schedule-submit':
    case 'submit':
      await scheduleSubmit();
      break;
    case 'view-log':
    case 'log':
      await viewLog();
      break;
    case 'test-notify':
    case 'test':
      await testNotify();
      break;
    case 'generate-key':
    case 'keygen':
      generateKey();
      break;
    default:
      showHelp();
  }
}

// ─── Commands ────────────────────────────────────────────

async function setCredentials() {
  if (!process.env.CIPHER_VAULT_KEY) {
    console.log(chalk.red('  ✗ CIPHER_VAULT_KEY not set in .env'));
    console.log(chalk.gray('    Run: node src/cipher-cli.js generate-key'));
    console.log(chalk.gray('    Then add the key to your .env file'));
    process.exit(1);
  }

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'username',
      message: 'Portal username (student ID or email):',
      validate: (v) => v.trim() ? true : 'Username is required'
    },
    {
      type: 'password',
      name: 'password',
      message: 'Portal password:',
      mask: '•',
      validate: (v) => v ? true : 'Password is required'
    },
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Encrypt and store these credentials?',
      default: true
    }
  ]);

  if (!answers.confirm) {
    console.log(chalk.gray('  Cancelled.'));
    return;
  }

  const { CipherVault } = await import('./core/cipher-vault.js');
  const vault = new CipherVault();
  vault.storeCredentials(answers.username, answers.password);

  // Verify round-trip
  const retrieved = vault.getCredentials();
  if (retrieved.username === answers.username) {
    console.log(chalk.green('  ✓ Credentials encrypted and verified'));
    console.log(chalk.gray(`    Vault: data/cipher-vault.enc`));
    console.log(chalk.gray(`    Stored at: ${retrieved.storedAt}`));
  } else {
    console.log(chalk.red('  ✗ Verification failed — encryption error'));
  }
}

async function scanNow() {
  console.log(chalk.magenta('  Triggering manual portal scan...\n'));

  const { NexusDatabase } = await import('./core/database.js');
  const db = new NexusDatabase('./data/nexus.db');
  db.initialize();

  const { CipherScheduler } = await import('./core/cipher-scheduler.js');
  const scheduler = new CipherScheduler({ database: db });

  try {
    await scheduler.manualScan();
    console.log(chalk.green('\n  ✓ Scan complete'));
  } catch (error) {
    console.error(chalk.red(`\n  ✗ Scan failed: ${error.message}`));
  } finally {
    db.close();
  }
}

async function listAssignments() {
  const { NexusDatabase } = await import('./core/database.js');
  const db = new NexusDatabase('./data/nexus.db');
  db.initialize();

  try {
    const pending = db.getPendingAssignments();

    if (pending.length === 0) {
      console.log(chalk.green('  ✓ No pending assignments'));
      console.log(chalk.gray('    Run "scan-now" to fetch from portal'));
      return;
    }

    console.log(chalk.white(`  ${pending.length} pending assignment(s):\n`));

    const now = new Date();

    for (const a of pending) {
      const due = new Date(a.due_date);
      const hoursLeft = ((due - now) / (1000 * 60 * 60)).toFixed(1);
      const isUrgent = hoursLeft <= 24;
      const isOverdue = hoursLeft <= 0;

      const statusIcon = isOverdue ? chalk.red('⊘') : isUrgent ? chalk.yellow('⚠') : chalk.green('●');
      const timeLabel = isOverdue
        ? chalk.red('OVERDUE')
        : isUrgent
          ? chalk.yellow(`${hoursLeft}h left`)
          : chalk.gray(`${hoursLeft}h left`);

      console.log(`  ${statusIcon} ${chalk.bold(a.title)}`);
      console.log(`    ${chalk.cyan(a.course_name || 'Unknown Course')}  ·  Due: ${due.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}  ·  ${timeLabel}`);
      console.log(`    Status: ${chalk.gray(a.status)}  ·  ID: ${chalk.gray(a.id.substring(0, 8))}`);
      console.log('');
    }
  } finally {
    db.close();
  }
}

async function scheduleSubmit() {
  const { NexusDatabase } = await import('./core/database.js');
  const db = new NexusDatabase('./data/nexus.db');
  db.initialize();

  try {
    const pending = db.getPendingAssignments();

    if (pending.length === 0) {
      console.log(chalk.yellow('  No pending assignments to submit. Run scan-now first.'));
      return;
    }

    const choices = pending.map(a => ({
      name: `${a.title} (${a.course_name || 'Unknown'}) — Due: ${new Date(a.due_date).toLocaleDateString()}`,
      value: a.id
    }));

    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'assignmentId',
        message: 'Select assignment:',
        choices
      },
      {
        type: 'input',
        name: 'filePath',
        message: 'Path to file to submit:',
        validate: (v) => v.trim() ? true : 'File path is required'
      },
      {
        type: 'input',
        name: 'scheduledAt',
        message: 'Schedule time (ISO format, or "now"):',
        default: 'now'
      }
    ]);

    const scheduledAt = answers.scheduledAt === 'now'
      ? new Date().toISOString()
      : answers.scheduledAt;

    db.queueSubmission(answers.assignmentId, answers.filePath, scheduledAt);
    console.log(chalk.green(`\n  ✓ Submission queued`));
    console.log(chalk.gray(`    Assignment: ${answers.assignmentId.substring(0, 8)}`));
    console.log(chalk.gray(`    File: ${answers.filePath}`));
    console.log(chalk.gray(`    Scheduled: ${scheduledAt}`));

  } finally {
    db.close();
  }
}

async function viewLog() {
  const { NexusDatabase } = await import('./core/database.js');
  const db = new NexusDatabase('./data/nexus.db');
  db.initialize();

  try {
    const logs = db.getAuditLog(30);

    if (logs.length === 0) {
      console.log(chalk.gray('  No audit log entries yet.'));
      return;
    }

    console.log(chalk.white(`  Last ${logs.length} audit events:\n`));

    for (const log of logs) {
      const time = new Date(log.created_at).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
      });

      const typeColors = {
        'scan_start': chalk.cyan,
        'scan_complete': chalk.green,
        'login': chalk.blue,
        'notify': chalk.yellow,
        'submit': chalk.magenta,
        'error': chalk.red
      };

      const colorFn = typeColors[log.event_type] || chalk.gray;
      console.log(`  ${chalk.gray(time)}  ${colorFn(log.event_type.padEnd(16))}  ${chalk.gray(log.details || '')}`);
    }

  } finally {
    db.close();
  }
}

async function testNotify() {
  console.log(chalk.magenta('  Sending test notification...\n'));

  const { CipherNotifier } = await import('./core/cipher-notifier.js');

  let telegramBot = null;
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const { default: TelegramBot } = await import('node-telegram-bot-api');
    telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
  }

  const notifier = new CipherNotifier({
    telegramBot,
    telegramChatId: process.env.CIPHER_TELEGRAM_CHAT_ID
  });

  const testAssignment = {
    title: 'Test Assignment — Cipher System Check',
    courseName: 'CS 000 — System Test',
    dueDate: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    id: 'test-001'
  };

  const result = await notifier.sendAlert(testAssignment, 'high');
  console.log(chalk.green('\n  ✓ Test notification sent'));
  console.log(chalk.gray(`    Channels: ${JSON.stringify(result.channels)}`));
}

function generateKey() {
  const key = randomBytes(32).toString('hex');
  console.log(chalk.green('  ✓ Generated vault encryption key:\n'));
  console.log(chalk.bold(`    ${key}`));
  console.log(chalk.gray('\n    Add this to your .env file as:'));
  console.log(chalk.white(`    CIPHER_VAULT_KEY=${key}\n`));
}

function showHelp() {
  console.log(chalk.white('  Available commands:\n'));
  console.log(`    ${chalk.cyan('set-credentials')}    Encrypt and store portal login credentials`);
  console.log(`    ${chalk.cyan('scan-now')}           Trigger immediate portal scan`);
  console.log(`    ${chalk.cyan('list-assignments')}   Show all tracked assignments`);
  console.log(`    ${chalk.cyan('schedule-submit')}    Queue a file for automated submission`);
  console.log(`    ${chalk.cyan('view-log')}           Show Cipher audit trail`);
  console.log(`    ${chalk.cyan('test-notify')}        Send a test notification`);
  console.log(`    ${chalk.cyan('generate-key')}       Generate a vault encryption key`);
  console.log('');
  console.log(chalk.gray('  Usage: node src/cipher-cli.js <command>'));
  console.log('');
}

main().catch(error => {
  console.error(chalk.red(`\n  ✗ Error: ${error.message}`));
  process.exit(1);
});

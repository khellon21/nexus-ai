#!/usr/bin/env node
/**
 * Mail CLI — manage email accounts for Nexus.
 *   node src/mail-cli.js add-account      — interactive: provider, address, app password
 *   node src/mail-cli.js list-accounts
 *   node src/mail-cli.js remove-account <email>
 *   node src/mail-cli.js test <email>     — live IMAP + SMTP connection check
 *   node src/mail-cli.js sync-now         — one full sync cycle
 */
import 'dotenv/config';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { MailEngine, PROVIDER_PRESETS } from './core/mail-engine.js';
import { NexusDatabase } from './core/database.js';

const command = process.argv[2];

function requireVaultKey() {
  if (!process.env.CIPHER_VAULT_KEY) {
    console.log(chalk.red('  ✗ CIPHER_VAULT_KEY not set in .env — credentials must be encrypted.'));
    console.log(chalk.gray('    Generate one: node src/cipher-cli.js generate-key'));
    process.exit(1);
  }
}

function makeEngine() {
  const db = new NexusDatabase('./data/nexus.db');
  db.initialize();
  return { db, engine: new MailEngine({ database: db }) };
}

async function addAccount() {
  requireVaultKey();
  const { provider } = await inquirer.prompt([{
    type: 'list', name: 'provider', message: 'Email provider:',
    choices: [
      ...Object.entries(PROVIDER_PRESETS).map(([value, p]) => ({ name: p.label, value })),
      { name: 'Custom (enter IMAP/SMTP hosts manually)', value: 'custom' },
    ],
  }]);

  if (provider !== 'custom') {
    const p = PROVIDER_PRESETS[provider];
    console.log(chalk.gray(`\n  You need an APP PASSWORD (not your normal password).`));
    console.log(chalk.gray(`  Create one here: ${p.appPasswordUrl}\n`));
    if (provider === 'office365') {
      console.log(chalk.yellow('  Note: many colleges block IMAP passwords. If "test" fails later,'));
      console.log(chalk.yellow('  enable forwarding from your college webmail to your Gmail instead —'));
      console.log(chalk.yellow('  forwarded .edu mail is still ranked always-important.\n'));
    }
  }

  const answers = await inquirer.prompt([
    { type: 'input', name: 'email', message: 'Email address:', validate: v => v.includes('@') || 'Enter a valid address' },
    { type: 'password', name: 'password', message: 'App password:', mask: '•', validate: v => v ? true : 'Required' },
    ...(provider === 'custom' ? [
      { type: 'input', name: 'imapHost', message: 'IMAP host:' },
      { type: 'input', name: 'imapPort', message: 'IMAP port:', default: '993' },
      { type: 'input', name: 'smtpHost', message: 'SMTP host:' },
      { type: 'input', name: 'smtpPort', message: 'SMTP port:', default: '465' },
    ] : []),
  ]);

  const { engine, db } = makeEngine();
  const acct = engine.addAccount({
    email: answers.email, password: answers.password,
    provider: provider === 'custom' ? null : provider,
    imapHost: answers.imapHost, imapPort: answers.imapPort && parseInt(answers.imapPort),
    smtpHost: answers.smtpHost, smtpPort: answers.smtpPort && parseInt(answers.smtpPort),
  });
  console.log(chalk.green(`\n  ✓ Stored ${acct.email} (encrypted). Run: node src/mail-cli.js test ${acct.email}`));
  db.close();
}

async function testAccount(email) {
  requireVaultKey();
  if (!email) { console.log(chalk.red('  Usage: node src/mail-cli.js test <email>')); process.exit(1); }
  const { engine, db } = makeEngine();
  const acct = engine._accounts.find(a => a.email === String(email).toLowerCase().trim());
  if (!acct) { console.log(chalk.red(`  ✗ No account ${email}. Add it first.`)); db.close(); process.exit(1); }

  process.stdout.write('  IMAP… ');
  try {
    const client = engine._imapFactory(acct);
    await client.connect();
    await client.logout();
    console.log(chalk.green('OK'));
  } catch (e) {
    console.log(chalk.red(`FAILED — ${e.message}`));
    if (acct.imapHost.includes('office365')) {
      console.log(chalk.yellow('  Your college likely blocks IMAP. Use webmail forwarding to Gmail instead.'));
    } else {
      console.log(chalk.yellow('  Check that this is an APP password, not your normal login password.'));
    }
  }

  process.stdout.write('  SMTP… ');
  try {
    await engine._transportFactory(acct).verify();
    console.log(chalk.green('OK'));
  } catch (e) {
    console.log(chalk.red(`FAILED — ${e.message}`));
  }
  db.close();
}

async function main() {
  switch (command) {
    case 'add-account': await addAccount(); break;
    case 'list-accounts': {
      requireVaultKey();
      const { engine, db } = makeEngine();
      const list = engine.listAccounts();
      if (!list.length) console.log(chalk.gray('  No accounts configured.'));
      for (const a of list) console.log(`  • ${a.email}  (imap: ${a.imapHost}, smtp: ${a.smtpHost})`);
      db.close(); break;
    }
    case 'remove-account': {
      requireVaultKey();
      const { engine, db } = makeEngine();
      console.log(engine.removeAccount(process.argv[3]) ? chalk.green('  ✓ Removed') : chalk.red('  ✗ Not found'));
      db.close(); break;
    }
    case 'test': await testAccount(process.argv[3]); break;
    case 'sync-now': {
      requireVaultKey();
      const { engine, db } = makeEngine();
      const res = await engine.syncAll();
      console.log(chalk.green(`  ✓ Synced ${res.synced} new message(s)`));
      for (const e of res.errors) console.log(chalk.red(`  ✗ ${e.account}: ${e.error}`));
      db.close(); break;
    }
    default:
      console.log('  Commands: add-account | list-accounts | remove-account <email> | test <email> | sync-now');
  }
}
main().catch(e => { console.error(chalk.red(`  ✗ ${e.message}`)); process.exit(1); });

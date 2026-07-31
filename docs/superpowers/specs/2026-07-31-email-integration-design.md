# Email Integration — Design Spec

**Date:** 2026-07-31
**Status:** Approved by Khellon
**Feature:** Multi-account email read/reply/triage for Nexus AI

## Goal

Nexus can read email from all of Khellon's accounts (college `.edu`, Gmail, AOL, Yahoo), reply with human approval, and — **only when asked** — report which emails are important and which are less important. No proactive email alerts, ever.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Access method | IMAP + app passwords (Gmail/Yahoo/AOL); `.edu` tries IMAP, falls back to server-side forwarding into Gmail |
| Reply safety | Draft + explicit user approval before any send (reuses the pending-tool-call approval mechanism) |
| Importance | Three combined signals: AI judgment per email + `.edu` origin always important + user-maintained VIP sender list |
| Fetch model | Silent background sync (default every 5 min) into local SQLite; questions answered from the local copy |
| Surfacing | Via the existing tool registry — works on every chat platform automatically |

## Architecture

```
src/core/mail-engine.js      ← new: IMAP sync + SMTP send + account registry
src/core/tools.js            ← new tools: check_mailbox, read_email, search_email, reply_to_email
src/core/conversation-manager.js ← intercept reply_to_email like install_npm_package (approval gate)
src/core/database.js         ← new tables: mail_accounts (metadata only), mail_messages
src/core/cipher-vault.js     ← reused as-is: stores IMAP/SMTP credentials via storeData('mail-accounts', …)
src/mail-cli.js              ← new: add/list/remove accounts, test connection
src/wizard.js                ← optional email step delegating to the same account-add logic
config/mail-vips.json        ← user-editable VIP addresses/domains
```

### MailEngine

- Constructed at boot when `MAIL_ENABLED=true`; loads account credentials from the vault.
- **Sync loop:** every `MAIL_SYNC_INTERVAL` seconds (default 300), for each account: IMAP connect (imapflow), fetch UIDs newer than the stored high-water mark from INBOX, store envelope (from, to, subject, date, message-id, uid) + first ~500 chars of text preview. Disconnect. Failures are logged and retried next cycle — never surfaced to chat.
- **Lazy bodies:** full body fetched over IMAP only when `read_email` runs, then cached in the row.
- **Send:** nodemailer SMTP per account; a reply is always sent from the account that received the original, with proper `In-Reply-To`/`References` headers.
- Flags computed at sync time and stored on the row: `is_edu` (account or sender domain ends `.edu`), `is_vip` (sender matches `config/mail-vips.json`), `is_automated` (List-Unsubscribe header / no-reply sender heuristics).

### Database

```sql
mail_messages (
  id TEXT PRIMARY KEY,           -- uuid
  account TEXT NOT NULL,         -- email address of the receiving account
  uid INTEGER NOT NULL,          -- IMAP UID
  message_id TEXT,               -- RFC 822 Message-ID (for reply threading)
  from_addr TEXT, from_name TEXT,
  subject TEXT, preview TEXT, body TEXT,   -- body NULL until lazily fetched
  received_at DATETIME,
  is_edu INTEGER DEFAULT 0, is_vip INTEGER DEFAULT 0, is_automated INTEGER DEFAULT 0,
  UNIQUE(account, uid)
)
mail_sync_state (account TEXT PRIMARY KEY, last_uid INTEGER, last_sync_at DATETIME, last_error TEXT)
```

Credentials are **not** in SQLite — they live encrypted in the vault (`data/cipher-vault-mail-accounts.enc` via `CipherVault.storeData`).

### Tools

| Tool | Behavior |
|---|---|
| `check_mailbox` | Returns recent messages (default: last 48h or last 30, whichever is larger) across all accounts: sender, subject, preview, account, flags. The conversation model triages into important / less important when presenting, guided by tool-description rules: VIP and `.edu` are always important; real humans outrank automated senders; deadlines/grades/money high; promos/newsletters low. |
| `read_email` | Fetches + returns the full body of one message by id. |
| `search_email` | LIKE search over sender/subject/preview, optional account + date filters. |
| `reply_to_email` | Takes message id + drafted body. **Never sends directly** — intercepted by the tool loop, draft shown to the user, sent only on explicit Yes. Denied → tool result "user declined". |
| `manage_vip_senders` | add/remove/list entries in `config/mail-vips.json`. |

### Approval flow

`ConversationManager` generalizes the existing install-approval intercept: a small table of gated tools (`install_npm_package`, `reply_to_email`) with per-tool prompt formatting. Pending state, ambiguous-reply re-prompt, and batching semantics are identical to the audited install flow.

### The .edu account

Attempt IMAP with provided credentials (`outlook.office365.com:993` preset). If the server rejects basic auth (typical for Microsoft 365), `mail-cli test` reports it clearly and instructs: enable forwarding from the college webmail to Gmail; forwarded college mail is then detected by sender/domain heuristics (`is_edu` on sender domain, plus X-Forwarded-For/original-To headers when present) and still ranked always-important.

### Config

```env
MAIL_ENABLED=true
MAIL_SYNC_INTERVAL=300        # seconds; sync is silent
```

## Error handling

- IMAP/SMTP failures: logged with account name, stored in `mail_sync_state.last_error`; `check_mailbox` includes a per-account staleness note if the last successful sync is old, so the AI can say "Yahoo hasn't synced since 9am".
- App password rejected: `mail-cli test` gives per-provider guidance (where to generate app passwords).
- Send failure after approval: reported back into the conversation as the tool result; the draft is not lost.

## Testing

- Unit-style script (like `_audit_test.mjs`): flag computation (edu/vip/automated), VIP matching, reply threading headers, approval-gate interception for `reply_to_email` (draft shown, nothing sent on deny/ambiguous).
- Live smoke test via `node src/mail-cli.js test <account>` against each real account during setup.

## Out of scope (YAGNI)

- Proactive email notifications (explicitly excluded by requirement)
- OAuth flows (Gmail API / Microsoft Graph)
- Attachments (read or send), HTML composition (plain-text replies)
- Folder management, mark-read/archive/delete operations
- Composing brand-new emails to arbitrary recipients (replies only, v1)

# Cipher — Autonomous Academic Automation Agent

Integrated as a new subsystem within the existing **Nexus AI** stack, Cipher adds autonomous portal navigation, assignment tracking, deadline alerting, and scheduled file submission.

## User Review Required

> [!IMPORTANT]
> **University Portal URL Required** — What is the exact URL of your university's student portal login page? (e.g., `https://portal.university.edu/login`)

> [!IMPORTANT]
> **Portal Authentication Method** — Does your portal use:
> - Standard username/password form?
> - SSO/OAuth redirect (e.g., Microsoft, Google)?
> - Multi-factor authentication (MFA)?
> Please describe the login flow so the navigator can be coded precisely.

> [!WARNING]
> **Credential Security** — Your .env file currently contains API keys in plaintext. This plan encrypts portal credentials using AES-256-GCM via a master key, stored in a separate encrypted vault file (`data/cipher-vault.enc`). The master key itself lives only in `.env` as `CIPHER_VAULT_KEY`. Is this acceptable, or would you prefer OS-level keychain integration (macOS Keychain)?

> [!IMPORTANT]
> **Notification Channels** — Your Telegram bot is already active (`@YourBot`, token configured). Should Cipher:
> 1. Send alerts via the **existing Telegram bot** to your chat ID?
> 2. Also trigger **macOS native desktop notifications** (via `osascript`)?
> 3. Also/instead use **Twilio SMS** (requires separate Twilio credentials)?
> Please confirm which channels and your Telegram chat ID.

> [!IMPORTANT]
> **Assignment File Paths** — For auto-submission, Cipher needs a mapping of local files → portal dropboxes. Where will you store completed assignment files? (e.g., `~/Assignments/CS101/hw3.pdf`). This will be configured via a JSON manifest.

---

## Architecture Overview

```mermaid
graph TD
    subgraph "Nexus AI (Existing)"
        IDX[index.js] --> AI[AI Engine]
        IDX --> DB[Database]
        IDX --> CM[ConversationManager]
        IDX --> BM[BackgroundMonitor]
        IDX --> TG[Telegram Adapter]
    end

    subgraph "Cipher Subsystem (New)"
        SCH[Scheduler Engine] --> PN[Portal Navigator]
        SCH --> ND[Notification Dispatcher]
        SCH --> FS[File Submitter]
        PN --> PV[Credential Vault]
        PN --> HB[Headless Browser - PinchTab]
        FS --> HB
        ND --> TG
        ND --> MN[macOS Notifications]
        ADB[Assignment Database] --> SCH
    end

    IDX --> SCH
    BM -.->|triggers| SCH
    SCH -.->|logs| DB
```

### State Machine — Cipher Lifecycle

```mermaid
stateDiagram-v2
    [*] --> IDLE: System Boot
    IDLE --> AUTHENTICATING: Schedule Trigger or Manual Command
    AUTHENTICATING --> AUTH_FAILED: Credentials Rejected
    AUTH_FAILED --> IDLE: Retry Backoff (exp.)
    AUTHENTICATING --> NAVIGATING: Login Success
    NAVIGATING --> EXTRACTING: Dashboard Loaded
    EXTRACTING --> AUDITING: Assignments Parsed
    AUDITING --> NOTIFYING: Deadlines Within Threshold
    AUDITING --> IDLE: No Urgent Deadlines
    NOTIFYING --> IDLE: Alerts Dispatched
    
    IDLE --> SUBMIT_AUTH: Submit Trigger Fires
    SUBMIT_AUTH --> SUBMIT_NAVIGATE: Login Success
    SUBMIT_NAVIGATE --> UPLOADING: Dropbox Located
    UPLOADING --> CONFIRMING: File Uploaded
    CONFIRMING --> IDLE: Submission Verified
    UPLOADING --> SUBMIT_FAILED: Upload Error
    SUBMIT_FAILED --> IDLE: Log + Alert
```

---

## Proposed Changes

### Credential Vault

New encrypted vault for portal credentials — never stored in plaintext.

#### [NEW] [cipher-vault.js](file:///Users/khellonpatel/Desktop/tem/nexus-ai/src/core/cipher-vault.js)

- `CipherVault` class using Node.js built-in `crypto` module (AES-256-GCM)
- Methods: `encrypt(data)`, `decrypt(data)`, `storeCredentials(username, password)`, `getCredentials()`
- Vault file stored at `data/cipher-vault.enc`
- Master encryption key sourced from `CIPHER_VAULT_KEY` env var
- CLI helper to initially set credentials: `node src/cipher-cli.js set-credentials`

---

### Portal Navigator

Headless browser automation using the existing PinchTab integration.

#### [NEW] [portal-navigator.js](file:///Users/khellonpatel/Desktop/tem/nexus-ai/src/core/portal-navigator.js)

- `PortalNavigator` class extending the existing `ToolExecutor` browser methods
- **State machine** with states: `IDLE`, `AUTHENTICATING`, `NAVIGATING`, `EXTRACTING`, `AUTH_FAILED`
- `login()` — Navigate to portal URL, inject credentials from vault, handle redirects
- `navigateToDashboard()` — Post-login navigation to assignment hub
- `extractAssignments()` — Parse dropbox list, extract: `{ title, courseId, dueDate, description, dropboxUrl, status }`
- `navigateToDropbox(dropboxUrl)` — Navigate to specific assignment dropbox for submission
- Configurable selectors via `config/cipher-portal.json` so UI changes don't require code edits
- Retry logic with exponential backoff (3 attempts, 2s → 4s → 8s)
- Screenshot capture on failure for debugging (saved to `data/cipher-screenshots/`)

---

### Assignment Database

New SQLite tables in existing `nexus.db`.

#### [MODIFY] [database.js](file:///Users/khellonpatel/Desktop/tem/nexus-ai/src/core/database.js)

Add new tables and methods:

```sql
CREATE TABLE IF NOT EXISTS cipher_assignments (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL,
    course_name TEXT,
    title TEXT NOT NULL,
    description TEXT,
    due_date DATETIME NOT NULL,
    dropbox_url TEXT,
    status TEXT DEFAULT 'pending',  -- pending, submitted, overdue, notified
    last_checked DATETIME DEFAULT CURRENT_TIMESTAMP,
    submitted_at DATETIME,
    submission_file TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cipher_submissions (
    id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    scheduled_at DATETIME NOT NULL,
    executed_at DATETIME,
    status TEXT DEFAULT 'queued',  -- queued, submitted, failed, confirmed
    error_message TEXT,
    FOREIGN KEY (assignment_id) REFERENCES cipher_assignments(id)
);

CREATE TABLE IF NOT EXISTS cipher_audit_log (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,  -- scan, notify, submit, error
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

New methods:
- `upsertAssignment(data)` — Insert or update assignment by title + courseId
- `getPendingAssignments()` — Get assignments where `due_date > now` and `status != 'submitted'`
- `getUrgentAssignments(hoursThreshold)` — Assignments due within N hours
- `queueSubmission(assignmentId, filePath, scheduledAt)` — Add to submission queue
- `getPendingSubmissions()` — Get queued submissions where `scheduled_at <= now`
- `logAuditEvent(type, details)` — Write to audit log

---

### Scheduler Engine

Internal cron-like scheduler using `setInterval` + priority queue.

#### [NEW] [cipher-scheduler.js](file:///Users/khellonpatel/Desktop/tem/nexus-ai/src/core/cipher-scheduler.js)

- `CipherScheduler` class
- **Scan Schedule**: Configurable interval (default: every 2 hours) to:
  1. Authenticate → navigate → extract assignments → upsert to DB
  2. Audit deadlines → dispatch notifications for assignments due within threshold
- **Submission Queue**: Checks every 5 minutes for queued submissions where `scheduled_at <= now`
  1. Authenticate → navigate to dropbox → upload file → confirm → update DB
- **Notification Schedule**: 
  - 48-hour warning (single SMS/Telegram)
  - 24-hour warning (SMS + desktop push)
  - 6-hour warning (escalated: all channels)
  - 1-hour warning (critical: repeated alerts)
- Priority queue with `deadline - now` as priority value
- Methods: `start()`, `stop()`, `runScan()`, `runSubmissionQueue()`, `scheduleSubmission(assignmentId, filePath, time)`

---

### Notification Dispatcher

Multi-channel alerting.

#### [NEW] [cipher-notifier.js](file:///Users/khellonpatel/Desktop/tem/nexus-ai/src/core/cipher-notifier.js)

- `CipherNotifier` class
- **Telegram**: Uses existing `node-telegram-bot-api` — sends formatted messages to configured chat ID
- **macOS Desktop**: Uses `child_process.exec` + `osascript` to trigger native Notification Center alerts
- **SMS (optional)**: Twilio integration if credentials provided
- Message formatting:
  ```
  🚨 CIPHER ALERT — Assignment Due Soon
  ━━━━━━━━━━━━━━━━━━━━━━━━━━
  📚 CS 301 — Data Structures
  📝 Homework #5: Binary Trees
  ⏰ Due: Apr 14, 2026 at 11:59 PM
  ⏳ Time Left: 23h 41m
  ━━━━━━━━━━━━━━━━━━━━━━━━━━
  ```
- Deduplication: Won't re-send the same alert within a configurable cooldown window (default: 4 hours)
- Methods: `sendAlert(assignment, urgencyLevel)`, `sendSubmissionConfirmation(assignment)`, `sendDailySummary(assignments)`

---

### File Submitter

Automated file upload via headless browser.

#### [NEW] [cipher-submitter.js](file:///Users/khellonpatel/Desktop/tem/nexus-ai/src/core/cipher-submitter.js)

- `CipherSubmitter` class
- Takes a `PortalNavigator` instance
- `submit(assignmentId, filePath)`:
  1. Verify file exists locally
  2. Authenticate via navigator
  3. Navigate to assignment dropbox URL
  4. Locate file upload input element via PinchTab snapshot
  5. Upload file via PinchTab file upload action
  6. Click submit button
  7. Verify confirmation page/message
  8. Update database status
  9. Send confirmation notification
- File path mapping via `config/cipher-submissions.json`:
  ```json
  {
    "submissions": [
      {
        "coursePattern": "CS 301",
        "assignmentPattern": "Homework #5",
        "filePath": "/Users/khellonpatel/Assignments/CS301/hw5.pdf",
        "submitAt": "2026-04-14T10:00:00-04:00"
      }
    ]
  }
  ```

---

### CLI Tool

Setup and management interface.

#### [NEW] [cipher-cli.js](file:///Users/khellonpatel/Desktop/tem/nexus-ai/src/cipher-cli.js)

- `set-credentials` — Encrypt and store portal username/password
- `scan-now` — Trigger immediate portal scan
- `list-assignments` — Show all tracked assignments with status
- `schedule-submit` — Queue a file for submission
- `view-log` — Show audit trail
- Uses `inquirer` (already a dependency) for interactive prompts

---

### Configuration Files

#### [NEW] [cipher-portal.json](file:///Users/khellonpatel/Desktop/tem/nexus-ai/config/cipher-portal.json)

Portal-specific selectors and URLs — editable without code changes:
```json
{
  "portalUrl": "https://your-university-portal.edu",
  "loginSelectors": {
    "usernameInput": "#username",
    "passwordInput": "#password", 
    "submitButton": "#login-btn"
  },
  "dashboardSelectors": {
    "courseLinks": ".course-card a",
    "assignmentList": ".assignment-row",
    "assignmentTitle": ".assignment-title",
    "dueDate": ".due-date",
    "dropboxLink": ".dropbox-link"
  },
  "submissionSelectors": {
    "fileInput": "input[type='file']",
    "submitButton": ".submit-btn",
    "confirmationText": "Submission successful"
  }
}
```

#### [NEW] [cipher-submissions.json](file:///Users/khellonpatel/Desktop/tem/nexus-ai/config/cipher-submissions.json)

Pre-configured submission mappings (file → dropbox → schedule time).

---

### Integration with Nexus AI

#### [MODIFY] [.env.example](file:///Users/khellonpatel/Desktop/tem/nexus-ai/.env.example)

Add new Cipher-specific environment variables:
```env
# ═══ Cipher — Academic Automation ═══
CIPHER_ENABLED=true
CIPHER_VAULT_KEY=          # 32-char hex key for credential encryption
CIPHER_SCAN_INTERVAL=7200  # Seconds between portal scans (default: 2 hours)
CIPHER_TELEGRAM_CHAT_ID=   # Your personal Telegram chat ID for alerts
CIPHER_ALERT_THRESHOLDS=48,24,6,1  # Hours before due date to alert
CIPHER_MACOS_NOTIFICATIONS=true
# Optional: Twilio SMS
CIPHER_TWILIO_SID=
CIPHER_TWILIO_AUTH=
CIPHER_TWILIO_FROM=
CIPHER_TWILIO_TO=
```

#### [MODIFY] [index.js](file:///Users/khellonpatel/Desktop/tem/nexus-ai/src/index.js)

- Import and initialize `CipherScheduler` after core systems boot
- Connect to existing database, AI engine, and Telegram adapter
- Add to graceful shutdown sequence

#### [MODIFY] [tools.js](file:///Users/khellonpatel/Desktop/tem/nexus-ai/src/core/tools.js)

Add new Cipher tools to the AI tool registry:
- `cipher_scan_portal` — Trigger an immediate portal scan
- `cipher_list_assignments` — Return current assignment tracker state
- `cipher_schedule_submission` — Queue a file for submission
- These allow Nexus AI's conversational interface to control Cipher via natural language

---

## Error Handling Protocol

| Scenario | Response |
|---|---|
| **Network Timeout** | Retry 3x with exponential backoff (2s, 4s, 8s). Log to audit. Alert if all retries fail. |
| **Authentication Rejection** | Abort immediately. Send Telegram alert: "🔒 Portal login failed — credential rotation may be needed." Don't retry credentials to avoid account lockout. |
| **Altered Portal UI** | If expected selectors not found, capture full-page screenshot. Send alert with error details. Fall back to AI-assisted parsing (send snapshot to AI engine for adaptive element discovery). |
| **File Not Found** | For submissions: abort, log, alert. Don't submit anything. |
| **Upload Failure** | Retry 2x. If still failing, send critical alert with deadline countdown. |
| **Duplicate Submission** | Check database for existing successful submission before uploading. Skip if already submitted. |
| **Scheduler Crash** | Caught by existing `uncaughtException` handler. Auto-restart scheduler after 30s delay. |

---

## New Files Summary

| File | Purpose |
|---|---|
| `src/core/cipher-vault.js` | AES-256-GCM credential encryption/decryption |
| `src/core/portal-navigator.js` | Headless browser automation for portal interaction |
| `src/core/cipher-scheduler.js` | Internal cron engine for scans and submissions |
| `src/core/cipher-notifier.js` | Multi-channel notification dispatcher |
| `src/core/cipher-submitter.js` | Automated file upload to portal dropboxes |
| `src/cipher-cli.js` | CLI for credential setup and manual operations |
| `config/cipher-portal.json` | Portal selectors and URLs (editable config) |
| `config/cipher-submissions.json` | File-to-dropbox submission mappings |

## Modified Files Summary

| File | Change |
|---|---|
| `src/core/database.js` | Add 3 new tables + assignment/submission/audit methods |
| `src/index.js` | Initialize Cipher scheduler on boot, add to shutdown |
| `src/core/tools.js` | Register 3 new Cipher tools for AI interaction |
| `.env.example` | Add Cipher env var documentation |
| `package.json` | No new external deps needed (all using built-in crypto + existing PinchTab) |

---

## Secure Environment Variable Injection

### Setting Up the Vault

```bash
# 1. Generate a random 32-byte vault key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. Add to .env
CIPHER_VAULT_KEY=<paste-output-here>

# 3. Store portal credentials (interactive, encrypted immediately)
node src/cipher-cli.js set-credentials
# Prompts for: portal username, portal password
# Encrypts with AES-256-GCM and writes to data/cipher-vault.enc
```

### Security Model
- **At rest**: Credentials encrypted with AES-256-GCM in `data/cipher-vault.enc`
- **In transit**: Credentials decrypted in-memory only during login, never written to disk unencrypted
- **In code**: Zero hardcoded secrets. All sensitive values from `.env` or vault
- **Git**: `.gitignore` already excludes `.env` and `data/`

---

## Verification Plan

### Automated Tests
1. `node src/cipher-cli.js set-credentials` — Verify vault encrypt/decrypt round-trip
2. `node src/cipher-cli.js scan-now` — Trigger manual scan, verify assignments stored in DB
3. `node src/cipher-cli.js list-assignments` — Confirm extracted data matches portal
4. Send test notification via Telegram and verify receipt on phone
5. Queue a test submission to a non-critical dropbox and verify upload

### Manual Verification
- Monitor audit log (`data/nexus.db` → `cipher_audit_log`) for complete event trail
- Verify macOS notifications appear in Notification Center
- Let scheduler run for one full cycle (2 hours) and verify end-to-end flow
- Check `data/cipher-screenshots/` for failure debugging capability

---

## Open Questions

> [!IMPORTANT]
> 1. **What is your university portal URL and login flow?** This is critical for coding the navigator selectors.
> 2. **What is your Telegram chat ID?** (Send `/start` to `@userinfobot` on Telegram to get it)
> 3. **Do you want Twilio SMS in addition to Telegram, or is Telegram + macOS notifications sufficient?**
> 4. **Where do you store your assignment files locally?** (e.g., `~/Documents/Assignments/`)
> 5. **Are there any specific courses to track, or should Cipher scan all courses on the portal?**

# 📚 Assignment Automator

> Automated scraping, SMS notifications, and scheduled submissions for your college portal.

---

## Features

| Feature | Description |
|---------|-------------|
| **Auto-Login** | Headless Chromium logs into your portal using environment variables |
| **Assignment Scraping** | Extracts names, due dates, and links from your LMS |
| **SMS Alerts** | Sends a Twilio SMS summary of assignments due within 7 days |
| **Scheduled Submissions** | APScheduler auto-uploads files before deadlines |
| **Error Handling** | Comprehensive try/except with structured logging |

---

## Quick Start

### 1. Clone & Install

```bash
cd /path/to/assament

# Create a virtual environment (recommended)
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Install Playwright browsers (one-time)
playwright install chromium
```

### 2. Configure Environment Variables

```bash
cp .env.example .env
```

Open `.env` and fill in **every** value:

| Variable | Description |
|----------|-------------|
| `PORTAL_URL` | Full URL of your portal's login page |
| `PORTAL_USERNAME` | Your student ID or email |
| `PORTAL_PASSWORD` | Your portal password |
| `TWILIO_ACCOUNT_SID` | From [Twilio Console](https://console.twilio.com) |
| `TWILIO_AUTH_TOKEN` | From Twilio Console |
| `TWILIO_FROM_NUMBER` | Your Twilio phone number (E.164 format: `+1...`) |
| `NOTIFY_TO_NUMBER` | Your personal phone number to receive SMS |
| `TIMEZONE` | IANA timezone, e.g. `America/New_York` |

> ⚠️ **Never commit `.env` to version control.** It's already in `.gitignore`.

### 3. Configure Submissions

Edit `submission_config.py` to map your assignment names to local files:

```python
SUBMISSION_MAP = {
    "Lab 5 Report": {
        "file_path": "/absolute/path/to/lab5_report.pdf",
        "submit_before": 60,      # minutes before deadline
    },
    "Homework 3": {
        "file_path": "/absolute/path/to/hw3.pdf",
        "submit_before": 30,
    },
}
```

### 4. Customise Portal Selectors

Every college portal has different HTML. You **must** update the CSS selectors in `assignment_automator.py` to match your specific LMS:

- **Login selectors** — `portal_login()` function (~line 80)
- **Navigation selectors** — `scrape_assignments()` function (~line 130)
- **Assignment row selectors** — same function (~line 160)
- **File upload / submit selectors** — `submit_assignment()` function (~line 260)

**Tip:** Run with `--headful` to see the browser and inspect elements:
```bash
python assignment_automator.py --headful
```

---

## Usage

### One-shot: Scrape & Notify

```bash
python assignment_automator.py
```

Scrapes all assignments, prints a summary, and sends an SMS.

### Scrape Only (no SMS)

```bash
python assignment_automator.py --no-sms
```

### Run Scheduler Daemon

```bash
python assignment_automator.py --schedule
```

Keeps running in the foreground. When a scheduled time arrives, it logs in, uploads, and submits your file. Press `Ctrl+C` to stop.

### Debug Mode (visible browser)

```bash
python assignment_automator.py --headful --no-sms
```

---

## Architecture

```
assignment_automator.py     ← Main script (login, scrape, notify, submit)
submission_config.py        ← Your assignment → file mapping
.env                        ← Secrets (gitignored)
.env.example                ← Template for .env
requirements.txt            ← Python dependencies
```

### Module Breakdown

```
§1  portal_login()          — Playwright-based authentication
§2  scrape_assignments()    — DOM traversal + date parsing
§3  send_sms_notification() — Twilio SMS composition & delivery
§4  submit_assignment()     — File upload + form submission
§5  build_scheduler()       — APScheduler job creation
§6  main()                  — CLI argument parsing & orchestration
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Login may have failed` | Verify `PORTAL_USERNAME` and `PORTAL_PASSWORD` in `.env` |
| `Could not locate login form elements` | Update CSS selectors in `portal_login()` for your portal |
| `No assignments found` | Update row/navigation selectors in `scrape_assignments()` |
| `SMS send failed` | Check Twilio credentials and phone number format |
| `File not found` | Ensure `file_path` in `submission_config.py` is absolute |
| `Playwright browser not found` | Run `playwright install chromium` |

---

## Security Notes

- **Credentials** are loaded exclusively from environment variables via `python-dotenv`.
- **`.env` is gitignored** — it will never be committed.
- The browser runs **headless by default** — no visible window.
- Consider running the scheduler behind a process manager like `systemd` or `pm2` for production use.

---

## License

MIT — use at your own risk. The author is not responsible for missed deadlines, incorrect submissions, or portal policy violations.


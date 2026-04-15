/**
 * Calendar Adapter — Assignment → Calendar Sync
 * 
 * Two sync modes:
 * 1. ICS Feed: Serves a subscribable .ics URL that any calendar app can import
 *    - Apple Calendar: Add → Subscribe → http://localhost:3000/api/calendar/assignments.ics
 *    - Google Calendar: Other calendars → From URL → paste the URL
 *    - Outlook: Add calendar → From internet → paste the URL
 * 
 * 2. Google Calendar API Push (optional): Directly creates/updates events
 *    - Requires Google Cloud credentials (see setup instructions below)
 */

import { createHash } from 'crypto';

// ─── ICS Feed Generator ─────────────────────────────────

export class CalendarAdapter {
  constructor(options = {}) {
    this.db = options.database;
    this.calendarName = options.calendarName || 'Nexus AI - Assignments';
    this.refreshInterval = options.refreshIntervalMin || 60; // How often calendar apps should re-fetch (minutes)
    
    // Google Calendar API (optional)
    this.googleEnabled = !!(process.env.GOOGLE_CALENDAR_CREDENTIALS);
    this.googleCalendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    this.googleClient = null;
    this.syncedEventIds = new Map(); // assignmentId → googleEventId
  }

  // ─── ICS Feed ──────────────────────────────────────────

  /**
   * Generate a full .ics calendar file from all assignments.
   * This is served at /api/calendar/assignments.ics
   */
  generateICS() {
    const assignments = this.db.getAllAssignments ? this.db.getAllAssignments() : [];
    
    const events = assignments.map(a => this._assignmentToVEvent(a)).join('');
    
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      `PRODID:-//Nexus AI//Cipher Academic Agent//EN`,
      `X-WR-CALNAME:${this.calendarName}`,
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-PUBLISHED-TTL:PT${this.refreshInterval}M`,
      `REFRESH-INTERVAL;VALUE=DURATION:PT${this.refreshInterval}M`,
      events,
      'END:VCALENDAR'
    ].join('\r\n');

    return ics;
  }

  /**
   * Convert a single assignment to a VEVENT block.
   */
  _assignmentToVEvent(assignment) {
    const uid = this._generateUID(assignment);
    const dueDate = new Date(assignment.due_date);
    
    // Create event: 1 hour before deadline → deadline
    const startDate = new Date(dueDate.getTime() - 60 * 60 * 1000);
    
    const dtStart = this._formatICSDate(startDate);
    const dtEnd = this._formatICSDate(dueDate);
    const dtStamp = this._formatICSDate(new Date());
    const created = this._formatICSDate(new Date(assignment.created_at || Date.now()));
    
    // Build description
    const parts = [];
    if (assignment.course_name) parts.push(`Course: ${assignment.course_name}`);
    if (assignment.completion_status) parts.push(`Status: ${assignment.completion_status}`);
    if (assignment.score) parts.push(`Score: ${assignment.score}`);
    if (assignment.evaluation_status) parts.push(`Evaluation: ${assignment.evaluation_status}`);
    if (assignment.dropbox_url) parts.push(`Portal: ${assignment.dropbox_url}`);
    parts.push('', 'Managed by Nexus AI — Cipher Academic Agent');
    
    const description = parts.join('\\n');
    const summary = this._escapeICS(assignment.title);
    const location = assignment.course_name ? this._escapeICS(assignment.course_name) : '';
    
    // Color/category based on urgency
    const hoursLeft = (dueDate - new Date()) / (1000 * 60 * 60);
    let status = 'CONFIRMED';
    let categories = 'Assignment';
    if (assignment.completion_status && assignment.completion_status.includes('Submission')) {
      status = 'CONFIRMED';
      categories = 'Submitted';
    } else if (hoursLeft <= 0) {
      categories = 'Overdue';
    } else if (hoursLeft <= 24) {
      categories = 'Urgent';
    }

    // Add alarm: 24h before, 6h before, 1h before
    const alarms = [
      this._createAlarm(24 * 60, `24h until: ${assignment.title}`),
      this._createAlarm(6 * 60, `6h until: ${assignment.title}`),
      this._createAlarm(60, `1h until: ${assignment.title}`)
    ].join('');

    return [
      '',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${dtStamp}`,
      `DTSTART:${dtStart}`,
      `DTEND:${dtEnd}`,
      `CREATED:${created}`,
      `SUMMARY:📚 ${summary}`,
      `DESCRIPTION:${description}`,
      location ? `LOCATION:${location}` : '',
      `STATUS:${status}`,
      `CATEGORIES:${categories}`,
      `TRANSP:OPAQUE`,
      alarms,
      'END:VEVENT',
      ''
    ].filter(Boolean).join('\r\n');
  }

  /**
   * Create an ICS alarm (VALARM) block.
   */
  _createAlarm(minutesBefore, description) {
    return [
      '',
      'BEGIN:VALARM',
      'TRIGGER;RELATED=START:-PT' + minutesBefore + 'M',
      'ACTION:DISPLAY',
      `DESCRIPTION:${this._escapeICS(description)}`,
      'END:VALARM'
    ].join('\r\n');
  }

  /**
   * Generate a stable UID for an assignment (so updates don't duplicate events).
   */
  _generateUID(assignment) {
    const hash = createHash('md5')
      .update(`${assignment.course_id}:${assignment.title}`)
      .digest('hex')
      .substring(0, 16);
    return `cipher-${hash}@nexus-ai`;
  }

  /**
   * Format a Date object into ICS timestamp format (YYYYMMDDTHHmmssZ).
   */
  _formatICSDate(date) {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  /**
   * Escape special characters for ICS text fields.
   */
  _escapeICS(text) {
    if (!text) return '';
    return text
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  }

  // ─── Google Calendar API Push (Optional) ───────────────

  /**
   * Initialize Google Calendar API client.
   * Requires GOOGLE_CALENDAR_CREDENTIALS env var pointing to credentials JSON file.
   */
  async initializeGoogle() {
    if (!this.googleEnabled) return false;

    try {
      const { google } = await import('googleapis');
      const { readFileSync } = await import('fs');

      const credPath = process.env.GOOGLE_CALENDAR_CREDENTIALS;
      const credentials = JSON.parse(readFileSync(credPath, 'utf-8'));

      // Support both service account and OAuth2 credentials
      if (credentials.type === 'service_account') {
        const auth = new google.auth.GoogleAuth({
          credentials,
          scopes: ['https://www.googleapis.com/auth/calendar']
        });
        this.googleClient = google.calendar({ version: 'v3', auth });
      } else if (credentials.installed || credentials.web) {
        // OAuth2 flow — requires token.json
        const tokenPath = process.env.GOOGLE_CALENDAR_TOKEN || './data/google-calendar-token.json';
        const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;
        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

        try {
          const token = JSON.parse(readFileSync(tokenPath, 'utf-8'));
          oAuth2Client.setCredentials(token);
          this.googleClient = google.calendar({ version: 'v3', auth: oAuth2Client });
        } catch (e) {
          console.log(`  ⚠ Google Calendar: Token not found at ${tokenPath}. Run calendar setup first.`);
          return false;
        }
      }

      console.log('  ✓ Google Calendar API initialized');
      return true;
    } catch (e) {
      console.log(`  ⚠ Google Calendar: ${e.message}`);
      return false;
    }
  }

  /**
   * Push all assignments to Google Calendar.
   * Creates new events and updates existing ones.
   */
  async pushToGoogle() {
    if (!this.googleClient) return { pushed: 0, error: 'Google Calendar not initialized' };

    const assignments = this.db.getAllAssignments ? this.db.getAllAssignments() : [];
    let pushed = 0;
    let errors = 0;

    for (const assignment of assignments) {
      try {
        const eventId = this._generateGoogleEventId(assignment);
        const event = this._assignmentToGoogleEvent(assignment);

        try {
          // Try to update existing event
          await this.googleClient.events.update({
            calendarId: this.googleCalendarId,
            eventId,
            resource: event
          });
        } catch (e) {
          if (e.code === 404) {
            // Event doesn't exist, create it
            event.id = eventId;
            await this.googleClient.events.insert({
              calendarId: this.googleCalendarId,
              resource: event
            });
          } else {
            throw e;
          }
        }
        pushed++;
      } catch (e) {
        errors++;
        console.error(`  ✗ Calendar push failed for "${assignment.title}": ${e.message}`);
      }
    }

    console.log(`  \x1b[32m[Calendar]\x1b[0m Pushed ${pushed} events to Google Calendar (${errors} errors)`);
    return { pushed, errors };
  }

  /**
   * Convert assignment to Google Calendar event format.
   */
  _assignmentToGoogleEvent(assignment) {
    const dueDate = new Date(assignment.due_date);
    const startDate = new Date(dueDate.getTime() - 60 * 60 * 1000);

    const description = [
      assignment.course_name ? `Course: ${assignment.course_name}` : '',
      assignment.completion_status ? `Status: ${assignment.completion_status}` : '',
      assignment.score ? `Score: ${assignment.score}` : '',
      assignment.dropbox_url ? `Portal: ${assignment.dropbox_url}` : '',
      '',
      'Managed by Nexus AI — Cipher Academic Agent'
    ].filter(Boolean).join('\n');

    return {
      summary: `📚 ${assignment.title}`,
      description,
      location: assignment.course_name || undefined,
      start: {
        dateTime: startDate.toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      },
      end: {
        dateTime: dueDate.toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 24 * 60 },
          { method: 'popup', minutes: 6 * 60 },
          { method: 'popup', minutes: 60 }
        ]
      },
      colorId: this._getGoogleColorId(assignment)
    };
  }

  /**
   * Generate a stable Google Calendar event ID (must be lowercase a-v and digits, 5-1024 chars).
   */
  _generateGoogleEventId(assignment) {
    const hash = createHash('md5')
      .update(`${assignment.course_id}:${assignment.title}`)
      .digest('hex');
    // Google event IDs: lowercase letters a-v and digits 0-9
    return hash.replace(/[g-z]/g, c => String.fromCharCode(((c.charCodeAt(0) - 97) % 22) + 97));
  }

  /**
   * Map assignment urgency to Google Calendar color IDs.
   */
  _getGoogleColorId(assignment) {
    const hoursLeft = (new Date(assignment.due_date) - new Date()) / (1000 * 60 * 60);
    if (assignment.completion_status?.includes('Submission')) return '2'; // Green — submitted
    if (hoursLeft <= 0) return '4';   // Red — overdue
    if (hoursLeft <= 24) return '6';  // Orange — urgent
    if (hoursLeft <= 72) return '5';  // Yellow — soon
    return '1'; // Blue — normal
  }

  // ─── Express Route Registration ────────────────────────

  /**
   * Register calendar routes on an Express app.
   */
  registerRoutes(app) {
    // ICS feed endpoint
    app.get('/api/calendar/assignments.ics', (req, res) => {
      try {
        const ics = this.generateICS();
        res.set({
          'Content-Type': 'text/calendar; charset=utf-8',
          'Content-Disposition': 'inline; filename="assignments.ics"',
          'Cache-Control': 'no-cache, must-revalidate',
          'X-WR-CALNAME': this.calendarName
        });
        res.send(ics);
      } catch (error) {
        console.error('ICS generation error:', error.message);
        res.status(500).json({ error: error.message });
      }
    });

    // Calendar info endpoint
    app.get('/api/calendar/info', (req, res) => {
      const assignments = this.db.getAllAssignments ? this.db.getAllAssignments() : [];
      const port = process.env.PORT || 3000;
      
      res.json({
        icsUrl: `http://localhost:${port}/api/calendar/assignments.ics`,
        totalEvents: assignments.length,
        upcomingEvents: assignments.filter(a => new Date(a.due_date) > new Date()).length,
        calendarName: this.calendarName,
        googleCalendarEnabled: this.googleEnabled,
        instructions: {
          apple: `Open Calendar app → File → New Calendar Subscription → Enter URL: http://localhost:${port}/api/calendar/assignments.ics`,
          google: `Open Google Calendar → Settings → Add calendar → From URL → Paste: http://localhost:${port}/api/calendar/assignments.ics (Note: Google Calendar requires a publicly accessible URL. Use ngrok or similar for remote access.)`,
          outlook: `Open Outlook → Add calendar → Subscribe from web → Paste URL`,
          manual: `Download the .ics file from the URL and import it into your calendar app`
        }
      });
    });

    // Google Calendar push endpoint (manual trigger)
    app.post('/api/calendar/push-google', async (req, res) => {
      if (!this.googleClient) {
        return res.status(400).json({ 
          error: 'Google Calendar not configured',
          setup: 'Set GOOGLE_CALENDAR_CREDENTIALS in .env pointing to your Google Cloud credentials JSON file'
        });
      }

      try {
        const result = await this.pushToGoogle();
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    console.log('  ✓ Calendar sync initialized (ICS feed ready)');
  }
}

export default CalendarAdapter;

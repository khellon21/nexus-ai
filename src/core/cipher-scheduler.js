/**
 * Cipher Scheduler — Internal Scheduling Engine
 * 
 * Orchestrates the full Cipher lifecycle:
 * 1. Periodic portal scans (extract assignments, upsert to DB)
 * 2. Deadline auditing and alert dispatch
 * 3. Submission queue processing
 * 4. Daily summary reports
 */

import { PortalNavigator } from './portal-navigator.js';
import { CipherNotifier } from './cipher-notifier.js';
import { CipherSubmitter } from './cipher-submitter.js';

export class CipherScheduler {
  constructor(options = {}) {
    this.db = options.database;
    this.telegramBot = options.telegramBot || null;

    // Parse alert thresholds from env (hours before deadline)
    const thresholdStr = process.env.CIPHER_ALERT_THRESHOLDS || '48,24,6,1';
    this.alertThresholds = thresholdStr.split(',').map(Number).sort((a, b) => b - a);

    // Scan interval (default: 2 hours)
    this.scanIntervalMs = (parseInt(process.env.CIPHER_SCAN_INTERVAL) || 7200) * 1000;

    // Submission queue check interval (default: 5 minutes)
    this.queueCheckIntervalMs = (parseInt(process.env.CIPHER_QUEUE_INTERVAL) || 300) * 1000;

    // Daily summary hour (default: 8 AM)
    this.dailySummaryHour = parseInt(process.env.CIPHER_SUMMARY_HOUR) || 8;

    // Timers
    this.scanTimer = null;
    this.queueTimer = null;
    this.summaryTimer = null;
    this.running = false;

    // Initialize subsystems
    this.navigator = new PortalNavigator({
      vaultPath: options.vaultPath,
      configPath: options.portalConfigPath,
      auditLog: (type, details) => this._auditLog(type, details)
    });

    this.notifier = new CipherNotifier({
      telegramBot: this.telegramBot,
      telegramChatId: process.env.CIPHER_TELEGRAM_CHAT_ID,
      auditLog: (type, details) => this._auditLog(type, details)
    });

    this.submitter = new CipherSubmitter({
      navigator: this.navigator,
      notifier: this.notifier,
      database: this.db,
      portalConfig: this.navigator.portalConfig,
      auditLog: (type, details) => this._auditLog(type, details)
    });
  }

  // ─── Lifecycle ─────────────────────────────────────────

  /**
   * Start all scheduled jobs.
   */
  start() {
    if (this.running) return;
    this.running = true;

    console.log(`  \x1b[35m[Cipher]\x1b[0m Scheduler started`);
    console.log(`  \x1b[35m[Cipher]\x1b[0m   Scan interval: ${this.scanIntervalMs / 60000} min`);
    console.log(`  \x1b[35m[Cipher]\x1b[0m   Queue check: ${this.queueCheckIntervalMs / 60000} min`);
    console.log(`  \x1b[35m[Cipher]\x1b[0m   Alert thresholds: ${this.alertThresholds.join('h, ')}h`);
    console.log(`  \x1b[35m[Cipher]\x1b[0m   Daily summary at: ${this.dailySummaryHour}:00`);

    // 1. Portal scan — first run after 30s, then on interval
    setTimeout(() => this._safeRun('scan', () => this.runScan()), 30000);
    this.scanTimer = setInterval(() => this._safeRun('scan', () => this.runScan()), this.scanIntervalMs);

    // 2. Submission queue — check every 5 minutes
    this.queueTimer = setInterval(() => this._safeRun('queue', () => this.runSubmissionQueue()), this.queueCheckIntervalMs);

    // 3. Daily summary — check every hour if it's time
    this.summaryTimer = setInterval(() => this._checkAndSendDailySummary(), 60 * 60 * 1000);
    // Also check on startup
    setTimeout(() => this._checkAndSendDailySummary(), 60000);

    this._auditLog('scheduler_start', {
      scanInterval: this.scanIntervalMs,
      queueInterval: this.queueCheckIntervalMs,
      thresholds: this.alertThresholds
    });
  }

  /**
   * Stop all scheduled jobs.
   */
  stop() {
    if (!this.running) return;

    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.queueTimer) clearInterval(this.queueTimer);
    if (this.summaryTimer) clearInterval(this.summaryTimer);

    this.scanTimer = null;
    this.queueTimer = null;
    this.summaryTimer = null;
    this.running = false;

    console.log(`  \x1b[35m[Cipher]\x1b[0m Scheduler stopped`);
    this._auditLog('scheduler_stop', {});
  }

  /**
   * Safely run a function, catching and logging errors.
   */
  async _safeRun(label, fn) {
    try {
      await fn();
    } catch (error) {
      console.error(`  \x1b[31m[Cipher]\x1b[0m ${label} error: ${error.message}`);
      this._auditLog('error', { label, error: error.message });

      // Send error alert (non-blocking)
      this.notifier.sendErrorAlert(`Cipher ${label} failed: ${error.message}`).catch(() => {});

      // Don't let a crash kill the scheduler
    }
  }

  // ─── Portal Scan ───────────────────────────────────────

  /**
   * Full portal scan: login → navigate → extract → upsert → audit.
   */
  async runScan() {
    console.log(`  \x1b[35m[Cipher]\x1b[0m Starting portal scan...`);
    this._auditLog('scan_start', {});

    try {
      // Authenticate
      const loginSuccess = await this.navigator.login();
      if (!loginSuccess) {
        await this.notifier.sendErrorAlert(
          '🔒 Portal login failed — credential rotation may be needed.\n' +
          'Run: node src/cipher-cli.js set-credentials'
        );
        return;
      }

      // Extract assignments
      const assignments = await this.navigator.extractAssignments();

      if (assignments.length === 0) {
        console.log(`  \x1b[33m[Cipher]\x1b[0m No assignments found during scan`);
        this._auditLog('scan_complete', { found: 0 });
        return;
      }

      // Upsert to database
      if (this.db) {
        for (const assignment of assignments) {
          this.db.upsertAssignment(assignment);
        }
        console.log(`  \x1b[32m[Cipher]\x1b[0m ${assignments.length} assignments synced to database`);
      }

      // Auto-match submission mappings
      this.submitter.matchAndQueue(assignments);

      // Audit deadlines and send alerts
      await this.auditDeadlines();

      this._auditLog('scan_complete', { found: assignments.length });

    } catch (error) {
      console.error(`  \x1b[31m[Cipher]\x1b[0m Scan failed: ${error.message}`);
      this._auditLog('scan_error', { error: error.message });
      throw error;
    } finally {
      await this.navigator.shutdown();
    }
  }

  // ─── Deadline Auditing ─────────────────────────────────

  /**
   * Check all pending assignments against alert thresholds.
   * Dispatch notifications for impending deadlines.
   */
  async auditDeadlines() {
    if (!this.db) return;

    console.log(`  \x1b[35m[Cipher]\x1b[0m Auditing deadlines...`);

    const pending = this.db.getPendingAssignments();
    if (pending.length === 0) {
      console.log(`  \x1b[32m[Cipher]\x1b[0m No pending assignments`);
      return;
    }

    const now = new Date();
    let alertsSent = 0;

    for (const assignment of pending) {
      const dueDate = new Date(assignment.due_date);
      const hoursLeft = (dueDate - now) / (1000 * 60 * 60);

      // Skip overdue assignments (already past)
      if (hoursLeft <= 0) {
        if (assignment.status !== 'overdue') {
          this.db.updateAssignmentStatus(assignment.id, 'overdue');
        }
        continue;
      }

      // Check each threshold
      for (const threshold of this.alertThresholds) {
        if (hoursLeft <= threshold) {
          const result = await this.notifier.sendAlert(assignment);
          if (result.sent) {
            alertsSent++;
            this.db.updateAssignmentStatus(assignment.id, 'notified');
          }
          break; // Only send for the most urgent matching threshold
        }
      }
    }

    console.log(`  \x1b[35m[Cipher]\x1b[0m Audit complete: ${pending.length} pending, ${alertsSent} alerts sent`);
    this._auditLog('audit_complete', { pending: pending.length, alertsSent });
  }

  // ─── Submission Queue ──────────────────────────────────

  /**
   * Process all queued submissions whose scheduled time has arrived.
   */
  async runSubmissionQueue() {
    if (!this.db) return;

    const pending = this.db.getPendingSubmissions();
    if (pending.length === 0) return;

    console.log(`  \x1b[35m[Cipher]\x1b[0m Processing ${pending.length} queued submission(s)...`);
    const results = await this.submitter.processQueue();

    for (const { submission, result } of results) {
      console.log(`  \x1b[35m[Cipher]\x1b[0m Submission ${submission.id}: ${result.success ? '✓' : '✗'}`);
    }
  }

  // ─── Daily Summary ─────────────────────────────────────

  /**
   * Send daily summary if it's the configured hour and we haven't sent today.
   */
  async _checkAndSendDailySummary() {
    const now = new Date();
    if (now.getHours() !== this.dailySummaryHour) return;

    // Check if we already sent today
    const todayKey = now.toISOString().split('T')[0];
    if (this._lastSummaryDate === todayKey) return;

    this._lastSummaryDate = todayKey;

    if (!this.db) return;

    const pending = this.db.getPendingAssignments();
    await this.notifier.sendDailySummary(pending);
  }

  // ─── Manual Triggers ───────────────────────────────────

  /**
   * Manually trigger a scan (used by CLI and AI tools).
   */
  async manualScan() {
    console.log(`  \x1b[35m[Cipher]\x1b[0m Manual scan triggered`);
    return await this.runScan();
  }

  /**
   * Manually schedule a submission.
   */
  scheduleSubmission(assignmentId, filePath, scheduledAt) {
    if (!this.db) throw new Error('Database not available');
    return this.db.queueSubmission(assignmentId, filePath, scheduledAt);
  }

  /**
   * Get current assignment status for AI tool response.
   */
  getAssignmentStatus() {
    if (!this.db) return { assignments: [], error: 'Database not available' };

    const allAssignments = this.db.getAllAssignments ? this.db.getAllAssignments() : [];
    const upcoming = allAssignments.filter(a => new Date(a.due_date) >= new Date())
      .sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
    const completedOrPast = allAssignments.filter(a => new Date(a.due_date) < new Date());

    const formatAssignment = (a) => {
      const dueDateObj = new Date(a.due_date);
      const dateOptions = { month: 'short', day: 'numeric', year: 'numeric' };
      const timeOptions = { hour: 'numeric', minute: '2-digit', hour12: true };
      const formattedDate = dueDateObj.toLocaleDateString('en-US', dateOptions);
      const formattedTime = dueDateObj.toLocaleTimeString('en-US', timeOptions);
      
      let semester = "Current Semester";
      if (a.course_name.includes("Spring") || a.course_name.includes("Fall") || a.course_name.includes("Summer")) {
        semester = a.course_name.split(' ')[0] + " " + a.course_name.split(' ')[1];
      }

      return {
        title: a.title,
        course: a.course_name,
        dueDate: a.due_date,
        status: a.status,
        completionStatus: a.completion_status || 'Not Submitted',
        score: a.score || 'N/A',
        evaluationStatus: a.evaluation_status || 'N/A',
        displayString: `${a.course_name}, ${semester}, Ends ${formattedDate} at ${formattedTime}`
      };
    };

    return {
      total: allAssignments.length,
      upcomingCount: upcoming.length,
      pastCount: completedOrPast.length,
      upcoming: upcoming.map(formatAssignment),
      pastAndCompleted: completedOrPast.map(formatAssignment)
    };
  }

  // ─── Audit Logging ─────────────────────────────────────

  _auditLog(eventType, details) {
    if (this.db) {
      try {
        this.db.logAuditEvent(eventType, JSON.stringify(details));
      } catch (e) {
        // Non-critical
      }
    }
  }
}

export default CipherScheduler;

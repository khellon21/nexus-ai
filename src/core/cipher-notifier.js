/**
 * Cipher Notifier — Multi-Channel Notification Dispatcher
 * 
 * Sends formatted assignment alerts via:
 * 1. Telegram (existing bot)
 * 2. macOS Notification Center (osascript)
 * 3. Twilio SMS (optional)
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ─── Urgency Levels ──────────────────────────────────────

const Urgency = {
  LOW: 'low',         // > 48 hours
  MEDIUM: 'medium',   // 24–48 hours
  HIGH: 'high',       // 6–24 hours
  CRITICAL: 'critical' // < 6 hours
};

export class CipherNotifier {
  constructor(options = {}) {
    // Telegram
    this.telegramBot = options.telegramBot || null;
    this.telegramChatId = options.telegramChatId || process.env.CIPHER_TELEGRAM_CHAT_ID;

    // macOS notifications
    this.macosEnabled = (process.env.CIPHER_MACOS_NOTIFICATIONS !== 'false') && process.platform === 'darwin';

    // Twilio
    this.twilioEnabled = !!(process.env.CIPHER_TWILIO_SID && process.env.CIPHER_TWILIO_AUTH);
    this.twilioClient = null;
    if (this.twilioEnabled) {
      this._initTwilio();
    }

    // Deduplication — track recently sent alerts
    this.recentAlerts = new Map(); // key: assignmentId+urgency → timestamp
    this.cooldownMs = (options.cooldownHours || 4) * 60 * 60 * 1000;

    // Audit logger
    this.auditLog = options.auditLog || (() => {});
  }

  _initTwilio() {
    try {
      // Dynamic import for optional dependency
      import('twilio').then(({ default: twilio }) => {
        this.twilioClient = twilio(
          process.env.CIPHER_TWILIO_SID,
          process.env.CIPHER_TWILIO_AUTH
        );
      }).catch(() => {
        console.log('  \x1b[33m[Cipher]\x1b[0m Twilio not installed — SMS disabled');
        this.twilioEnabled = false;
      });
    } catch (e) {
      this.twilioEnabled = false;
    }
  }

  // ─── Alert Management ─────────────────────────────────

  /**
   * Determine urgency level based on hours until deadline.
   */
  getUrgencyLevel(hoursRemaining) {
    if (hoursRemaining <= 1) return Urgency.CRITICAL;
    if (hoursRemaining <= 6) return Urgency.HIGH;
    if (hoursRemaining <= 24) return Urgency.MEDIUM;
    return Urgency.LOW;
  }

  /**
   * Check if an alert was recently sent (deduplication).
   */
  _wasRecentlySent(assignmentId, urgency) {
    const key = `${assignmentId}:${urgency}`;
    const lastSent = this.recentAlerts.get(key);
    if (!lastSent) return false;
    return (Date.now() - lastSent) < this.cooldownMs;
  }

  /**
   * Mark an alert as sent.
   */
  _markSent(assignmentId, urgency) {
    const key = `${assignmentId}:${urgency}`;
    this.recentAlerts.set(key, Date.now());

    // Cleanup old entries
    const cutoff = Date.now() - this.cooldownMs * 2;
    for (const [k, v] of this.recentAlerts) {
      if (v < cutoff) this.recentAlerts.delete(k);
    }
  }

  // ─── Message Formatting ─────────────────────────────────

  /**
   * Format a single assignment alert message.
   */
  formatAlertMessage(assignment, urgency) {
    const dueDate = new Date(assignment.dueDate || assignment.due_date);
    const now = new Date();
    const hoursLeft = Math.max(0, (dueDate - now) / (1000 * 60 * 60));
    const timeLeft = this._formatTimeRemaining(hoursLeft);

    const urgencyEmoji = {
      [Urgency.CRITICAL]: '🔴',
      [Urgency.HIGH]: '🟠',
      [Urgency.MEDIUM]: '🟡',
      [Urgency.LOW]: '🟢'
    };

    const urgencyLabel = {
      [Urgency.CRITICAL]: 'CRITICAL — SUBMIT NOW',
      [Urgency.HIGH]: 'HIGH PRIORITY',
      [Urgency.MEDIUM]: 'UPCOMING',
      [Urgency.LOW]: 'REMINDER'
    };

    const emoji = urgencyEmoji[urgency] || '🔔';
    const label = urgencyLabel[urgency] || 'ALERT';

    return [
      `${emoji} CIPHER — ${label}`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `📚 ${assignment.courseName || assignment.course_name || 'Course'}`,
      `📝 ${assignment.title}`,
      `⏰ Due: ${dueDate.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
      `⏳ Time Left: ${timeLeft}`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━'
    ].join('\n');
  }

  /**
   * Format a daily summary of all pending assignments.
   */
  formatDailySummary(assignments) {
    if (!assignments || assignments.length === 0) {
      return '✅ CIPHER — No pending assignments. You\'re all clear!';
    }

    const sorted = [...assignments].sort((a, b) => {
      const dateA = new Date(a.dueDate || a.due_date);
      const dateB = new Date(b.dueDate || b.due_date);
      return dateA - dateB;
    });

    const lines = [
      '📋 CIPHER — Daily Assignment Summary',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `📅 ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`,
      `📊 ${assignments.length} pending assignment${assignments.length > 1 ? 's' : ''}`,
      ''
    ];

    sorted.forEach((a, i) => {
      const dueDate = new Date(a.dueDate || a.due_date);
      const hoursLeft = Math.max(0, (dueDate - new Date()) / (1000 * 60 * 60));
      const urgency = this.getUrgencyLevel(hoursLeft);
      const urgencyEmoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' };

      lines.push(
        `${urgencyEmoji[urgency]} ${i + 1}. ${a.title}`,
        `   ${a.courseName || a.course_name || ''}  ·  Due: ${dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${dueDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}  ·  ${this._formatTimeRemaining(hoursLeft)}`,
        ''
      );
    });

    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return lines.join('\n');
  }

  /**
   * Format a submission confirmation message.
   */
  formatSubmissionConfirmation(assignment, filePath) {
    return [
      '✅ CIPHER — Submission Confirmed',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `📚 ${assignment.courseName || assignment.course_name || 'Course'}`,
      `📝 ${assignment.title}`,
      `📁 File: ${filePath.split('/').pop()}`,
      `🕐 Submitted: ${new Date().toLocaleString('en-US')}`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━'
    ].join('\n');
  }

  _formatTimeRemaining(hours) {
    if (hours < 0) return 'OVERDUE';
    if (hours < 1) return `${Math.round(hours * 60)}m remaining`;
    if (hours < 24) return `${Math.round(hours)}h remaining`;
    const days = Math.floor(hours / 24);
    const remainingHours = Math.round(hours % 24);
    return `${days}d ${remainingHours}h remaining`;
  }

  // ─── Dispatch Methods ──────────────────────────────────

  /**
   * Send an alert for a single assignment across all configured channels.
   */
  async sendAlert(assignment, urgencyOverride = null) {
    const dueDate = new Date(assignment.dueDate || assignment.due_date);
    const hoursLeft = Math.max(0, (dueDate - new Date()) / (1000 * 60 * 60));
    const urgency = urgencyOverride || this.getUrgencyLevel(hoursLeft);

    const assignmentId = assignment.id || assignment.title;

    // Deduplication check
    if (this._wasRecentlySent(assignmentId, urgency)) {
      console.log(`  \x1b[90m[Cipher]\x1b[0m Skipping duplicate alert for "${assignment.title}" (${urgency})`);
      return { sent: false, reason: 'cooldown' };
    }

    const message = this.formatAlertMessage(assignment, urgency);
    const results = { telegram: false, macos: false, sms: false };

    // Telegram
    if (this.telegramBot && this.telegramChatId) {
      try {
        await this.telegramBot.sendMessage(this.telegramChatId, message);
        results.telegram = true;
        console.log(`  \x1b[32m[Cipher]\x1b[0m Telegram alert sent for "${assignment.title}"`);
      } catch (e) {
        console.error(`  \x1b[31m[Cipher]\x1b[0m Telegram alert failed: ${e.message}`);
      }
    }

    // macOS Notification Center
    if (this.macosEnabled) {
      try {
        await this._sendMacNotification(
          `${assignment.title}`,
          `Due: ${this._formatTimeRemaining(hoursLeft)} — ${assignment.courseName || assignment.course_name || ''}`,
          urgency === Urgency.CRITICAL ? 'Basso' : undefined
        );
        results.macos = true;
      } catch (e) {
        console.error(`  \x1b[31m[Cipher]\x1b[0m macOS notification failed: ${e.message}`);
      }
    }

    // Twilio SMS (only for HIGH and CRITICAL)
    if (this.twilioEnabled && this.twilioClient && 
        (urgency === Urgency.HIGH || urgency === Urgency.CRITICAL)) {
      try {
        await this.twilioClient.messages.create({
          body: message,
          from: process.env.CIPHER_TWILIO_FROM,
          to: process.env.CIPHER_TWILIO_TO
        });
        results.sms = true;
        console.log(`  \x1b[32m[Cipher]\x1b[0m SMS alert sent for "${assignment.title}"`);
      } catch (e) {
        console.error(`  \x1b[31m[Cipher]\x1b[0m SMS alert failed: ${e.message}`);
      }
    }

    this._markSent(assignmentId, urgency);
    this.auditLog('notify', {
      assignment: assignment.title,
      urgency,
      channels: results
    });

    return { sent: true, urgency, channels: results };
  }

  /**
   * Send daily summary via all channels.
   */
  async sendDailySummary(assignments) {
    const message = this.formatDailySummary(assignments);

    if (this.telegramBot && this.telegramChatId) {
      try {
        await this.telegramBot.sendMessage(this.telegramChatId, message);
        console.log(`  \x1b[32m[Cipher]\x1b[0m Daily summary sent via Telegram`);
      } catch (e) {
        console.error(`  \x1b[31m[Cipher]\x1b[0m Telegram summary failed: ${e.message}`);
      }
    }

    if (this.macosEnabled) {
      await this._sendMacNotification(
        'Cipher — Daily Summary',
        `${assignments.length} pending assignments`
      );
    }

    this.auditLog('daily_summary', { assignmentCount: assignments.length });
  }

  /**
   * Send submission confirmation across all channels.
   */
  async sendSubmissionConfirmation(assignment, filePath) {
    const message = this.formatSubmissionConfirmation(assignment, filePath);

    if (this.telegramBot && this.telegramChatId) {
      try {
        await this.telegramBot.sendMessage(this.telegramChatId, message);
      } catch (e) {
        console.error(`  \x1b[31m[Cipher]\x1b[0m Telegram confirmation failed: ${e.message}`);
      }
    }

    if (this.macosEnabled) {
      await this._sendMacNotification(
        '✅ Submission Confirmed',
        `${assignment.title} submitted successfully`
      );
    }

    this.auditLog('submission_confirmed', {
      assignment: assignment.title,
      file: filePath
    });
  }

  /**
   * Send a raw error/failure alert.
   */
  async sendErrorAlert(errorMessage) {
    const message = [
      '⚠️ CIPHER — System Error',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━',
      errorMessage,
      `🕐 ${new Date().toLocaleString('en-US')}`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━'
    ].join('\n');

    if (this.telegramBot && this.telegramChatId) {
      try {
        await this.telegramBot.sendMessage(this.telegramChatId, message);
      } catch (e) {
        console.error(`  \x1b[31m[Cipher]\x1b[0m Error alert dispatch failed: ${e.message}`);
      }
    }

    if (this.macosEnabled) {
      await this._sendMacNotification('⚠️ Cipher Error', errorMessage, 'Basso');
    }
  }

  // ─── macOS Native Notifications ────────────────────────

  async _sendMacNotification(title, body, sound) {
    const escaped = (str) => str.replace(/"/g, '\\"').replace(/'/g, "\\'");
    const soundArg = sound ? ` sound name "${escaped(sound)}"` : '';

    const script = `display notification "${escaped(body)}" with title "${escaped(title)}" subtitle "Cipher Academic Agent"${soundArg}`;

    try {
      await execAsync(`osascript -e '${script}'`);
    } catch (e) {
      // Non-critical
    }
  }
}

export { Urgency };
export default CipherNotifier;

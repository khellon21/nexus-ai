/**
 * Cipher Submitter — Automated File Upload to Portal Dropboxes
 * 
 * Handles the full submission lifecycle:
 * 1. Verify local file exists
 * 2. Authenticate via PortalNavigator
 * 3. Navigate to assignment dropbox
 * 4. Upload file via PinchTab
 * 5. Confirm submission
 * 6. Update database and notify
 */

import { existsSync, statSync } from 'fs';
import { readFileSync } from 'fs';
import { basename } from 'path';

export class CipherSubmitter {
  constructor(options = {}) {
    this.navigator = options.navigator;
    this.notifier = options.notifier;
    this.db = options.database;
    this.portalConfig = options.portalConfig || {};

    // Load submission mappings
    this.submissionConfig = this._loadSubmissionConfig(options.submissionConfigPath);

    // Audit logger
    this.auditLog = options.auditLog || (() => {});
  }

  _loadSubmissionConfig(configPath) {
    const path = configPath || './config/cipher-submissions.json';
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch (e) {
      console.log(`  \x1b[33m[Cipher]\x1b[0m No submission config found at ${path}`);
      return { submissions: [], defaults: {} };
    }
  }

  // ─── Submission Execution ──────────────────────────────

  /**
   * Execute a file submission for a specific assignment.
   * 
   * @param {Object} assignment - Assignment record from DB
   * @param {string} filePath - Absolute path to the file to upload
   * @returns {Object} Result of the submission attempt
   */
  async submit(assignment, filePath) {
    const submissionId = assignment.submission_id || assignment.id;

    console.log(`  \x1b[35m[Cipher]\x1b[0m Starting submission for "${assignment.title}"`);
    console.log(`  \x1b[35m[Cipher]\x1b[0m File: ${filePath}`);

    // ─── Step 1: Verify file exists ─────────────────────
    if (!existsSync(filePath)) {
      const error = `File not found: ${filePath}`;
      console.error(`  \x1b[31m[Cipher]\x1b[0m ${error}`);
      this.auditLog('submit', { status: 'failed', error, assignment: assignment.title });

      if (this.db) {
        this.db.updateSubmissionStatus(submissionId, 'failed', error);
      }
      if (this.notifier) {
        await this.notifier.sendErrorAlert(`Submission failed for "${assignment.title}": ${error}`);
      }
      return { success: false, error };
    }

    const fileStats = statSync(filePath);
    console.log(`  \x1b[35m[Cipher]\x1b[0m File size: ${(fileStats.size / 1024).toFixed(1)} KB`);

    // ─── Step 2: Check for duplicate submission ──────────
    if (this.db) {
      const existing = this.db.getAssignment(assignment.id);
      if (existing && existing.status === 'submitted') {
        console.log(`  \x1b[33m[Cipher]\x1b[0m Assignment "${assignment.title}" already submitted. Skipping.`);
        return { success: false, error: 'Already submitted', skipped: true };
      }
    }

    // ─── Step 3: Authenticate ────────────────────────────
    try {
      const loginSuccess = await this.navigator.login();
      if (!loginSuccess) {
        const error = 'Portal login failed — cannot submit.';
        this.auditLog('submit', { status: 'failed', error, assignment: assignment.title });
        
        if (this.db) {
          this.db.updateSubmissionStatus(submissionId, 'failed', error);
        }
        if (this.notifier) {
          await this.notifier.sendErrorAlert(`Submission failed for "${assignment.title}": ${error}`);
        }
        return { success: false, error };
      }
    } catch (authError) {
      const error = `Authentication error: ${authError.message}`;
      this.auditLog('submit', { status: 'failed', error, assignment: assignment.title });
      if (this.db) {
        this.db.updateSubmissionStatus(submissionId, 'failed', error);
      }
      return { success: false, error };
    }

    // ─── Step 4: Navigate to dropbox ─────────────────────
    const dropboxUrl = assignment.dropbox_url || assignment.dropboxUrl;
    if (!dropboxUrl) {
      const error = 'No dropbox URL configured for this assignment.';
      console.error(`  \x1b[31m[Cipher]\x1b[0m ${error}`);
      this.auditLog('submit', { status: 'failed', error, assignment: assignment.title });
      if (this.db) {
        this.db.updateSubmissionStatus(submissionId, 'failed', error);
      }
      return { success: false, error };
    }

    try {
      await this.navigator.navigateToDropbox(dropboxUrl);

      // ─── Step 5: Upload file via Playwright ───────────
      await this.navigator.uploadFile(filePath);

      // ─── Step 6: Click submit button ──────────────────
      try {
        await this.navigator.clickSubmit();
      } catch (e) {
        console.log(`  \x1b[33m[Cipher]\x1b[0m Submit button not found — file may auto-submit`);
      }

      // ─── Step 7: Verify confirmation ──────────────────
      const confirmationText = await this.navigator.getPageText();
      const confirmIndicator = (this.portalConfig.submissionSelectors?.confirmationText) || 'submitted successfully';

      const confirmed = confirmationText.toLowerCase().includes(confirmIndicator.toLowerCase());

      if (confirmed) {
        console.log(`  \x1b[32m[Cipher]\x1b[0m ✓ Submission confirmed for "${assignment.title}"`);
      } else {
        console.log(`  \x1b[33m[Cipher]\x1b[0m Submission completed but confirmation text not found. Assuming success.`);
      }

      // ─── Step 8: Update database ──────────────────────
      if (this.db) {
        this.db.markAssignmentSubmitted(assignment.id, filePath);
        this.db.updateSubmissionStatus(submissionId, confirmed ? 'confirmed' : 'submitted');
      }

      // ─── Step 9: Send confirmation notification ───────
      if (this.notifier) {
        await this.notifier.sendSubmissionConfirmation(assignment, filePath);
      }

      this.auditLog('submit', {
        status: 'success',
        assignment: assignment.title,
        file: basename(filePath),
        confirmed
      });

      return { success: true, confirmed };

    } catch (submitError) {
      const error = `Submission error: ${submitError.message}`;
      console.error(`  \x1b[31m[Cipher]\x1b[0m ${error}`);
      
      await this.navigator._saveScreenshot('submission-failure');

      this.auditLog('submit', { status: 'failed', error, assignment: assignment.title });

      if (this.db) {
        this.db.updateSubmissionStatus(submissionId, 'failed', error);
      }
      if (this.notifier) {
        await this.notifier.sendErrorAlert(`Submission failed for "${assignment.title}": ${submitError.message}`);
      }

      return { success: false, error };
    } finally {
      // Clean up browser session
      await this.navigator.shutdown();
    }
  }

  // ─── Submission Queue Processing ───────────────────────

  /**
   * Process all pending submissions whose scheduled time has passed.
   */
  async processQueue() {
    if (!this.db) {
      console.log(`  \x1b[33m[Cipher]\x1b[0m No database — cannot process submission queue`);
      return [];
    }

    const pending = this.db.getPendingSubmissions();
    if (pending.length === 0) return [];

    console.log(`  \x1b[35m[Cipher]\x1b[0m Processing ${pending.length} queued submission(s)...`);
    const results = [];

    for (const submission of pending) {
      // Get the full assignment record
      const assignment = this.db.getAssignment(submission.assignment_id);
      if (!assignment) {
        console.error(`  \x1b[31m[Cipher]\x1b[0m Assignment ${submission.assignment_id} not found in DB`);
        this.db.updateSubmissionStatus(submission.id, 'failed', 'Assignment not found');
        continue;
      }

      // Merge submission info
      assignment.submission_id = submission.id;

      const result = await this.submit(assignment, submission.file_path);
      results.push({ submission, result });

      // Brief delay between submissions to avoid overwhelming the portal
      await this.navigator._delay(5000);
    }

    return results;
  }

  // ─── Auto-Submit Matching ──────────────────────────────

  /**
   * Check configured submission mappings against newly discovered assignments.
   * Automatically queues submissions where a match is found.
   */
  matchAndQueue(assignments) {
    if (!this.db) return [];

    const queued = [];

    for (const mapping of this.submissionConfig.submissions) {
      if (!mapping.enabled) continue;

      for (const assignment of assignments) {
        const courseMatch = !mapping.coursePattern || 
          (assignment.courseName || '').toLowerCase().includes(mapping.coursePattern.toLowerCase());
        const titleMatch = !mapping.assignmentPattern ||
          (assignment.title || '').toLowerCase().includes(mapping.assignmentPattern.toLowerCase());

        if (courseMatch && titleMatch) {
          // Check if already queued
          const existing = this.db.getSubmissionForAssignment(assignment.id);
          if (existing) continue;

          const scheduledAt = mapping.submitAt || 
            new Date(Date.now() + (this.submissionConfig.defaults?.submitMinutesBeforeDeadline || 60) * 60000).toISOString();

          this.db.queueSubmission(assignment.id, mapping.filePath, scheduledAt);
          queued.push({ assignment: assignment.title, filePath: mapping.filePath, scheduledAt });

          console.log(`  \x1b[35m[Cipher]\x1b[0m Auto-queued submission: "${assignment.title}" → ${basename(mapping.filePath)}`);
        }
      }
    }

    return queued;
  }
}

export default CipherSubmitter;

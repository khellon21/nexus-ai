/**
 * Portal Navigator — Headless Browser Automation for University Portal
 * 
 * Uses Playwright (Chromium) to navigate, authenticate,
 * and extract assignment data from the university portal.
 * 
 * Implements a state machine: IDLE → AUTHENTICATING → NAVIGATING → EXTRACTING
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { CipherVault } from './cipher-vault.js';

// ─── State Machine States ────────────────────────────────

const States = {
  IDLE: 'IDLE',
  AUTHENTICATING: 'AUTHENTICATING',
  AUTH_FAILED: 'AUTH_FAILED',
  NAVIGATING: 'NAVIGATING',
  EXTRACTING: 'EXTRACTING',
  SUBMITTING: 'SUBMITTING',
  ERROR: 'ERROR'
};

export class PortalNavigator {
  constructor(options = {}) {
    this.state = States.IDLE;
    this.vault = new CipherVault(options.vaultPath);
    this.portalConfig = this._loadPortalConfig(options.configPath);

    // Playwright browser state
    this.browser = null;
    this.context = null;
    this.page = null;

    // Retry configuration
    this.maxRetries = this.portalConfig.navigation?.maxRetries || 3;
    this.retryBaseDelay = this.portalConfig.navigation?.retryBaseDelayMs || 2000;
    this.pageLoadDelay = this.portalConfig.navigation?.pageLoadDelayMs || 4000;
    this.actionDelay = this.portalConfig.navigation?.actionDelayMs || 2000;

    // Screenshot directory for failure debugging
    this.screenshotDir = options.screenshotDir || './data/cipher-screenshots';
    if (!existsSync(this.screenshotDir)) {
      mkdirSync(this.screenshotDir, { recursive: true });
    }

    // Audit logger (injected by scheduler)
    this.auditLog = options.auditLog || (() => {});
  }

  // ─── Configuration ─────────────────────────────────────

  _loadPortalConfig(configPath) {
    const path = configPath || './config/cipher-portal.json';
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch (e) {
      console.error(`  ✗ [Cipher] Failed to load portal config: ${e.message}`);
      return {};
    }
  }

  // ─── State Machine ────────────────────────────────────

  _transition(newState) {
    const prev = this.state;
    this.state = newState;
    console.log(`  \x1b[35m[Cipher]\x1b[0m State: ${prev} → ${newState}`);
    this.auditLog('state_transition', { from: prev, to: newState });
  }

  getState() {
    return this.state;
  }

  // ─── Playwright Browser Interface ──────────────────────

  async _ensureBrowser() {
    if (this.browser && this.page) return;

    try {
      const { chromium } = await import('playwright');
      
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      this.context = await this.browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 }
      });

      this.page = await this.context.newPage();
      console.log(`  \x1b[35m[Cipher]\x1b[0m Playwright browser launched (headless Chromium)`);
    } catch (e) {
      throw new Error(`Failed to launch browser: ${e.message}`);
    }
  }

  async _navigate(url) {
    await this._ensureBrowser();
    console.log(`  \x1b[35m[Cipher]\x1b[0m Navigating to: ${url}`);

    try {
      await this.page.goto(url, { 
        waitUntil: 'networkidle',
        timeout: 30000
      });
      console.log(`  \x1b[35m[Cipher]\x1b[0m Page loaded: ${this.page.url()}`);
    } catch (e) {
      // networkidle can timeout on heavy pages — try domcontentloaded
      console.log(`  \x1b[33m[Cipher]\x1b[0m networkidle timeout, retrying with domcontentloaded...`);
      await this.page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
    }

    await this._delay(1000);
  }

  async _extractText() {
    if (!this.page) throw new Error('No active browser page');
    return await this.page.innerText('body').catch(() => '');
  }

  async _saveScreenshot(label) {
    try {
      if (!this.page) return;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${label}_${timestamp}.png`;
      await this.page.screenshot({ 
        path: join(this.screenshotDir, filename),
        fullPage: true
      });
      console.log(`  \x1b[35m[Cipher]\x1b[0m Screenshot saved: ${filename}`);
    } catch (e) {
      // Non-critical
    }
  }

  async _closeBrowser() {
    try {
      if (this.browser) {
        await this.browser.close();
      }
    } catch (e) {
      // Ignore cleanup errors
    }
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─── Authentication ────────────────────────────────────

  /**
   * Log into the university portal using encrypted credentials.
   * Handles Wright State's PingFederate SSO redirect:
   *   pilot.wright.edu → auth.wright.edu → back to pilot.wright.edu
   * Returns true on success, false on failure.
   */
  async login() {
    this._transition(States.AUTHENTICATING);

    const credentials = this.vault.getCredentials();
    const portalUrl = this.portalConfig.portalUrl;
    const loginPage = this.portalConfig.loginPage || '/login';
    const selectors = this.portalConfig.loginSelectors;
    const ssoConfig = this.portalConfig.sso || {};

    let lastError = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        console.log(`  \x1b[35m[Cipher]\x1b[0m Login attempt ${attempt}/${this.maxRetries}...`);

        // Navigate to portal login landing page
        await this._navigate(`${portalUrl}${loginPage}`);

        // Log current URL to see if SSO redirect happened
        const currentUrl = this.page.url();
        console.log(`  \x1b[35m[Cipher]\x1b[0m Current URL: ${currentUrl}`);

        // Check if the login form is already present (skip clicking LOGIN button)
        const usernameSelector = selectors.usernameInput || '#username';
        const passwordSelector = selectors.passwordInput || '#password';
        const submitSelector = selectors.submitButton || '#signOnButton';
        const ssoRedirectDomain = ssoConfig.redirectDomain || '';

        const formAlreadyVisible = await this.page.$(usernameSelector).catch(() => null);

        if (formAlreadyVisible) {
          console.log(`  \x1b[35m[Cipher]\x1b[0m Login form already visible — skipping login button click`);
        } else if (ssoRedirectDomain && currentUrl.includes(ssoRedirectDomain)) {
          console.log(`  \x1b[35m[Cipher]\x1b[0m Already on SSO page (${ssoRedirectDomain})`);
        } else {
          // Try to find and click a LOGIN button to trigger SSO redirect
          console.log(`  \x1b[35m[Cipher]\x1b[0m Looking for login button to trigger SSO...`);

          let clicked = false;

          // Strategy 1: Find button/link with login-related text
          const loginSelectors = [
            'a:has-text("LOGIN")', 'button:has-text("LOGIN")',
            'a:has-text("Log In")', 'button:has-text("Log In")',
            'a:has-text("Sign In")', 'button:has-text("Sign In")',
            'a:has-text("log in")', 'button:has-text("log in")',
            '.login-btn', '#login-btn',
            'a[href*="login"]', 'a[href*="saml"]', 'a[href*="sso"]', 'a[href*="auth"]'
          ];

          for (const sel of loginSelectors) {
            try {
              const btn = await this.page.$(sel);
              if (btn) {
                console.log(`  \x1b[35m[Cipher]\x1b[0m Found login trigger: ${sel}`);
                await Promise.all([
                  this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
                  btn.click()
                ]);
                await this._delay(3000);
                clicked = true;
                break;
              }
            } catch (e) { continue; }
          }

          if (!clicked) {
            // Strategy 2: Maybe the page auto-redirects — just wait a bit
            console.log(`  \x1b[33m[Cipher]\x1b[0m No login button found — waiting for auto-redirect...`);
            await this._delay(5000);
          }

          const ssoUrl = this.page.url();
          console.log(`  \x1b[35m[Cipher]\x1b[0m Now at: ${ssoUrl}`);
        }

        if (ssoConfig.enabled && ssoRedirectDomain && this.page.url().includes(ssoRedirectDomain)) {
          console.log(`  \x1b[35m[Cipher]\x1b[0m SSO redirect detected → ${ssoRedirectDomain}`);
        }


        // Wait for username field to be visible
        await this.page.waitForSelector(usernameSelector, { 
          state: 'visible', 
          timeout: 15000 
        });

        console.log(`  \x1b[35m[Cipher]\x1b[0m Login form found. Filling credentials...`);

        // Clear and fill username
        await this.page.fill(usernameSelector, '');
        await this.page.fill(usernameSelector, credentials.username);
        await this._delay(500);

        // Clear and fill password
        await this.page.fill(passwordSelector, '');
        await this.page.fill(passwordSelector, credentials.password);
        await this._delay(500);

        // Click login button
        await this.page.click(submitSelector);

        // Wait for navigation after login (SSO redirect chain)
        console.log(`  \x1b[35m[Cipher]\x1b[0m Waiting for SSO authentication redirect (Please approve Duo 2FA on phone if asked)...`);
        
        try {
          await this.page.waitForNavigation({ 
            waitUntil: 'networkidle', 
            timeout: 60000 // Give user 60 seconds to approve Duo 
          });
        } catch (navErr) {
          // May timeout — check URL anyway
          console.log(`  \x1b[33m[Cipher]\x1b[0m Navigation wait timeout — checking state...`);
        }

        await this._delay(3000);

        let finalUrl = this.page.url();
        console.log(`  \x1b[35m[Cipher]\x1b[0m Post-login URL: ${finalUrl}`);

        // Handle Duo 2FA "Yes, this is my device" button
        if (finalUrl.includes('duosecurity.com') || finalUrl.includes('api-')) {
          console.log(`  \x1b[35m[Cipher]\x1b[0m Duo 2FA detected. Listening for 'Yes, this is my device' button...`);
          try {
            const duoBtn = await this.page.waitForSelector('button:has-text("Yes, this is my device"), button:has-text("Trust browser"), #trust-browser-button', {
              state: 'visible',
              timeout: 45000
            });
            if (duoBtn) {
              console.log(`  \x1b[32m[Cipher]\x1b[0m Duo approved! Clicking "Yes, this is my device"...`);
              await Promise.all([
                this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
                duoBtn.click()
              ]);
              await this._delay(3000);
              finalUrl = this.page.url();
              console.log(`  \x1b[35m[Cipher]\x1b[0m Redirection URL after Duo: ${finalUrl}`);
            }
          } catch (e) {
            console.log(`  \x1b[33m[Cipher]\x1b[0m Duo button not found or wait timed out: ${e.message}`);
          }
        }

        const pageText = await this._extractText();
        const loginErrorIndicator = selectors.loginErrorIndicator || 'invalid';

        // Check for error indicators
        if (pageText.toLowerCase().includes(loginErrorIndicator.toLowerCase()) &&
            (finalUrl.includes('auth.') || finalUrl.includes('login'))) {
          throw new Error('Login failed — invalid credentials or SSO rejection.');
        }

        // Check for success: should be back on pilot.wright.edu
        const isOnPortal = finalUrl.includes(portalUrl.replace('https://', ''));
        const hasContent = pageText.toLowerCase().includes('course') ||
            pageText.toLowerCase().includes('homepage') ||
            pageText.toLowerCase().includes('my home') ||
            pageText.toLowerCase().includes('announcements');
        const notOnLogin = !finalUrl.includes('/login') && !finalUrl.includes('/SSO');

        if (isOnPortal || hasContent || notOnLogin) {
          this._transition(States.NAVIGATING);
          this.auditLog('login', { status: 'success', attempt, sso: true, url: finalUrl });
          console.log(`  \x1b[32m[Cipher]\x1b[0m Login successful on attempt ${attempt} (via SSO)`);
          return true;
        }

        throw new Error(`SSO login did not redirect to Pilot dashboard. URL: ${finalUrl}`);

      } catch (error) {
        lastError = error;
        console.error(`  \x1b[31m[Cipher]\x1b[0m Login attempt ${attempt} failed: ${error.message}`);
        await this._saveScreenshot(`login-failure-attempt-${attempt}`);

        if (attempt < this.maxRetries) {
          const backoff = this.retryBaseDelay * Math.pow(2, attempt - 1);
          console.log(`  \x1b[35m[Cipher]\x1b[0m Retrying in ${backoff / 1000}s...`);
          // Close and reopen browser for clean retry
          await this._closeBrowser();
          await this._delay(backoff);
        }
      }
    }

    this._transition(States.AUTH_FAILED);
    this.auditLog('login', { status: 'failed', error: lastError?.message });
    return false;
  }

  // ─── Assignment Extraction ─────────────────────────────

  /**
   * Navigate through the portal and extract all assignments.
   * Returns an array of assignment objects.
   */
  async extractAssignments() {
    if (this.state !== States.NAVIGATING && this.state !== States.EXTRACTING) {
      throw new Error(`Cannot extract in state ${this.state}. Login first.`);
    }

    this._transition(States.EXTRACTING);
    const assignments = [];

    try {
      const portalUrl = this.portalConfig.portalUrl;
      const dashboardPage = this.portalConfig.dashboardPage || '/d2l/home';

      // Navigate to dashboard
      await this._navigate(`${portalUrl}${dashboardPage}`);
      await this._delay(2000);

      const pageText = await this._extractText();
      console.log(`  \x1b[35m[Cipher]\x1b[0m Dashboard loaded. Extracting content...`);

      // Try to find course links on the D2L homepage
      const courseLinks = await this.page.$$eval(
        'a[href*="/d2l/home/"]',
        links => links.map(a => ({ 
          href: a.href, 
          text: a.textContent.trim() 
        })).filter(l => l.text && !l.href.endsWith('/d2l/home/'))
      ).catch(() => []);

      console.log(`  \x1b[35m[Cipher]\x1b[0m Found ${courseLinks.length} course links`);

      if (courseLinks.length === 0) {
        // Fallback: try to find courses from the widget/card view
        const widgetLinks = await this.page.$$eval(
          'd2l-card a, .d2l-courses-widget a, a.d2l-link',
          links => links.map(a => ({ href: a.href, text: a.textContent.trim() }))
        ).catch(() => []);
        
        if (widgetLinks.length > 0) {
          courseLinks.push(...widgetLinks);
        } else {
          // Last resort: parse from page text
          const textAssignments = this._parseAssignmentsFromText(pageText);
          this._transition(States.IDLE);
          return textAssignments;
        }
      }

      // Visit each course and look for assignments/dropbox
      for (const course of courseLinks) {
        try {
          console.log(`  \x1b[35m[Cipher]\x1b[0m Checking course: ${course.text}`);
          await this._navigate(course.href);
          await this._delay(2000);

          const courseName = course.text.substring(0, 80);

          // Look for Assessments/Assignments dropdown tab
          console.log(`  \x1b[35m[Cipher]\x1b[0m Looking for 'Assessments' or 'Assignments' tab...`);
          try {
            const dropdownBtn = await this.page.waitForSelector('text=Assessments, text=Assignments, button:has-text("Assessments"), button:has-text("Assignments"), a:has-text("Assessments")', {
              state: 'visible',
              timeout: 5000
            });
            if (dropdownBtn) {
              await dropdownBtn.click();
              await this._delay(1000); // Wait for dropdown to open
            }
          } catch (e) {
            console.log(`  \x1b[33m[Cipher]\x1b[0m Dropdown button not found. Moving directly to try to find Dropbox link.`);
          }

          // Click Dropbox from the dropdown or page
          console.log(`  \x1b[35m[Cipher]\x1b[0m Clicking 'Dropbox'...`);
          try {
            const dropboxLink = await this.page.waitForSelector('text=Dropbox, a:has-text("Dropbox"), [role="menuitem"]:has-text("Dropbox")', {
              state: 'visible',
              timeout: 5000
            });
            if (dropboxLink) {
              await Promise.all([
                this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
                dropboxLink.click()
              ]);
              await this._delay(3000); // Wait for dropbox to load
            }
          } catch (e) {
            console.log(`  \x1b[33m[Cipher]\x1b[0m Explicit Dropbox link not clicked, looking for fallback href...`);
            // Look for Dropbox / Assignments link in course nav (Fallback)
            const fallbackLink = await this.page.$eval(
              'a[href*="dropbox"], a[href*="assignments"], a[title*="Assignment"], a[title*="Dropbox"]',
              a => a.href
            ).catch(() => null);

            if (fallbackLink) {
              await this._navigate(fallbackLink);
              await this._delay(2000);
            } else {
              console.log(`  \x1b[33m[Cipher]\x1b[0m No Dropbox URL found for ${courseName}`);
            }
          }

          // Extract assignment data from the page table
          let courseAssignments = await this.page.$$eval('tr, d2l-table-row, [role="row"], li.d2l-datalist-item', rows => {
            const results = [];
            for (const row of rows) {
              const cells = row.querySelectorAll('th, td, d2l-td, [role="cell"]');
              if (cells.length < 2) continue; // Must be a real row
              
              const firstCell = cells[0];
              const link = firstCell.querySelector('a');
              
              // If there's a link, use it. Otherwise, use the cell's raw text for the title (like past quizzes)
              const titleEl = link || firstCell.querySelector('strong, label, div') || firstCell;
              const title = titleEl.textContent.trim();
              
              if (!title || title.toLowerCase() === 'folder' || title === 'No Category') continue;

              const text = row.textContent.replace(/\s+/g, ' ').trim();
              
              // CRITICAL: Send text back to node environment so we can print it!
              // Since this runs in browser context, console.log goes to browser console.
              // To see it in node, we can just push it into the results temporarily under 'debugText'
              
              // Extract date
              const dateMatch = text.match(/(?:due on|due|deadline):?\s*([a-z]+ \d{1,2}, \d{4} \d{1,2}:\d{2} [ap]m)/i) || 
                                text.match(/(?:due on|due|deadline):?\s*([a-z]+ \d{1,2}, \d{4})/i);
              
              let dueDateStr = null;
              if (dateMatch) {
                dueDateStr = dateMatch[1];
              }

              // Extract extra columns robustly via Regex since D2L DOM can vary (e.g. mobile view)
              let completionMatch = text.match(/(Not Submitted|\d+ Submission, \d+ File(?:s?))/i);
              let scoreMatch = text.match(/(- \/ \d+|\d+ \/ \d+\s*(?:-\s*\d+(?:\.\d+)?\s*%)?)/i);
              let evalMatch = text.match(/Feedback:\s*(Unread|Read)/i);

              let completionStatus = completionMatch ? completionMatch[1] : '';
              let score = scoreMatch ? scoreMatch[1] : '';
              let evaluationStatus = evalMatch ? evalMatch[0] : '';
              
              // Fallback to positional cells if Regex missed it
              if (cells.length >= 3) {
                 const cell1 = cells[1].textContent.replace(/\s+/g, ' ').trim();
                 const cell2 = cells[2] ? cells[2].textContent.replace(/\s+/g, ' ').trim() : '';
                 const cell3 = cells[3] ? cells[3].textContent.replace(/\s+/g, ' ').trim() : '';
                 
                 if (!completionStatus && cell1) completionStatus = cell1;
                 if (!score && cell2 && cell2.includes('/')) score = cell2;
                 if (!evaluationStatus && cell3) evaluationStatus = cell3;
              }

              results.push({
                title: title,
                description: text,
                dueDateStr: dueDateStr,
                dropboxUrl: link.href || null,
                status: 'pending',
                completionStatus: completionStatus,
                score: score,
                evaluationStatus: evaluationStatus,
                debugText: text
              });
            }
            return results;
          }).catch(() => []);

          // DEBUG LOG
          for (const a of courseAssignments) {
             if (a.title.includes('Quiz-1')) {
                console.log(`\n  \x1b[36m[Cipher DEBUG]\x1b[0m Quiz-1 text content: "${a.debugText}"\n`);
             }
          }

          // Fallback to text parser if table parsing fails
          if (courseAssignments.length === 0) {
            console.log(`  \x1b[33m[Cipher]\x1b[0m Table extraction found 0 assignments, falling back to text parsing...`);
            const courseText = await this._extractText();
            courseAssignments = this._parseAssignmentsFromText(courseText);
          } else {
            // Convert to Date objects using the navigator's built-in date parser
            courseAssignments.forEach(a => {
              if (a.dueDateStr) {
                const parsedDate = this._parseDate(a.dueDateStr);
                a.dueDate = parsedDate ? parsedDate.toISOString() : null;
                delete a.dueDateStr;
              }
            });
          }

          // Filter out assignments without due dates to avoid DB constraint errors
          courseAssignments = courseAssignments.filter(a => a.dueDate);

          // Tag with course info
          courseAssignments.forEach(a => {
            a.courseId = courseName.replace(/\s+/g, '-').toLowerCase();
            a.courseName = courseName;
          });

          assignments.push(...courseAssignments);

        } catch (courseError) {
          console.error(`  \x1b[31m[Cipher]\x1b[0m Error processing "${course.text}": ${courseError.message}`);
          await this._saveScreenshot('course-extraction-error');
        }
      }

      this._transition(States.IDLE);
      this.auditLog('extraction', { 
        status: 'success', 
        assignmentCount: assignments.length 
      });

      console.log(`  \x1b[32m[Cipher]\x1b[0m Extracted ${assignments.length} assignments`);
      return assignments;

    } catch (error) {
      this._transition(States.ERROR);
      this.auditLog('extraction', { status: 'failed', error: error.message });
      await this._saveScreenshot('extraction-failure');
      throw error;
    }
  }

  /**
   * Navigate to a specific assignment dropbox for file submission.
   */
  async navigateToDropbox(dropboxUrl) {
    if (this.state === States.IDLE) {
      const loginSuccess = await this.login();
      if (!loginSuccess) throw new Error('Cannot navigate to dropbox — login failed.');
    }

    this._transition(States.SUBMITTING);
    await this._navigate(dropboxUrl);
  }

  /**
   * Upload a file to a file input on the current page.
   */
  async uploadFile(filePath) {
    if (!this.page) throw new Error('No active browser page');

    // Find file input
    const fileInput = await this.page.$('input[type="file"]');
    if (!fileInput) {
      throw new Error('No file input found on page');
    }

    await fileInput.setInputFiles(filePath);
    console.log(`  \x1b[35m[Cipher]\x1b[0m File uploaded: ${filePath}`);
    await this._delay(2000);
  }

  /**
   * Click a submit button on the current page.
   */
  async clickSubmit() {
    if (!this.page) throw new Error('No active browser page');

    const submitSelectors = [
      'button[type="submit"]',
      '.d2l-button-primary',
      'button[primary]',
      'button:has-text("Submit")',
      'button:has-text("submit")',
      'input[type="submit"]'
    ];

    for (const sel of submitSelectors) {
      try {
        const btn = await this.page.$(sel);
        if (btn) {
          await btn.click();
          console.log(`  \x1b[35m[Cipher]\x1b[0m Submit button clicked (${sel})`);
          await this._delay(3000);
          return true;
        }
      } catch (e) {
        continue;
      }
    }

    throw new Error('Submit button not found on page');
  }

  /**
   * Get the text content of the current page.
   */
  async getPageText() {
    return await this._extractText();
  }

  /**
   * Get the current page URL.
   */
  getCurrentUrl() {
    return this.page ? this.page.url() : null;
  }

  // ─── Parsing Helpers ───────────────────────────────────

  /**
   * Parse assignment data from raw page text.
   * Looks for common patterns like "Due: April 14, 2026" or "Deadline: 04/14/2026".
   */
  _parseAssignmentsFromText(text) {
    const assignments = [];
    if (!text) return assignments;

    const lines = text.split('\n').filter(l => l.trim());
    let currentAssignment = null;

    for (const line of lines) {
      const trimmed = line.trim();

      // Date patterns
      const datePatterns = [
        /due[:\s]*(.+?(?:\d{4}|\d{1,2}[:/]\d{1,2}).*?)(?:\n|$)/i,
        /deadline[:\s]*(.+?(?:\d{4}|\d{1,2}[:/]\d{1,2}).*?)(?:\n|$)/i,
        /submit\s+by[:\s]*(.+?(?:\d{4}|\d{1,2}[:/]\d{1,2}).*?)(?:\n|$)/i,
        /closes?[:\s]*(.+?(?:\d{4}|\d{1,2}[:/]\d{1,2}).*?)(?:\n|$)/i,
        /end\s+date[:\s]*(.+?(?:\d{4}|\d{1,2}[:/]\d{1,2}).*?)(?:\n|$)/i
      ];

      // Check if this line looks like an assignment title
      if (trimmed.match(/^(assignment|homework|hw|project|lab|quiz|exam|midterm|final)/i) ||
          trimmed.match(/^(week\s*\d|module\s*\d|unit\s*\d)/i) ||
          trimmed.match(/#\d+/) ||
          trimmed.match(/^(dropbox|submission)/i)) {
        
        if (currentAssignment) {
          assignments.push(currentAssignment);
        }
        currentAssignment = {
          title: trimmed.substring(0, 200),
          description: '',
          dueDate: null,
          dropboxUrl: null,
          status: 'pending'
        };
        continue;
      }

      // Check for due date
      for (const pattern of datePatterns) {
        const match = trimmed.match(pattern);
        if (match && currentAssignment) {
          const parsedDate = this._parseDate(match[1]);
          if (parsedDate) {
            currentAssignment.dueDate = parsedDate.toISOString();
          }
        }
      }

      // Accumulate description
      if (currentAssignment && !trimmed.match(/^(due|deadline|submit|close)/i)) {
        if (currentAssignment.description.length < 500) {
          currentAssignment.description += (currentAssignment.description ? ' ' : '') + trimmed;
        }
      }
    }

    if (currentAssignment) {
      assignments.push(currentAssignment);
    }

    return assignments;
  }

  /**
   * Parse a date string into a Date object.
   */
  _parseDate(dateStr) {
    if (!dateStr) return null;

    const cleaned = dateStr.trim()
      .replace(/at\s+/i, '')
      .replace(/\s+/g, ' ');

    try {
      const date = new Date(cleaned);
      if (!isNaN(date.getTime())) return date;
    } catch (e) {
      // Fall through
    }

    const patterns = [
      { regex: /(\d{1,2})\/(\d{1,2})\/(\d{4})/, handler: (m) => new Date(m[3], m[1]-1, m[2]) },
      { regex: /(\d{4})-(\d{1,2})-(\d{1,2})/, handler: (m) => new Date(m[1], m[2]-1, m[3]) },
      { regex: /(\w+)\s+(\d{1,2}),?\s*(\d{4})/, handler: (m) => new Date(`${m[1]} ${m[2]}, ${m[3]}`) }
    ];

    for (const { regex, handler } of patterns) {
      const match = cleaned.match(regex);
      if (match) {
        const date = handler(match);
        if (!isNaN(date.getTime())) return date;
      }
    }

    return null;
  }

  // ─── Cleanup ───────────────────────────────────────────

  async shutdown() {
    await this._closeBrowser();
    this._transition(States.IDLE);
  }
}

export { States as NavigatorStates };
export default PortalNavigator;

/**
 * Puppeteer is only a transitive dependency (via whatsapp-web.js).
 * Nexus uses Playwright's Chromium for browser automation, so skip
 * Puppeteer's own ~150MB Chrome download at install time.
 *
 * If you enable the WhatsApp adapter and it fails to launch a browser,
 * remove this file and run `npm install` again to fetch Chrome.
 */
module.exports = {
  skipDownload: true,
};

/**
 * Mail triage helpers — pure functions computing importance flags.
 * Hard flags (edu / VIP) are stored on each row at sync time; the
 * conversational model does the soft "AI judgment" layer when presenting.
 */

import { readFileSync, writeFileSync } from 'fs';

const DEFAULT_VIP_PATH = './config/mail-vips.json';

const AUTOMATED_LOCAL_RE = /^(no-?reply|do-?not-?reply|newsletter|notifications?|marketing|mailer(-daemon)?|bounce|updates)/i;

function domainOf(addr) {
  const m = String(addr || '').toLowerCase().match(/@([^@\s>]+)/);
  return m ? m[1] : '';
}

export function loadVips(path = DEFAULT_VIP_PATH) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return (Array.isArray(data.vips) ? data.vips : []).map(v => String(v).toLowerCase().trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function saveVips(list, path = DEFAULT_VIP_PATH) {
  const vips = [...new Set(list.map(v => String(v).toLowerCase().trim()).filter(Boolean))];
  writeFileSync(path, JSON.stringify({ vips }, null, 2) + '\n');
  return vips;
}

export function isEduMail({ account, fromAddr }) {
  return domainOf(account).endsWith('.edu') || domainOf(fromAddr).endsWith('.edu');
}

export function isVipSender(fromAddr, vips) {
  const addr = String(fromAddr || '').toLowerCase().trim();
  const dom = domainOf(addr);
  return vips.some(v => v === addr || (!v.includes('@') && v === dom));
}

export function isAutomatedSender({ fromAddr, hasListUnsubscribe }) {
  if (hasListUnsubscribe) return true;
  const local = String(fromAddr || '').toLowerCase().split('@')[0];
  return AUTOMATED_LOCAL_RE.test(local);
}

export function computeFlags({ account, fromAddr, hasListUnsubscribe }, vips) {
  return {
    isEdu: isEduMail({ account, fromAddr }) ? 1 : 0,
    isVip: isVipSender(fromAddr, vips) ? 1 : 0,
    isAutomated: isAutomatedSender({ fromAddr, hasListUnsubscribe }) ? 1 : 0,
  };
}

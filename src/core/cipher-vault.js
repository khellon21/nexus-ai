/**
 * Cipher Vault — AES-256-GCM Encrypted Credential Store
 * 
 * Encrypts portal credentials at rest using a master key from the environment.
 * Credentials are never stored in plaintext — only the encrypted vault file exists on disk.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const ALGORITHM = 'aes-256-gcm';
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export class CipherVault {
  constructor(vaultPath = './data/cipher-vault.enc') {
    this.vaultPath = vaultPath;
    this.masterKey = process.env.CIPHER_VAULT_KEY;

    if (!this.masterKey) {
      throw new Error(
        'CIPHER_VAULT_KEY not set in .env. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
      );
    }
  }

  // ─── Encryption Primitives ──────────────────────────────

  /**
   * Derive a 256-bit key from the master key using scrypt.
   * Each encryption gets a unique salt → unique derived key.
   */
  _deriveKey(salt) {
    return scryptSync(this.masterKey, salt, KEY_LENGTH);
  }

  /**
   * Encrypt arbitrary plaintext.
   * Output format: salt(16) + iv(12) + authTag(16) + ciphertext
   */
  encrypt(plaintext) {
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const key = this._deriveKey(salt);

    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([salt, iv, authTag, encrypted]);
  }

  /**
   * Decrypt a buffer produced by encrypt().
   */
  decrypt(encryptedBuffer) {
    const salt = encryptedBuffer.subarray(0, SALT_LENGTH);
    const iv = encryptedBuffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const authTag = encryptedBuffer.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    const ciphertext = encryptedBuffer.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

    const key = this._deriveKey(salt);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);

    return decrypted.toString('utf8');
  }

  // ─── Credential Management ─────────────────────────────

  /**
   * Store portal credentials in the encrypted vault file.
   */
  storeCredentials(username, password) {
    const payload = JSON.stringify({
      username,
      password,
      storedAt: new Date().toISOString()
    });

    const encrypted = this.encrypt(payload);

    // Ensure directory exists
    const dir = dirname(this.vaultPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(this.vaultPath, encrypted);
    console.log(`  ✓ Credentials encrypted and stored in ${this.vaultPath}`);
  }

  /**
   * Retrieve decrypted portal credentials from the vault.
   * Returns { username, password, storedAt } or throws.
   */
  getCredentials() {
    if (!existsSync(this.vaultPath)) {
      throw new Error(
        `No credential vault found at ${this.vaultPath}.\n` +
        'Run: node src/cipher-cli.js set-credentials'
      );
    }

    const encryptedBuffer = readFileSync(this.vaultPath);
    const decrypted = this.decrypt(encryptedBuffer);
    return JSON.parse(decrypted);
  }

  /**
   * Check if credentials have been configured.
   */
  hasCredentials() {
    return existsSync(this.vaultPath);
  }

  /**
   * Store arbitrary key-value data in a secondary vault section.
   * Useful for storing cookies, session tokens, etc.
   */
  storeData(key, value) {
    const dataPath = this.vaultPath.replace('.enc', `-${key}.enc`);
    const encrypted = this.encrypt(JSON.stringify(value));

    const dir = dirname(dataPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(dataPath, encrypted);
  }

  /**
   * Retrieve arbitrary key-value data from secondary vault.
   */
  getData(key) {
    const dataPath = this.vaultPath.replace('.enc', `-${key}.enc`);
    if (!existsSync(dataPath)) return null;

    const encryptedBuffer = readFileSync(dataPath);
    const decrypted = this.decrypt(encryptedBuffer);
    return JSON.parse(decrypted);
  }
}

export default CipherVault;

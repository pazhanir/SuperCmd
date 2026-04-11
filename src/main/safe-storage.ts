/**
 * safe-storage.ts
 *
 * Wraps Electron's safeStorage API to encrypt/decrypt sensitive values
 * (API keys, OAuth tokens, etc.).
 *
 * Encrypted blobs are stored as base64 strings in:
 *   ~/Library/Application Support/SuperCmd/safe-storage.json
 *
 * Falls back gracefully when safeStorage is unavailable (e.g. headless CI).
 * In fallback mode values are stored as-is (no encryption).
 */

import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

function getSafeStoragePath(): string {
  return path.join(app.getPath('userData'), 'safe-storage.json');
}

let safeStorageCache: Record<string, string> | null = null;

function loadSafeStorageFile(): Record<string, string> {
  if (safeStorageCache) return safeStorageCache;
  try {
    const raw = fs.readFileSync(getSafeStoragePath(), 'utf-8');
    safeStorageCache = JSON.parse(raw) || {};
  } catch {
    safeStorageCache = {};
  }
  return safeStorageCache!;
}

function persistSafeStorageFile(data: Record<string, string>): void {
  safeStorageCache = data;
  try {
    fs.writeFileSync(getSafeStoragePath(), JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[safe-storage] Failed to write safe-storage.json:', e);
  }
}

/**
 * Returns true if Electron's safeStorage encryption backend is available.
 */
export function isSafeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Encrypt and persist a secret value under `key`.
 * - If `value` is empty/falsy, any existing entry for `key` is removed.
 * - Encrypts with safeStorage when available; falls back to plain-text storage.
 */
export function storeSecret(key: string, value: string): void {
  const data = loadSafeStorageFile();

  if (!value) {
    if (key in data) {
      delete data[key];
      persistSafeStorageFile(data);
    }
    return;
  }

  if (isSafeStorageAvailable()) {
    try {
      const encrypted = safeStorage.encryptString(value);
      // Prefix with 'enc:' so we can distinguish encrypted from plain-text fallback entries
      data[key] = 'enc:' + encrypted.toString('base64');
      persistSafeStorageFile(data);
      return;
    } catch (e) {
      console.error('[safe-storage] Encryption failed, falling back to plain text:', e);
    }
  }

  // Fallback: no encryption available — store as plain text
  data[key] = value;
  persistSafeStorageFile(data);
}

/**
 * Retrieve and decrypt a secret stored under `key`.
 * Returns `null` if the key does not exist.
 */
export function retrieveSecret(key: string): string | null {
  const data = loadSafeStorageFile();
  const stored = data[key];
  if (stored === undefined || stored === null) return null;

  if (stored.startsWith('enc:') && isSafeStorageAvailable()) {
    try {
      const buf = Buffer.from(stored.slice(4), 'base64');
      return safeStorage.decryptString(buf);
    } catch (e) {
      console.error('[safe-storage] Decryption failed for key', key, ':', e);
      return null;
    }
  }

  // Plain-text fallback entry (stored without 'enc:' prefix)
  return stored;
}

/**
 * Returns true if a secret is stored under `key`.
 */
export function hasSecret(key: string): boolean {
  const data = loadSafeStorageFile();
  return key in data;
}

/**
 * Remove a secret from safe storage.
 */
export function deleteSecret(key: string): void {
  const data = loadSafeStorageFile();
  if (key in data) {
    delete data[key];
    persistSafeStorageFile(data);
  }
}

/** Invalidate the in-memory cache (used in tests / after external writes). */
export function resetSafeStorageCache(): void {
  safeStorageCache = null;
}

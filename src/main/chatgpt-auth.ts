/**
 * ChatGPT Account OAuth Authentication
 *
 * Implements the OAuth PKCE login flow against auth.openai.com
 * using the Codex CLI client credentials. Manages token storage,
 * refresh, and JWT decoding — no npm dependencies.
 */

import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import * as querystring from 'querystring';
import { shell } from 'electron';
import { loadSettings, saveSettings } from './settings-store';

// ─── Constants ────────────────────────────────────────────────────

const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_ISSUER = 'https://auth.openai.com';
const OAUTH_TOKEN_URL = `${OAUTH_ISSUER}/oauth/token`;
const OAUTH_AUTHORIZE_URL = `${OAUTH_ISSUER}/oauth/authorize`;
const OAUTH_REDIRECT_PORT = 1455;
const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_REDIRECT_PORT}/auth/callback`;
const OAUTH_SCOPE = 'openid profile email offline_access';

const LOGIN_TIMEOUT_MS = 120_000; // 2 minutes

// ─── Token interface ──────────────────────────────────────────────

export interface ChatGPTAccountTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  lastRefresh: string; // ISO timestamp
}

// ─── PKCE helpers ─────────────────────────────────────────────────

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(64).toString('hex');
  const digest = crypto.createHash('sha256').update(codeVerifier).digest();
  const codeChallenge = digest
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return { codeVerifier, codeChallenge };
}

// ─── JWT decode (no verification) ─────────────────────────────────

function parseJWTClaims(token: string): Record<string, any> | null {
  if (!token || token.split('.').length !== 3) return null;
  try {
    const payload = token.split('.')[1];
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const data = Buffer.from(padded, 'base64url').toString('utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function extractAccountId(idToken: string): string {
  const claims = parseJWTClaims(idToken);
  if (!claims) return '';
  const authClaims = claims['https://api.openai.com/auth'];
  if (typeof authClaims === 'object' && authClaims) {
    const accountId = authClaims.chatgpt_account_id;
    if (typeof accountId === 'string' && accountId) return accountId;
  }
  return '';
}

// ─── HTTPS POST helper ───────────────────────────────────────────

function httpsPost(
  url: string,
  body: string,
  contentType: string
): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => {
          responseBody += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${responseBody.slice(0, 500)}`));
            return;
          }
          try {
            resolve(JSON.parse(responseBody));
          } catch {
            reject(new Error('Failed to parse token response'));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Token exchange ───────────────────────────────────────────────

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string
): Promise<ChatGPTAccountTokens> {
  const body = querystring.stringify({
    grant_type: 'authorization_code',
    code,
    redirect_uri: OAUTH_REDIRECT_URI,
    client_id: OAUTH_CLIENT_ID,
    code_verifier: codeVerifier,
  });

  const payload = await httpsPost(OAUTH_TOKEN_URL, body, 'application/x-www-form-urlencoded');

  const idToken = payload.id_token || '';
  const accessToken = payload.access_token || '';
  const refreshToken = payload.refresh_token || '';
  const accountId = extractAccountId(idToken);

  if (!accessToken) throw new Error('No access token received from OpenAI');

  return {
    accessToken,
    refreshToken,
    idToken,
    accountId,
    lastRefresh: new Date().toISOString(),
  };
}

// ─── Token refresh ────────────────────────────────────────────────

async function refreshAccessToken(refreshToken: string): Promise<ChatGPTAccountTokens> {
  const body = querystring.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
    scope: OAUTH_SCOPE,
  });

  const payload = await httpsPost(OAUTH_TOKEN_URL, body, 'application/x-www-form-urlencoded');

  const idToken = payload.id_token || '';
  const accessToken = payload.access_token || '';
  const newRefreshToken = payload.refresh_token || refreshToken;
  const accountId = extractAccountId(idToken);

  if (!accessToken) throw new Error('Token refresh failed: no access token');

  return {
    accessToken,
    refreshToken: newRefreshToken,
    idToken,
    accountId,
    lastRefresh: new Date().toISOString(),
  };
}

function shouldRefreshToken(tokens: ChatGPTAccountTokens): boolean {
  // Check JWT expiry — refresh if within 5 minutes
  const claims = parseJWTClaims(tokens.accessToken);
  if (claims?.exp) {
    const expiryMs = claims.exp * 1000;
    const fiveMinutes = 5 * 60 * 1000;
    if (Date.now() >= expiryMs - fiveMinutes) return true;
  }

  // Also refresh if last refresh was >55 minutes ago
  if (tokens.lastRefresh) {
    const lastRefreshMs = new Date(tokens.lastRefresh).getTime();
    const fiftyFiveMinutes = 55 * 60 * 1000;
    if (Date.now() - lastRefreshMs > fiftyFiveMinutes) return true;
  }

  return false;
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Load ChatGPT tokens from settings, auto-refreshing if needed.
 * Returns null if not logged in or refresh fails.
 */
export async function loadChatGPTTokens(): Promise<ChatGPTAccountTokens | null> {
  const settings = loadSettings();
  const tokens = settings.ai?.chatgptAccountTokens;
  if (!tokens?.accessToken || !tokens?.refreshToken) return null;

  if (shouldRefreshToken(tokens)) {
    try {
      const refreshed = await refreshAccessToken(tokens.refreshToken);
      // Preserve existing accountId if the new one is empty
      if (!refreshed.accountId && tokens.accountId) {
        refreshed.accountId = tokens.accountId;
      }
      saveSettings({ ai: { ...settings.ai, chatgptAccountTokens: refreshed } });
      return refreshed;
    } catch (e) {
      console.error('[ChatGPT Auth] Token refresh failed:', e);
      return null;
    }
  }

  return tokens;
}

/**
 * Check if the user is logged in with a ChatGPT account.
 */
export function isChatGPTLoggedIn(): boolean {
  const settings = loadSettings();
  const tokens = settings.ai?.chatgptAccountTokens;
  return !!(tokens?.accessToken && tokens?.refreshToken);
}

/**
 * Get login status details.
 */
export function getChatGPTLoginStatus(): { loggedIn: boolean; accountId?: string } {
  const settings = loadSettings();
  const tokens = settings.ai?.chatgptAccountTokens;
  if (!tokens?.accessToken) return { loggedIn: false };
  return { loggedIn: true, accountId: tokens.accountId || undefined };
}

/**
 * Clear ChatGPT tokens (logout).
 */
export function chatgptLogout(): void {
  const settings = loadSettings();
  const { chatgptAccountTokens, ...restAI } = settings.ai as any;
  saveSettings({ ai: { ...restAI, chatgptAccountTokens: undefined } });
}

// Module-level reference to cancel an active login
let activeLoginCleanup: (() => void) | null = null;

/**
 * Cancel any in-progress OAuth login, freeing port 1455.
 */
export function cancelOAuthLogin(): void {
  if (activeLoginCleanup) {
    activeLoginCleanup();
    activeLoginCleanup = null;
  }
}

/**
 * Start the OAuth login flow:
 * 1. Generate PKCE + state
 * 2. Start local callback server on port 1455
 * 3. Open browser to authorize URL
 * 4. Wait for callback with auth code
 * 5. Exchange code for tokens
 * 6. Save tokens to settings
 */
export async function startOAuthLogin(
  onProgress?: (status: string) => void
): Promise<ChatGPTAccountTokens> {
  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = crypto.randomBytes(32).toString('hex');

  // Cancel any previous login attempt
  cancelOAuthLogin();

  return new Promise<ChatGPTAccountTokens>((resolve, reject) => {
    let settled = false;
    let server: http.Server | null = null;

    const cleanup = () => {
      activeLoginCleanup = null;
      if (server) {
        try { server.close(); } catch {}
        server = null;
      }
    };

    // Register module-level cancel so external code can abort
    activeLoginCleanup = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        cleanup();
        reject(new Error('Login cancelled.'));
      }
    };

    // Timeout
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error('Login timed out. Please try again.'));
      }
    }, LOGIN_TIMEOUT_MS);

    server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${OAUTH_REDIRECT_PORT}`);

      if (url.pathname === '/auth/callback') {
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Error</h1><p>Missing authorization code.</p></body></html>');
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            cleanup();
            reject(new Error('No authorization code received'));
          }
          return;
        }

        if (returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Error</h1><p>State mismatch.</p></body></html>');
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            cleanup();
            reject(new Error('OAuth state mismatch'));
          }
          return;
        }

        onProgress?.('Exchanging tokens...');

        try {
          const tokens = await exchangeCodeForTokens(code, codeVerifier);

          // Save tokens
          const settings = loadSettings();
          saveSettings({ ai: { ...settings.ai, chatgptAccountTokens: tokens } });

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!DOCTYPE html>
<html><head><title>Login Successful</title></head>
<body style="max-width:640px;margin:80px auto;font-family:system-ui,-apple-system,sans-serif;">
<h1>Login successful!</h1>
<p>You can close this tab and return to SuperCmd.</p>
</body></html>`);

          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            setTimeout(cleanup, 2000);
            resolve(tokens);
          }
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`<html><body><h1>Error</h1><p>${e.message}</p></body></html>`);
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            cleanup();
            reject(e);
          }
        }
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.on('error', (err: any) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        cleanup();
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${OAUTH_REDIRECT_PORT} is already in use. Close the application using it and try again.`));
        } else {
          reject(err);
        }
      }
    });

    server.listen(OAUTH_REDIRECT_PORT, '127.0.0.1', () => {
      onProgress?.('Opening browser...');

      const authorizeParams = querystring.stringify({
        response_type: 'code',
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: OAUTH_REDIRECT_URI,
        scope: OAUTH_SCOPE,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        state,
      });

      const authorizeUrl = `${OAUTH_AUTHORIZE_URL}?${authorizeParams}`;
      shell.openExternal(authorizeUrl);

      onProgress?.('Waiting for authorization...');
    });
  });
}

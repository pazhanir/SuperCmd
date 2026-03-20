# ChatGPT Account Login — Feature Execution Plan

## Overview

Allow SuperCmd users to sign in with their ChatGPT account (Plus/Pro/Team) and use it as an AI provider — no API key required. This mirrors what ChatMock does: authenticate via OpenAI's OAuth, then route requests through ChatGPT's internal Responses API (`chatgpt.com/backend-api/codex/responses`).

**User value**: Anyone with a ChatGPT subscription can use AI features in SuperCmd without obtaining or paying for a separate API key.

---

## How ChatMock Works (Reference)

ChatMock is a Python proxy that:

1. **OAuth Login**: Uses the Codex CLI OAuth client (`app_EMoamEEZ73f0CkXaXp7hrann`) with PKCE against `auth.openai.com`. A local HTTP server on port 1455 handles the callback.
2. **Token Management**: Stores `access_token`, `refresh_token`, `id_token`, and `account_id` in `~/.chatgpt-local/auth.json`. Auto-refreshes when token expires or every 55 minutes.
3. **Upstream Bridge**: Converts OpenAI chat-completion messages to the Responses API format and POSTs to `https://chatgpt.com/backend-api/codex/responses` with SSE streaming.
4. **Message Translation**: Converts `{role, content}` messages to `{type: "message", role, content: [{type: "input_text", text}]}` and back.
5. **Session/Prompt Caching**: Generates deterministic session IDs (SHA256 of instructions + first message) sent as `prompt_cache_key`.
6. **Model Registry**: Maps model names like `gpt-5`, `gpt-5.4`, `codex-mini` to upstream IDs with reasoning effort variants.

Key files to reference:
- `ChatMock/chatmock/oauth.py` — OAuth flow, PKCE, token exchange
- `ChatMock/chatmock/upstream.py` — Responses API bridge
- `ChatMock/chatmock/utils.py` — Token loading, refresh, message conversion
- `ChatMock/chatmock/transform.py` — Message format translation
- `ChatMock/chatmock/session.py` — Prompt cache key generation
- `ChatMock/chatmock/model_registry.py` — Model name mapping
- `ChatMock/chatmock/config.py` — OAuth constants (client ID, issuer, redirect URI)
- `ChatMock/chatmock/reasoning.py` — Reasoning effort/summary parameter handling
- `ChatMock/chatmock/limits.py` — Rate limit tracking from response headers

---

## Architecture Decision

**Direct Electron integration** (not running ChatMock as a subprocess):

- Port the OAuth flow and Responses API bridge into TypeScript in the Electron main process
- No Python dependency, no subprocess management, no extra port
- Consistent with how other providers (OpenAI, Anthropic, Gemini) are implemented
- Tokens stored in SuperCmd's existing settings store

---

## Implementation Plan

### Phase 1: OAuth Authentication (Main Process)

#### 1.1 Create `src/main/chatgpt-auth.ts`

This module handles the full ChatGPT OAuth lifecycle.

**Constants** (from `ChatMock/chatmock/config.py`):
```typescript
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OAUTH_ISSUER = 'https://auth.openai.com'
const OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/authorize'
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const OAUTH_REDIRECT_PORT = 1455
const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_REDIRECT_PORT}/auth/callback`
const OAUTH_SCOPE = 'openid profile email offline_access'
const OAUTH_AUDIENCE = 'https://api.openai.com/v1'
```

**Functions to implement**:

| Function | Purpose | Reference |
|----------|---------|-----------|
| `generatePKCE()` | Generate code_verifier (random 43 chars) + code_challenge (SHA256 + base64url) | `oauth.py:PkceCodes`, `_gen_pkce()` |
| `startOAuthLogin()` | 1. Generate PKCE + state<br>2. Start local HTTP server on port 1455<br>3. Open browser to authorize URL<br>4. Wait for callback with auth code<br>5. Exchange code for tokens<br>6. Extract account_id from id_token JWT<br>7. Save tokens<br>8. Return success/failure | `oauth.py:login()`, `OAuthHandler` |
| `exchangeCodeForTokens(code, codeVerifier)` | POST to token URL with `grant_type=authorization_code` | `oauth.py:_exchange()` |
| `refreshAccessToken(refreshToken)` | POST to token URL with `grant_type=refresh_token` | `utils.py:load_chatgpt_tokens()` |
| `loadChatGPTTokens()` | Load from settings, auto-refresh if expired or stale (>55min) | `utils.py:load_chatgpt_tokens()` |
| `extractAccountId(idToken)` | Decode JWT payload, extract `https://api.openai.com/auth.chatgpt_account_id` | `utils.py:_account_id_from_id_token()` |
| `isLoggedIn()` | Check if valid tokens exist in settings | — |
| `logout()` | Clear tokens from settings | — |

**Local HTTP server for callback**:
- Use Node.js `http.createServer()` (no npm deps needed)
- Listen on `127.0.0.1:1455`
- Single route: `GET /auth/callback?code=...&state=...`
- Serve an HTML response ("Login successful, you can close this tab")
- Shut down server after receiving callback
- Timeout after 120 seconds if no callback

**Token storage** — store in settings under `ai.chatgptAccount`:
```typescript
interface ChatGPTAccountTokens {
  accessToken: string
  refreshToken: string
  idToken: string
  accountId: string
  lastRefresh: string // ISO timestamp
}
```

**JWT decoding** (no library needed):
- Split token by `.`, base64url-decode the payload segment, JSON.parse
- Only need to read claims, not verify signature (token comes from OpenAI directly)

---

#### 1.2 Create `src/main/chatgpt-upstream.ts`

This module bridges to ChatGPT's Responses API.

**Functions to implement**:

| Function | Purpose | Reference |
|----------|---------|-----------|
| `streamChatGPTResponse(messages, options, abortSignal)` | async generator that yields text chunks | `upstream.py:stream_responses()` |
| `convertMessagesToResponsesInput(messages)` | Convert OpenAI `{role, content}` to Responses `{type: "message", role, content: [{type: "input_text", text}]}` | `utils.py:convert_chat_messages_to_responses_input()` |
| `buildResponsesPayload(input, model, systemPrompt, options)` | Build the full POST body for Responses API | `upstream.py:stream_responses()` |
| `parseSSEStream(response, abortSignal)` | Parse SSE lines from HTTP response, yield parsed events | `upstream.py` SSE parsing |
| `generateSessionId(systemPrompt, firstMessage)` | SHA256 hash for prompt caching | `session.py:session_id_for()` |

**Responses API endpoint**: `https://chatgpt.com/backend-api/codex/responses`

**Request headers**:
```typescript
{
  'Authorization': `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
  'Accept': 'text/event-stream',
  'chatgpt-account-id': accountId,
  'OpenAI-Beta': 'responses=experimental',
  'session_id': sessionId,
}
```

**Request payload structure**:
```typescript
{
  model: string,           // e.g. 'gpt-5', 'gpt-5.4'
  instructions: string,    // system prompt
  input: ResponsesInput[], // converted messages
  store: false,
  stream: true,
  prompt_cache_key: string, // session ID for caching
  reasoning: {              // for reasoning models
    effort: string,         // 'medium' | 'high' | 'low' etc.
    summary: 'auto'
  }
}
```

**SSE event types to handle**:
| Event type | Action |
|------------|--------|
| `response.output_text.delta` | Yield `delta` field as text chunk |
| `response.reasoning_summary_text.delta` | Optionally yield as thinking chunk |
| `response.completed` | End stream |
| `response.failed` | Throw error with message |

**Model mapping** (from `ChatMock/chatmock/model_registry.py`):
```typescript
const CHATGPT_MODELS: Record<string, { upstreamId: string; reasoning?: string }> = {
  'gpt-5.4':      { upstreamId: 'gpt-5.4', reasoning: 'none' },
  'gpt-5.2':      { upstreamId: 'gpt-5.2' },
  'gpt-5.1':      { upstreamId: 'gpt-5.1' },
  'gpt-5':        { upstreamId: 'gpt-5' },
  'gpt-5-codex':  { upstreamId: 'gpt-5-codex' },
  'codex-mini':   { upstreamId: 'codex-mini' },
  // ...
}
```

---

### Phase 2: Provider Integration (Main Process)

#### 2.1 Update `src/main/settings-store.ts`

Add `'chatgpt-account'` to the provider union type and add token fields:

```typescript
// In AISettings interface:
provider: 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'openai-compatible' | 'chatgpt-account'

// New fields:
chatgptAccountTokens?: ChatGPTAccountTokens  // from chatgpt-auth.ts
chatgptAccountModel: string                   // default: 'gpt-5'
```

Update `DEFAULT_SETTINGS.ai` with defaults for the new fields.

#### 2.2 Update `src/main/ai-provider.ts`

**Add to `MODEL_TABLE`**:
```typescript
// ChatGPT Account models
'chatgpt-gpt-5.4':     { provider: 'chatgpt-account', modelId: 'gpt-5.4' },
'chatgpt-gpt-5.2':     { provider: 'chatgpt-account', modelId: 'gpt-5.2' },
'chatgpt-gpt-5.1':     { provider: 'chatgpt-account', modelId: 'gpt-5.1' },
'chatgpt-gpt-5':       { provider: 'chatgpt-account', modelId: 'gpt-5' },
'chatgpt-codex-mini':  { provider: 'chatgpt-account', modelId: 'codex-mini' },
```

**Add to `resolveModel()`**: Handle `'chatgpt-account'` provider prefix.

**Add to `hasProviderCredentials()`**: Check `settings.ai.chatgptAccountTokens?.accessToken` exists.

**Add `streamChatGPTAccount()` generator** (or call into `chatgpt-upstream.ts`):
1. Call `loadChatGPTTokens()` to get fresh tokens (auto-refresh)
2. Convert messages to Responses API format
3. Stream via `streamChatGPTResponse()`
4. Yield text chunks

**Add to `streamAI()` switch**: Route `'chatgpt-account'` to new generator.

---

### Phase 3: IPC Handlers (Main Process)

#### 3.1 Update `src/main/main.ts`

Add new IPC handlers:

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `chatgpt-login` | renderer → main | Trigger OAuth login flow |
| `chatgpt-logout` | renderer → main | Clear tokens |
| `chatgpt-login-status` | renderer → main | Check if logged in (returns `{ loggedIn, email?, accountId? }`) |
| `chatgpt-login-progress` | main → renderer | Push login progress events ("Opening browser...", "Waiting for callback...", "Exchanging tokens...") |

```typescript
ipcMain.handle('chatgpt-login', async (event) => {
  try {
    // Send progress updates via event.sender.send('chatgpt-login-progress', ...)
    const tokens = await startOAuthLogin((status) => {
      event.sender.send('chatgpt-login-progress', status)
    })
    // Save tokens to settings
    await saveSettings({ ai: { chatgptAccountTokens: tokens } })
    return { success: true, accountId: tokens.accountId }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('chatgpt-logout', async () => {
  await saveSettings({ ai: { chatgptAccountTokens: undefined } })
  return { success: true }
})

ipcMain.handle('chatgpt-login-status', async () => {
  const settings = loadSettings()
  const tokens = settings.ai?.chatgptAccountTokens
  if (!tokens?.accessToken) return { loggedIn: false }
  return { loggedIn: true, accountId: tokens.accountId }
})
```

#### 3.2 Update `src/main/preload.ts`

Expose new IPC methods on `window.electron`:

```typescript
chatgptLogin: () => ipcRenderer.invoke('chatgpt-login'),
chatgptLogout: () => ipcRenderer.invoke('chatgpt-logout'),
chatgptLoginStatus: () => ipcRenderer.invoke('chatgpt-login-status'),
onChatGPTLoginProgress: (callback) => {
  ipcRenderer.on('chatgpt-login-progress', (_, status) => callback(status))
},
```

#### 3.3 Update `src/renderer/types/electron.d.ts`

Add type declarations for the new bridge methods.

---

### Phase 4: Settings UI (Renderer)

#### 4.1 Update `src/renderer/src/settings/AITab.tsx`

**Add "ChatGPT Account" to the provider dropdown** in the LLM tab.

**When `chatgpt-account` is selected, show a login card instead of API key fields**:

```
┌──────────────────────────────────────────┐
│  ChatGPT Account                         │
│                                          │
│  Sign in with your ChatGPT account to    │
│  use GPT-5 models without an API key.    │
│                                          │
│  Requires ChatGPT Plus, Pro, or Team.    │
│                                          │
│  [  Sign in with ChatGPT  ]             │
│                                          │
│  Status: Not connected                   │
└──────────────────────────────────────────┘
```

**After login**:
```
┌──────────────────────────────────────────┐
│  ChatGPT Account                         │
│                                          │
│  ✓ Connected                             │
│  Account: user-abc123...                 │
│                                          │
│  Model: [  GPT-5  ▾  ]                  │
│                                          │
│  [  Sign Out  ]                          │
└──────────────────────────────────────────┘
```

**Model dropdown options**:
- GPT-5.4
- GPT-5.2
- GPT-5.1
- GPT-5
- GPT-5 Codex
- Codex Mini

**Login flow UX**:
1. User clicks "Sign in with ChatGPT"
2. Button shows spinner + "Opening browser..."
3. System browser opens to OpenAI login page
4. User authenticates in browser
5. Button updates to "Waiting for authorization..."
6. On callback: "Connected!" with green checkmark
7. On error: Show error message with retry option

---

### Phase 5: Raycast API Compatibility (Renderer)

#### 5.1 Update `src/renderer/src/raycast-api/index.tsx`

Add ChatGPT account models to `AI.Model` enum (if extensions should be able to target them):
```typescript
'OpenAI_GPT5': 'chatgpt-gpt-5',
'OpenAI_GPT5_4': 'chatgpt-gpt-5.4',
```

No other changes needed — extensions call `AI.ask()` which routes through the same `ai-ask` IPC channel. The provider selection happens in the main process based on settings.

---

## File Change Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/main/chatgpt-auth.ts` | **New** | OAuth flow, PKCE, token management, JWT decode |
| `src/main/chatgpt-upstream.ts` | **New** | Responses API bridge, message translation, SSE parsing, session IDs |
| `src/main/ai-provider.ts` | Edit | Add `chatgpt-account` provider, model table entries, streaming generator |
| `src/main/settings-store.ts` | Edit | Add `chatgpt-account` to provider type, add `chatgptAccountTokens` and `chatgptAccountModel` fields |
| `src/main/main.ts` | Edit | Add `chatgpt-login`, `chatgpt-logout`, `chatgpt-login-status` IPC handlers |
| `src/main/preload.ts` | Edit | Expose new IPC methods on bridge |
| `src/renderer/types/electron.d.ts` | Edit | Type declarations for new bridge methods |
| `src/renderer/src/settings/AITab.tsx` | Edit | Add ChatGPT Account provider option with login/logout UI |
| `src/renderer/src/raycast-api/index.tsx` | Edit | (Optional) Add GPT-5 model entries to `AI.Model` |

---

## Implementation Order

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5
  Auth        Provider     IPC        Settings    API Shim
  Module      Integration  Bridge     UI          (optional)
```

**Recommended order within phases**:

1. `chatgpt-auth.ts` — get OAuth working standalone (test with a manual IPC call)
2. `chatgpt-upstream.ts` — get streaming working against Responses API
3. `ai-provider.ts` + `settings-store.ts` — wire into existing provider system
4. `main.ts` + `preload.ts` + `electron.d.ts` — expose to renderer
5. `AITab.tsx` — build the login UI
6. Test end-to-end: settings → login → select model → AI chat

---

## Edge Cases & Considerations

### Token Refresh
- Access tokens expire frequently. `loadChatGPTTokens()` must check expiry before every request and refresh proactively (within 5 minutes of expiry, or if last refresh was >55 minutes ago).
- If refresh fails (e.g., user revoked access), surface a clear error: "ChatGPT session expired. Please sign in again."

### Port Conflicts
- The OAuth callback server uses port 1455. If the port is occupied, try a small range (1455–1460) and adjust the redirect URI accordingly. Or fail with a clear message.

### Rate Limits
- ChatGPT has usage caps (especially for Plus users). Parse `x-codex-primary-used-percent` and related headers from responses. Optionally show usage in settings UI or as a toast when approaching limits.

### Multiple Accounts
- For v1, support a single ChatGPT account. The UI shows one login state.

### Concurrent Requests
- The Responses API supports concurrent requests. Our existing `activeAIRequests` map with per-request AbortControllers handles this.

### Error Messages from Responses API
- `response.failed` events contain error details. Parse and surface these as `ai-stream-error` to the renderer.

### No Tool/Function Calling (v1)
- ChatMock supports tool calling translation, but for v1 we only need text completion. Tool support can be added later.

### Security
- Tokens stored in SuperCmd's settings file (same as API keys today). File permissions should already be user-only on macOS.
- PKCE prevents authorization code interception.
- Callback server binds to `127.0.0.1` only (not `0.0.0.0`).

---

## Testing Checklist

- [ ] OAuth login opens browser, receives callback, stores tokens
- [ ] Token refresh works when access token is near expiry
- [ ] Logout clears tokens and UI updates
- [ ] Streaming works with GPT-5 model via Responses API
- [ ] Long conversations (multiple messages) are correctly translated
- [ ] Session ID / prompt caching generates consistent IDs
- [ ] Error from Responses API surfaces in chat UI
- [ ] Settings UI shows correct state (logged in / logged out)
- [ ] Model dropdown works and persists selection
- [ ] Switching away from `chatgpt-account` provider and back preserves login
- [ ] Port conflict handled gracefully
- [ ] Works with ChatGPT Plus, Pro, and Team accounts
- [ ] Existing providers (OpenAI API, Anthropic, Ollama, etc.) unaffected

# API Reference

All endpoints are served by the Express app in `src/index.ts`. JSON bodies are parsed with `express.json()` and cookies with `cookie-parser`.

- **Base URL (default):** `http://localhost:5000`
- **Auth:** httpOnly session cookie (`df_session`) issued by `/auth/github/callback`. Endpoints wrapped in `requireAuth` return an error when the session is missing or expired.
- **CORS:** `origin: true` with `credentials: true`, so browser clients must send credentials.

## Health

### `GET /health`

No auth required.

```json
{ "status": "ok", "service": "docforge-backend" }
```

## Auth

### `GET /auth/github`

Starts the OAuth flow.

- Returns `503 { "error": "GitHub OAuth not configured on the server" }` if `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` are unset.
- Otherwise sets the `df_oauth_state` cookie (httpOnly, `sameSite: lax`, 10 minute TTL) and redirects to GitHub with scope `repo read:user`.

### `GET /auth/github/callback?code=...&state=...`

- Clears the state cookie.
- Rejects on missing/mismatched `state` → redirects to `${FRONTEND_URL}/?error=invalid_oauth_state`.
- Exchanges the code, reads the GitHub profile, and upserts a `User` (token stored encrypted).
- Creates a `Session` row (token hash + expiry) and sets the `df_session` cookie (30 day TTL).
- Success → redirect `${FRONTEND_URL}/chat`; failure → redirect `${FRONTEND_URL}/?error=oauth_failed`.

### `GET /auth/me` *(auth)*

```json
{ "id": "cuid", "login": "octocat", "name": "The Octocat", "email": null, "avatarUrl": "https://..." }
```

### `POST /auth/logout` *(auth)*

Deletes the current session row and clears the cookie.

```json
{ "ok": true }
```

## Repos

### `GET /repos` *(auth)*

Paginates `repos.listForAuthenticatedUser` (100 per page, sorted by `updated`, visibility `all`) using the signed-in user's token. Returns an array of summaries:

```json
[
  {
    "id": 123456,
    "name": "widgets",
    "fullName": "acme/widgets",
    "owner": "acme",
    "private": false,
    "defaultBranch": "main",
    "description": "Widget toolkit",
    "language": "TypeScript",
    "updatedAt": "2024-05-01T12:00:00Z"
  }
]
```

## Models

### `/models`

Exposes the provider registry. Only providers with a configured API key are returned; each model carries its current health status.

Provider ids: `google_genai`, `openrouter`, `anthropic`, `openai`, `groq`.

| Provider | Model ids |
| --- | --- |
| `google_genai` | `gemini-2.5-flash`, `gemini-2.0-flash`, `gemini-2.5-pro` |
| `openrouter` | `auto`, `deepseek/deepseek-chat-v3-0324`, `deepseek/deepseek-r1`, `qwen/qwen-2.5-coder-32b-instruct`, `meta-llama/llama-3.3-70b-instruct` |
| `anthropic` | `claude-sonnet-4`, `claude-haiku-4`, `claude-opus-4` |
| `openai` | `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini`, `o3-mini` |
| `groq` | `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `qwen-2.5-coder-32b` |

## Conversations

### `POST /conversations` *(auth)*

Creates a conversation bound to a repo, branch, provider, and model.

```json
{
  "repoOwner": "acme",
  "repoName": "widgets",
  "branch": "main",
  "provider": "openrouter",
  "model": "deepseek/deepseek-chat-v3-0324"
}
```

Validation:

- `branch` defaults to `main`; all string fields are required and non-empty.
- `400` with `{ "error": "Invalid payload", "issues": [...] }` on schema failure.
- `400` if the provider is unknown/unconfigured, or the model isn't registered for that provider.

Response: `201` with `{ "conversation": { ... } }`.

### `GET /conversations` *(auth)*

Lists the caller's conversations, newest `updatedAt` first, each including `_count: { messages, drafts }`.

```json
{
  "conversations": [
    {
      "id": "cuid",
      "repoOwner": "acme",
      "repoName": "widgets",
      "branch": "main",
      "provider": "openrouter",
      "model": "deepseek/deepseek-chat-v3-0324",
      "status": "active",
      "prUrl": null,
      "prNumber": null,
      "_count": { "messages": 4, "drafts": 2 }
    }
  ]
}
```

### Conversation-scoped endpoints

The router in `src/routes/conversations.ts` also serves conversation detail, message streaming, and draft review. Runs are driven through `runAgent()` in `src/agent/graph.ts`, which streams LangGraph output and forwards it as Server-Sent Events.

SSE event shapes (`event: <name>` + `data: <json>`):

| Event | Payload | Meaning |
| --- | --- | --- |
| `token` | `{ "type": "token", "content": "..." }` | Streamed model output chunk |
| `node` | `{ "type": "node", "node": "..." }` | A graph node produced an update |
| `interrupt` | `{ "type": "interrupt", "data": { "drafts": [...] } }` | Paused for human review; resume with a `Command` payload |
| `end` | `{ "type": "end" }` | Run finished |

Resuming a paused run reuses the same `thread_id` (the conversation id) and can set the action to `review`, `push`, or `answer`.

## Pull Requests

### `/prs` *(auth)*

Lists pull requests the agent has opened for the caller, backed by the `PullRequest` model (`number`, `url`, `branch`, `title`, `state`, optional `conversationId`).

## Errors

- Auth failures from `requireAuth` return a non-2xx JSON body.
- Model quota/rate failures surface as `ModelQuotaError` from `src/agent/retry.ts` and mark the model unhealthy in `src/models/health.ts`.
- Unhandled route failures are passed to the Express error handler via `next(err)`.

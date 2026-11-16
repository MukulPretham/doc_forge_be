# Setup Guide

Step-by-step environment setup for docforge-backend.

## 1. Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js 20+ | The project is ESM (`"type": "module"`) and runs TypeScript via `tsx` |
| Postgres | Used by Prisma for app data **and** by the LangGraph checkpointer; a Neon connection string is expected |
| GitHub OAuth app | Needed for sign-in and repository access |
| Model provider key | At least one of OpenRouter, Anthropic, OpenAI, Groq, Google Gemini |

## 2. Install dependencies

```bash
npm install
```

## 3. Create a GitHub OAuth app

In GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**:

- **Homepage URL:** your frontend origin, e.g. `http://localhost:3000`
- **Authorization callback URL:** must match `GITHUB_REDIRECT_URI` exactly, e.g. `http://localhost:5000/auth/github/callback`

Copy the client id and generate a client secret.

Requested scopes are hard-coded in `src/github/oauth.ts`:

- `repo` — read repository contents and push branches/commits for docs PRs
- `read:user` — read the authenticated profile (login, name, email, avatar)

## 4. Prepare the database

Use any Postgres instance reachable from the backend. Take the connection string (include `sslmode=require` for hosted providers).

Then:

```bash
npm run prisma:generate
npm run prisma:migrate
```

`prisma:schema` is configured in `package.json` (`prisma/schema.prisma`), so no extra flags are needed. The LangGraph `PostgresSaver` creates its checkpoint tables on first agent run — no manual migration required.

## 5. Write `.env`

Create `.env` in the repository root (`dotenv/config` is imported by `src/config.ts`):

```dotenv
NODE_ENV=development
PORT=5000
FRONTEND_URL=http://localhost:3000

DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
APP_SECRET=replace-with-a-32-character-secret

GITHUB_CLIENT_ID=your-client-id
GITHUB_CLIENT_SECRET=your-client-secret
GITHUB_REDIRECT_URI=http://localhost:5000/auth/github/callback

OPENROUTER_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GROQ_API_KEY=
GEMINI_API_KEY=
```

Validation rules enforced at boot (`src/config.ts`):

- `DATABASE_URL` — required, non-empty.
- `APP_SECRET` — required, **minimum 32 characters**.
- `FRONTEND_URL`, `GITHUB_REDIRECT_URI` — must parse as URLs.
- `PORT` — coerced to a number, defaults to `5000`.
- `NODE_ENV` — `development` | `production` | `test`, defaults to `development`.
- GitHub credentials are optional: if either is missing, the server logs a warning and `/auth/github` responds `503`.

Any validation failure prints each issue and exits with code `1`.

## 6. Start the server

```bash
npm run dev
```

Expected output includes:

```
✅ docforge-backend listening on http://localhost:5000
```

Verify:

```bash
curl http://localhost:5000/health
```

## 7. Smoke-test the flow

1. `GET /auth/github` → GitHub consent → redirected to `FRONTEND_URL/chat`.
2. `GET /auth/me` with the session cookie → your profile.
3. `GET /models` → only providers with API keys listed.
4. `GET /repos` → your repositories.
5. `POST /conversations` with `repoOwner`, `repoName`, `branch`, `provider`, `model` → `201`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `❌ Invalid environment configuration` on boot | Read the printed issues; `APP_SECRET` under 32 chars and a missing `DATABASE_URL` are the common ones |
| `Port 5000 is already in use...` | Another instance is running. Find it with `lsof -i :5000` and stop it, or change `PORT` |
| `/auth/github` returns `503` | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` not set |
| Redirect back to `/?error=invalid_oauth_state` | The callback URL mismatch or the state cookie expired (10 minute TTL) / cookies blocked |
| Redirect back to `/?error=oauth_failed` | Code exchange failed — check client secret and that the callback URL matches exactly |
| `/repos` or agent runs fail with 401 from GitHub | The stored token was revoked; log out and sign in again to refresh it |
| Provider missing from `/models` | Its API key env var is empty; the registry hides unconfigured providers |
| `Provider "x" is not configured` on `POST /conversations` | Same cause — set the key and restart |
| Prisma client errors after pulling schema changes | Re-run `npm run prisma:generate` and `npm run prisma:migrate` |

## Production notes

- Serve over HTTPS; the session cookie is `httpOnly` and `sameSite: lax`.
- Set `FRONTEND_URL` to the deployed frontend origin and register the matching callback URL on the GitHub OAuth app.
- Run `npm start` (or compile and run) behind a process manager; the app has no separate build script.
- SSE responses mean reverse proxies should not buffer `/conversations` streams.

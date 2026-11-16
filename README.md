# docforge-backend

Backend service for **DocForge** — an AI agent that reads a GitHub repository and drafts documentation (a `README.md`, pages under `docs/`, or answers questions about the codebase). Drafts are staged for review, and once approved the agent opens a pull request with the generated docs.

Built with Express 5, TypeScript (ESM), Prisma/Postgres, and a [LangGraph](https://github.com/langchain-ai/langgraphjs) agent that can stream to the browser over Server-Sent Events.

---

## What it does

1. You sign in with GitHub OAuth. The backend stores the account and an encrypted access token.
2. You pick a repository and branch, plus a model provider/model.
3. The agent fetches the repository tree, classifies your message as either a **docs** request or an **answer** (Q&A) request, selects relevant files, reads them, and drafts documentation.
4. Drafts are stored as `DocDraft` rows and shown to you. You can loop back with feedback for revisions.
5. When you approve, the agent commits the docs to a working branch and opens a pull request.

## Features

- **GitHub OAuth** with `repo read:user` scope, httpOnly session cookies, hashed session tokens, and encrypted GitHub access tokens at rest.
- **Repository browsing** — lists the authenticated user's repositories via Octokit.
- **Multi-provider model registry** — Google Gemini, OpenRouter, Anthropic, OpenAI, and Groq, each exposing a curated list of models. Only providers whose API key is present are advertised.
- **LangGraph agent** with an explicit state machine, interrupt-based human review, and Postgres checkpointing (threads are keyed by conversation id).
- **Streaming** — tokens, node updates, interrupts, and completion events are streamed to the client as SSE.
- **Guardrails** — capped file reads, capped number of drafts, junk/binary/lockfile filtering in the repo tree, and truncated large files.
- **Write-scoped tooling** — the agent can only stage docs at `README.md` or paths under `docs/`.
- **Structured logging** with per-request timing and status codes.

## Quick start

### Prerequisites

- Node.js 20+ (ESM project; Express 5, Prisma 6)
- A Postgres database (Neon-compatible connection string) — also used for LangGraph checkpoints
- A GitHub OAuth app (client id + secret)
- At least one model provider API key

### Install

```bash
git clone <repo-url> doc_forge_be
cd doc_forge_be
npm install
```

### Configure

Create a `.env` file in the project root. The server validates it with zod at startup and exits if anything is missing or invalid.

```dotenv
NODE_ENV=development
PORT=5000
FRONTEND_URL=http://localhost:3000

# Required
DATABASE_URL=postgresql://user:password@host/db?sslmode=require
APP_SECRET=at-least-32-characters-long-secret

# GitHub OAuth (optional — /auth/github returns 503 when unset)
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_REDIRECT_URI=http://localhost:5000/auth/github/callback

# Model providers (at least one)
OPENROUTER_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GROQ_API_KEY=
GEMINI_API_KEY=
```

| Variable | Required | Notes |
| --- | --- | --- |
| `NODE_ENV` | no | `development` \| `production` \| `test`, default `development` |
| `PORT` | no | Default `5000` |
| `FRONTEND_URL` | no | Must be a valid URL; default `http://localhost:3000`. Used for OAuth redirects |
| `DATABASE_URL` | **yes** | Postgres connection string (Prisma + checkpoint store) |
| `APP_SECRET` | **yes** | Minimum 32 characters |
| `GITHUB_CLIENT_ID` | no | Missing → `/auth/github` responds `503` with a warning logged |
| `GITHUB_CLIENT_SECRET` | no | Same as above |
| `GITHUB_REDIRECT_URI` | no | Default `http://localhost:5000/auth/github/callback` |
| `OPENROUTER_API_KEY` | no | Enables the `openrouter` provider |
| `ANTHROPIC_API_KEY` | no | Enables the `anthropic` provider |
| `OPENAI_API_KEY` | no | Enables the `openai` provider |
| `GROQ_API_KEY` | no | Enables the `groq` provider |
| `GEMINI_API_KEY` | no | Enables the `google_genai` provider |

### Database

```bash
npm run prisma:generate   # generate the Prisma client
npm run prisma:migrate    # apply migrations (prisma migrate dev)
```

The LangGraph checkpointer creates/updates its own tables on first use (`PostgresSaver.setup()`).

### Run

```bash
npm run dev     # tsx watch src/index.ts
# or
npm start       # tsx src/index.ts
```

The service logs `docforge-backend listening on http://localhost:5000`. If the port is taken, it exits with a hint to run `lsof -i :<port>`.

Health check:

```bash
curl http://localhost:5000/health
# {"status":"ok","service":"docforge-backend"}
```

## Scripts

| Script | Command | Purpose |
| --- | --- | --- |
| `npm run dev` | `tsx watch src/index.ts` | Watch-mode development server |
| `npm start` | `tsx src/index.ts` | Start without watching |
| `npm run typecheck` | `tsc --noEmit` | Type-check only |
| `npm run prisma:generate` | `prisma generate` | Regenerate the Prisma client |
| `npm run prisma:migrate` | `prisma migrate dev` | Create/apply dev migrations |
| `npm run prisma:studio` | `prisma studio` | Open Prisma Studio |

The Prisma schema lives at `prisma/schema.prisma` (configured via the `prisma` key in `package.json`).

## Usage

Typical flow against the API (cookies must be sent with credentials):

```bash
# 1. Start GitHub OAuth — redirects to GitHub, then back to FRONTEND_URL/chat
open http://localhost:5000/auth/github

# 2. Confirm the session
curl -b cookies.txt http://localhost:5000/auth/me

# 3. List repos available to the user
curl -b cookies.txt http://localhost:5000/repos

# 4. Create a conversation bound to a repo, branch, provider and model
curl -b cookies.txt -X POST http://localhost:5000/conversations \
  -H 'Content-Type: application/json' \
  -d '{"repoOwner":"acme","repoName":"widgets","branch":"main","provider":"openrouter","model":"deepseek/deepseek-chat-v3-0324"}'

# 5. Drive the agent on that conversation (streamed as SSE)
```

Requests without a valid session are rejected by the `requireAuth` middleware.

### Agent graph

```
START → fetch_tree → classify_intent ─┬─ docs   → select_files → explore → draft_docs → review
                                       └─ answer → answer ────────────────────────────────┐
                                                                                          │
review ─┬─ review (drafts present) → draft_docs                                          │
        ├─ push  → create_pr → END                                                       │
        └─ answer → answer ──────────────────────────────────────────────────────────────┘
```

- `recursionLimit` is 50; runs are abortable via an `AbortSignal`.
- The review step raises a LangGraph **interrupt** carrying the current drafts; resuming with a `Command` continues the run.
- Runs stream in `["updates", "messages"]` mode and emit `token`, `node`, `interrupt`, and `end` events.
- Limits: `MAX_READS = 15` file reads, `MAX_DRAFTS = 10` draft files, `MAX_FILE_CHARS = 25_000` characters per file.

## API surface

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Liveness probe |
| `GET` | `/auth/github` | Start GitHub OAuth (state cookie, 10 min TTL) |
| `GET` | `/auth/github/callback` | Exchange code, upsert user, create session, redirect to `FRONTEND_URL/chat` |
| `GET` | `/auth/me` | Current user profile |
| `POST` | `/auth/logout` | Delete session, clear cookie |
| `GET` | `/repos` | Repositories for the authenticated user |
| `POST` | `/conversations` | Create a conversation (validates provider + model) |
| `GET` | `/conversations` | List the user's conversations with message/draft counts |
| — | `/models` | Configured providers and their models (with health status) |
| — | `/conversations/:id/...` | Conversation detail, message streaming, drafts, review/resume |
| — | `/prs` | Pull requests opened by the agent |

See [`docs/api-reference.md`](docs/api-reference.md) for request/response details.

## Project structure

```
src/
  index.ts              Express app: middleware, request logging, router mounting, /health
  config.ts             zod-validated environment config
  logger.ts             Structured log helpers (http/info/ok/warn/error)
  agent/
    graph.ts            StateGraph wiring, routing, SSE event generator (runAgent)
    nodes.ts            fetch_tree, classify_intent, select_files, explore, draft_docs, review, answer, create_pr
    state.ts            AgentState annotation schema + shared types
    tools.ts            read_file / write_doc_draft tools, repo tree fetch, limits
    prompts.ts          Prompt builders for each node
    retry.ts            modelCall retry helper + ModelQuotaError
    checkpointer.ts     PostgresSaver singleton
  github/
    oauth.ts            Authorize URL + code exchange
    client.ts           Authenticated Octokit factory
    crypto.ts           encrypt/decrypt for stored tokens
  middleware/auth.ts    requireAuth, session tokens, cookie name, expiry
  models/
    registry.ts         Provider/model registry and chat model factory
    health.ts           Per-model health status tracking
  routes/               auth, repos, models, conversations, prs
  db/prisma.ts          Prisma client singleton
prisma/schema.prisma    User, Session, Conversation, Message, DocDraft, PullRequest
```

## Data model

- **User** — GitHub identity, encrypted `accessToken`, relations to sessions/conversations/PRs.
- **Session** — `tokenHash` (unique) + `expiresAt`; cascade-deleted with the user.
- **Conversation** — repo owner/name, base `branch`, optional `workBranch`, `provider`/`model`, `status`, and PR fields (`prUrl`, `prNumber`).
- **Message** — role, JSON `content`, provider/model; indexed by `(conversationId, createdAt)`.
- **DocDraft** — unique per `(conversationId, path)`; `status` defaults to `draft`.
- **PullRequest** — number, url, branch, title, state; optionally linked to one conversation.

## Notes and constraints

- CORS is permissive with `origin: true` and `credentials: true`; cookies therefore work from the configured frontend origin.
- Docs may only be written to `README.md` or `docs/**`; any other path is rejected by the tool.
- The repo tree walker skips dotfiles, common build/dependency directories (`node_modules`, `dist`, `.next`, `target`, …), lockfiles, and binary/media extensions.
- Repository access uses the signed-in user's own GitHub token, so the agent can only touch repos the user can already write to.

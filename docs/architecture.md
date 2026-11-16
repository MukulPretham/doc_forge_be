# Architecture

docforge-backend is a single Express service that hosts an OAuth-protected REST API and a LangGraph documentation agent. State lives in Postgres: application entities via Prisma, and agent conversation checkpoints via `@langchain/langgraph-checkpoint-postgres`.

## Process layout

`src/index.ts` builds the app in a fixed order:

1. `cors({ origin: true, credentials: true })` — cookie-based auth from the frontend.
2. `express.json()` and `cookie-parser()`.
3. Request logging middleware: records start time, logs `method`, URL, status, duration, and the logged-in user's `login` on `finish`.
4. `GET /health`.
5. Routers mounted at `/auth`, `/repos`, `/models`, `/conversations`, `/prs`.
6. `app.listen(config.PORT)` with an explicit `EADDRINUSE` handler that exits with a hint to run `lsof -i :<port>`.

Environment validation happens in `src/config.ts` before the app boots: zod parses `process.env`, prints every issue, and calls `process.exit(1)` on failure. Missing GitHub OAuth credentials are non-fatal — they only log a warning and disable `/auth/github`.

## Authentication and sessions

- **OAuth** (`src/github/oauth.ts`): authorize URL with `repo read:user` scope; code exchange against `https://github.com/login/oauth/access_token`.
- **CSRF protection**: a random 16-byte hex `state` stored in the `df_oauth_state` cookie and compared on callback.
- **Tokens at rest**: the GitHub access token is encrypted (`src/github/crypto.ts`) before being written to `User.accessToken`, and decrypted per request by `getOctokit()`.
- **Sessions**: `createSessionToken()` returns a random token; only its hash is stored (`Session.tokenHash`, unique) with an `expiresAt`. The raw token lives in the `df_session` httpOnly cookie (30 day max age). `requireAuth` resolves cookie → session → user into `req.user` / `req.session`.

Because repository access uses the user's own token, the agent is limited to repos that user can already write to.

## Model registry

`src/models/registry.ts` is a static array of provider definitions, each with:

- `id` / `label`
- `key` — read from config; falsy keys make the provider invisible to clients
- `build(model)` — constructs the LangChain chat model (all streaming-enabled; OpenRouter uses a custom `baseURL`, `maxTokens: 8192`)
- `models` — a curated, allow-listed set of model ids

`getConfiguredProviders()` is what `/models` returns; `createChatModel()` throws for unknown providers, unconfigured providers, or unregistered model ids — the same checks `POST /conversations` performs up front. `src/models/health.ts` tracks per-model health so quota failures can be surfaced in the UI.

## Agent

### State

`src/agent/state.ts` defines `AgentState` with `Annotation.Root`. Most keys are simple "last write wins" reducers; `messages` concatenates (LangGraph's message reducer). Keys cover the run's inputs (`userMessage`, `provider`, `model`, `repoOwner`, `repoName`, `branch`, `authorName`, `authorEmail`), working data (`tree`, `selectedFiles`, `explored`, `drafts`, `readCount`), control (`feedback`, `action`, `intent`), and `prResult`.

### Graph

`src/agent/graph.ts` compiles:

```
START → fetch_tree → classify_intent
classify_intent ─ docs   → select_files
                └ answer → answer
select_files → explore → draft_docs → review
review ─ review → draft_docs
       ├ push   → create_pr → END
       └ answer → answer
answer ─ drafts present → review
       └ otherwise      → END
```

`buildGraph()` attaches a `PostgresSaver` checkpointer; module-level memoization (`getAgentGraph`) keeps a single compiled graph. `thread_id` is the conversation id, which is how nodes look up the owning user and token (`getCtx` in `nodes.ts`).

### Nodes

- **`fetch_tree`** — pulls the recursive tree for the branch and stores the filtered entry list.
- **`classify_intent`** — heuristics first (regexes for "write/update docs", question words); falls back to a cheap model call, and defaults to `docs` on error.
- **`select_files`** — structured output (`z.object({ files: [...] })`) choosing files with a one-line reason each.
- **`explore`** — reads selected files through the `read_file` tool, capped by `MAX_READS`.
- **`draft_docs`** — calls the drafting model, which stages docs via the `write_doc_draft` tool; capped by `MAX_DRAFTS`.
- **`review`** — `interrupt()` with the current drafts so the user can approve, request changes, or switch to Q&A.
- **`answer`** — Q&A response; may itself produce drafts, which routes back into `review`.
- **`create_pr`** — commits drafts to a working branch and opens the pull request, recording it in `PullRequest`.

`runAgent()` wraps `graph.stream(input, { configurable: { thread_id }, recursionLimit: 50, signal })` in `["updates", "messages"]` mode and yields `token`, `node`, `interrupt`, and `end` events, so the HTTP layer can relay them as SSE. Passing a `Command` instance resumes an interrupted thread.

### Tools and limits

`src/agent/tools.ts` exports two tools plus the tree fetcher:

| Item | Value / behavior |
| --- | --- |
| `read_file` | Reads a blob at `ref = branch`; directory paths return a listing; content truncated above `MAX_FILE_CHARS` |
| `write_doc_draft` | Upserts a `DocDraft` on `(conversationId, path)`; rejects any path that isn't `README.md` or under `docs/` |
| `MAX_READS` | `15` |
| `MAX_DRAFTS` | `10` |
| `MAX_FILE_CHARS` | `25_000` |

`getRepoTree()` filters the GitHub tree before it reaches the model: skips paths starting with `.`, any path containing a junk directory (`node_modules`, `.git`, `dist`, `build`, `.next`, `out`, `coverage`, `__pycache__`, `.venv`, `.cache`, `.turbo`, `.nx`, `target`, `.idea`, `.vscode`), lockfiles, and binary/media extensions.

`src/agent/retry.ts` provides `modelCall()` (retry wrapper) and `ModelQuotaError`, which the conversations router maps to quota-exhausted handling and a health-status update.

## Persistence

Prisma models (`prisma/schema.prisma`):

- `User` → `Session[]`, `Conversation[]`, `PullRequest[]`
- `Conversation` → `Message[]`, `DocDraft[]`, optional `PullRequest`
- `DocDraft` unique on `(conversationId, path)`
- `PullRequest.conversationId` is unique and `onDelete: SetNull`

All child relations cascade from `User`/`Conversation`, so deleting a user or conversation removes its sessions, messages, and drafts.

## Design notes

- Drafts are persisted before any git write, so review and revision never touch the repository.
- Writes are whitelisted to documentation paths, so the agent cannot modify source code.
- The checkpointer shares `DATABASE_URL` with Prisma but manages its own tables (`PostgresSaver.setup()` on first use).
- Streaming is one-directional per request; resumption is a new request with a `Command` input for the same thread id.

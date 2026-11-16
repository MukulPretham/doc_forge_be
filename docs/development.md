# Development Guide

Notes for working on docforge-backend.

## Tooling

| Concern | Choice |
| --- | --- |
| Language | TypeScript, ESM (`"type": "module"`, `.js` extensions in relative imports) |
| Runtime | `tsx` (no separate build step) |
| Type checking | `npm run typecheck` → `tsc --noEmit` |
| ORM | Prisma 6 (`prisma generate`, `prisma migrate dev`, `prisma studio`) |
| Agent framework | `@langchain/langgraph` with `@langchain/langgraph-checkpoint-postgres` |
| HTTP | Express 5 |
| Validation | `zod` (env config, request bodies, structured output schemas) |

## Commands

```bash
npm run dev              # tsx watch src/index.ts
npm start                # tsx src/index.ts
npm run typecheck        # tsc --noEmit
npm run prisma:generate
npm run prisma:migrate
npm run prisma:studio
```

There is no test runner or linter configured in `package.json`; verification is via `npm run typecheck` plus manual API exercise.

## Conventions

- **ESM imports.** Always use the `.js` suffix for relative imports (`import { config } from "./config.js"`).
- **Fail fast on config.** Add new env vars to `envSchema` in `src/config.ts` with an explicit default or an error message; do not read `process.env` elsewhere.
- **Logging.** Use `log.http/info/ok/warn/error` from `src/logger.ts` rather than `console.*` (the port-in-use handler and OAuth failure path are the only exceptions).
- **Auth.** Any new route that touches user data must be wrapped in `requireAuth` and scoped by `req.user!.id`.
- **Repo access.** Never store or construct tokens directly — go through `getOctokit(req.user!.accessToken)` or `getOctokit(conversation.user.accessToken)` in agent nodes so decryption stays centralized.

## Adding a model provider

1. Add the API key to `envSchema` in `src/config.ts` (optional, like the existing keys).
2. Append a `ProviderDefinition` to the `providers` array in `src/models/registry.ts`: `id`, `label`, `key`, a `build(model)` returning a LangChain chat model with `streaming: true`, and the allow-listed `models`.
3. Restart the server; `/models` will list it automatically once the key is set.
4. No route changes are required — `POST /conversations` validates against the registry.

## Modifying the agent

### State

Add fields to `AgentState` in `src/agent/state.ts` with an appropriate reducer (`(_a, b) => b` for replace, concat for `messages`) and a default.

### Nodes

- Node functions live in `src/agent/nodes.ts` and receive `(state, config)`.
- Resolve the thread's context with `getCtx(state, config)` — it loads the conversation, its user, and a decrypted Octokit instance.
- Call models through `modelCall(...)` from `src/agent/retry.ts` so retries and `ModelQuotaError` behavior stay consistent.
- Keep the `thread_id` config requirement intact (`threadId(config)` throws if missing).

### Graph wiring

Update `buildGraph()` in `src/agent/graph.ts` — register nodes, add edges, and add conditional routers next to the existing `routeAfterFetchTree` / `routeAfterReview` / `routeAfterAnswer` helpers. Bump `recursionLimit` (currently `50`) only if a legitimate run needs deeper traversal.

Graph changes take effect on restart; the compiled graph is memoized in module scope.

### Tools and limits

New tools go in `buildTools()` (`src/agent/tools.ts`) and must be counted against the budgets:

- `MAX_READS = 15` — reads during `explore`
- `MAX_DRAFTS = 10` — staged documents
- `MAX_FILE_CHARS = 25_000` — per-file truncation

Keep the write whitelist (`README.md` or `docs/**`) enforced in the tool, not only in prompts.

### Human review

`review` calls `interrupt()` with the current drafts. Resumption passes a `Command` input to `runAgent` for the same thread id, and `state.action` (`review` | `push` | `answer`) decides the next hop. If you add an action, extend the annotation type in `state.ts` and the router in `graph.ts`.

## Database changes

1. Edit `prisma/schema.prisma`.
2. `npm run prisma:migrate` to create and apply a migration.
3. `npm run prisma:generate` (usually run by migrate).
4. Update the affected route or node code through the Prisma client from `src/db/prisma.ts`.

Delete semantics are cascade-based: `User` deletion removes sessions, conversations, and PRs; `Conversation` deletion removes messages and drafts, and nulls the linked PR's `conversationId`.

## Streaming behavior

`runAgent()` streams in `["updates", "messages"]` mode and yields typed events:

- `token` — assistant content chunks (character counts are tracked for logging)
- `node` — per-node state updates; `__interrupt__` updates are converted to `interrupt` events
- `interrupt` — carries `data.drafts`
- `end` — run completion

The conversations router serializes these as SSE via `sendEvent(res, event, data)` using `event: <name>` / `data: <json>` frames. Preserve that frame format if you add new event types.

## Message persistence

`persistUserVisibleMessages()` in `src/routes/conversations.ts` copies only **user-visible** assistant messages from the LangGraph checkpoint into `Message` rows. A message qualifies when it is an AI message with non-empty string content and `additional_kwargs.__df.userVisible === true`. Duplicates are avoided by comparing stored `content.msgId` values against checkpoint message ids. Tag messages with `__df.userVisible` if you want them shown in history.

## Manual verification checklist

- `GET /health` returns `200`.
- `GET /auth/github` redirects to GitHub; callback lands on `FRONTEND_URL/chat`.
- `GET /models` lists exactly the providers whose keys are set.
- `POST /conversations` rejects unknown providers/models with `400`.
- An agent run on a small repo produces drafts, pauses at review, and resumes on feedback.
- Approving a push creates a branch, a commit, and a pull request, and records it in `PullRequest`.

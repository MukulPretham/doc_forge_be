import type { BaseMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { Router } from "express";
import { z } from "zod";
import { getAgentGraph, runAgent } from "../agent/graph.js";
import { ModelQuotaError } from "../agent/retry.js";
import { prisma } from "../db/prisma.js";
import { getProvider } from "../models/registry.js";
import { markQuotaExhausted } from "../models/health.js";
import { log } from "../logger.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const createConversationSchema = z.object({
  repoOwner: z.string().min(1),
  repoName: z.string().min(1),
  branch: z.string().min(1).default("main"),
  provider: z.string().min(1),
  model: z.string().min(1),
});

function sendEvent(res: { write: (chunk: string) => boolean }, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

router.post("/", requireAuth, async (req, res, next) => {
  try {
    const body = createConversationSchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: "Invalid payload", issues: body.error.issues });
    }
    const { repoOwner, repoName, branch, provider, model } = body.data;

    const providerDef = getProvider(provider);
    if (!providerDef || !providerDef.key) {
      return res.status(400).json({ error: `Provider "${provider}" is not configured` });
    }
    if (!providerDef.models.some((m) => m.id === model)) {
      return res.status(400).json({ error: `Model "${model}" is not registered for provider "${provider}"` });
    }

    const conversation = await prisma.conversation.create({
      data: {
        userId: req.user!.id,
        repoOwner,
        repoName,
        branch,
        provider,
        model,
        status: "active",
      },
    });

    log.ok(`conversation created id=${conversation.id} ${repoOwner}/${repoName}@${branch} model=${provider}/${model} by=${req.user!.login}`);
    res.status(201).json({ conversation });
  } catch (err) {
    next(err);
  }
});

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const conversations = await prisma.conversation.findMany({
      where: { userId: req.user!.id },
      orderBy: { updatedAt: "desc" },
      include: {
        _count: { select: { messages: true, drafts: true } },
      },
    });
    log.info(`conversations list by=${req.user!.login} count=${conversations.length}`);
    res.json({ conversations });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/messages", requireAuth, async (req, res, next) => {
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: String(req.params.id), userId: req.user!.id },
    });
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });

    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "asc" },
    });
    log.info(`messages list conv=${conversation.id} count=${messages.length}`);
    res.json({ messages });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/drafts", requireAuth, async (req, res, next) => {
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: String(req.params.id), userId: req.user!.id },
    });
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });

    const drafts = await prisma.docDraft.findMany({
      where: { conversationId: conversation.id, status: "draft" },
      orderBy: { path: "asc" },
    });
    log.info(`drafts list conv=${conversation.id} count=${drafts.length} status=${conversation.status}`);
    res.json({ drafts, conversation });
  } catch (err) {
    next(err);
  }
});

async function loadConversationOrNull(id: string, userId: string) {
  return prisma.conversation.findFirst({ where: { id, userId } });
}

function sseHeaders(res: { setHeader: (k: string, v: string) => void; flushHeaders?: () => void }) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
}

function sendAgentError(res: { write: (chunk: string) => boolean }, conversationId: string, err: unknown) {
  const message = (err as Error).message ?? "Unknown error";
  if (err instanceof ModelQuotaError) {
    markQuotaExhausted(err.provider, err.model, message);
    log.warn(`quota marked exhausted provider=${err.provider} model=${err.model}`);
    sendEvent(res, "error", { quota: true, provider: err.provider, model: err.model, message });
  } else {
    sendEvent(res, "error", { message });
  }
  prisma.conversation
    .update({ where: { id: conversationId }, data: { status: "error" } })
    .catch(() => {});
}

function startKeepalive(res: { write: (chunk: string) => boolean }) {
  const interval = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      clearInterval(interval);
    }
  }, 10_000);
  interval.unref?.();
  return interval;
}

router.post("/:id/stream", requireAuth, async (req, res) => {
  const conversation = await loadConversationOrNull(String(req.params.id), req.user!.id);
  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found" });
  }
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }
  if (conversation.status === "pr_open") {
    log.warn(`stream rejected conv=${conversation.id} — already pushed`);
    return res.status(409).json({ error: "Conversation already pushed. Start a new conversation." });
  }
  if (conversation.status === "running") {
    log.warn(`stream rejected conv=${conversation.id} — already running`);
    return res.status(409).json({ error: "Conversation is already running" });
  }

  await prisma.message.create({
    data: { conversationId: conversation.id, role: "user", content: { text: message } },
  });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { status: "running" },
  });
  log.info(`stream start conv=${conversation.id} by=${req.user!.login} msg="${message.slice(0, 60)}${message.length > 60 ? "…" : ""}" resume=${conversation.status === "review"}`);

  sseHeaders(res);
  const keepalive = startKeepalive(res);
  const abort = new AbortController();
  let finished = false;
  const onClose = () => {
    if (!finished) abort.abort();
  };
  res.on("close", onClose);

  try {
    const threadId = conversation.id;
    const input =
      conversation.status === "review"
        ? new Command({ resume: message })
        : {
            userMessage: message,
            repoOwner: conversation.repoOwner,
            repoName: conversation.repoName,
            branch: conversation.branch,
            provider: conversation.provider,
            model: conversation.model,
            authorName: req.user!.name ?? req.user!.login,
            authorEmail: req.user!.email ?? `${req.user!.login}@users.noreply.github.com`,
          };

    for await (const event of runAgent({ threadId, input, signal: abort.signal })) {
      if (event.type === "token") sendEvent(res, "token", { content: event.content });
      else if (event.type === "node") {
        log.info(`sse node conv=${threadId} → ${event.node}`);
        sendEvent(res, "node", { node: event.node, data: event.data });
      } else if (event.type === "interrupt") {
        log.info(`sse interrupt conv=${threadId} → review`);
        sendEvent(res, "interrupt", event.data ?? {});
      } else if (event.type === "end") sendEvent(res, "end", event.data ?? {});
    }

    const graph = await getAgentGraph();
    const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
    const messages = (snapshot.values as { messages: BaseMessage[] }).messages ?? [];

    const storedCount = await prisma.message.count({
      where: { conversationId: conversation.id, role: { not: "user" } },
    });
    const fresh = messages.slice(storedCount);
    if (fresh.length > 0) {
      await prisma.message.createMany({
        data: fresh.map((m) => ({
          conversationId: conversation.id,
          role: "assistant",
          provider: conversation.provider,
          model: conversation.model,
          content: {
            type: m.getType(),
            text: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          },
        })),
      });
    }

    const next = snapshot.next as string[];
    const finalStatus = next.length === 0 ? "pr_open" : next.includes("review") ? "review" : "running";
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { status: finalStatus },
    });

    sendEvent(res, "done", { status: finalStatus });
    finished = true;
    log.ok(`stream done conv=${conversation.id} status=${finalStatus} storedMsgs=${fresh.length}`);
  } catch (err) {
    if (abort.signal.aborted) {
      log.warn(`stream aborted conv=${conversation.id} — client disconnected`);
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: "active" },
      });
    } else {
      console.error("Agent run failed:", err);
      log.error(`stream error conv=${conversation.id} type=${(err as Error).name} msg=${(err as Error).message.slice(0, 200)}`);
      finished = true;
      sendAgentError(res, conversation.id, err);
    }
  } finally {
    clearInterval(keepalive);
    res.removeListener("close", onClose);
    res.end();
  }
});

router.post("/:id/push", requireAuth, async (req, res) => {
  const conversation = await loadConversationOrNull(String(req.params.id), req.user!.id);
  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found" });
  }
  if (conversation.status !== "review") {
    log.warn(`push rejected conv=${conversation.id} — status=${conversation.status} (not review)`);
    return res.status(409).json({ error: "Conversation is not in review state" });
  }

  log.info(`push start conv=${conversation.id} by=${req.user!.login}`);
  sseHeaders(res);
  const keepalive = startKeepalive(res);
  const abort = new AbortController();
  let finished = false;
  const onClose = () => {
    if (!finished) abort.abort();
  };
  res.on("close", onClose);

  try {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { status: "running" },
    });

    for await (const event of runAgent({
      threadId: conversation.id,
      input: new Command({ resume: { action: "push", feedback: "" } }),
      signal: abort.signal,
    })) {
      if (event.type === "token") sendEvent(res, "token", { content: event.content });
      else if (event.type === "node") {
        log.info(`sse node conv=${conversation.id} → ${event.node}`);
        sendEvent(res, "node", { node: event.node, data: event.data });
      } else if (event.type === "interrupt") sendEvent(res, "interrupt", event.data ?? {});
      else if (event.type === "end") sendEvent(res, "end", event.data ?? {});
    }

    const graph = await getAgentGraph();
    const snapshot = await graph.getState({ configurable: { thread_id: conversation.id } });
    const messages = (snapshot.values as { messages: BaseMessage[] }).messages ?? [];
    const storedCount = await prisma.message.count({
      where: { conversationId: conversation.id, role: { not: "user" } },
    });
    const fresh = messages.slice(storedCount);
    if (fresh.length > 0) {
      await prisma.message.createMany({
        data: fresh.map((m) => ({
          conversationId: conversation.id,
          role: "assistant",
          provider: conversation.provider,
          model: conversation.model,
          content: {
            type: m.getType(),
            text: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          },
        })),
      });
    }

    const prRow = await prisma.pullRequest.findUnique({ where: { conversationId: conversation.id } });
    log.ok(`push done conv=${conversation.id} pr=${prRow ? `#${prRow.number} ${prRow.url}` : "none"}`);
    finished = true;
    sendEvent(res, "done", {
      status: "pr_open",
      prUrl: prRow?.url ?? null,
      prNumber: prRow?.number ?? null,
    });
  } catch (err) {
    if (abort.signal.aborted) {
      log.warn(`push aborted conv=${conversation.id} — client disconnected`);
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: "review" },
      });
    } else {
      console.error("Push failed:", err);
      log.error(`push error conv=${conversation.id} type=${(err as Error).name} msg=${(err as Error).message.slice(0, 200)}`);
      finished = true;
      sendAgentError(res, conversation.id, err);
    }
  } finally {
    clearInterval(keepalive);
    res.removeListener("close", onClose);
    res.end();
  }
});

export default router;

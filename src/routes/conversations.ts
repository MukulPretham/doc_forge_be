import type { BaseMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { Router } from "express";
import { z } from "zod";
import { getAgentGraph, runAgent } from "../agent/graph.js";
import { prisma } from "../db/prisma.js";
import { getProvider } from "../models/registry.js";
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
    return res.status(409).json({ error: "Conversation already pushed. Start a new conversation." });
  }
  if (conversation.status === "running") {
    return res.status(409).json({ error: "Conversation is already running" });
  }

  await prisma.message.create({
    data: { conversationId: conversation.id, role: "user", content: { text: message } },
  });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { status: "running" },
  });

  sseHeaders(res);

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

    for await (const event of runAgent({ threadId, input })) {
      if (event.type === "token") sendEvent(res, "token", { content: event.content });
      else if (event.type === "node") sendEvent(res, "node", { node: event.node, data: event.data });
      else if (event.type === "interrupt") sendEvent(res, "interrupt", event.data ?? {});
      else if (event.type === "end") sendEvent(res, "end", event.data ?? {});
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
  } catch (err) {
    console.error("Agent run failed:", err);
    sendEvent(res, "error", { message: (err as Error).message });
    await prisma.conversation
      .update({ where: { id: conversation.id }, data: { status: "error" } })
      .catch(() => {});
  }

  res.end();
});

router.post("/:id/push", requireAuth, async (req, res) => {
  const conversation = await loadConversationOrNull(String(req.params.id), req.user!.id);
  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found" });
  }
  if (conversation.status !== "review") {
    return res.status(409).json({ error: "Conversation is not in review state" });
  }

  sseHeaders(res);

  try {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { status: "running" },
    });

    for await (const event of runAgent({
      threadId: conversation.id,
      input: new Command({ resume: { action: "push", feedback: "" } }),
    })) {
      if (event.type === "token") sendEvent(res, "token", { content: event.content });
      else if (event.type === "node") sendEvent(res, "node", { node: event.node, data: event.data });
      else if (event.type === "interrupt") sendEvent(res, "interrupt", event.data ?? {});
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
    sendEvent(res, "done", {
      status: "pr_open",
      prUrl: prRow?.url ?? null,
      prNumber: prRow?.number ?? null,
    });
  } catch (err) {
    console.error("Push failed:", err);
    sendEvent(res, "error", { message: (err as Error).message });
    await prisma.conversation
      .update({ where: { id: conversation.id }, data: { status: "error" } })
      .catch(() => {});
  }

  res.end();
});

export default router;

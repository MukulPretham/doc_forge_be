import type { RunnableConfig } from "@langchain/core/runnables";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { getOctokit } from "../github/client.js";
import { log } from "../logger.js";
import { createChatModel } from "../models/registry.js";
import { draftDocsPrompt, answerPrompt, classifyIntentPrompt, explorePrompt, selectFilesPrompt } from "./prompts.js";
import { modelCall } from "./retry.js";
import type { AgentStateType, DraftDoc, ExploredFile, PrResult } from "./state.js";
import { buildTools, getRepoTree, MAX_DRAFTS, MAX_READS, type ToolContext } from "./tools.js";

type ToolInvoker = (args: Record<string, unknown>) => Promise<unknown>;

function threadId(config: RunnableConfig): string {
  const id = config.configurable?.thread_id;
  if (typeof id !== "string") throw new Error("Missing thread_id in graph config");
  return id;
}

async function getCtx(state: AgentStateType, config: RunnableConfig): Promise<ToolContext> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: threadId(config) },
    include: { user: true },
  });
  if (!conversation) throw new Error("Conversation not found");
  return {
    conversationId: conversation.id,
    octokit: getOctokit(conversation.user.accessToken),
    repoOwner: state.repoOwner,
    repoName: state.repoName,
    branch: state.branch,
  };
}

export async function fetchTree(state: AgentStateType, config: RunnableConfig) {
  const ctx = await getCtx(state, config);
  const tree = await getRepoTree(ctx.octokit, state.repoOwner, state.repoName, state.branch);
  log.info(`node fetch_tree conv=${ctx.conversationId} ${state.repoOwner}/${state.repoName}@${state.branch} entries=${tree.length}`);
  return { tree };
}

const fileSelectionSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().describe("File path in the repo"),
      reason: z.string().describe("One-line reason this file matters for docs"),
    }),
  ),
});

function heuristicIntent(text: string): "docs" | "answer" | undefined {
  const t = text.trim().toLowerCase();
  const docsRe =
    /\b(generate|draft|write|create|update|improve|fix|revise|add|rewrite|build|make|produce)\b.*\b(doc|docs|documentation|readme|guide|comments-as-docs)\b|\b(doc|docs|documentation|readme)\b.*\b(improve|update|fix|rewrite|generate|draft|write|create)\b/;
  if (docsRe.test(t)) return "docs";
  if (/[?]|\b(what|how|why|which|does|is|can|where|when|who|tell|describe|explain|about)\b/.test(t)) return "answer";
  return undefined;
}

function requestedDocPaths(feedback: string): string[] {
  const out = new Set<string>();
  const re = /\b((?:docs\/)?[\w./@-]+\.md)\b/gi;
  for (const m of feedback.matchAll(re)) {
    if (m[1]) out.add(m[1]);
  }
  return [...out];
}

async function classifyIntentImpl(
  state: AgentStateType,
  config: RunnableConfig,
  text: string,
): Promise<"docs" | "answer"> {
  const heuristic = heuristicIntent(text);
  if (heuristic) {
    log.info(`classify_intent thread=${threadId(config)} heuristic → ${heuristic}`);
    return heuristic;
  }
  const model = createChatModel(state.provider!, state.model!);
  try {
    const result = (await modelCall(
      model,
      [new SystemMessage(classifyIntentPrompt()), new HumanMessage(text)],
      state.provider!,
      state.model!,
      config.signal,
    )) as AIMessage;
    const out = String(result.content ?? "").trim().toLowerCase();
    const match = out.match(/\b(docs|answer)\b/);
    const intent = match?.[1] === "answer" ? "answer" : "docs";
    log.info(`classify_intent thread=${threadId(config)} raw="${out.slice(0, 80)}" → ${intent}`);
    return intent;
  } catch (err) {
    log.warn(
      `classify_intent failed thread=${threadId(config)} — defaulting to docs (${(err as Error).message.slice(0, 120)})`,
    );
    return "docs";
  }
}

export async function classifyIntent(state: AgentStateType, config: RunnableConfig) {
  const text = state.feedback || state.userMessage;
  const intent = await classifyIntentImpl(state, config, text);
  log.info(`node classify_intent thread=${threadId(config)} → ${intent}`);
  return { intent, text };
}

export async function selectFiles(state: AgentStateType, config: RunnableConfig) {
  const model = createChatModel(state.provider!, state.model!);
  const structured = model.withStructuredOutput(fileSelectionSchema, { name: "select_files" });

  const result = (await modelCall(structured, [
    new SystemMessage(selectFilesPrompt(state)),
    new HumanMessage(state.userMessage),
  ], state.provider!, state.model!, config.signal)) as { files: { path: string; reason: string }[] };

  const summary = new AIMessage(
    `Selected ${result.files.length} file(s) to explore:\n${result.files.map((f) => `- ${f.path}`).join("\n")}`,
  );
  log.info(`node select_files model=${state.provider}/${state.model} files=${result.files.map((f) => f.path).join(",")}`);
  return { selectedFiles: result.files, messages: [summary] };
}

export async function explore(state: AgentStateType, config: RunnableConfig) {
  const ctx = await getCtx(state, config);
  const { readFile } = buildTools(ctx);
  const tools = [readFile];
  const toolMap = new Map<string, ToolInvoker>(
    tools.map((t) => [t.name, t.invoke.bind(t) as unknown as ToolInvoker]),
  );

  const model = createChatModel(state.provider!, state.model!).bindTools!(tools);
  const local: BaseMessage[] = [
    new SystemMessage(explorePrompt(state)),
    ...state.messages.slice(-6),
    new HumanMessage(state.userMessage),
  ];
  const baseLen = local.length;

  const explored: ExploredFile[] = [...state.explored];
  let readCount = state.readCount;
  const seen = new Set(explored.map((f) => f.path));

  for (let round = 0; round < 6; round++) {
    const res = (await modelCall(model, local, state.provider!, state.model!, config.signal)) as AIMessage;
    local.push(res);

    const calls = res.tool_calls ?? [];
    if (calls.length === 0) break;

    for (const call of calls) {
      if (!call.id) continue;
      if (call.name === "read_file") {
        if (readCount >= MAX_READS) {
          local.push(new ToolMessage({ content: "Read limit reached; stop reading.", tool_call_id: call.id }));
          continue;
        }
        readCount++;
        const fn = toolMap.get(call.name);
        if (!fn) continue;
        let output: string;
        try {
          const result = (await fn(call.args)) as {
            path: string;
            content?: string;
            truncated?: boolean;
            error?: string;
          };
          output = JSON.stringify(result);
          if (result.content && !result.error && !seen.has(result.path)) {
            seen.add(result.path);
            explored.push({ path: result.path, content: result.content, truncated: !!result.truncated });
          }
        } catch (err) {
          output = `Error: ${(err as Error).message}`;
        }
        local.push(new ToolMessage({ content: output, tool_call_id: call.id }));
      }
    }
  }

  log.info(`node explore conv=${ctx.conversationId} reads=${readCount} explored=${explored.length} rounds=${Math.min(6, Math.ceil(local.length - baseLen))}`);
  return { explored, readCount, messages: local.slice(baseLen) };
}

export async function draftDocs(state: AgentStateType, config: RunnableConfig) {
  const ctx = await getCtx(state, config);
  const { writeDocDraft, deleteDocDraft } = buildTools(ctx);
  const tools = [writeDocDraft, deleteDocDraft];
  const toolMap = new Map<string, ToolInvoker>(
    tools.map((t) => [t.name, t.invoke.bind(t) as unknown as ToolInvoker]),
  );

  const model = createChatModel(state.provider!, state.model!).bindTools!(tools);
  const local: BaseMessage[] = [
    new SystemMessage(draftDocsPrompt(state)),
    ...state.messages.slice(-10),
    new HumanMessage(state.feedback || state.userMessage),
  ];
  const baseLen = local.length;

  const drafts = new Map<string, DraftDoc>(state.drafts.map((d) => [d.path, d]));
  const writtenPaths = new Set<string>();
  let draftCount = state.drafts.length;

  const handleCall = async (call: unknown) => {
    const c = call as { id?: string; name?: string; args?: { path?: string; content?: string } };
    if (!c.id) return;
    const fn = toolMap.get(c.name!);
    if (!fn) return;
    let output: string;
    try {
      const args = c.args as { path?: string; content?: string };
      if (c.name === "write_doc_draft") {
        if (draftCount >= MAX_DRAFTS) {
          local.push(new ToolMessage({ content: "Draft limit reached; stop writing.", tool_call_id: c.id }));
          return;
        }
        if (!args.path || !args.content) throw new Error("write_doc_draft requires path and content");
        const result = (await fn({ path: args.path, content: args.content })) as {
          saved: boolean;
          error?: string;
        };
        output = JSON.stringify(result);
        if (result.saved) {
          drafts.set(args.path, { path: args.path, content: args.content });
          writtenPaths.add(args.path);
          if (!state.drafts.some((d) => d.path === args.path)) draftCount++;
        }
      } else if (c.name === "delete_doc_draft") {
        if (!args.path) throw new Error("delete_doc_draft requires path");
        const result = (await fn({ path: args.path })) as { deleted: boolean; error?: string };
        output = JSON.stringify(result);
        if (result.deleted) {
          drafts.delete(args.path);
          if (!state.drafts.some((d) => d.path === args.path)) draftCount = Math.max(0, draftCount - 1);
        }
      } else {
        return;
      }
    } catch (err) {
      output = `Error: ${(err as Error).message}`;
    }
    local.push(new ToolMessage({ content: output, tool_call_id: c.id }));
  };

  const think = async (): Promise<AIMessage> =>
    (await modelCall(model, local, state.provider!, state.model!, config.signal)) as AIMessage;

  for (let round = 0; round < 8; round++) {
    const res = await think();
    local.push(res);
    const calls = res.tool_calls ?? [];
    if (calls.length === 0) break;
    for (const call of calls) await handleCall(call);
  }

  const negativeRevision =
    /\b(remove|delete|drop|don'?t|do not|skip|avoid|without|no longer|never)\b/i.test(state.feedback ?? "");
  if (state.feedback && !negativeRevision) {
    const staged = new Set([...drafts.keys()].map((p) => p.toLowerCase()));
    const missing = requestedDocPaths(state.feedback).filter((p) => !staged.has(p.toLowerCase()));
    if (missing.length > 0) {
      log.warn(`node draft_docs conv=${ctx.conversationId} nudge: creating ${missing.join(",")}`);
      local.push(
        new HumanMessage(
          `The user explicitly requested the following file(s), which you have not created yet: ${missing.join(", ")}. Call write_doc_draft for each of them now with full markdown content.`,
        ),
      );
      for (let round = 0; round < 3; round++) {
        const res = await think();
        local.push(res);
        const calls = res.tool_calls ?? [];
        if (calls.length === 0) break;
        for (const call of calls) await handleCall(call);
        const stagedNow = new Set([...drafts.keys()].map((p) => p.toLowerCase()));
        if (missing.every((p) => stagedNow.has(p.toLowerCase()))) break;
      }
    }
  }

  const consolidationRequest = (state.feedback ?? "").match(
    /\b(merge|combine|consolidate|join|unify)\b|\b(all|everything|whole)\b.*\b(one|single|only)\b.*\bfile\b|\b(one|single)\b.*\bfile\b/i,
  );
  log.info(
    `node draft_docs conv=${ctx.conversationId} feedback="${(state.feedback ?? "").slice(0, 60)}" written=${writtenPaths.size} consolidation=${!!consolidationRequest}`,
  );
  if (consolidationRequest) {
    const primary = drafts.has("README.md")
      ? "README.md"
      : writtenPaths.size > 0
        ? (writtenPaths.values().next().value as string)
        : (drafts.keys().next().value as string | undefined);
    if (primary) {
      if (writtenPaths.size === 0) {
        const others = [...drafts.keys()].filter((p) => p !== primary);
        if (others.length > 0) {
          const merged = [
            drafts.get(primary)!.content,
            ...others.map(
              (p) => `\n\n---\n\n# ${p.replace(/\.md$/, "").replace(/^docs\//, "")}\n\n${drafts.get(p)!.content}`,
            ),
          ].join("");
          await prisma.docDraft.upsert({
            where: { conversationId_path: { conversationId: ctx.conversationId, path: primary } },
            update: { content: merged, status: "draft" },
            create: { conversationId: ctx.conversationId, path: primary, content: merged, status: "draft" },
          });
          drafts.set(primary, { path: primary, content: merged });
          log.info(`node draft_docs conv=${ctx.conversationId} consolidated: merged into ${primary}`);
        }
      }
      for (const [path] of drafts) {
        if (path === primary) continue;
        await prisma.docDraft.deleteMany({ where: { conversationId: ctx.conversationId, path, status: "draft" } });
        drafts.delete(path);
        log.info(`node draft_docs conv=${ctx.conversationId} consolidated: removed ${path}`);
      }
    }
  }

  local.push(new AIMessage(`Drafting complete. ${drafts.size} document(s) staged for review.`));
  log.ok(`node draft_docs conv=${ctx.conversationId} drafts=${[...drafts.values()].map((d) => d.path).join(",")}`);
  return { drafts: [...drafts.values()], messages: local.slice(baseLen) };
}

export async function answerNode(state: AgentStateType, config: RunnableConfig) {
  const ctx = await getCtx(state, config);
  const { readFile } = buildTools(ctx);
  const tools = [readFile];
  const toolMap = new Map<string, ToolInvoker>(
    tools.map((t) => [t.name, t.invoke.bind(t) as unknown as ToolInvoker]),
  );

  const model = createChatModel(state.provider!, state.model!).bindTools!(tools);
  const question = state.feedback || state.userMessage;
  const local: BaseMessage[] = [
    new SystemMessage(answerPrompt(state)),
    ...(question ? [new HumanMessage(question)] : []),
  ];

  const baseLen = local.length;
  for (let round = 0; round < 4; round++) {
    const res = (await modelCall(model, local, state.provider!, state.model!, config.signal)) as AIMessage;
    local.push(res);

    const calls = res.tool_calls ?? [];
    if (calls.length === 0) break;

    for (const call of calls) {
      if (!call.id) continue;
      if (call.name === "read_file") {
        const fn = toolMap.get(call.name);
        if (!fn) continue;
        let output: string;
        try {
          const result = (await fn(call.args)) as {
            path: string;
            content?: string;
            truncated?: boolean;
            error?: string;
          };
          output = JSON.stringify(result);
        } catch (err) {
          output = `Error: ${(err as Error).message}`;
        }
        local.push(new ToolMessage({ content: output, tool_call_id: call.id }));
      }
    }
  }

  const replies = local
    .slice(baseLen)
    .filter((m): m is AIMessage => {
      const type = typeof m.getType === "function" ? m.getType() : "";
      const toolCalls = (m as { tool_calls?: unknown[] }).tool_calls ?? [];
      return type === "ai" && toolCalls.length === 0 && String(m.content ?? "").trim().length > 0;
    })
    .slice(-1)
    .map((m) => new AIMessage({ content: m.content, additional_kwargs: { ...m.additional_kwargs, __df: { userVisible: true } } }));
  log.ok(`node answer conv=${ctx.conversationId} replyChars=${(replies[0]?.content ?? "").toString().length}`);
  return { messages: replies };
}

function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (t.endsWith("?")) return true;
  return /^(what|whats|what's|how|why|which|where|when|who|whom|whose|is|are|was|were|can|could|do|does|did|should|would|will|may|might|has|have|had|tell|explain|describe|summarize|walk|about|show)\b/i.test(
    t,
  );
}

export async function classifyResumeIntoAction(
  state: AgentStateType,
  config: RunnableConfig,
  text: string,
): Promise<{ action: "review" | "answer"; feedback: string }> {
  const isQuestion = looksLikeQuestion(text);
  log.info(
    `classify_resume thread=${threadId(config)} question=${isQuestion} text="${text.slice(0, 60)}" → ${isQuestion ? "answer" : "review"}`,
  );
  if (isQuestion) return { action: "answer", feedback: text };
  return { action: "review", feedback: text };
}

export async function review(state: AgentStateType, config: RunnableConfig) {
  const resume = interrupt({
    status: "review",
    drafts: state.drafts,
    message: "Drafts are ready. Reply with feedback to revise, or say 'push' to open a PR.",
  }) as string | { action?: string; feedback?: string } | undefined;

  const pushWords = ["push", "publish", "approve", "go", "push it"];

  if (typeof resume === "string") {
    const text = resume.trim();
    if (text && (pushWords.includes(text.toLowerCase()) || text.toLowerCase().includes("push"))) {
      return { action: "push" as const, feedback: "" };
    }
    if (text) return classifyResumeIntoAction(state, config, text);
    return { action: "review" as const, feedback: "" };
  }

  if (resume?.action === "push") {
    return { action: "push" as const, feedback: resume.feedback ?? "" };
  }
  const feedbackText = resume?.feedback?.trim() ?? "";
  if (feedbackText) return classifyResumeIntoAction(state, config, feedbackText);
  return { action: "review" as const, feedback: "" };
}

export async function createPr(state: AgentStateType, config: RunnableConfig) {
  const conversationId = threadId(config);
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { user: true },
  });
  if (!conversation) throw new Error("Conversation not found");

  const drafts = await prisma.docDraft.findMany({
    where: { conversationId, status: "draft" },
    orderBy: { path: "asc" },
  });
  if (drafts.length === 0) throw new Error("No drafts to push");

  const octokit = getOctokit(conversation.user.accessToken);
  const { repoOwner, repoName, branch } = state;
  const workBranch = `docs/auto-${Date.now().toString(36)}`;
  const authorName = state.authorName || conversation.user.name || conversation.user.login;
  const authorEmail =
    state.authorEmail || conversation.user.email || `${conversation.user.login}@users.noreply.github.com`;

  const { data: baseRef } = await octokit.rest.git.getRef({
    owner: repoOwner,
    repo: repoName,
    ref: `heads/${branch}`,
  });

  await octokit.rest.git.createRef({
    owner: repoOwner,
    repo: repoName,
    ref: `refs/heads/${workBranch}`,
    sha: baseRef.object.sha,
  });

  const treeEntries: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
  for (const draft of drafts) {
    const { data: blob } = await octokit.rest.git.createBlob({
      owner: repoOwner,
      repo: repoName,
      content: draft.content,
      encoding: "utf-8",
    });
    treeEntries.push({ path: draft.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const { data: tree } = await octokit.rest.git.createTree({
    owner: repoOwner,
    repo: repoName,
    base_tree: baseRef.object.sha,
    tree: treeEntries,
  });

  const commitMessage = `docs: add auto-generated documentation

Generated by DocForge for ${repoOwner}/${repoName}.`;
  const { data: commit } = await octokit.rest.git.createCommit({
    owner: repoOwner,
    repo: repoName,
    message: commitMessage,
    tree: tree.sha,
    parents: [baseRef.object.sha],
    author: { name: authorName, email: authorEmail },
    committer: { name: authorName, email: authorEmail },
  });

  await octokit.rest.git.updateRef({
    owner: repoOwner,
    repo: repoName,
    ref: `heads/${workBranch}`,
    sha: commit.sha,
  });

  const body = `## Auto-generated documentation

This PR was created by **DocForge** — an AI documentation agent.

### Files
${drafts.map((d) => `- \`${d.path}\``).join("\n")}

Generated from branch \`${branch}\`.`;
  const { data: pr } = await octokit.rest.pulls.create({
    owner: repoOwner,
    repo: repoName,
    title: "docs: auto-generated documentation",
    head: workBranch,
    base: branch,
    body,
    maintainer_can_modify: true,
  });

  const prResult: PrResult = { url: pr.html_url, number: pr.number, branch: workBranch };
  log.ok(`node create_pr conv=${conversationId} ${repoOwner}/${repoName} branch=${workBranch} PR #${pr.number} ${pr.html_url}`);

  await prisma.$transaction([
    prisma.pullRequest.upsert({
      where: { conversationId },
      update: {
        repoOwner,
        repoName,
        number: pr.number,
        url: pr.html_url,
        branch: workBranch,
        title: pr.title ?? "docs: auto-generated documentation",
        state: pr.state ?? "open",
      },
      create: {
        conversationId,
        userId: conversation.userId,
        repoOwner,
        repoName,
        number: pr.number,
        url: pr.html_url,
        branch: workBranch,
        title: pr.title ?? "docs: auto-generated documentation",
        state: pr.state ?? "open",
      },
    }),
    prisma.conversation.update({
      where: { id: conversationId },
      data: { workBranch, prUrl: pr.html_url, prNumber: pr.number, status: "pr_open" },
    }),
    prisma.docDraft.updateMany({
      where: { conversationId, status: "draft" },
      data: { status: "committed" },
    }),
  ]);

  return { prResult, action: "push" as const };
}

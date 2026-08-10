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
import { createChatModel } from "../models/registry.js";
import { draftDocsPrompt, explorePrompt, selectFilesPrompt } from "./prompts.js";
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

export async function selectFiles(state: AgentStateType) {
  const model = createChatModel(state.provider!, state.model!);
  const structured = model.withStructuredOutput(fileSelectionSchema, { name: "select_files" });

  const result = (await modelCall(structured, [
    new SystemMessage(selectFilesPrompt(state)),
    new HumanMessage(state.userMessage),
  ])) as { files: { path: string; reason: string }[] };

  const summary = new AIMessage(
    `Selected ${result.files.length} file(s) to explore:\n${result.files.map((f) => `- ${f.path}`).join("\n")}`,
  );
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
    const res = (await modelCall(model, local)) as AIMessage;
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

  return { explored, readCount, messages: local.slice(baseLen) };
}

export async function draftDocs(state: AgentStateType, config: RunnableConfig) {
  const ctx = await getCtx(state, config);
  const { writeDocDraft } = buildTools(ctx);
  const tools = [writeDocDraft];
  const toolMap = new Map<string, ToolInvoker>(
    tools.map((t) => [t.name, t.invoke.bind(t) as unknown as ToolInvoker]),
  );

  const model = createChatModel(state.provider!, state.model!).bindTools!(tools);
  const local: BaseMessage[] = [
    new SystemMessage(draftDocsPrompt(state)),
    ...state.messages.slice(-10),
    new HumanMessage(state.userMessage),
  ];
  const baseLen = local.length;

  const drafts = new Map<string, DraftDoc>(state.drafts.map((d) => [d.path, d]));
  let draftCount = state.drafts.length;

  for (let round = 0; round < 8; round++) {
    const res = (await modelCall(model, local)) as AIMessage;
    local.push(res);

    const calls = res.tool_calls ?? [];
    if (calls.length === 0) break;

    for (const call of calls) {
      if (!call.id || call.name !== "write_doc_draft") continue;
      if (draftCount >= MAX_DRAFTS) {
        local.push(new ToolMessage({ content: "Draft limit reached; stop writing.", tool_call_id: call.id }));
        continue;
      }
      const fn = toolMap.get(call.name);
      if (!fn) continue;
      let output: string;
      try {
        const args = call.args as { path?: string; content?: string };
        if (!args.path || !args.content) throw new Error("write_doc_draft requires path and content");
        const result = (await fn({ path: args.path, content: args.content })) as {
          saved: boolean;
          error?: string;
        };
        output = JSON.stringify(result);
        if (result.saved) {
          drafts.set(args.path, { path: args.path, content: args.content });
          if (!state.drafts.some((d) => d.path === args.path)) draftCount++;
        }
      } catch (err) {
        output = `Error: ${(err as Error).message}`;
      }
      local.push(new ToolMessage({ content: output, tool_call_id: call.id }));
    }
  }

  local.push(new AIMessage(`Drafting complete. ${drafts.size} document(s) staged for review.`));
  return { drafts: [...drafts.values()], messages: local.slice(baseLen) };
}

export async function review(state: AgentStateType) {
  const resume = interrupt({
    status: "review",
    drafts: state.drafts,
    message: "Drafts are ready. Reply with feedback to revise, or say 'push' to open a PR.",
  }) as string | { action?: string; feedback?: string } | undefined;

  if (typeof resume === "string") {
    const text = resume.trim().toLowerCase();
    if (["push", "publish", "approve", "go", "push it"].includes(text) || text.includes("push")) {
      return { action: "push" as const, feedback: "" };
    }
    return { action: "review" as const, feedback: resume };
  }

  if (resume?.action === "push") {
    return { action: "push" as const, feedback: resume.feedback ?? "" };
  }
  return { action: "review" as const, feedback: resume?.feedback ?? "" };
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

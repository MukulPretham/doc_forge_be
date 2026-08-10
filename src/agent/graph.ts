import { Command, END, INTERRUPT, START, StateGraph, isInterrupted } from "@langchain/langgraph";
import { getCheckpointer } from "./checkpointer.js";
import { createPr, draftDocs, explore, fetchTree, review, selectFiles } from "./nodes.js";
import { AgentState, type AgentStateType } from "./state.js";

function routeAfterReview(state: AgentStateType): "review" | "push" {
  return state.action === "push" ? "push" : "review";
}

export async function buildGraph() {
  const checkpointer = await getCheckpointer();

  return new StateGraph(AgentState)
    .addNode("fetch_tree", fetchTree)
    .addNode("select_files", selectFiles)
    .addNode("explore", explore)
    .addNode("draft_docs", draftDocs)
    .addNode("review", review)
    .addNode("create_pr", createPr)
    .addEdge(START, "fetch_tree")
    .addEdge("fetch_tree", "select_files")
    .addEdge("select_files", "explore")
    .addEdge("explore", "draft_docs")
    .addEdge("draft_docs", "review")
    .addConditionalEdges("review", routeAfterReview, {
      review: "draft_docs",
      push: "create_pr",
    })
    .addEdge("create_pr", END)
    .compile({ checkpointer });
}

export type CompiledGraph = Awaited<ReturnType<typeof buildGraph>>;

let graphPromise: Promise<CompiledGraph> | undefined;

export function getAgentGraph(): Promise<CompiledGraph> {
  if (!graphPromise) graphPromise = buildGraph();
  return graphPromise;
}

export interface AgentRunEvent {
  type: "token" | "node" | "interrupt" | "end";
  node?: string;
  content?: string;
  data?: Record<string, unknown>;
}

export interface RunAgentOptions {
  threadId: string;
  input: unknown;
}

export async function* runAgent({
  threadId,
  input,
}: RunAgentOptions): AsyncGenerator<AgentRunEvent> {
  const graph = await getAgentGraph();
  const config = { configurable: { thread_id: threadId }, recursionLimit: 50 };

  const stream = await graph.stream(input as never, {
    ...config,
    streamMode: ["updates", "messages"],
  });

  for await (const rawChunk of stream as AsyncIterable<unknown>) {
    const chunk = rawChunk as [string[], string, unknown];

    if (!Array.isArray(chunk) || chunk.length < 2) {
      continue;
    }

    const mode = chunk[1];
    const payload = chunk[2];

    if (mode === "messages") {
      const pair = payload as [unknown, unknown];
      const msg = pair[0] as { content?: unknown };
      if (typeof msg?.content === "string" && msg.content) {
        yield { type: "token", content: msg.content };
      }
      continue;
    }

    if (mode === "updates") {
      const update = payload as Record<string, unknown>;
      const node = Object.keys(update)[0];
      if (!node) continue;
      const data = update[node];
      if (data && typeof data === "object" && isInterrupted(data)) {
        const first = (data as Record<string | symbol, unknown>)[INTERRUPT] as {
          value?: Record<string, unknown>;
        }[];
        const payload = first?.[0]?.value;
        yield { type: "interrupt", node, data: (payload ?? {}) as Record<string, unknown> };
      } else {
        yield { type: "node", node, data: (data ?? {}) as Record<string, unknown> };
      }
    }
  }

  const snapshot = await graph.getState(config);
  yield { type: "end", data: { status: "pr_open", next: snapshot.next } };
}

import { Command, END, START, StateGraph } from "@langchain/langgraph";
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
    if (!Array.isArray(rawChunk) || rawChunk.length < 2) {
      continue;
    }

    const [mode, payload] = rawChunk as [string, unknown];

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
      if (update && typeof update === "object" && "__interrupt__" in update) {
        const list = update.__interrupt__ as { value?: Record<string, unknown> }[];
        yield { type: "interrupt", data: (list?.[0]?.value ?? {}) as Record<string, unknown> };
        continue;
      }
      const node = Object.keys(update)[0];
      if (!node) continue;
      yield { type: "node", node, data: (update[node] ?? {}) as Record<string, unknown> };
    }
  }

  const snapshot = await graph.getState(config);
  yield { type: "end", data: { status: "pr_open", next: snapshot.next } };
}

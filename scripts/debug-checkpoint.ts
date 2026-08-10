import { getAgentGraph } from "../src/agent/graph.js";

const graph = await getAgentGraph();
const threadId = process.argv[2] ?? "cmsmtba0q0001xvjtftcvrpx9";
const snap = await graph.getState({ configurable: { thread_id: threadId } });
const messages = (snap.values as { messages: unknown[] }).messages ?? [];
console.log(`total messages in checkpoint: ${messages.length}`);
for (const m of messages as { getType: () => string; content?: unknown; tool_calls?: { name: string; args: unknown }[]; tool_call_id?: string }[]) {
  const type = m.getType();
  const calls = (m.tool_calls ?? []).map((c) => `${c.name}(${JSON.stringify(c.args).slice(0, 80)})`).join(", ");
  const content = typeof m.content === "string" ? m.content.slice(0, 150) : JSON.stringify(m.content)?.slice(0, 150);
  console.log(`[${type}]${calls ? ` CALLS: ${calls}` : ""}${content ? ` content: ${content}` : ""}`);
}

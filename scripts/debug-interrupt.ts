import { Annotation, END, MemorySaver, START, StateGraph, interrupt } from "@langchain/langgraph";

const S = Annotation.Root({
  x: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
});

const g = new StateGraph(S)
  .addNode("review", async () => {
    interrupt({ drafts: [{ path: "README.md" }] });
    return { x: 1 };
  })
  .addEdge(START, "review")
  .addEdge("review", END)
  .compile({ checkpointer: new MemorySaver() });

const stream = await g.stream({}, { configurable: { thread_id: "debug1" }, streamMode: ["updates", "messages"] });
for await (const raw of stream) {
  console.log("CHUNK:", JSON.stringify(raw).slice(0, 250));
}
console.log("---state---");
const snap = await g.getState({ configurable: { thread_id: "debug1" } });
console.log("next:", JSON.stringify(snap.next));
console.log("tasks:", JSON.stringify(snap.tasks?.map((t) => ({ name: t.name, interrupts: t.interrupts }))).slice(0, 300));

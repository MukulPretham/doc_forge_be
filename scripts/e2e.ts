import { Command } from "@langchain/langgraph";
import { runAgent } from "../src/agent/graph.js";
import { prisma } from "../src/db/prisma.js";

async function withRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts) throw err;
      console.error(`  (neon retry ${i}/${attempts - 1})`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error("unreachable");
}

const step = process.argv[2] ?? "create";
const user = await withRetry(() => prisma.user.findFirstOrThrow({ where: { login: "MukulPretham" } }));

if (step === "create") {
  const provider = process.argv[3] ?? "openrouter";
  const model = process.argv[4] ?? "deepseek/deepseek-chat-v3-0324";
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      repoOwner: "MukulPretham",
      repoName: "Express",
      branch: "main",
      provider,
      model,
      status: "active",
    },
  });
  console.log("CONVERSATION_ID=" + conversation.id);
  console.log("provider/model: " + provider + "/" + model);
  console.log("next: node --import tsx scripts/e2e.ts run " + conversation.id);
  await prisma.$disconnect();
  process.exit(0);
}

const conversationId = step === "run" || step === "push" ? process.argv[3] : undefined;
if (!conversationId) throw new Error("conversation id required");

const conversation = await withRetry(() =>
  prisma.conversation.findFirstOrThrow({ where: { id: conversationId } }),
);
console.log(`conversation ${conversationId}: ${conversation.repoOwner}/${conversation.repoName} status=${conversation.status}`);

const input =
  step === "push"
    ? new Command({ resume: { action: "push", feedback: "" } })
    : {
        userMessage: "Write documentation for this repository: README.md and a docs/ folder as appropriate.",
        repoOwner: conversation.repoOwner,
        repoName: conversation.repoName,
        branch: conversation.branch,
        provider: conversation.provider,
        model: conversation.model,
        authorName: user.name ?? user.login,
        authorEmail: user.email ?? `${user.login}@users.noreply.github.com`,
      };

await prisma.conversation.update({ where: { id: conversationId }, data: { status: "running" } });

let sawInterrupt = false;
for await (const event of runAgent({ threadId: conversationId, input })) {
  if (event.type === "node") {
    const data = event.data ?? {};
    const brief = Object.keys(data).slice(0, 4).join(",");
    console.log(`[node] ${event.node}  -> {${brief}}`);
  } else if (event.type === "interrupt") {
    sawInterrupt = true;
    const drafts = (event.data?.drafts as { path: string }[]) ?? [];
    console.log(`[interrupt] review point reached. ${drafts.length} draft(s) staged:`);
    for (const d of drafts) console.log("   - " + d.path);
  } else if (event.type === "end") {
    console.log(`[end] next=${JSON.stringify(event.data?.next)}`);
  }
}

const drafts = await prisma.docDraft.findMany({
  where: { conversationId, status: "draft" },
  orderBy: { path: "asc" },
});
console.log(`\ndrafts in DB (${drafts.length}):`);
for (const d of drafts) console.log(`  - ${d.path} (${d.content.length} chars)`);

if (!sawInterrupt) {
  console.log("WARNING: no interrupt event seen");
}

const finalConversation = await prisma.conversation.findFirstOrThrow({ where: { id: conversationId } });
console.log(`conversation status -> ${finalConversation.status}`);
console.log(step === "push" ? "next: check PR in DB + github" : `next: node --import tsx scripts/e2e.ts push ${conversationId}`);

await prisma.$disconnect();

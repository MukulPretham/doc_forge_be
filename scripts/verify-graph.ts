import { getAgentGraph } from "../src/agent/graph.js";
import { prisma } from "../src/db/prisma.js";

const graph = await getAgentGraph();
console.log("graph compiled:", graph.name ?? "ok");

const tables = (await prisma.$queryRawUnsafe(
  "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'checkpoint%'",
)) as { tablename: string }[];
console.log("checkpoint tables:", tables.map((r) => r.tablename).join(", "));
await prisma.$disconnect();

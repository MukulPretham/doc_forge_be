import { prisma } from "../src/db/prisma.js";
import { getOctokit } from "../src/github/client.js";

async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts) throw err;
      console.error(`  (retry ${i}/${attempts - 1}: ${(err as Error).message.split("\n")[0]})`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error("unreachable");
}

const user = await withRetry(() =>
  prisma.user.findFirstOrThrow({ where: { login: "MukulPretham" } }),
);
console.log("user:", user.login, "| githubId:", user.githubId);

const octokit = getOctokit(user.accessToken);
const repos = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
  per_page: 100,
  sort: "updated",
});
console.log("repos:");
for (const r of repos) {
  console.log(`  ${r.full_name} | ${r.private ? "private" : "public"} | branch:${r.default_branch} | ${r.size}KB`);
}

await prisma.$disconnect();

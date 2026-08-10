import type { Octokit } from "@octokit/rest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { prisma } from "../db/prisma.js";

export const MAX_READS = 15;
export const MAX_DRAFTS = 10;
export const MAX_FILE_CHARS = 25_000;

const JUNK_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "coverage",
  "__pycache__", ".venv", "venv", ".cache", ".turbo", ".nx", "target",
  ".idea", ".vscode",
]);

const JUNK_FILE_RE =
  /package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|uv\.lock|Pipfile\.lock|\.DS_Store$|\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|otf|pdf|zip|gz|tar|tgz|jar|class|pyc|pyo|exe|dll|so|dylib|wasm|mp4|webm|mp3|wav|o|a)$/i;

export interface ToolContext {
  conversationId: string;
  octokit: Octokit;
  repoOwner: string;
  repoName: string;
  branch: string;
}

export async function getRepoTree(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<{ path: string; type: "blob" | "tree"; size?: number }[]> {
  const { data } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: branch,
    recursive: "1",
  });

  const entries = data.tree ?? [];
  const filtered: { path: string; type: "blob" | "tree"; size?: number }[] = [];

  for (const entry of entries) {
    const path = entry.path ?? "";
    const type = entry.type === "tree" ? ("tree" as const) : ("blob" as const);
    if (path.startsWith(".")) continue;
    const segments = path.split("/");
    if (segments.some((s) => JUNK_DIRS.has(s))) continue;
    if (type === "blob" && JUNK_FILE_RE.test(path)) continue;
    filtered.push({ path, type, size: entry.size });
  }

  return filtered;
}

export function buildTools(ctx: ToolContext) {
  const readFile = tool(
    async ({ path }: { path: string }) => {
      try {
        const { data } = await ctx.octokit.rest.repos.getContent({
          owner: ctx.repoOwner,
          repo: ctx.repoName,
          path,
          ref: ctx.branch,
        });

        if (Array.isArray(data)) {
          return {
            path,
            isDirectory: true,
            entries: data.map((d) => ({
              name: d.name,
              type: d.type,
            })),
          };
        }

        if (data.type !== "file" || !data.content) {
          return { path, isDirectory: false, content: "[not a readable file]", truncated: false };
        }

        let content = Buffer.from(data.content, "base64").toString("utf8");
        const truncated = content.length > MAX_FILE_CHARS;
        if (truncated) content = content.slice(0, MAX_FILE_CHARS);

        return { path, isDirectory: false, content, truncated };
      } catch (err) {
        return { path, error: (err as Error).message };
      }
    },
    {
      name: "read_file",
      description:
        "Read a file from the repository at a given path. Returns file contents (truncated if very large) or a directory listing.",
      schema: z.object({
        path: z.string().describe("Path of the file or directory within the repo, e.g. src/index.ts"),
      }),
    },
  );

  const writeDocDraft = tool(
    async ({ path, content }: { path: string; content: string }) => {
      if (!path.startsWith("README.md") && !path.startsWith("docs/")) {
        return { saved: false, error: "Docs may only be written to README.md or paths under docs/" };
      }
      await prisma.docDraft.upsert({
        where: { conversationId_path: { conversationId: ctx.conversationId, path } },
        update: { content, status: "draft" },
        create: { conversationId: ctx.conversationId, path, content, status: "draft" },
      });
      return { saved: true, path, chars: content.length };
    },
    {
      name: "write_doc_draft",
      description:
        "Stage a documentation file (README.md or docs/...). The draft is stored locally and shown to the user; it is NOT committed to git until the user approves a push.",
      schema: z.object({
        path: z.string().describe("File path, e.g. README.md or docs/architecture.md"),
        content: z.string().describe("Full markdown content of the file"),
      }),
    },
  );

  return { readFile, writeDocDraft, tools: [readFile, writeDocDraft] };
}

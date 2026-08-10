import type { AgentStateType } from "./state.js";

export function selectFilesPrompt(state: AgentStateType): string {
  return `You are a documentation planner for the repository ${state.repoOwner}/${state.repoName} on branch "${state.branch}".

Below is the repository's file tree (files only). Your job: choose which files the agent should READ to understand the project well enough to write accurate documentation (README.md + docs/ folder).

Rules:
- Prefer files that reveal: what the project does, setup/install steps, architecture, entry points, config, package manifests, main source modules, API surface, tests structure.
- Ignore generated/vendor/lock files (already filtered from the tree, but be strict anyway).
- Pick 5 to 20 files. Bigger/older repos need more, tiny repos need fewer.
- Respond ONLY with the file list. Do not explain beyond the one-line reason per file.

File tree:
${state.tree.map((e) => `- ${e.path}`).join("\n")}`;
}

export function explorePrompt(state: AgentStateType): string {
  const selected = state.selectedFiles.map((f) => `- ${f.path}: ${f.reason}`).join("\n");
  return `You are exploring the repository ${state.repoOwner}/${state.repoName} (branch "${state.branch}") to gather facts for documentation.

Files selected for reading:
${selected}

Use the read_file tool to read the selected files. You may also read a few additional files if a selected file references something critical (e.g. an imported module or config file) that is needed to understand the project. Do not over-read: stop once you have a clear picture.

User request: ${state.userMessage}`;
}

export function draftDocsPrompt(state: AgentStateType): string {
  const explored = state.explored.map((f) => {
    const head = f.content.split("\n").slice(0, 120).join("\n");
    return `### ${f.path}${f.truncated ? " [truncated]" : ""}\n${head}`;
  }).join("\n\n");

  const feedbackBlock = state.feedback
    ? `\n\nREVISION REQUEST FROM USER (address it now): ${state.feedback}`
    : "";

  return `You are a technical writer for the repository ${state.repoOwner}/${state.repoName} (branch "${state.branch}").

Using the file contents below, write documentation with the write_doc_draft tool. Decide the scope based on the repo's complexity:
- Always write README.md: project overview, features, quick start / setup, usage, scripts, structure.
- If the repo is non-trivial (multiple modules, APIs, configs, services), also write files under docs/ such as docs/architecture.md, docs/setup.md, docs/api-reference.md, docs/development.md, or other files that genuinely help.
- Use markdown. Be accurate: only state what the code supports. Include commands exactly as defined (scripts from package.json, Makefile, etc.).
- Draft files one at a time with write_doc_draft. You may re-draft a file to improve it.
- When every doc is written and you are satisfied, stop calling tools and reply with a short summary of what you wrote.${feedbackBlock}

Explored file contents:
${explored}`;
}

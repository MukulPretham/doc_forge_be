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
    ? `\n\nREVISION REQUEST FROM USER (this is the latest instruction — it overrides everything above):\n${state.feedback}\n\nRules for revisions:\n- If the revision explicitly names a file (e.g. docs/setup.md), you MUST create it with write_doc_draft even if it does not exist yet. Never skip a requested file.\n- If the revision asks to merge, consolidate, or drop files, call delete_doc_draft for files that should no longer exist, then write the consolidated content to the surviving file(s).\n- Do not rewrite files the user said are fine.`
    : "";

  return `You are a technical writer for the repository ${state.repoOwner}/${state.repoName} (branch "${state.branch}").

Using the file contents below, write documentation with the write_doc_draft tool. Decide the scope based on the repo's complexity:
- Always write README.md: project overview, features, quick start / setup, usage, scripts, structure.
- If the repo is non-trivial (multiple modules, APIs, configs, services), also write files under docs/ such as docs/architecture.md, docs/setup.md, docs/api-reference.md, docs/development.md, or other files that genuinely help.
- Use markdown. Be accurate: only state what the code supports. Include commands exactly as defined (scripts from package.json, Makefile, etc.).
- Draft files one at a time with write_doc_draft. You may re-draft a file to improve it.
- When every doc is written and you are satisfied, stop calling tools and reply with a short summary of what you wrote.

Explored file contents:
${explored}${feedbackBlock}`;
}

export function classifyIntentPrompt(): string {
  return `You route a user's request for a documentation agent that works inside a GitHub repository.

Decide whether the user wants the agent to WRITE OR EDIT DOCUMENTATION, or simply ANSWER A QUESTION about the codebase.

Hard rule: "docs" ONLY when the request explicitly asks to create, draft, write, generate, update, improve, or revise documentation files (README, docs/, comments-as-docs, "write docs", "draft a README", "add a section to the docs", "fix the README"). Requests that mention docs but do not ask to write them are "answer".

"answer" for ANY question, including questions about the repository itself: what it does, how it works, architecture, setup, ports, dependencies, comparisons, troubleshooting, small talk. If the message is a question or a request for information, it is "answer" unless it explicitly asks to write documentation into files.

Examples:
- "Generate documentation for this repository." -> docs
- "Draft a README" -> docs
- "Add a troubleshooting section to the README" -> docs
- "Update the docs to reflect the new config" -> docs
- "Write API docs" -> docs
- "Fix the README" -> docs
- "What is this repo about?" -> answer
- "What does this project do?" -> answer
- "Tell me about this project" -> answer
- "Explain the architecture" -> answer
- "How do I set this up locally?" -> answer
- "Does it support websockets?" -> answer
- "Which port does the server listen on?" -> answer
- "What is this repo about?" -> answer
- "Hello!" -> answer

Reply ONLY with the single word "docs" or "answer". No punctuation, no explanation.`;
}

export function answerPrompt(state: AgentStateType): string {
  const tree = state.tree.map((e) => `- ${e.path}`).join("\n");
  const explored = state.explored.map((f) => {
    const head = f.content.split("\n").slice(0, 120).join("\n");
    return `### ${f.path}${f.truncated ? " [truncated]" : ""}\n${head}`;
  }).join("\n\n");

  const question = state.feedback || state.userMessage;

  return `You are a helpful assistant for the repository ${state.repoOwner}/${state.repoName} (branch "${state.branch}").

Answer the user's question about this repository. Use the read_file tool to inspect any file when the details matter. If you already have the relevant file contents below, use them.

Rules:
- Be accurate: only state what the code actually shows. If something is unclear, say so.
- Answer concisely in markdown. Short answers are fine.
- If the question is not about this repository, answer briefly anyway (one or two sentences).
- Do NOT write any files or call any doc-writing tools.

File tree:
${tree}

Explored file contents:
${explored || "(none yet — read files as needed)"}

User question: ${question}`;
}

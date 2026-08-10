import type { BaseMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";

export interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
}

export interface SelectedFile {
  path: string;
  reason: string;
}

export interface ExploredFile {
  path: string;
  content: string;
  truncated: boolean;
}

export interface DraftDoc {
  path: string;
  content: string;
}

export interface PrResult {
  url: string;
  number: number;
  branch: string;
}

export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
  userMessage: Annotation<string>({ reducer: (_a, b) => b, default: () => "" }),
  provider: Annotation<string>({ reducer: (_a, b) => b, default: () => "" }),
  model: Annotation<string>({ reducer: (_a, b) => b, default: () => "" }),
  repoOwner: Annotation<string>({ reducer: (_a, b) => b, default: () => "" }),
  repoName: Annotation<string>({ reducer: (_a, b) => b, default: () => "" }),
  branch: Annotation<string>({ reducer: (_a, b) => b, default: () => "" }),
  authorName: Annotation<string>({ reducer: (_a, b) => b, default: () => "" }),
  authorEmail: Annotation<string>({ reducer: (_a, b) => b, default: () => "" }),
  tree: Annotation<TreeEntry[]>({ reducer: (_a, b) => b, default: () => [] }),
  selectedFiles: Annotation<SelectedFile[]>({ reducer: (_a, b) => b, default: () => [] }),
  explored: Annotation<ExploredFile[]>({ reducer: (_a, b) => b, default: () => [] }),
  drafts: Annotation<DraftDoc[]>({ reducer: (_a, b) => b, default: () => [] }),
  readCount: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  feedback: Annotation<string>({ reducer: (_a, b) => b, default: () => "" }),
  action: Annotation<"review" | "push">({ reducer: (_a, b) => b, default: () => "review" }),
  prResult: Annotation<PrResult | undefined>({
    reducer: (_a, b) => b,
    default: () => undefined,
  }),
});

export type AgentStateType = typeof AgentState.State;

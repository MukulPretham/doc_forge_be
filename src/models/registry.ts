import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatGroq } from "@langchain/groq";
import { ChatOpenAI } from "@langchain/openai";
import { config } from "../config.js";
import { getModelHealth, type ModelHealthStatus } from "./health.js";

export interface ModelDefinition {
  id: string;
  label: string;
  status?: ModelHealthStatus;
}

export interface ProviderDefinition {
  id: string;
  label: string;
  key: string | undefined;
  build: (model: string) => BaseChatModel;
  models: ModelDefinition[];
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const providers: ProviderDefinition[] = [
  {
    id: "google_genai",
    label: "Google Gemini",
    key: config.GEMINI_API_KEY,
    build: (model) =>
      new ChatGoogleGenerativeAI({
        model,
        apiKey: config.GEMINI_API_KEY,
        streaming: true,
      }),
    models: [
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    key: config.OPENROUTER_API_KEY,
    build: (model) =>
      new ChatOpenAI({
        model,
        apiKey: config.OPENROUTER_API_KEY,
        streaming: true,
        configuration: { baseURL: OPENROUTER_BASE_URL },
      }),
    models: [
      { id: "deepseek/deepseek-chat-v3-0324", label: "DeepSeek V3" },
      { id: "deepseek/deepseek-r1", label: "DeepSeek R1" },
      { id: "qwen/qwen-2.5-coder-32b-instruct", label: "Qwen 2.5 Coder 32B" },
      { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    key: config.ANTHROPIC_API_KEY,
    build: (model) => new ChatAnthropic({ model, apiKey: config.ANTHROPIC_API_KEY, streaming: true }),
    models: [
      { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
      { id: "claude-haiku-4", label: "Claude Haiku 4" },
      { id: "claude-opus-4", label: "Claude Opus 4" },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    key: config.OPENAI_API_KEY,
    build: (model) => new ChatOpenAI({ model, apiKey: config.OPENAI_API_KEY, streaming: true }),
    models: [
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4o-mini", label: "GPT-4o mini" },
      { id: "gpt-4.1", label: "GPT-4.1" },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
      { id: "o3-mini", label: "o3-mini" },
    ],
  },
  {
    id: "groq",
    label: "Groq",
    key: config.GROQ_API_KEY,
    build: (model) => new ChatGroq({ model, apiKey: config.GROQ_API_KEY, streaming: true }),
    models: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B Versatile" },
      { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B Instant" },
      { id: "qwen-2.5-coder-32b", label: "Qwen 2.5 Coder 32B" },
    ],
  },
];

export function getConfiguredProviders(): Omit<ProviderDefinition, "key" | "build">[] {
  return providers
    .filter((p) => p.key)
    .map(({ id, label, models }) => ({
      id,
      label,
      models: models.map((m) => ({ ...m, status: getModelHealth(id, m.id) })),
    }));
}

export function getProvider(providerId: string): ProviderDefinition | undefined {
  return providers.find((p) => p.id === providerId);
}

export function createChatModel(providerId: string, modelId: string): BaseChatModel {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  if (!provider.key) throw new Error(`Provider "${providerId}" is not configured (missing API key)`);
  if (!provider.models.some((m) => m.id === modelId)) {
    throw new Error(`Model "${modelId}" is not registered for provider "${providerId}"`);
  }
  return provider.build(modelId);
}

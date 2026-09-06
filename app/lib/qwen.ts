import OpenAI from "openai";
import type { ModelCall, Usage } from "./evidence";
export function qwenCall(apiKey: string, signal?: AbortSignal, onUsage?: (usage: Usage) => void): ModelCall {
  const client = new OpenAI({ apiKey, fetch: globalThis.fetch, baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", timeout: 90000, maxRetries: 1 });
  return async (system, data, stage) => {
    const response = await client.chat.completions.create({
      model: stage ? "qwen3-max" : "qwen-plus", temperature: 0, max_tokens: 6000,
      ...{ enable_thinking: false },
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(data) }],
    }, { signal });
    if (response.usage) onUsage?.({ inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens,
      cachedInputTokens: response.usage.prompt_tokens_details?.cached_tokens || 0, calls: 1 });
    const choice = response.choices[0];
    if (choice?.finish_reason !== "stop" || !choice.message.content) throw new Error(`答案未完整傳回（${choice?.finish_reason || "empty"}）。`);
    return JSON.parse(choice.message.content);
  };
}

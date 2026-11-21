import OpenAI from "openai";
import type { ModelCall, Usage } from "./evidence";

const answerModel = "qwen3.7-max";
const alternateModel = "qwen-plus";

export function qwenCall(apiKey: string, signal?: AbortSignal, onUsage?: (usage: Usage) => void): ModelCall {
  const client = new OpenAI({ apiKey, fetch: globalThis.fetch, baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", timeout: 90000, maxRetries: 1 });
  const complete = async (model: string, system: string, data: unknown) => {
    const response = await client.chat.completions.create({
      model, temperature: 0, max_tokens: 6000,
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
  return async (system, data, stage) => {
    if (stage !== "compose") return complete(alternateModel, system, data);
    try {
      return await complete(answerModel, system, data);
    } catch (error) {
      if (signal?.aborted || !(error instanceof OpenAI.APIError) || error instanceof OpenAI.APIUserAbortError) throw error;
      const { status, code } = error;
      if (status === 401 || code === "DataInspectionFailed") throw error;
      console.warn("Qwen answer model request failed", {
        model: answerModel, status, code: code && /^[\w.-]{1,80}$/.test(code) ? code : undefined,
      });
      return complete(alternateModel, system, data);
    }
  };
}

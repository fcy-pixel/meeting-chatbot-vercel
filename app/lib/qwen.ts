import OpenAI from "openai";
import type { ModelCall } from "./evidence";
export function qwenCall(apiKey: string, signal?: AbortSignal): ModelCall {
  const client = new OpenAI({ apiKey, baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", timeout: 90000, maxRetries: 1 });
  return async (system, data) => {
    const response = await client.chat.completions.create({
      model: "qwen-plus", temperature: 0, max_tokens: 6000,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(data) }],
    }, { signal });
    const choice = response.choices[0];
    if (choice?.finish_reason !== "stop" || !choice.message.content) throw new Error("模型查核未完整完成。");
    return JSON.parse(choice.message.content);
  };
}

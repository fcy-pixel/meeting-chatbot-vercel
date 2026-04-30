import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "edge";

const QWEN_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const MODEL_NAME = "qwen-plus";

const SYSTEM_PROMPT = `你是一個專業的學校會議紀錄助手。你的任務是根據提供的會議紀錄 PDF 內容，準確回答老師的問題。

規則：
1. 只根據提供的會議紀錄內容回答，不要編造資訊
2. 如果會議紀錄中沒有相關資訊，請明確告知
3. 回答時引用具體的會議名稱和日期
4. 使用繁體中文回答
5. 回答要以自然段落書寫，不要使用 Markdown 格式（不要用 **粗體**、# 標題、- 列表、> 引用等符號）
6. 需要強調重點時，在該句或該項前面加上合適的 emoji（例如 📌 表示重點、📅 表示日期、✅ 表示已決議、⚠️ 表示注意事項），不要用星號或其他符號`;

function buildContext(docs: { name: string; modified: string; text: string }[], maxChars = 60000): string {
  const parts: string[] = [];
  let total = 0;
  for (const doc of docs) {
    const header = `===== 檔案：${doc.name}（修改時間：${doc.modified}）=====\n`;
    const content = doc.text;
    if (total + header.length + content.length > maxChars) {
      const remaining = maxChars - total - header.length;
      if (remaining > 200) {
        parts.push(header + content.slice(0, remaining) + "\n...(截斷)");
      }
      break;
    }
    parts.push(header + content);
    total += header.length + content.length;
  }
  return parts.join("\n\n");
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.QWEN_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "QWEN_API_KEY not configured" }, { status: 500 });
  }

  const body = await req.json();
  const { messages, docs } = body as {
    messages: { role: string; content: string }[];
    docs: { name: string; modified: string; text: string }[];
  };

  if (!messages || !Array.isArray(messages)) {
    return NextResponse.json({ error: "messages required" }, { status: 400 });
  }

  const context = buildContext(docs || []);
  const systemMsg = SYSTEM_PROMPT + `\n\n以下是會議紀錄內容：\n\n${context}`;

  const apiMessages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemMsg },
    ...messages.map((m: { role: string; content: string }) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  const client = new OpenAI({ apiKey, baseURL: QWEN_BASE_URL });

  const stream = await client.chat.completions.create({
    model: MODEL_NAME,
    messages: apiMessages,
    temperature: 0.3,
    max_tokens: 2000,
    stream: true,
  });

  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || "";
        if (text) {
          controller.enqueue(encoder.encode(text));
        }
      }
      controller.close();
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import { qwenCall } from "../app/lib/qwen";

test("follow-up resolution uses Plus and direct document answers use Max", async t => {
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"supported":true}' } }] });
  });
  const call = qwenCall("test");
  await call("Read source", { sources: [] });
  await call("Compose", { evidence: [] }, "compose");
  assert.deepEqual(requests.map(r => r.model), ["qwen-plus", "qwen3-max"]);
  assert.ok(requests.every(r => r.enable_thinking === false && r.temperature === 0 && r.response_format.type === "json_object"));
});

test("incomplete model output is rejected instead of parsing a truncated answer", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ finish_reason: "length", message: { content: '{"claims":[]}' } }] }));
  await assert.rejects(() => qwenCall("test")("Compose", {}, "compose"), /未完整傳回/);
});

test("actual provider token usage is reported, including incomplete responses", async t => {
  const usage: unknown[] = [];
  t.mock.method(globalThis, "fetch", async () => Response.json({
    usage: { prompt_tokens: 1200, completion_tokens: 70, total_tokens: 1270, prompt_tokens_details: { cached_tokens: 800 } },
    choices: [{ finish_reason: "length", message: { content: '{"claims":[]}' } }],
  }));
  await assert.rejects(() => qwenCall("test", undefined, value => usage.push(value))("Compose", {}, "compose"));
  assert.deepEqual(usage, [{ inputTokens: 1200, outputTokens: 70, cachedInputTokens: 800, calls: 1 }]);
});

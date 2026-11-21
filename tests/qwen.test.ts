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

test("a rejected Max request falls back to Plus with the same source text", async t => {
  const requests: { model: string; messages: unknown }[] = [];
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    requests.push(request);
    if (request.model === "qwen3-max") {
      return Response.json({ error: { code: "model_not_found" } }, { status: 404 });
    }
    return Response.json({
      choices: [{ finish_reason: "stop", message: { content: '{"claims":[],"notFound":true}' } }],
    });
  });
  const result = await qwenCall("test")("Reply in JSON", { sources: ["Stored text"] }, "compose");
  assert.deepEqual(result, { claims: [], notFound: true });
  assert.deepEqual(requests.map(request => request.model), ["qwen3-max", "qwen-plus"]);
  assert.deepEqual(requests[0].messages, requests[1].messages);
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

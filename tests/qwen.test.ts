import test from "node:test";
import assert from "node:assert/strict";
import { qwenCall } from "../app/lib/qwen";

test("document reading stays on Plus while composing and reviewing use Max with thinking disabled", async t => {
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"supported":true}' } }] });
  });
  const call = qwenCall("test");
  await call("Read source", { sources: [] });
  await call("Compose", { evidence: [] }, "compose");
  await call("Review", { claims: [] }, "verify");
  assert.deepEqual(requests.map(r => r.model), ["qwen-plus", "qwen3-max", "qwen3-max"]);
  assert.ok(requests.every(r => r.enable_thinking === false && r.temperature === 0 && r.response_format.type === "json_object"));
});

test("incomplete model output is rejected instead of parsing a truncated answer", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ finish_reason: "length", message: { content: '{"claims":[]}' } }] }));
  await assert.rejects(() => qwenCall("test")("Compose", {}, "compose"), /未完整完成/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { withToolImages } from "../../apps/runtime/src/agents/model-media.ts";

test("image evidence follows all tool responses and never remains encoded as tool text", () => {
  const png = "iVBORw0KGgo=";
  const body = withToolImages({
    messages: [
      { role: "assistant", tool_calls: [{ id: "screen" }, { id: "check" }] },
      {
        role: "tool",
        tool_call_id: "screen",
        content: JSON.stringify([
          { type: "file", mediaType: "image/png", data: { type: "data", data: png } },
        ]),
      },
      { role: "tool", tool_call_id: "check", content: "no overflow" },
    ],
  });
  assert.deepEqual(
    (body.messages as Array<{ role: string }>).map((m) => m.role),
    ["assistant", "tool", "tool", "user"],
  );
  const text = JSON.stringify(body);
  assert.equal(text.split(png).length - 1, 1);
  assert.match(text, /image_url/);
  assert.match(text, /screen/);
});

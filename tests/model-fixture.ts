import { createServer } from "node:http";
/** Deterministic OpenAI protocol fixture. Never a production model or AI quality evaluation. */
export async function startModelFixture(port = 0) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.end("test-fixture");
      return;
    }
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.headers.authorization !== "Bearer fixture-key") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "Invalid fixture credential", type: "authentication_error" },
        }),
      );
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    calls++;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const emit = (delta: unknown, finish_reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "fixture-completion", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "protocol-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    if (input.model === "slow-fixture") {
      emit({ role: "assistant", content: "等待取消…" });
      const timer = setTimeout(() => res.end("data: [DONE]\n\n"), 30000);
      timer.unref();
      res.once("close", () => clearTimeout(timer));
      return;
    }
    const tool = input.tools?.[0]?.function?.name;
    if (tool && input.messages.at(-1)?.role !== "tool") {
      emit({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            index: 0,
            id: `fixture-call-${calls}`,
            type: "function",
            function: { name: tool, arguments: '{"values":[40,80]}' },
          },
        ],
      });
      emit({}, "tool_calls");
    } else {
      emit({ role: "assistant", content: "" });
      for (const word of ["这是协议验收服务。", "已完成", "工具调用，", "计算结果为 120。"])
        emit({ content: word });
      emit({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture listener failed");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    get calls() {
      return calls;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

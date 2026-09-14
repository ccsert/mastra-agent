import { createServer } from "node:http";
/** Deterministic OpenAI protocol fixture. Never a production model or AI quality evaluation. */
export async function startModelFixture(
  port = 0,
  options: {
    toolArguments?: Record<string, unknown> | (() => Record<string, unknown>);
    answer?: string;
    reasoning?: string;
    sequenceByRequest?: boolean;
    toolSequence?: { name: string; input: Record<string, unknown> }[];
  } = {},
) {
  let calls = 0;
  const advertisedTools = new Set<string>();
  const toolResults: unknown[] = [];
  let imageInputs = 0;
  const systemPrompts: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.end("test-fixture");
      return;
    }
    if (
      req.url !== "/v1/chat/completions" &&
      req.url !== "/v1/embeddings" &&
      req.url !== "/v1/rerank" &&
      req.url !== "/v1/models"
    ) {
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
    // The OpenAI catalogue endpoint. Served unsorted and with a duplicate so the
    // caller's normalisation is exercised rather than assumed.
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "fixture-chat", object: "model", owned_by: "fixture" },
            { id: "fixture-embed", object: "model", owned_by: "fixture" },
            { id: "fixture-chat", object: "model", owned_by: "fixture" },
          ],
        }),
      );
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    if (req.url === "/v1/embeddings") {
      // A real service has a fixed output width, so `dimensions` is echoed back only
      // when it matches. Probe callers rely on that to spot a wrong configuration.
      const width = 8;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          model: input.model,
          data: [
            {
              object: "embedding",
              index: 0,
              embedding: Array.from({ length: width }, () => 0.125),
            },
          ],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      );
      return;
    }
    if (req.url === "/v1/rerank") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: input.model,
          results: (input.documents ?? []).map((_: unknown, index: number) => ({
            index,
            relevance_score: 1 - index * 0.5,
          })),
        }),
      );
      return;
    }
    calls++;
    if (JSON.stringify(input.messages).includes("data:image/")) imageInputs++;
    systemPrompts.push(
      JSON.stringify(input.messages.filter((m: { role: string }) => m.role === "system")),
    );
    toolResults.push(
      ...input.messages
        .filter((m: { role: string }) => m.role === "tool")
        .map((m: { content: unknown }) => m.content),
    );
    for (const tool of input.tools ?? []) advertisedTools.add(tool.function.name);
    const planned =
      options.toolSequence?.[
        options.sequenceByRequest
          ? calls - 1
          : input.messages.filter((m: { role: string }) => m.role === "tool").length
      ];
    if (input.stream !== true) {
      const tool = options.toolSequence ? planned?.name : input.tools?.[0]?.function?.name;
      const message =
        tool && (options.toolSequence || input.messages.at(-1)?.role !== "tool")
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `fixture-call-${calls}`,
                  type: "function",
                  function: {
                    name: tool,
                    arguments: JSON.stringify(
                      planned?.input ??
                        (typeof options.toolArguments === "function"
                          ? options.toolArguments()
                          : options.toolArguments) ?? { values: [40, 80] },
                    ),
                  },
                },
              ],
            }
          : { role: "assistant", content: options.answer ?? "协议验收完成。" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `fixture-${calls}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: input.model,
          choices: [
            { index: 0, message, finish_reason: "tool_calls" in message ? "tool_calls" : "stop" },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const emit = (delta: unknown, finish_reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "fixture-completion", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "protocol-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    const supervisor = input.tools?.some(
      (t: { function: { name: string } }) => t.function.name === "delegate_task",
    );
    if (
      input.model === "slow-fixture" ||
      (input.model === "delegation-slow-fixture" && !supervisor)
    ) {
      emit({ role: "assistant", content: "等待取消…" });
      const timer = setTimeout(() => res.end("data: [DONE]\n\n"), 30000);
      timer.unref();
      res.once("close", () => clearTimeout(timer));
      return;
    }
    if (
      ["delegation-fixture", "delegation-slow-fixture"].includes(input.model) &&
      input.messages.at(-1)?.role !== "tool"
    ) {
      const planned = supervisor
        ? [
            {
              name: "delegate_task",
              input: { name: "订单核对", task: "调用 sum_values 核对合成订单" },
            },
            {
              name: "delegate_task",
              input: { name: "独立复核", task: "调用 sum_values 独立复核" },
            },
          ]
        : [{ name: "sum_values", input: { values: [40, 80] } }];
      emit({
        role: "assistant",
        tool_calls: planned.map((plan, index) => ({
          index,
          id: supervisor ? `delegate-${calls}-${index}` : "same-child-call-id",
          type: "function",
          function: { name: plan.name, arguments: JSON.stringify(plan.input) },
        })),
      });
      emit({}, "tool_calls");
      if (input.stream_options?.include_usage)
        res.write(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: input.model, choices: [], usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 } })}\n\n`,
        );
      res.end("data: [DONE]\n\n");
      return;
    }
    const tool = options.toolSequence ? planned?.name : input.tools?.[0]?.function?.name;
    if (tool && (options.toolSequence || input.messages.at(-1)?.role !== "tool")) {
      emit({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            index: 0,
            id: `fixture-call-${calls}`,
            type: "function",
            function: {
              name: tool,
              arguments: JSON.stringify(
                planned?.input ??
                  (typeof options.toolArguments === "function"
                    ? options.toolArguments()
                    : options.toolArguments) ?? { values: [40, 80] },
              ),
            },
          },
        ],
      });
      emit({}, "tool_calls");
    } else {
      emit({ role: "assistant", content: "" });
      if (options.reasoning) emit({ reasoning_content: options.reasoning });
      for (const word of options.answer
        ? [options.answer]
        : ["这是协议验收服务。", "已完成", "工具调用，", "计算结果为 120。"])
        emit({ content: word });
      emit({}, "stop");
    }
    // OpenAI reports usage on a final chunk with no choices when the request sets
    // `stream_options.include_usage`. Mirrored here so usage capture is exercised.
    if (input.stream_options?.include_usage === true)
      res.write(
        `data: ${JSON.stringify({ id: "fixture-completion", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: input.model, choices: [], usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 } })}\n\n`,
      );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture listener failed");
  return {
    server,
    advertisedTools,
    get imageInputs() {
      return imageInputs;
    },
    toolResults,
    systemPrompts,
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

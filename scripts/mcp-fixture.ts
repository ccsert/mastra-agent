import { mcpFixture } from "../tests/fixtures/mcp-fixture.ts";

const service = await mcpFixture(Number(process.env.MCP_FIXTURE_PORT ?? 4201));
console.log(`Synthetic read-only MCP service: ${service.url}`);
console.log("Fixture token: mcp-fixture-key; sample order: ORD-1001. No real business data.");
const stop = async () => {
  await service.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

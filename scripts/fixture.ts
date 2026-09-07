import { startModelFixture } from "../tests/model-fixture.ts";

const fixture = await startModelFixture(Number(process.env.FIXTURE_PORT ?? 4199));
console.log(`TEST FIXTURE ONLY — deterministic responses, no LLM inference. ${fixture.url}/v1`);
console.log("Model ID: protocol-fixture; test credential: fixture-key");
async function stop() {
  await fixture.close();
  process.exit(0);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

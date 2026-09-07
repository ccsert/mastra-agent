import { createHash, createHmac, randomBytes } from "node:crypto";
/** Server-side signing only. Request methods and schemas are generated from OpenAPI. */
export function applicationSigner(credentials: {
  appId: string;
  accessKey: string;
  secretKey: string;
}) {
  return async (request: Request) => {
    const timestamp = new Date().toISOString(),
      nonce = randomBytes(16).toString("hex"),
      url = new URL(request.url);
    const body = await request.clone().text(),
      hash = createHash("sha256").update(body).digest("hex");
    const signature = createHmac("sha256", credentials.secretKey)
      .update([request.method, url.pathname + url.search, timestamp, nonce, hash].join("\n"))
      .digest("hex");
    const headers = new Headers(request.headers);
    headers.set(
      "authorization",
      `Platform-HMAC ${credentials.appId}:${credentials.accessKey}:${signature}`,
    );
    headers.set("x-platform-date", timestamp);
    headers.set("x-platform-nonce", nonce);
    return new Request(request, { headers });
  };
}

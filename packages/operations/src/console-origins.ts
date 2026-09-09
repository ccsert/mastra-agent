import { networkInterfaces } from "node:os";

export function localConsoleOrigins(
  host: string,
  port: number,
  interfaces = networkInterfaces(),
): string[] {
  const addresses =
    host === "0.0.0.0"
      ? [
          "127.0.0.1",
          "localhost",
          ...Object.values(interfaces)
            .flatMap((entries) => entries ?? [])
            .filter((entry) => entry.family === "IPv4" && !entry.internal)
            .map((entry) => entry.address),
        ]
      : [host];
  return [...new Set(addresses.map((address) => `http://${address}:${port}`))];
}

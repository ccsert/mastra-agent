import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { test } from "node:test";
import { localConsoleOrigins } from "../scripts/console-origins.ts";

const ipv4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  family: "IPv4",
  internal,
  netmask: "255.255.255.0",
  mac: "00:00:00:00:00:00",
  cidr: `${address}/24`,
});

test("local console origins follow current interfaces without retaining old network addresses", () => {
  const interfaces = {
    lo0: [ipv4("127.0.0.1", true)],
    en0: [ipv4("192.168.50.31")],
  };
  assert.deepEqual(localConsoleOrigins("0.0.0.0", 5179, interfaces), [
    "http://127.0.0.1:5179",
    "http://localhost:5179",
    "http://192.168.50.31:5179",
  ]);
  interfaces.en0 = [ipv4("192.168.110.151")];
  assert.deepEqual(localConsoleOrigins("0.0.0.0", 5179, interfaces), [
    "http://127.0.0.1:5179",
    "http://localhost:5179",
    "http://192.168.110.151:5179",
  ]);
  interfaces.en0 = [];
  assert.deepEqual(localConsoleOrigins("0.0.0.0", 5179, interfaces), [
    "http://127.0.0.1:5179",
    "http://localhost:5179",
  ]);
});

test("a console bound to a specific host only authorizes that host and configured port", () => {
  const interfaces = { en0: [ipv4("192.168.110.151")] };
  assert.deepEqual(localConsoleOrigins("127.0.0.1", 5180, interfaces), ["http://127.0.0.1:5180"]);
  assert.deepEqual(localConsoleOrigins("192.168.50.31", 5179, interfaces), [
    "http://192.168.50.31:5179",
  ]);
});

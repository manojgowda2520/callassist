#!/usr/bin/env node
// Checks that a CallAssist MCP server is reachable and lists its tools.
// Usage: node check-server.mjs <server-url> [bearer-token]
// Example: node check-server.mjs http://localhost:8787/mcp
const [url, token] = process.argv.slice(2);
if (!url) {
  console.error("Usage: node check-server.mjs <server-url> [bearer-token]");
  process.exit(2);
}

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) };
const rpc = async (id, method, params) => {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const text = await res.text();
  if (res.status === 401) throw new Error("401 Unauthorized: get a token by linking the account (OAuth), then pass it as the second argument.");
  const line = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))?.slice(5);
  const body = JSON.parse(line ?? "{}");
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
};

try {
  const init = await rpc(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "callassist-skill-check", version: "1.0.0" } });
  console.log(`Connected to ${init.serverInfo?.title ?? init.serverInfo?.name} ${init.serverInfo?.version ?? ""} (protocol ${init.protocolVersion})`);
  const { tools } = await rpc(2, "tools/list", {});
  for (const t of tools) console.log(`  • ${t.name}${t._meta?.ui?.resourceUri ? "  [MCP App]" : ""}`);
  console.log(tools.length >= 10 ? "OK: CallAssist is ready." : "Warning: fewer tools than expected.");
} catch (err) {
  console.error(`Not reachable: ${err.message}`);
  process.exit(1);
}

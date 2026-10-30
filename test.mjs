// Smoke test: starts server.mjs, runs the MCP handshake and calls each tool once.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const model = process.argv[2] || "qwen3:4b";
const here = fileURLToPath(new URL(".", import.meta.url));
const srv = spawn(process.execPath, [here + "server.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let nextId = 1;

createInterface({ input: srv.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});

const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
console.log("initialize:", init.result.serverInfo, init.result.protocolVersion);
srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
console.log("tools:", (await rpc("tools/list")).result.tools.map((t) => t.name).join(", "));
console.log((await rpc("tools/call", { name: "list_local_models", arguments: {} })).result.content[0].text);
const ask = await rpc("tools/call", { name: "ask_local", arguments: { model, prompt: "Reply with exactly: local model OK" } });
console.log("ask_local:", ask.result.content[0].text);
const files = await rpc("tools/call", {
  name: "ask_local_files",
  arguments: { model, prompt: "In one sentence, what does this file do?", paths: [here + "server.mjs"] },
});
console.log("ask_local_files:", files.result.content[0].text);
srv.kill();

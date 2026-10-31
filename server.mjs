#!/usr/bin/env node
// Minimal MCP server (stdio, zero dependencies) that lets Claude Code delegate work
// to models running in a local Ollama instance.
// Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout. Logs go to stderr only.

import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";

const OLLAMA = (process.env.OLLAMA_HOST_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const DEFAULT_MODEL = process.env.LOCAL_LLM_MODEL || "qwen3:14b";
const TIMEOUT_MS = Number(process.env.LOCAL_LLM_TIMEOUT_MS || 600000);
const MAX_FILE_BYTES = Number(process.env.LOCAL_LLM_MAX_FILE_BYTES || 400000);
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const CPU_ONLY_DESC =
  "Run this model on the CPU and system RAM only, leaving the GPU to another model, so a small model (4B-8B) can " +
  "work in parallel with a big one at no cost to its speed. Slower than the GPU (~19 tok/s for a 4B). Use the same " +
  "setting every time for a given model: switching reloads it.";

const log = (...a) => process.stderr.write("[local-llm] " + a.join(" ") + "\n");

const TOOLS = [
  {
    name: "list_local_models",
    description: "List the models installed in the local Ollama instance, with size and whether they are loaded in memory.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ask_local",
    description:
      "Send a self-contained prompt to a local model and return its answer. The local model has NO context of this " +
      "conversation, so include everything it needs. Good for drafts, summaries, classification, bulk or private work, " +
      "and second opinions. Check its output before relying on it.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The full task for the local model." },
        model: { type: "string", description: `Ollama model name (default ${DEFAULT_MODEL}). Use list_local_models to see options.` },
        system: { type: "string", description: "Optional system prompt (role, output format)." },
        think: { type: "boolean", description: "Let reasoning models think before answering (slower). Default false." },
        cpu_only: { type: "boolean", description: CPU_ONLY_DESC },
        temperature: { type: "number", description: "Sampling temperature (default model setting)." },
        max_tokens: { type: "integer", description: "Maximum tokens to generate." },
        num_ctx: { type: "integer", description: "Context window in tokens (default 8192)." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_local_files",
    description:
      "Like ask_local, but the server reads the given local files and appends their contents to the prompt, so the " +
      "files never pass through Claude's context. Use for summarising, reviewing or extracting from large or private files.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to do with the files." },
        paths: { type: "array", items: { type: "string" }, description: "Absolute paths of the files to include." },
        model: { type: "string", description: `Ollama model name (default ${DEFAULT_MODEL}).` },
        system: { type: "string", description: "Optional system prompt." },
        think: { type: "boolean", description: "Let reasoning models think first (slower). Default false." },
        cpu_only: { type: "boolean", description: CPU_ONLY_DESC },
        max_tokens: { type: "integer", description: "Maximum tokens to generate." },
        num_ctx: { type: "integer", description: "Context window in tokens (default: sized to the files, at least 8192)." },
      },
      required: ["prompt", "paths"],
      additionalProperties: false,
    },
  },
];

async function ollama(path, body) {
  const res = await fetch(OLLAMA + path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Ollama ${path} returned ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function chat(args, prompt, defaultCtx) {
  const messages = [];
  if (args.system) messages.push({ role: "system", content: args.system });
  messages.push({ role: "user", content: prompt });
  const options = { num_ctx: args.num_ctx || defaultCtx };
  if (args.temperature !== undefined) options.temperature = args.temperature;
  if (args.max_tokens) options.num_predict = args.max_tokens;
  if (args.cpu_only) options.num_gpu = 0; // zero layers offloaded to the GPU
  const model = args.model || DEFAULT_MODEL;
  const started = Date.now();
  const r = await ollama("/api/chat", { model, messages, stream: false, think: !!args.think, options });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const tps = r.eval_count && r.eval_duration ? (r.eval_count / (r.eval_duration / 1e9)).toFixed(1) : "?";
  const footer = `\n\n[local model ${model}${args.cpu_only ? " (CPU)" : ""}:${r.prompt_eval_count ?? "?"} prompt tokens, ${r.eval_count ?? "?"} output tokens, ${tps} tok/s, ${secs}s]`;
  return stripThinking(r.message?.content || "") + footer;
}

// Some models (e.g. thinking-only builds) reason inline even with think:false.
// Only the answer after the last </think> is returned, to keep Claude's context small.
function stripThinking(text) {
  const end = text.lastIndexOf("</think>");
  return (end >= 0 ? text.slice(end + "</think>".length) : text).trim();
}

// A bigger context window costs VRAM: on a 12 GB card a 32k window pushes a 14B model
// partly onto the CPU and cuts its speed by ~4x. Size it to the input instead
// (~3.5 characters per token, plus room for the answer), in 8k steps.
function contextFor(prompt, maxTokens) {
  const needed = Math.ceil(prompt.length / 3.5) + (maxTokens || 4096);
  return Math.max(8192, Math.ceil(needed / 8192) * 8192);
}

// Where a loaded model lives, from /api/ps: "GPU", "CPU" or e.g. "47% GPU / 53% CPU".
function placement(m) {
  const gpu = m.size ? Math.round((100 * (m.size_vram || 0)) / m.size) : 0;
  return gpu >= 100 ? "GPU" : gpu <= 0 ? "CPU" : `${gpu}% GPU / ${100 - gpu}% CPU`;
}

async function readFiles(paths) {
  let total = 0;
  const parts = [];
  for (const p of paths) {
    const size = (await stat(p)).size;
    total += size;
    if (total > MAX_FILE_BYTES) throw new Error(`Files exceed ${MAX_FILE_BYTES} bytes in total (stopped at ${p}).`);
    parts.push(`===== FILE: ${p} =====\n${await readFile(p, "utf8")}`);
  }
  return parts.join("\n\n");
}

async function callTool(name, args = {}) {
  switch (name) {
    case "list_local_models": {
      const [tags, ps] = await Promise.all([ollama("/api/tags"), ollama("/api/ps")]);
      const loaded = new Map((ps.models || []).map((m) => [m.name, placement(m)]));
      const lines = (tags.models || []).map(
        (m) => `${m.name}  ${(m.size / 1e9).toFixed(1)} GB  ${m.details?.parameter_size || ""} ${m.details?.quantization_level || ""}${loaded.has(m.name) ? `  [loaded: ${loaded.get(m.name)}]` : ""}`
      );
      return `Default model: ${DEFAULT_MODEL}\n` + (lines.join("\n") || "No models installed.");
    }
    case "ask_local":
      return chat(args, args.prompt, 8192);
    case "ask_local_files": {
      const prompt = `${args.prompt}\n\n${await readFiles(args.paths || [])}`;
      return chat(args, prompt, contextFor(prompt, args.max_tokens));
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification
  try {
    let result;
    if (method === "initialize") {
      const asked = params?.protocolVersion;
      result = {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "local-llm", version: "0.1.0" },
      };
    } else if (method === "ping") {
      result = {};
    } else if (method === "tools/list") {
      result = { tools: TOOLS };
    } else if (method === "tools/call") {
      try {
        const text = await callTool(params?.name, params?.arguments);
        result = { content: [{ type: "text", text }] };
      } catch (e) {
        log("tool error:", e.message);
        result = { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    send({ jsonrpc: "2.0", id, result });
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  handle(msg);
});
log(`ready (Ollama ${OLLAMA}, default model ${DEFAULT_MODEL})`);

# local-llm-mcp

A small [MCP](https://modelcontextprotocol.io) server that lets **Claude Code delegate work to models running on your own machine** through [Ollama](https://ollama.com).

Claude stays the planner and reviewer; the local model does the cheap, bulk, private or offline work: drafts, summaries, classification, first-pass code review, second opinions. One file, plain Node, **no dependencies** (`npm install` is not needed).

```
Claude Code ──MCP (stdio)──> server.mjs ──HTTP──> Ollama (127.0.0.1:11434) ──> qwen3 / gpt-oss / ...
```

## Tools

| Tool | What it does |
|---|---|
| `list_local_models` | Installed models with size, parameter count, quantization, and which are loaded (on the GPU, the CPU, or split) |
| `ask_local` | Sends a self-contained prompt (optional system prompt) to a local model and returns the answer |
| `ask_local_files` | Same, but the **server reads the files itself** and appends them to the prompt, so their contents never pass through Claude's context. Good for large or private files |

Every answer ends with a footer like `[local model qwen3:4b: 2184 prompt tokens, 1819 output tokens, 118.7 tok/s, 18.2s]`.

Notes:
- The local model has **no context of the Claude conversation**: each call must contain everything it needs.
- Reasoning ("thinking") is off by default. Pass `think: true` for harder tasks. Inline reasoning (`...</think>`) is stripped, so only the answer comes back.
- Local models are much weaker than Claude. Treat their output as a draft and check it.

## A GPU model and a CPU model at the same time

Pass `cpu_only: true` to `ask_local` or `ask_local_files` to run that model entirely on the CPU and system RAM. A small model can then work in parallel with a big model on the GPU without slowing it down, because they use separate memory. Measured on an RTX 4070 Ti + i7-13700KF with 32 GB DDR5:

| | `qwen3:14b` (GPU) | `qwen3:4b` (`cpu_only`) |
|---|---|---|
| Each alone | 44.0 tok/s | 18.6 tok/s |
| Both at once | 43.7 tok/s | 19.4 tok/s |

Good CPU-side jobs: tagging or sorting lines, pulling fields out of text, quick checks, short summaries. Keep CPU models at 4B-8B, and don't pair a CPU model with one that is already split between GPU and RAM (like `qwen3-coder:30b`): they compete for RAM bandwidth. Use the same `cpu_only` setting every time for a given model, since switching reloads it. The gain needs Claude to issue both calls at once; the server handles requests concurrently.

## Requirements

- Windows, macOS or Linux
- [Ollama](https://ollama.com/download) running (it listens on `http://127.0.0.1:11434`)
- [Node.js](https://nodejs.org) 18 or newer (uses the built-in `fetch`)
- At least one model pulled, for example `ollama pull qwen3:14b`

## Install

1. Clone the repo:
   ```
   git clone https://github.com/blaster32blaster/local-llm-mcp.git
   ```
2. Register it with Claude Code for all projects (use the full path to `node` if `node` is not on Claude Code's PATH):
   ```
   claude mcp add --scope user local-llm -- node /path/to/local-llm-mcp/server.mjs
   ```
   On Windows, for example:
   ```
   claude mcp add --scope user local-llm -- "C:\Program Files\nodejs\node.exe" C:\Users\you\local-llm-mcp\server.mjs
   ```
3. Check it: `claude mcp list` should show `local-llm ... Connected`.
4. Restart Claude Code. The tools appear as `mcp__local-llm__ask_local` and so on.

To register it for one project only, run `claude mcp add` without `--scope user` inside that project.

## Usage

Ask Claude in plain words, for example:

- "Use the local model to summarise every file in `notes/` and then check its summaries."
- "Ask qwen3-coder for a first-pass review of `src/parser.ts`, then verify what it finds."
- "Have the local model classify these 200 log lines; you only look at the ones it flags."

To make Claude reach for it on its own, add a line to your `CLAUDE.md`, such as: *"For bulk summarising or first drafts, delegate to the `local-llm` tools and review the result."*

## Settings

Set these as environment variables, for example with `claude mcp add ... -e LOCAL_LLM_MODEL=qwen3:4b -- node ...`.

| Variable | Default | Meaning |
|---|---|---|
| `LOCAL_LLM_MODEL` | `qwen3:14b` | Model used when a call names none |
| `OLLAMA_HOST_URL` | `http://127.0.0.1:11434` | Ollama address |
| `LOCAL_LLM_TIMEOUT_MS` | `600000` | Per-request timeout (10 min) |
| `LOCAL_LLM_MAX_FILE_BYTES` | `400000` | Total size limit for `ask_local_files` |

Context windows default to 8192 tokens for `ask_local`; `ask_local_files` sizes the window to the files it sends (in 8k steps, at least 8192). Either can be overridden per call with `num_ctx`. Keep windows small on a 12 GB GPU: a 32k window pushed `qwen3:14b` partly onto the CPU and cut it from ~44 to ~15 tok/s (RTX 4070 Ti).

## Suggested models (12 GB GPU, 32 GB RAM)

| Role | Model | Download | Notes |
|---|---|---|---|
| General / default | `qwen3:14b` | ~9 GB | Fits fully on a 12 GB GPU at 8k context; ~44 tok/s on an RTX 4070 Ti |
| Coding | `qwen3-coder:30b` | ~19 GB | MoE; splits about half and half between GPU and RAM, still ~45 tok/s |
| Fast subagent | `qwen3:4b` | 2.5 GB | ~120-140 tok/s on an RTX 4070 Ti; always reasons before answering (the server strips it) |

## Test

Runs the MCP handshake and calls each tool once against a model you have pulled:

```
node test.mjs qwen3:4b
```

## Using the models without Claude

The same models work on their own: `ollama run qwen3:14b` in a terminal, the Ollama app, or [LM Studio](https://lmstudio.ai) for a desktop chat window (LM Studio keeps its own model downloads).

## How it works

`server.mjs` speaks MCP over stdio (newline-delimited JSON-RPC 2.0): it answers `initialize`, `ping`, `tools/list` and `tools/call`, and forwards tool calls to Ollama's `/api/chat`, `/api/tags` and `/api/ps`. Logs go to stderr so they never corrupt the protocol stream. It only talks to the Ollama address above; nothing leaves your machine.

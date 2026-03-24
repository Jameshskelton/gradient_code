# Gradient Code Functional Plan

## Goal

Build `Gradient Code`, a local-first coding assistant wrapper that uses DigitalOcean Gradient serverless inference as the model backend and provides Codex/Claude-style workflows through an open tool-execution layer instead of proprietary built-in tools.

The wrapper should let a user:

- chat from a terminal or desktop app
- let the model inspect a repo
- run shell commands
- read and edit files
- browse/search through app-managed tools
- iterate in an agent loop until the task is done

## Key Product Decision

Do not try to reproduce OpenAI's or Anthropic's private tool stack.

Instead, build a model-agnostic agent runtime with:

1. a standard tool registry
2. a secure local tool executor
3. a conversation orchestrator that loops model -> tool call -> tool result -> model
4. model adapters for Gradient-supported APIs and response formats

This is the durable part of the system. Models can change; the runtime stays yours.

## What The Official Docs Confirm

- DigitalOcean Gradient serverless inference exposes OpenAI-compatible endpoints at `https://inference.do-ai.run`, including `/v1/chat/completions` and `/v1/responses`.
- DigitalOcean recommends `/v1/responses` for newer integrations, including multi-step tool use in a single request and state preservation with `store: true`.
- DigitalOcean's model catalog currently states that all Anthropic and OpenAI models available on Gradient support tool/function calling.
- Ollama documents the same core agent pattern we want: pass tool schemas, collect `tool_calls`, execute them in the app, append tool results, and continue the loop until no more tool calls are returned.

Implication:

Gradient Code should treat tool calling as an application-layer protocol, not a provider-native capability beyond schema + structured output.

## Recommended Architecture

Use a TypeScript monorepo.

Why TypeScript:

- strong JSON-schema and API ergonomics
- easy PTY/process integration for terminal tools
- shared code across CLI, desktop, and backend packages
- good fit for Electron or Tauri frontends

### Packages

`packages/core`

- conversation state
- agent loop
- tool registry
- permission policy
- task/session model

`packages/provider-gradient`

- Gradient API client
- adapter for `/v1/responses`
- fallback adapter for `/v1/chat/completions`
- streaming parser
- model capability metadata

`packages/tools`

- file tools
- shell tools
- search/web tools
- git tools
- diagnostics/logging tools

`packages/cli`

- terminal UX
- interactive session management
- approval prompts for dangerous tools

`packages/desktop`

- richer app UI
- file tree, diff view, approvals, logs, streaming tokens

`packages/shared`

- tool schema definitions
- event types
- config types

## Core Runtime Design

### 1. Agent Loop

The runtime loop should be:

1. user sends request
2. runtime builds system prompt + tool schemas + conversation history
3. model returns text, tool calls, or both
4. runtime validates tool calls against JSON schema
5. runtime asks user approval if needed
6. runtime executes tool(s)
7. runtime appends tool results to conversation
8. runtime repeats until stop condition

### 2. Tool Contract

Every tool should expose:

- `name`
- `description`
- `input_schema`
- `requires_approval`
- `execute(input, context)`

Suggested tool result envelope:

```json
{
  "ok": true,
  "tool_name": "read_file",
  "content": "...",
  "metadata": {
    "path": "/repo/src/app.ts"
  }
}
```

Suggested error envelope:

```json
{
  "ok": false,
  "tool_name": "run_command",
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "Command requires approval"
  }
}
```

### 3. Tool Categories

Start with a minimal, high-value tool set.

Read-only tools:

- `list_files`
- `read_file`
- `search_text`
- `get_cwd`
- `git_status`

Edit tools:

- `apply_patch`
- `write_file`
- `create_file`

Execution tools:

- `run_command`
- `read_process_output`
- `send_process_input`

Research tools:

- `web_search`
- `fetch_url`

Optional later:

- `open_browser`
- `run_tests`
- `grep_symbols`
- `lsp_diagnostics`

### 4. Safety Model

This is the difference between a demo and a usable product.

Policy levels:

- `read`: allowed by default inside workspace
- `edit`: allowed in workspace, diff preview available
- `execute`: ask approval for commands outside allowlist
- `network`: ask approval unless explicitly enabled
- `destructive`: always ask approval

Hard rules:

- sandbox the workspace by default
- block `rm -rf`, git reset, and broad destructive operations without confirmation
- attach stdout/stderr and exit code to every execution result
- maintain a visible audit log

## Provider Strategy

### Default API Choice

Use Gradient `/v1/responses` as the primary path.

Reasons:

- DigitalOcean explicitly recommends it for new integrations
- better fit for multi-step tool workflows
- better forward compatibility with newer models

### Fallback Path

Keep `/v1/chat/completions` support for:

- models that behave better with chat-completions formatting
- migration/debugging
- provider quirks

### Capability Matrix

Do not assume every model behaves equally well with tools.

Maintain metadata such as:

- supports tool calling
- supports parallel tool calls
- supports reasoning
- supports streaming
- max context
- preferred endpoint
- known prompt quirks

Important note:

DigitalOcean's current docs explicitly guarantee tool/function calling for the OpenAI and Anthropic models they host. For other models, including any future Kimi or GLM deployments, treat tool support as capability-tested rather than assumed.

## UX Plan

### CLI Experience

Target command:

```bash
gradient-code --model anthropic-claude-4.5-sonnet
```

Expected CLI behaviors:

- stream assistant output live
- show tool call intents before execution
- request approval inline when needed
- show diffs before write operations when configured
- support session resume
- support non-interactive mode for automation later

Example:

```bash
gradient-code
gradient-code --model openai-gpt-5.4
gradient-code "fix the failing tests in this repo"
```

### Desktop Experience

Desktop app should expose:

- prompt pane
- repo/file browser
- terminal pane
- diff/patch review pane
- tool activity timeline
- model selector
- approvals drawer

The desktop app can come after CLI MVP, but both should share the same runtime.

## MVP Scope

Version `0.1` should support:

- one workspace
- one active session
- Gradient model selection via config
- `responses` API calls
- streaming text output
- basic tool loop
- file read/search
- patch-based editing
- shell command execution
- explicit approval prompts
- markdown/plain-text transcript export

Do not include in MVP:

- multi-user sync
- cloud-hosted execution
- browser automation
- advanced memory
- collaborative sessions

## Implementation Phases

## Phase 0: Technical Spike

Goal:
Prove that Gradient-hosted models can drive a local agent loop through standard tool calling.

Deliverables:

- tiny Gradient client
- one model prompt
- two tools: `read_file`, `run_command`
- loop until no tool calls remain
- transcript saved to disk

Success criteria:

- model can inspect a repo file
- model can request a command
- app executes tool and returns result
- model completes task coherently

## Phase 1: CLI MVP

Deliverables:

- monorepo setup
- config loader
- tool registry
- workspace sandbox rules
- streaming CLI UI
- approvals
- patch editing flow

Success criteria:

- user can ask for a code change
- model can inspect files, edit code, run tests
- all actions are visible and controllable

## Phase 2: Reliability Layer

Deliverables:

- retry/backoff
- tool schema validation
- timeout and cancellation
- command session persistence
- better model-specific prompting
- capability matrix

Success criteria:

- fewer malformed tool calls
- recover gracefully from tool failures
- stable long-running sessions

## Phase 3: Desktop App

Deliverables:

- Electron or Tauri shell
- shared backend runtime
- diff viewer
- approvals UI
- session history

Success criteria:

- same task can be completed from GUI without losing CLI parity

## Phase 4: Research + Power Features

Deliverables:

- web research tools
- git-aware planning
- model profiles
- reusable prompt presets
- optional memory/project notes

## Prompting Strategy

You will need a strong system prompt because the provider is not supplying a built-in coding-agent runtime.

The system prompt should teach the model:

- available tools
- when to inspect before editing
- how to ask for approval-sensitive actions
- how to summarize command output instead of dumping noise
- how to keep iterating until the task is complete
- how to recover from failed commands

It should also define house rules such as:

- prefer `rg` for search
- do not overwrite unrelated user changes
- do not use destructive git commands
- explain edits briefly after completion

## Recommended Initial Tech Choices

- Runtime: Node.js + TypeScript
- CLI: `commander` or `cac`, `ink` for richer TUI if desired
- Desktop: Electron for fastest path, Tauri if you want smaller footprint
- PTY: `node-pty`
- Validation: `zod`
- Diff/Patch: unified diff + internal `applyPatch` helper
- Storage: local JSONL or SQLite for session history
- HTTP client: `fetch` or `openai`-compatible SDK configured against Gradient base URL

## Biggest Risks

### 1. Model Variability

Some models produce cleaner tool calls than others. Build adapters and capability flags early.

### 2. Tool Call Drift

Models may hallucinate tool names or malformed args. Strict schema validation is required.

### 3. Security

A coding agent that can run shell commands is dangerous without approvals, path restrictions, and audit trails.

### 4. UX Trust

If the app edits files without making intent visible, users will not trust it. Show tool calls and diffs clearly.

## Concrete First Sprint

Build this in order:

1. bootstrap TypeScript monorepo
2. implement Gradient client for `/v1/responses`
3. define tool interface and registry
4. add `read_file`, `search_text`, `run_command`
5. implement simple agent loop
6. add CLI streaming output
7. add `apply_patch`
8. add approval gates
9. test against two Gradient-hosted models
10. record model behavior notes

## Acceptance Tests

The MVP is good enough when these pass:

- "Read this repo and summarize the architecture."
- "Find the failing test and fix it."
- "Search for `TODO` comments and propose cleanup."
- "Run the test suite and explain the first failure."
- "Edit one file and show me the diff before applying."
- "Refuse to run destructive command until approved."

## Near-Term Build Recommendation

Start with a CLI-first prototype, not the full desktop app.

That gives you:

- the fastest path to a working agent loop
- immediate proof that Gradient can replace the provider backend
- a reusable core runtime for the later GUI

If the CLI loop works well, the desktop app becomes mostly a presentation layer over the same engine.

## Sources

- DigitalOcean serverless inference docs: https://docs.digitalocean.com/products/gradient-ai-platform/how-to/use-serverless-inference/
- DigitalOcean model catalog: https://docs.digitalocean.com/products/gradient-ai-platform/details/models/
- Ollama tool calling docs: https://docs.ollama.com/capabilities/tool-calling

# Gradient Code

<p align="center">
  <img src="./logo.png" alt="Gradient Code logo" width="120" />
</p>

<p align="center">
  <img src="./DigitalOcean_logo.svg.png" alt="DigitalOcean logo" height="48" />
</p>

`Gradient Code` is a local-first coding assistant that lets you use DigitalOcean Gradient-hosted models through an application-owned tool runtime instead of a proprietary built-in tool stack.

It is designed to feel closer to a real coding agent than a plain chat wrapper:

- a terminal app you can launch with `gradient_code`
- an Electron desktop app with a conversational UI
- shared runtime logic across CLI and desktop
- repo inspection, code editing, review, planning, research, and command execution
- approval flows, diff previews, retries, timeouts, and resumable sessions

## What This App Does

Gradient Code sits between:

- a model hosted on DigitalOcean Gradient
- your local workspace
- a set of application-managed tools

That means the model does not depend on OpenAI-only built-in tools. Instead, the app:

1. sends the model a system prompt plus tool schemas
2. receives tool calls from the model
3. executes those tools locally
4. returns tool results to the model
5. repeats until the task is complete

This makes it possible to use models such as `kimi-k2.5`, `glm-5`, `minimax-m2.5`, Claude-family models, OpenAI-family models, and other Gradient-supported models through the same coding workflow.

## What You Can Use It For

- ask questions about a codebase
- review changes for bugs and missing tests
- make phased implementation plans
- inspect files and symbols
- edit code with patches or file writes
- run shell commands with approval
- use AST-aware JS/TS code intelligence tools
- do approval-gated web research
- resume previous sessions in the same workspace
- work from either the terminal or the desktop app

## Key Features

### Shared agent runtime

Both the CLI and desktop app use the same core runtime for:

- provider requests
- tool execution
- approvals
- retries and timeouts
- session persistence
- prompt presets

### Desktop app

The Electron app includes:

- workspace picker
- model selector
- session history
- inline activity summaries inside the conversation
- command log and debug console
- approval modal for sensitive actions
- collapsible run details
- resumable conversations
- session deletion from the UI

### CLI app

The terminal interface supports:

- single-prompt runs
- resumable sessions
- saved workspace defaults
- tool activity output
- prompt presets
- configurable timeouts and retries
- installation as a global `gradient_code` command

### Tool categories

The toolset is broader than simple file read/write:

- workspace orientation
  - `get_cwd`
  - `inspect_path`
  - `list_files`
  - `list_tree`
- file reading and search
  - `read_file`
  - `read_many_files`
  - `search_text`
- JS/TS code intelligence
  - `find_symbol`
  - `find_references`
  - `list_exports`
  - `list_imports`
  - `ast_edit`
- editing
  - `replace_in_file`
  - `write_file`
  - `create_file`
  - `apply_patch`
- git-aware review and planning
  - `git_status`
  - `git_changed_files`
  - `git_changed_file_summaries`
  - `git_diff`
  - `git_recent_commits`
  - `estimate_test_impact`
- web research
  - `web_search`
  - `fetch_url`
- shell and long-running commands
  - `run_command`
  - `start_command_session`
  - `read_process_output`
  - `send_process_input`
  - `close_command_session`

### Reliability and safety

Gradient Code includes:

- provider retry/backoff
- provider and tool timeouts
- tool schema validation
- model-aware endpoint fallback between `/v1/chat/completions` and `/v1/responses`
- workspace-scoped file writes
- diff previews before edits
- approval gating for sensitive actions
- command-session persistence
- blocking for a small set of destructive shell commands

## Architecture

### Monorepo layout

- `packages/shared`
  - shared types and contracts
- `packages/core`
  - agent loop, prompts, config, sessions, approvals
- `packages/provider-gradient`
  - DigitalOcean Gradient provider adapter
- `packages/tools`
  - local tools, git tools, web tools, command tools, code intelligence
- `packages/cli`
  - terminal entrypoint
- `packages/desktop`
  - Electron desktop shell
- `bin/gradient_code.js`
  - CLI launcher for the global `gradient_code` command

### Provider behavior

The provider layer is built to work with different model families:

- native `/v1/chat/completions` support
- native `/v1/responses` support
- model-specific endpoint preferences
- model alias normalization
- model capability profiles for streaming, tool prompting, and endpoint selection

## Requirements

- Node.js
- npm
- a DigitalOcean Gradient `MODEL_ACCESS_KEY`

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Then set:

- `MODEL_ACCESS_KEY`
- optionally `GRADIENT_BASE_URL`
- optionally `GRADIENT_MODEL`

Current example values are in [.env.example](./.env.example).

## Running The App

### Desktop app

Build the workspace and launch the Electron shell:

```bash
npm run build
npm run desktop
```

Inside the app you can:

- pick a workspace from Finder
- choose a model from the dropdown
- select a mode like `Ask`, `Review`, `Plan`, `Implement`, or `Research`
- chat with the repo
- approve or deny sensitive actions
- reopen saved sessions

### CLI in dev mode

Run the TypeScript CLI directly:

```bash
npm run dev -- "summarize this repository"
```

Example with a model and workspace:

```bash
npm run dev -- --model kimi-k2.5 --cwd /path/to/repo "tell me about this workspace"
```

### Built CLI

Build and run the packaged CLI entrypoint:

```bash
npm run build
npm start -- "review the current changes for bugs and missing tests"
```

### Install as `gradient_code`

If you want a standalone terminal command:

```bash
npm run build
npm link
```

Then use:

```bash
gradient_code "summarize this repository"
gradient_code --cwd /path/to/repo "tell me about this workspace"
gradient_code --preset review "review the current changes for bugs and missing tests"
gradient_code --preset plan "make a phased implementation plan for adding auth"
gradient_code --preset implement "fix the failing test and explain the change"
```

## CLI Usage

Base usage:

```bash
gradient_code [--model MODEL] [--cwd PATH] [--approve-all] [--no-store] [--no-preview-writes] [--session ID] [--resume-last] [--max-turns N] "your prompt"
```

Supported CLI options:

- `--model MODEL`
  - choose the model
- `--cwd PATH`
  - choose the workspace
- `--preset default|review|plan|implement|research`
  - set the task mode
- `--approve-all`
  - skip per-action approvals
- `--no-store`
  - disable app-level response storage for the run
- `--no-preview-writes`
  - disable diff previews in edit approvals
- `--max-turns N`
  - cap the agent loop
- `--session ID`
  - resume a specific saved session
- `--resume-last`
  - resume the most recent session in the workspace
- `--save-config`
  - save current settings into `gradient-code.config.json`
- `--print-config`
  - print resolved runtime config
- `--provider-timeout-ms N`
  - set provider timeout
- `--tool-timeout-ms N`
  - set tool timeout
- `--retry-count N`
  - set provider retry count

## Examples

### Explore a repo

```bash
gradient_code "tell me about this workspace"
```

### Do a review

```bash
gradient_code --preset review "review the current changes for bugs and missing tests"
```

### Make a plan

```bash
gradient_code --preset plan "make a phased implementation plan for multiplayer support"
```

### Implement a change

```bash
gradient_code --preset implement "add a logout button and wire up the handler"
```

### Run with more generous reliability settings

```bash
gradient_code --retry-count 3 --provider-timeout-ms 90000 --tool-timeout-ms 60000 "run the tests and fix the first failure"
```

### Save workspace defaults

```bash
gradient_code --model kimi-k2.5 --preset review --save-config "hello"
```

### Print resolved config

```bash
gradient_code --print-config
```

## Modes And Presets

The app supports five high-level modes:

- `Ask`
  - general repository exploration and explanation
- `Review`
  - bugs, regressions, risks, and missing tests
- `Plan`
  - phased implementation planning
- `Implement`
  - inspect, edit, and validate changes
- `Research`
  - external comparison and source gathering

These modes map to prompt presets in the shared runtime and are available in both CLI and desktop workflows.

## Sessions, Config, And Project Notes

### Session storage

Per-workspace session state is saved under:

```text
.gradient-code/sessions/
```

Conversation transcripts are also written under:

```text
.gradient-code/
```

### Workspace config

Workspace defaults are stored in:

```text
gradient-code.config.json
```

Config fields currently supported:

```json
{
  "model": "kimi-k2.5",
  "baseUrl": "https://inference.do-ai.run/v1",
  "storeResponses": true,
  "previewEdits": true,
  "approveAll": false,
  "maxTurns": 12,
  "providerTimeoutMs": 60000,
  "toolTimeoutMs": 45000,
  "retryCount": 2,
  "preset": "default",
  "includeProjectNotes": true,
  "projectNotesPath": ".gradient-code/project-notes.md"
}
```

### Optional project memory

If enabled, project notes are loaded from:

```text
.gradient-code/project-notes.md
```

You can use this file for durable context such as:

- architecture notes
- conventions
- known issues
- preferred commands
- project-specific constraints

## Approvals And Guardrails

Sensitive actions are approval-gated unless you explicitly allow them.

This includes actions such as:

- file edits
- shell commands
- long-running command sessions
- web research

Important guardrails:

- writes are scoped to the selected workspace
- edit tools can show diffs before approval
- destructive shell patterns are blocked by policy
- non-git folders are treated as informational, not as hard failures

## Development

Useful scripts:

```bash
npm run typecheck
npm run build
npm run dev -- "hello"
npm run desktop
```

## Notes

- the desktop app and CLI share the same backend runtime
- JS/TS codebases get the strongest code-intelligence support because AST-aware tools currently use the TypeScript compiler API
- some models are better suited to coding than others; the provider layer applies model-specific capability hints automatically
- web research tools are approval-gated and intended for cases where external information is actually needed

## Why This Exists

Gradient Code is an attempt to make a reusable, provider-flexible coding agent shell:

- not locked to one proprietary app runtime
- not dependent on one model vendor
- able to run the same agent loop from terminal or GUI
- able to own its own tool stack, approvals, and safety model

If you want a Codex-like or Claude Code-like workflow on top of DigitalOcean Gradient-hosted models, that is the core goal of this repo.

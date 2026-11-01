# Claude Vision

A native Apple Vision Pro client for Claude Code, backed by a server on a Mac.

- `protocol/` — WebSocket protocol, defined once as JSON Schema (`schema/protocol.v1.json`). TypeScript types are generated into `generated/protocol.ts`; Swift Codable types are hand-written in the visionOS app.
- `server/` — Node + TypeScript service using the Claude Agent SDK.
- `visionos/` — SwiftUI visionOS app (in progress).

Full setup instructions (Tailscale, tokens, launchd, Xcode signing) arrive with milestone 6.

## Server quick start

Requires Node 22.18 or newer, which runs TypeScript directly (there is no build step).

```bash
cd server
npm install
cp .env.example .env    # then set CV_AUTH_TOKEN (npm run token) and CV_PROJECTS_ROOT
npm start               # real Claude (CV_AGENT_BACKEND=sdk)
npm run dev             # fake echo backend, makes no API calls
```

Try it with the CLI client:

```bash
npm run client -- --cwd some-project "explain this repo"
npm run client -- --list
npm run client -- --session <id> --after-seq 0      # replay the transcript, then stay attached
```

When the agent wants to edit a file or run a command, the client prints the proposed diff or command and asks `Allow? [y/N]`. Pass `--yes` to approve everything (for scripted runs only), or `--auto-approve-edits` when creating a session to auto-approve edits inside its working directory. Commands still ask.

The fake backend (`npm run dev`) supports scripted tool calls for testing the permission flow without API calls:

```text
/write notes.txt hello world      # Write tool (asks for permission)
/edit notes.txt hello => goodbye  # Edit tool
/bash make test                   # Bash tool (never actually executed)
```

### Permissions

The server uses the Agent SDK's `default` permission mode and loads your normal Claude Code settings (`~/.claude/settings.json`, project `.claude/settings*.json`, and `CLAUDE.md`). Anything your settings already allow runs without a prompt, as do the read-only commands Claude Code allows by default (for example `cat` and `ls`). Everything else becomes a `permission.request` that waits for the client to approve or deny it. Auto-approve edits covers only Edit/Write targets whose real path is inside the session's working directory.

### Persistence

Sessions and full event transcripts are stored in SQLite at `$CV_DATA_DIR/sessions.db`. After a reconnect, clients send `session.subscribe { afterSeq }` to replay anything they missed. After a server restart, sessions show as `stopped` and resume the same Agent SDK conversation on the next message. Any permission request that was pending at shutdown is recorded as cancelled.

Checks:

```bash
npm test            # unit and integration tests (fake backend)
npm run typecheck
npm run gen:check   # make sure the generated protocol types match the schema
```

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

Checks:

```bash
npm test            # unit and integration tests (fake backend)
npm run typecheck
npm run gen:check   # make sure the generated protocol types match the schema
```

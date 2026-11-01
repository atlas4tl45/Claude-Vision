# Claude Vision for visionOS

SwiftUI app for Apple Vision Pro. It talks to the server in `../server` over the WebSocket protocol in `../protocol`.

- `ClaudeVision.xcodeproj` is the app target. Its `ClaudeVision/` folder is a synced folder, so new Swift files are picked up automatically.
- `ClaudeVisionKit/` is a local Swift package (Foundation only) with the protocol types, the transcript reducer, reconnect backoff, and the Markdown block splitter. The app links it.
- `Config/Info.plist` holds the scene manifest and App Transport Security exceptions for `ws://` over Tailscale.

Requires Xcode 26 or newer with the visionOS SDK.

## Run in the Simulator against a local server

1. Start the server on the same Mac with the fake backend. It makes no API calls and responds instantly:

   ```bash
   cd server
   cp .env.example .env    # set CV_AUTH_TOKEN (npm run token) and CV_PROJECTS_ROOT
   mkdir -p ~/Projects/demo
   npm run dev
   ```

   Use `npm start` instead to talk to real Claude.

2. Open `visionos/ClaudeVision.xcodeproj`, pick the **ClaudeVision** scheme and an **Apple Vision Pro** simulator, and press Run. The first time, Xcode resolves the local `ClaudeVisionKit` package.

3. In the app, Settings opens automatically. Enter:
   - Server address: `127.0.0.1:8787` (the Simulator shares the Mac's localhost)
   - Auth token: the `CV_AUTH_TOKEN` value from `server/.env`

4. Tap **+**, enter `demo` as the folder, and send a message. With the fake backend, try `/write notes.txt hello`, `/edit notes.txt hello => bye`, or `/bash make test` to see permission requests. Nothing is executed for `/bash`.

To test reconnecting, stop the server with Ctrl-C. The sidebar shows "Reconnecting" with a countdown. Start it again and the app reconnects and replays anything it missed.

## Unit tests for the core package

```bash
cd visionos/ClaudeVisionKit
swift test
```

These decode every frame in `protocol/fixtures/` (captured from the real server) and check that the Swift encoder produces exactly the client frames that the server's schema test validates. That catches protocol drift between Swift and TypeScript.

## On your device

Signing and Tailscale setup are covered in the top-level README (milestone 6). In short: set your Team and a unique bundle identifier on the ClaudeVision target (Signing & Capabilities), and point the app at your Mac's Tailscale address.

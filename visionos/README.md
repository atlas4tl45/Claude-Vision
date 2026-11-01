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

## On your device via TestFlight (no Mac needed)

`.github/workflows/testflight.yml` archives the app on GitHub's macOS runners, signs it with cloud-managed certificates, and uploads it to TestFlight. It runs on every push to `main` that touches `visionos/` or `protocol/`, and can also be started by hand from the Actions tab.

You set this up once:

1. A paid Apple Developer account. The team ID and bundle ID (`com.robertcasad.claudevision`) are in the Xcode project.
2. An App Store Connect app record for that bundle ID, with platform visionOS.
3. An App Store Connect API key with the Admin role, stored as GitHub repository secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`, and `ASC_KEY_P8` (the full `.p8` text).
4. In App Store Connect under TestFlight → Internal Testing, add yourself to a group. Then install the TestFlight app on the Vision Pro.

Build numbers come from the workflow run number, so every upload is newer than the last. Each run publishes a "diagnostics: TestFlight upload" check on its commit with the archive and upload output.

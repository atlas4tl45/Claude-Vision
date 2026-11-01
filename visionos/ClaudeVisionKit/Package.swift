// swift-tools-version: 6.0
// Platform-independent core of the Claude Vision app: protocol types, the
// transcript reducer, and reconnect backoff. Foundation only, so it can be
// unit-tested with `swift test` on a Mac without a simulator.

import PackageDescription

let package = Package(
    name: "ClaudeVisionKit",
    platforms: [.visionOS(.v2), .macOS(.v15), .iOS(.v18)],
    products: [
        .library(name: "ClaudeVisionKit", targets: ["ClaudeVisionKit"]),
    ],
    targets: [
        .target(name: "ClaudeVisionKit"),
        .testTarget(name: "ClaudeVisionKitTests", dependencies: ["ClaudeVisionKit"]),
    ]
)

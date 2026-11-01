import Testing
@testable import ClaudeVisionKit

@Suite("Message blocks")
struct MessageBlocksTests {
    @Test func proseOnly() {
        #expect(MessageBlocks.parse("Hello **there**") == [.prose("Hello **there**")])
    }

    @Test func proseCodeProse() {
        let text = "Run this:\n\n```bash\nnpm test\nnpm run build\n```\n\nThen check."
        #expect(MessageBlocks.parse(text) == [
            .prose("Run this:"),
            .code(language: "bash", code: "npm test\nnpm run build"),
            .prose("Then check."),
        ])
    }

    @Test func unterminatedFenceWhileStreaming() {
        #expect(MessageBlocks.parse("Here:\n```swift\nlet x = 1") == [
            .prose("Here:"),
            .code(language: "swift", code: "let x = 1"),
        ])
    }

    @Test func fenceWithoutLanguageAndTildes() {
        #expect(MessageBlocks.parse("~~~\nplain\n~~~") == [.code(language: nil, code: "plain")])
        #expect(MessageBlocks.parse("```\n```") == [.code(language: nil, code: "")])
    }

    @Test func backticksInsideCodeDoNotCloseADifferentFence() {
        #expect(MessageBlocks.parse("~~~\n```\n~~~") == [.code(language: nil, code: "```")])
    }
}

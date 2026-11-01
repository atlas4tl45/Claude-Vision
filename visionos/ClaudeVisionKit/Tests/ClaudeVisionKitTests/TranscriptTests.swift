import Foundation
import Testing
@testable import ClaudeVisionKit

func events(_ file: String) throws -> [SessionEvent] {
    try fixtureLines(file).compactMap {
        if case .event(let e) = try ServerMessage.decode($0) { return e }
        return nil
    }
}

@Suite("Transcript")
struct TranscriptTests {
    @Test func streamsDeltasThenFinalText() {
        var t = Transcript()
        t.apply(.userMessage(UserMessageEvent(sessionId: "S", seq: 1, ts: "t", text: "hi")))
        t.apply(.assistantTextDelta(AssistantTextEvent(sessionId: "S", seq: 2, ts: "t", messageId: "m1", blockIndex: 0, text: "Hel", parentToolUseId: nil)))
        t.apply(.assistantTextDelta(AssistantTextEvent(sessionId: "S", seq: 3, ts: "t", messageId: "m1", blockIndex: 0, text: "lo", parentToolUseId: nil)))
        #expect(t.items.count == 2)
        #expect(t.items[1].kind == .assistant(text: "Hello", isComplete: false, parentToolUseId: nil))
        t.apply(.assistantText(AssistantTextEvent(sessionId: "S", seq: 4, ts: "t", messageId: "m1", blockIndex: 0, text: "Hello!", parentToolUseId: nil)))
        #expect(t.items[1].kind == .assistant(text: "Hello!", isComplete: true, parentToolUseId: nil))
        #expect(t.lastSeq == 4)
    }

    @Test func duplicateAndOldEventsAreIgnored() {
        var t = Transcript()
        let delta = SessionEvent.assistantTextDelta(AssistantTextEvent(sessionId: "S", seq: 5, ts: "t", messageId: "m", blockIndex: 0, text: "x", parentToolUseId: nil))
        let first = t.apply(delta)
        let second = t.apply(delta)
        #expect(first)
        #expect(!second, "replayed after reconnect")
        #expect(t.items.count == 1)
        #expect(t.items[0].kind == .assistant(text: "x", isComplete: false, parentToolUseId: nil))
    }

    @Test func fakeBackendFixtureProducesExpectedItems() throws {
        let all = try events("server-frames.jsonl")
        let t = Transcript(events: all)

        let users = t.items.compactMap { if case .user(let text) = $0.kind { return text } else { return nil } }
        #expect(users == ["hello fixtures", "/write notes.txt alpha", "/bash rm -rf build"])

        let texts = t.items.compactMap { if case .assistant(let text, let done, _) = $0.kind { return done ? text : nil } else { return nil } }
        #expect(texts.first == "You said: hello fixtures")

        let tools = t.items.compactMap { if case .tool(let tool) = $0.kind { return tool } else { return nil } }
        #expect(tools.map(\.name) == ["Write", "Bash"])
        #expect(tools[0].status == .succeeded)
        #expect(tools[1].status == .denied)
        #expect(tools[1].result == "no thanks")

        #expect(t.pendingPermissions.isEmpty)
        #expect(t.fileEdits.map(\.path) == ["notes.txt"])
        #expect(t.fileEdits[0].created)
        #expect(tools[0].editDiff?.contains("+alpha") == true, "edit diff attaches to its tool card")
        #expect(!t.items.contains { if case .fileEdit = $0.kind { return true } else { return false } })
        #expect(t.commandRuns.map(\.command) == ["rm -rf build"])
        #expect(t.state == .stopped)
    }

    @Test func realSdkFixture() throws {
        let t = Transcript(events: try events("server-frames-real-sdk.jsonl"))
        let tools = t.items.compactMap { if case .tool(let tool) = $0.kind { return tool } else { return nil } }
        #expect(tools.map(\.name) == ["Write", "Bash"])
        #expect(tools.allSatisfy { $0.status == .succeeded })
        #expect(tools[0].input["file_path"]?.stringValue?.hasSuffix("notes.txt") == true)
        #expect(t.fileEdits.first?.diff.contains("+alpha") == true)
    }

    @Test func pendingPermissionMarksToolAndResolves() {
        var t = Transcript()
        t.apply(.toolCall(ToolCallEvent(sessionId: "S", seq: 1, ts: "t", toolUseId: "tu", name: "Bash", input: .object(["command": "make"]), parentToolUseId: nil)))
        t.apply(.permissionRequest(PermissionRequestEvent(sessionId: "S", seq: 2, ts: "t", requestId: "p", toolUseId: "tu", toolName: "Bash", kind: .command, input: .object(["command": "make"]), title: nil, description: nil, diff: nil)))
        #expect(t.pendingPermissions.map(\.requestId) == ["p"])
        #expect(t.commandRuns.first?.status == .awaitingPermission)
        t.apply(.permissionResolved(PermissionResolvedEvent(sessionId: "S", seq: 3, ts: "t", requestId: "p", decision: .allow, resolvedBy: .user)))
        #expect(t.pendingPermissions.isEmpty)
        #expect(t.commandRuns.first?.status == .running)
        t.apply(.toolResult(ToolResultEvent(sessionId: "S", seq: 4, ts: "t", toolUseId: "tu", name: "Bash", isError: false, content: "ok", truncated: nil, parentToolUseId: nil)))
        #expect(t.commandRuns.first?.status == .succeeded)
        #expect(t.commandRuns.first?.output == "ok")
    }
}

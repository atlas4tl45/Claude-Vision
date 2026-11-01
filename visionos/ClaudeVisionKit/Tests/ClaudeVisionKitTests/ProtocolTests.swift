import Foundation
import Testing
@testable import ClaudeVisionKit

/// protocol/fixtures at the repo root (shared with the Node tests).
let fixturesDir = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent() // ClaudeVisionKitTests
    .deletingLastPathComponent() // Tests
    .deletingLastPathComponent() // ClaudeVisionKit
    .deletingLastPathComponent() // visionos
    .deletingLastPathComponent() // repo root
    .appendingPathComponent("protocol/fixtures")

func fixtureLines(_ name: String) throws -> [Data] {
    let text = try String(contentsOf: fixturesDir.appendingPathComponent(name), encoding: .utf8)
    return text.split(separator: "\n").map { Data($0.utf8) }
}

@Suite("Protocol decoding")
struct ProtocolDecodingTests {
    @Test("every captured server frame decodes to a known message", arguments: ["server-frames.jsonl", "server-frames-real-sdk.jsonl"])
    func decodesFixtures(file: String) throws {
        let lines = try fixtureLines(file)
        #expect(lines.count > 10)
        for line in lines {
            let msg = try ServerMessage.decode(line)
            if case .unknown(let type) = msg {
                Issue.record("unknown message type \(type)")
            }
        }
    }

    @Test func welcomeAndEvents() throws {
        let welcome = try ServerMessage.decode(Data(#"{"v":1,"type":"welcome","protocolVersion":1,"serverVersion":"0.1.0","projectsRoot":"/Users/me/Projects"}"#.utf8))
        guard case .welcome(let w) = welcome else { Issue.record("not welcome"); return }
        #expect(w.projectsRoot == "/Users/me/Projects")

        let delta = try ServerMessage.decode(Data(#"{"v":1,"type":"assistant.text_delta","sessionId":"S","seq":3,"ts":"t","messageId":"m","blockIndex":0,"text":"Hi"}"#.utf8))
        guard case .event(.assistantTextDelta(let d)) = delta else { Issue.record("not delta"); return }
        #expect(d.text == "Hi" && d.seq == 3)
    }

    @Test func sessionErrorsBecomeEventsButRequestErrorsDoNot() throws {
        let sessionErr = try ServerMessage.decode(Data(#"{"v":1,"type":"error","sessionId":"S","seq":9,"ts":"t","code":"agent_error","message":"boom"}"#.utf8))
        guard case .event(.error(let e, "S", 9, _)) = sessionErr else { Issue.record("expected session error event"); return }
        #expect(e.message == "boom")

        let reqErr = try ServerMessage.decode(Data(#"{"v":1,"type":"error","reqId":"r1","code":"path_not_allowed","message":"nope"}"#.utf8))
        guard case .error(let r) = reqErr else { Issue.record("expected request error"); return }
        #expect(r.reqId == "r1" && r.code == "path_not_allowed")
        #expect(reqErr.reqId == "r1")
    }

    @Test func unknownTypesAndValuesAreTolerated() throws {
        let msg = try ServerMessage.decode(Data(#"{"v":1,"type":"from.the.future","x":1}"#.utf8))
        guard case .unknown(let type) = msg else { Issue.record("expected unknown"); return }
        #expect(type == "from.the.future")

        let status = try ServerMessage.decode(Data(#"{"v":1,"type":"session.status","sessionId":"S","seq":1,"ts":"t","state":"hibernating"}"#.utf8))
        guard case .event(.status(let s)) = status else { Issue.record("expected status"); return }
        #expect(s.state == .unknown)
    }
}

@Suite("Protocol encoding")
struct ProtocolEncodingTests {
    static let cases: [(String, ClientMessage, String)] = [
        ("hello", .hello(client: "ClaudeVision/0.1.0 visionOS"), "r1"),
        ("ping", .ping, "r2"),
        ("sessionCreate", .sessionCreate(cwd: "my-app", title: "My App", autoApproveEdits: false), "r3"),
        ("sessionCreateMinimal", .sessionCreate(cwd: "my-app"), "r4"),
        ("sessionList", .sessionList, "r5"),
        ("sessionSubscribe", .sessionSubscribe(sessionId: "S1", afterSeq: 42), "r6"),
        ("sessionSubscribeFromStart", .sessionSubscribe(sessionId: "S1"), "r7"),
        ("sessionUnsubscribe", .sessionUnsubscribe(sessionId: "S1"), "r8"),
        ("sessionSend", .sessionSend(sessionId: "S1", text: "Hello \"Claude\"\nsecond line ✨"), "r9"),
        ("sessionInterrupt", .sessionInterrupt(sessionId: "S1"), "r10"),
        ("sessionStop", .sessionStop(sessionId: "S1"), "r11"),
        ("setAutoApproveEdits", .setAutoApproveEdits(sessionId: "S1", enabled: true), "r12"),
        ("permissionAllow", .permissionRespond(sessionId: "S1", requestId: "P1", decision: .allow), "r13"),
        ("permissionDeny", .permissionRespond(sessionId: "S1", requestId: "P1", decision: .deny, message: "Not now"), "r14"),
        ("fsList", .fsList(sessionId: "S1", path: "src"), "r15"),
        ("fsRead", .fsRead(sessionId: "S1", path: "src/main.ts"), "r16"),
    ]

    @Test("encoder output matches protocol/fixtures/client-frames.json (validated by the server's schema test)")
    func matchesFixtures() throws {
        let data = try Data(contentsOf: fixturesDir.appendingPathComponent("client-frames.json"))
        let fixtures = try JSONDecoder().decode([String: JSONValue].self, from: data)
        #expect(Set(fixtures.keys) == Set(Self.cases.map { $0.0 }), "every fixture has a Swift case and vice versa")
        for (name, message, reqId) in Self.cases {
            let encoded = try JSONDecoder().decode(JSONValue.self, from: message.encoded(reqId: reqId))
            #expect(encoded == fixtures[name], "\(name)")
        }
    }
}

@Suite("Server address")
struct ServerAddressTests {
    @Test func normalizes() {
        #expect(ServerAddress.normalize("100.64.0.1")?.absoluteString == "ws://100.64.0.1:8787/v1/ws")
        #expect(ServerAddress.normalize(" 100.64.0.1:9000 ")?.absoluteString == "ws://100.64.0.1:9000/v1/ws")
        #expect(ServerAddress.normalize("ws://mini.tailnet.ts.net:8787/v1/ws")?.absoluteString == "ws://mini.tailnet.ts.net:8787/v1/ws")
        #expect(ServerAddress.normalize("https://mini.tailnet.ts.net")?.absoluteString == "wss://mini.tailnet.ts.net/v1/ws")
        #expect(ServerAddress.normalize("HTTP://100.64.0.1")?.absoluteString == "ws://100.64.0.1:8787/v1/ws")
        #expect(ServerAddress.normalize("fd7a:115c:a1e0::1")?.absoluteString == "ws://[fd7a:115c:a1e0::1]:8787/v1/ws")
        #expect(ServerAddress.normalize("[fd7a:115c:a1e0::1]:9000")?.absoluteString == "ws://[fd7a:115c:a1e0::1]:9000/v1/ws")
        #expect(ServerAddress.normalize("") == nil)
        #expect(ServerAddress.normalize("ftp://x") == nil)
    }
}

@Suite("Backoff")
struct BackoffTests {
    @Test func growsAndCaps() {
        var b = Backoff(base: 0.5, maximum: 30)
        let upper = (0..<10).map { _ in b.next(random: { $0.upperBound }) }
        #expect(upper == [0.5, 1, 2, 4, 8, 16, 30, 30, 30, 30])
        b.reset()
        let floor = b.next(random: { $0.lowerBound })
        #expect(floor == 0.25, "floor prevents spinning")
    }
}

import Foundation

// Hand-written Swift mirror of protocol/schema/protocol.v1.json.
// Keep in sync with the schema; protocol/fixtures/*.json(l) are decoded and
// encoded by ClaudeVisionKitTests to catch drift.

public let protocolVersion = 1

// MARK: - Enums (tolerant: unknown values decode to .unknown)

public enum SessionState: String, Sendable, Hashable, Codable, CaseIterable {
    case starting, idle, running
    case awaitingPermission = "awaiting_permission"
    case stopped, error
    case unknown

    public init(from decoder: Decoder) throws {
        self = SessionState(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

public enum PermissionDecision: String, Sendable, Hashable, Codable {
    case allow, deny
}

public enum PermissionKind: String, Sendable, Hashable, Codable {
    case edit, command, read, web, other

    public init(from decoder: Decoder) throws {
        self = PermissionKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
    }
}

public enum PermissionResolver: String, Sendable, Hashable, Codable {
    case user, auto, cancelled
    case unknown

    public init(from decoder: Decoder) throws {
        self = PermissionResolver(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

public enum FsEntryKind: String, Sendable, Hashable, Codable {
    case file, directory, symlink, other

    public init(from decoder: Decoder) throws {
        self = FsEntryKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
    }
}

// MARK: - Shared structures

public struct SessionInfo: Sendable, Hashable, Codable, Identifiable {
    public var id: String
    public var title: String
    public var cwd: String
    public var state: SessionState
    public var autoApproveEdits: Bool
    public var createdAt: String
    public var updatedAt: String
    public var lastSeq: Int

    public init(id: String, title: String, cwd: String, state: SessionState, autoApproveEdits: Bool, createdAt: String, updatedAt: String, lastSeq: Int) {
        self.id = id
        self.title = title
        self.cwd = cwd
        self.state = state
        self.autoApproveEdits = autoApproveEdits
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastSeq = lastSeq
    }
}

public struct FsEntry: Sendable, Hashable, Codable, Identifiable {
    public var name: String
    public var path: String
    public var kind: FsEntryKind
    public var size: Int?
    public var id: String { path }
}

// MARK: - Server -> client replies

public struct Welcome: Sendable, Codable {
    public var reqId: String?
    public var protocolVersion: Int
    public var serverVersion: String
    public var projectsRoot: String
}

public struct Ack: Sendable, Codable {
    public var reqId: String?
    public var sessionId: String?
}

public struct ServerError: Sendable, Codable, Error, Hashable {
    public var reqId: String?
    public var sessionId: String?
    public var seq: Int?
    public var ts: String?
    public var code: String
    public var message: String
}

public struct SessionCreated: Sendable, Codable {
    public var reqId: String?
    public var session: SessionInfo
}

public struct SessionListResult: Sendable, Codable {
    public var reqId: String?
    public var sessions: [SessionInfo]
}

public struct SessionSubscribed: Sendable, Codable {
    public var reqId: String?
    public var session: SessionInfo
    public var replayedThroughSeq: Int
}

public struct SessionUpdated: Sendable, Codable {
    public var session: SessionInfo
}

public struct FsListResult: Sendable, Codable {
    public var reqId: String?
    public var sessionId: String
    public var path: String
    public var entries: [FsEntry]
}

public struct FsReadResult: Sendable, Codable {
    public var reqId: String?
    public var sessionId: String
    public var path: String
    public var content: String
    public var truncated: Bool
    public var binary: Bool
}

// MARK: - Session events (sequenced, persisted, replayable)

public struct StatusEvent: Sendable, Codable, Hashable {
    public var sessionId: String
    public var seq: Int
    public var ts: String
    public var state: SessionState
    public var detail: String?
}

public struct UserMessageEvent: Sendable, Codable, Hashable {
    public var sessionId: String
    public var seq: Int
    public var ts: String
    public var text: String
}

public struct AssistantTextEvent: Sendable, Codable, Hashable {
    public var sessionId: String
    public var seq: Int
    public var ts: String
    public var messageId: String
    public var blockIndex: Int
    public var text: String
    public var parentToolUseId: String?
}

public struct ToolCallEvent: Sendable, Codable, Hashable {
    public var sessionId: String
    public var seq: Int
    public var ts: String
    public var toolUseId: String
    public var name: String
    public var input: JSONValue
    public var parentToolUseId: String?
}

public struct ToolResultEvent: Sendable, Codable, Hashable {
    public var sessionId: String
    public var seq: Int
    public var ts: String
    public var toolUseId: String
    public var name: String?
    public var isError: Bool
    public var content: String
    public var truncated: Bool?
    public var parentToolUseId: String?
}

public struct FileEditEvent: Sendable, Codable, Hashable {
    public var sessionId: String
    public var seq: Int
    public var ts: String
    public var toolUseId: String
    public var path: String
    public var diff: String
    public var created: Bool?
}

public struct PermissionRequestEvent: Sendable, Codable, Hashable {
    public var sessionId: String
    public var seq: Int
    public var ts: String
    public var requestId: String
    public var toolUseId: String
    public var toolName: String
    public var kind: PermissionKind
    public var input: JSONValue
    public var title: String?
    public var description: String?
    public var diff: String?
}

public struct PermissionResolvedEvent: Sendable, Codable, Hashable {
    public var sessionId: String
    public var seq: Int
    public var ts: String
    public var requestId: String
    public var decision: PermissionDecision
    public var resolvedBy: PermissionResolver
}

public struct TurnCompleteEvent: Sendable, Codable, Hashable {
    public var sessionId: String
    public var seq: Int
    public var ts: String
    public var subtype: String
    public var isError: Bool
    public var durationMs: Int?
    public var numTurns: Int?
    public var totalCostUsd: Double?
    public var resultText: String?
}

public enum SessionEvent: Sendable, Hashable {
    case status(StatusEvent)
    case userMessage(UserMessageEvent)
    case assistantTextDelta(AssistantTextEvent)
    case assistantText(AssistantTextEvent)
    case toolCall(ToolCallEvent)
    case toolResult(ToolResultEvent)
    case fileEdit(FileEditEvent)
    case permissionRequest(PermissionRequestEvent)
    case permissionResolved(PermissionResolvedEvent)
    case turnComplete(TurnCompleteEvent)
    /// A session-level error (an `error` frame carrying sessionId and seq).
    case error(ServerError, sessionId: String, seq: Int, ts: String)

    public var sessionId: String {
        switch self {
        case .status(let e): e.sessionId
        case .userMessage(let e): e.sessionId
        case .assistantTextDelta(let e), .assistantText(let e): e.sessionId
        case .toolCall(let e): e.sessionId
        case .toolResult(let e): e.sessionId
        case .fileEdit(let e): e.sessionId
        case .permissionRequest(let e): e.sessionId
        case .permissionResolved(let e): e.sessionId
        case .turnComplete(let e): e.sessionId
        case .error(_, let sessionId, _, _): sessionId
        }
    }

    public var seq: Int {
        switch self {
        case .status(let e): e.seq
        case .userMessage(let e): e.seq
        case .assistantTextDelta(let e), .assistantText(let e): e.seq
        case .toolCall(let e): e.seq
        case .toolResult(let e): e.seq
        case .fileEdit(let e): e.seq
        case .permissionRequest(let e): e.seq
        case .permissionResolved(let e): e.seq
        case .turnComplete(let e): e.seq
        case .error(_, _, let seq, _): seq
        }
    }

    public var ts: String {
        switch self {
        case .status(let e): e.ts
        case .userMessage(let e): e.ts
        case .assistantTextDelta(let e), .assistantText(let e): e.ts
        case .toolCall(let e): e.ts
        case .toolResult(let e): e.ts
        case .fileEdit(let e): e.ts
        case .permissionRequest(let e): e.ts
        case .permissionResolved(let e): e.ts
        case .turnComplete(let e): e.ts
        case .error(_, _, _, let ts): ts
        }
    }
}

// MARK: - ServerMessage

public enum ServerMessage: Sendable {
    case welcome(Welcome)
    case pong(reqId: String?)
    case ack(Ack)
    case error(ServerError)
    case sessionCreated(SessionCreated)
    case sessionListResult(SessionListResult)
    case sessionSubscribed(SessionSubscribed)
    case sessionUpdated(SessionUpdated)
    case fsListResult(FsListResult)
    case fsReadResult(FsReadResult)
    case event(SessionEvent)
    /// A message type this client doesn't know (newer server). Ignored.
    case unknown(type: String)

    /// The request id this message answers, if any.
    public var reqId: String? {
        switch self {
        case .welcome(let m): m.reqId
        case .pong(let reqId): reqId
        case .ack(let m): m.reqId
        case .error(let m): m.reqId
        case .sessionCreated(let m): m.reqId
        case .sessionListResult(let m): m.reqId
        case .sessionSubscribed(let m): m.reqId
        case .fsListResult(let m): m.reqId
        case .fsReadResult(let m): m.reqId
        case .sessionUpdated, .event, .unknown: nil
        }
    }

    private struct Probe: Decodable {
        let type: String
        let reqId: String?
    }

    public static func decode(_ data: Data) throws -> ServerMessage {
        let decoder = JSONDecoder()
        let probe = try decoder.decode(Probe.self, from: data)
        func d<T: Decodable>(_ type: T.Type) throws -> T { try decoder.decode(T.self, from: data) }
        switch probe.type {
        case "welcome": return .welcome(try d(Welcome.self))
        case "pong": return .pong(reqId: probe.reqId)
        case "ack": return .ack(try d(Ack.self))
        case "error":
            let e = try d(ServerError.self)
            if let sessionId = e.sessionId, let seq = e.seq {
                return .event(.error(e, sessionId: sessionId, seq: seq, ts: e.ts ?? ""))
            }
            return .error(e)
        case "session.created": return .sessionCreated(try d(SessionCreated.self))
        case "session.list.result": return .sessionListResult(try d(SessionListResult.self))
        case "session.subscribed": return .sessionSubscribed(try d(SessionSubscribed.self))
        case "session.updated": return .sessionUpdated(try d(SessionUpdated.self))
        case "fs.list.result": return .fsListResult(try d(FsListResult.self))
        case "fs.read.result": return .fsReadResult(try d(FsReadResult.self))
        case "session.status": return .event(.status(try d(StatusEvent.self)))
        case "user.message": return .event(.userMessage(try d(UserMessageEvent.self)))
        case "assistant.text_delta": return .event(.assistantTextDelta(try d(AssistantTextEvent.self)))
        case "assistant.text": return .event(.assistantText(try d(AssistantTextEvent.self)))
        case "tool.call": return .event(.toolCall(try d(ToolCallEvent.self)))
        case "tool.result": return .event(.toolResult(try d(ToolResultEvent.self)))
        case "file.edit": return .event(.fileEdit(try d(FileEditEvent.self)))
        case "permission.request": return .event(.permissionRequest(try d(PermissionRequestEvent.self)))
        case "permission.resolved": return .event(.permissionResolved(try d(PermissionResolvedEvent.self)))
        case "turn.complete": return .event(.turnComplete(try d(TurnCompleteEvent.self)))
        default: return .unknown(type: probe.type)
        }
    }
}

// MARK: - ClientMessage

public enum ClientMessage: Sendable, Hashable {
    case hello(client: String)
    case ping
    case sessionCreate(cwd: String, title: String? = nil, autoApproveEdits: Bool? = nil)
    case sessionList
    case sessionSubscribe(sessionId: String, afterSeq: Int? = nil)
    case sessionUnsubscribe(sessionId: String)
    case sessionSend(sessionId: String, text: String)
    case sessionInterrupt(sessionId: String)
    case sessionStop(sessionId: String)
    case setAutoApproveEdits(sessionId: String, enabled: Bool)
    case permissionRespond(sessionId: String, requestId: String, decision: PermissionDecision, message: String? = nil)
    case fsList(sessionId: String, path: String)
    case fsRead(sessionId: String, path: String)

    /// The frame as a JSON object. Optional fields are omitted, never sent as null.
    public func jsonObject(reqId: String?) -> [String: JSONValue] {
        var o: [String: JSONValue] = ["v": .int(protocolVersion)]
        if let reqId { o["reqId"] = .string(reqId) }
        func set(_ key: String, _ value: String?) { if let value { o[key] = .string(value) } }
        switch self {
        case .hello(let client):
            o["type"] = "hello"
            set("client", client)
        case .ping:
            o["type"] = "ping"
        case .sessionCreate(let cwd, let title, let autoApproveEdits):
            o["type"] = "session.create"
            set("cwd", cwd)
            set("title", title)
            if let autoApproveEdits { o["autoApproveEdits"] = .bool(autoApproveEdits) }
        case .sessionList:
            o["type"] = "session.list"
        case .sessionSubscribe(let sessionId, let afterSeq):
            o["type"] = "session.subscribe"
            set("sessionId", sessionId)
            if let afterSeq { o["afterSeq"] = .int(afterSeq) }
        case .sessionUnsubscribe(let sessionId):
            o["type"] = "session.unsubscribe"
            set("sessionId", sessionId)
        case .sessionSend(let sessionId, let text):
            o["type"] = "session.send"
            set("sessionId", sessionId)
            set("text", text)
        case .sessionInterrupt(let sessionId):
            o["type"] = "session.interrupt"
            set("sessionId", sessionId)
        case .sessionStop(let sessionId):
            o["type"] = "session.stop"
            set("sessionId", sessionId)
        case .setAutoApproveEdits(let sessionId, let enabled):
            o["type"] = "session.setAutoApproveEdits"
            set("sessionId", sessionId)
            o["enabled"] = .bool(enabled)
        case .permissionRespond(let sessionId, let requestId, let decision, let message):
            o["type"] = "permission.respond"
            set("sessionId", sessionId)
            set("requestId", requestId)
            set("decision", decision.rawValue)
            set("message", message)
        case .fsList(let sessionId, let path):
            o["type"] = "fs.list"
            set("sessionId", sessionId)
            set("path", path)
        case .fsRead(let sessionId, let path):
            o["type"] = "fs.read"
            set("sessionId", sessionId)
            set("path", path)
        }
        return o
    }

    public func encoded(reqId: String?) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(JSONValue.object(jsonObject(reqId: reqId)))
    }
}

extension JSONValue: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
}

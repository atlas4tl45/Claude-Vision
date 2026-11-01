import Foundation

/// Status of a tool call as shown on its card.
public enum ToolCallStatus: Sendable, Hashable {
    case running
    case awaitingPermission
    case denied
    case succeeded
    case failed
}

public struct ToolCallItem: Sendable, Hashable {
    public var toolUseId: String
    public var name: String
    public var input: JSONValue
    public var status: ToolCallStatus
    public var result: String?
    public var resultTruncated: Bool
    public var parentToolUseId: String?
}

public struct PermissionItem: Sendable, Hashable {
    public var requestId: String
    public var toolUseId: String
    public var toolName: String
    public var kind: PermissionKind
    public var input: JSONValue
    public var title: String?
    public var description: String?
    public var diff: String?
    public var decision: PermissionDecision?
    public var resolvedBy: PermissionResolver?

    public var isPending: Bool { decision == nil }
}

public struct FileEditItem: Sendable, Hashable {
    public var toolUseId: String
    public var path: String
    public var diff: String
    public var created: Bool
}

public struct TurnSummary: Sendable, Hashable {
    public var subtype: String
    public var isError: Bool
    public var durationMs: Int?
    public var totalCostUsd: Double?
}

public struct TranscriptItem: Sendable, Hashable, Identifiable {
    public enum Kind: Sendable, Hashable {
        case user(text: String)
        /// `isComplete` turns true when the authoritative full text arrives.
        case assistant(text: String, isComplete: Bool, parentToolUseId: String?)
        case tool(ToolCallItem)
        case permission(PermissionItem)
        case fileEdit(FileEditItem)
        case turnComplete(TurnSummary)
        case error(code: String, message: String)
    }

    public let id: String
    /// Seq of the event that created this item.
    public let seq: Int
    public let timestamp: String
    public var kind: Kind
}

/// A command run (Bash tool call) with its output, for the terminal window.
public struct CommandRun: Sendable, Hashable, Identifiable {
    public var id: String { toolUseId }
    public var toolUseId: String
    public var command: String
    public var description: String?
    public var status: ToolCallStatus
    public var output: String?
    public var timestamp: String
}

/// Folds a session's event stream into display items.
///
/// Pure and deterministic: replaying the same events always produces the same
/// transcript, and events with `seq <= lastSeq` are ignored, so overlapping
/// replays after a reconnect are harmless.
public struct Transcript: Sendable, Hashable {
    public private(set) var items: [TranscriptItem] = []
    public private(set) var lastSeq: Int = 0
    public private(set) var state: SessionState?

    private var textIndex: [String: Int] = [:]
    private var toolIndex: [String: Int] = [:]
    private var permissionIndex: [String: Int] = [:]

    public init() {}

    public init(events: [SessionEvent]) {
        for e in events { apply(e) }
    }

    /// Requests still waiting on the user, oldest first.
    public var pendingPermissions: [PermissionItem] {
        items.compactMap {
            if case .permission(let p) = $0.kind, p.isPending { return p }
            return nil
        }
    }

    /// File edits, oldest first.
    public var fileEdits: [FileEditItem] {
        items.compactMap {
            if case .fileEdit(let f) = $0.kind { return f }
            return nil
        }
    }

    /// Bash tool calls with their output, oldest first.
    public var commandRuns: [CommandRun] {
        items.compactMap { item in
            guard case .tool(let t) = item.kind, t.name == "Bash" else { return nil }
            return CommandRun(
                toolUseId: t.toolUseId,
                command: t.input["command"]?.stringValue ?? "",
                description: t.input["description"]?.stringValue,
                status: t.status,
                output: t.result,
                timestamp: item.timestamp
            )
        }
    }

    /// Apply one event. Returns false if it was a duplicate (already applied).
    @discardableResult
    public mutating func apply(_ event: SessionEvent) -> Bool {
        guard event.seq > lastSeq else { return false }
        lastSeq = event.seq
        let seq = event.seq
        let ts = event.ts

        switch event {
        case .status(let e):
            state = e.state

        case .userMessage(let e):
            append(id: "user-\(seq)", seq: seq, ts: ts, .user(text: e.text))

        case .assistantTextDelta(let e):
            let key = "\(e.messageId):\(e.blockIndex)"
            if let i = textIndex[key], case .assistant(let text, let done, let parent) = items[i].kind {
                if !done { items[i].kind = .assistant(text: text + e.text, isComplete: false, parentToolUseId: parent) }
            } else {
                textIndex[key] = items.count
                append(id: "text-\(key)", seq: seq, ts: ts, .assistant(text: e.text, isComplete: false, parentToolUseId: e.parentToolUseId))
            }

        case .assistantText(let e):
            let key = "\(e.messageId):\(e.blockIndex)"
            if let i = textIndex[key] {
                items[i].kind = .assistant(text: e.text, isComplete: true, parentToolUseId: e.parentToolUseId)
            } else {
                textIndex[key] = items.count
                append(id: "text-\(key)", seq: seq, ts: ts, .assistant(text: e.text, isComplete: true, parentToolUseId: e.parentToolUseId))
            }

        case .toolCall(let e):
            if toolIndex[e.toolUseId] == nil {
                toolIndex[e.toolUseId] = items.count
                append(id: "tool-\(e.toolUseId)", seq: seq, ts: ts, .tool(ToolCallItem(
                    toolUseId: e.toolUseId, name: e.name, input: e.input, status: .running,
                    result: nil, resultTruncated: false, parentToolUseId: e.parentToolUseId
                )))
            }

        case .toolResult(let e):
            if let i = toolIndex[e.toolUseId], case .tool(var t) = items[i].kind {
                if t.status != .denied { t.status = e.isError ? .failed : .succeeded }
                t.result = e.content
                t.resultTruncated = e.truncated ?? false
                items[i].kind = .tool(t)
            } else {
                // Result for a call we never saw (e.g. replay started mid-turn).
                toolIndex[e.toolUseId] = items.count
                append(id: "tool-\(e.toolUseId)", seq: seq, ts: ts, .tool(ToolCallItem(
                    toolUseId: e.toolUseId, name: e.name ?? "Tool", input: .object([:]),
                    status: e.isError ? .failed : .succeeded, result: e.content,
                    resultTruncated: e.truncated ?? false, parentToolUseId: e.parentToolUseId
                )))
            }

        case .fileEdit(let e):
            append(id: "edit-\(seq)", seq: seq, ts: ts, .fileEdit(FileEditItem(
                toolUseId: e.toolUseId, path: e.path, diff: e.diff, created: e.created ?? false
            )))

        case .permissionRequest(let e):
            permissionIndex[e.requestId] = items.count
            append(id: "perm-\(e.requestId)", seq: seq, ts: ts, .permission(PermissionItem(
                requestId: e.requestId, toolUseId: e.toolUseId, toolName: e.toolName, kind: e.kind,
                input: e.input, title: e.title, description: e.description, diff: e.diff,
                decision: nil, resolvedBy: nil
            )))
            updateTool(e.toolUseId) { if $0.status == .running { $0.status = .awaitingPermission } }

        case .permissionResolved(let e):
            if let i = permissionIndex[e.requestId], case .permission(var p) = items[i].kind {
                p.decision = e.decision
                p.resolvedBy = e.resolvedBy
                items[i].kind = .permission(p)
                updateTool(p.toolUseId) { t in
                    if t.status == .awaitingPermission { t.status = e.decision == .allow ? .running : .denied }
                }
            }

        case .turnComplete(let e):
            append(id: "turn-\(seq)", seq: seq, ts: ts, .turnComplete(TurnSummary(
                subtype: e.subtype, isError: e.isError, durationMs: e.durationMs, totalCostUsd: e.totalCostUsd
            )))
            // A finished turn can't still be waiting on approval: treat any
            // request the server never resolved as cancelled.
            for (_, i) in permissionIndex {
                if case .permission(var p) = items[i].kind, p.isPending {
                    p.decision = .deny
                    p.resolvedBy = .cancelled
                    items[i].kind = .permission(p)
                    updateTool(p.toolUseId) { if $0.status == .awaitingPermission { $0.status = .denied } }
                }
            }
            // Any tool still marked running when the turn ends didn't report back.
            for (id, i) in toolIndex {
                if case .tool(let t) = items[i].kind, t.status == .running {
                    updateTool(id) { $0.status = e.isError ? .failed : .succeeded }
                }
            }

        case .error(let err, _, _, _):
            append(id: "error-\(seq)", seq: seq, ts: ts, .error(code: err.code, message: err.message))
        }
        return true
    }

    private mutating func append(id: String, seq: Int, ts: String, _ kind: TranscriptItem.Kind) {
        items.append(TranscriptItem(id: id, seq: seq, timestamp: ts, kind: kind))
    }

    private mutating func updateTool(_ toolUseId: String, _ body: (inout ToolCallItem) -> Void) {
        guard let i = toolIndex[toolUseId], case .tool(var t) = items[i].kind else { return }
        body(&t)
        items[i].kind = .tool(t)
    }
}

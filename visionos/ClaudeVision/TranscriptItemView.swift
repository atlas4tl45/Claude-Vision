import ClaudeVisionKit
import SwiftUI

struct TranscriptItemView: View {
    let item: TranscriptItem
    let sessionId: String

    var body: some View {
        switch item.kind {
        case .user(let text):
            UserBubble(text: text)
        case .assistant(let text, let isComplete, let parent):
            AssistantMessageView(text: text, isComplete: isComplete, isSubagent: parent != nil)
        case .tool(let tool):
            ToolCallCard(tool: tool)
        case .permission(let permission):
            PermissionRecordRow(permission: permission)
        case .fileEdit(let edit):
            FileEditRow(edit: edit)
        case .turnComplete(let summary):
            TurnSummaryRow(summary: summary)
        case .error(let code, let message):
            Label("\(message) (\(code))", systemImage: "exclamationmark.triangle.fill")
                .font(.callout)
                .foregroundStyle(.red)
        }
    }
}

// MARK: - Messages

struct UserBubble: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 120)
            Text(text)
                .textSelection(.enabled)
                .padding(.horizontal, 20)
                .padding(.vertical, 14)
                .background(Color.accentColor.opacity(0.35), in: RoundedRectangle(cornerRadius: 22))
        }
        .accessibilityLabel("You: \(text)")
    }
}

struct AssistantMessageView: View {
    let text: String
    let isComplete: Bool
    let isSubagent: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if isSubagent {
                Label("Subagent", systemImage: "person.2")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(MessageBlocks.parse(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .prose(let prose):
                    Text(markdown(prose))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                case .code(let language, let code):
                    CodeBlockView(language: language, code: code)
                }
            }
        }
        .padding(.trailing, 80)
        .opacity(isSubagent ? 0.8 : 1)
    }

    private func markdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

struct CodeBlockView: View {
    let language: String?
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let language {
                Text(language)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            ScrollView(.horizontal) {
                Text(code)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.black.opacity(0.25), in: RoundedRectangle(cornerRadius: 16))
    }
}

// MARK: - Tool helpers

struct ToolStatusIcon: View {
    let status: ToolCallStatus

    var body: some View {
        Group {
            switch status {
            case .running: ProgressView().controlSize(.small)
            case .awaitingPermission: Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
            case .denied: Image(systemName: "nosign").foregroundStyle(.red)
            case .succeeded: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            case .failed: Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
            }
        }
        .frame(width: 22, height: 22)
    }
}

extension ToolCallItem {
    /// One-line description of the call: the command, file path, or pattern.
    var summary: String {
        for key in ["command", "file_path", "notebook_path", "pattern", "url", "query", "path", "description"] {
            if let value = input[key]?.stringValue, !value.isEmpty {
                return value.replacingOccurrences(of: "\n", with: " ")
            }
        }
        return ""
    }
}

struct FileEditRow: View {
    let edit: FileEditItem

    var body: some View {
        Label {
            Text("\(edit.created ? "Created" : "Edited") \(edit.path)")
                .font(.system(.callout, design: .monospaced))
        } icon: {
            Image(systemName: edit.created ? "doc.badge.plus" : "pencil")
        }
        .foregroundStyle(.secondary)
    }
}

struct TurnSummaryRow: View {
    let summary: TurnSummary

    var body: some View {
        HStack(spacing: 8) {
            Rectangle().frame(height: 1).foregroundStyle(.quaternary)
            Text(text)
                .font(.caption)
                .foregroundStyle(summary.isError ? Color.red : Color.secondary)
                .fixedSize()
            Rectangle().frame(height: 1).foregroundStyle(.quaternary)
        }
    }

    private var text: String {
        var parts: [String] = [summary.isError ? "Turn ended: \(summary.subtype)" : "Done"]
        if let ms = summary.durationMs { parts.append(String(format: "%.1fs", Double(ms) / 1000)) }
        if let cost = summary.totalCostUsd, cost > 0 { parts.append(String(format: "$%.4f", cost)) }
        return parts.joined(separator: " · ")
    }
}

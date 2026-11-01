import ClaudeVisionKit
import SwiftUI

/// Collapsible card for one tool call: header with status, expandable input and output.
struct ToolCallCard: View {
    let tool: ToolCallItem
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.snappy) { expanded.toggle() }
            } label: {
                header
            }
            .buttonStyle(.plain)
            .hoverEffect(.highlight)
            .accessibilityHint(expanded ? "Collapse details" : "Expand details")

            if expanded {
                VStack(alignment: .leading, spacing: 16) {
                    ToolInputView(tool: tool)
                    if let diff = tool.editDiff, !diff.isEmpty {
                        section("Change") { DiffView(diff: diff) }
                    }
                    if let result = tool.result, !(tool.editDiff != nil && !tool.isError) {
                        section(tool.isError ? "Error" : "Output") {
                            OutputText(text: result, isError: tool.isError, truncated: tool.resultTruncated)
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 20)
                .transition(.opacity)
            }
        }
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 20))
        .padding(.leading, tool.parentToolUseId == nil ? 0 : 32)
    }

    private var header: some View {
        HStack(spacing: 14) {
            ToolStatusIcon(status: tool.status)
            Image(systemName: tool.symbol)
                .foregroundStyle(.secondary)
                .frame(width: 24)
            Text(tool.name)
                .font(.callout.weight(.semibold))
            Text(tool.summary)
                .font(.system(.callout, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            if let diff = tool.editDiff {
                DiffStatsLabel(diff: diff)
            }
            Text(tool.status.label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
                .rotationEffect(.degrees(expanded ? 90 : 0))
        }
        .padding(.horizontal, 20)
        .frame(minHeight: 60)
        .contentShape(.rect)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            content()
        }
    }
}

/// Tool-specific rendering of a call's input.
struct ToolInputView: View {
    let tool: ToolCallItem

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch tool.name {
            case "Bash":
                if let description = tool.input["description"]?.stringValue {
                    Text(description).font(.callout).foregroundStyle(.secondary)
                }
                CodeText(text: "$ " + (tool.input["command"]?.stringValue ?? ""))
            case "Edit", "MultiEdit", "Write", "Read", "NotebookEdit":
                Label(tool.input["file_path"]?.stringValue ?? tool.input["notebook_path"]?.stringValue ?? "", systemImage: "doc")
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                if tool.name == "Write", tool.editDiff == nil, let content = tool.input["content"]?.stringValue {
                    CodeText(text: content, maxHeight: 240)
                }
            default:
                CodeText(text: tool.input.prettyPrinted, maxHeight: 240)
            }
        }
    }
}

/// Monospaced, selectable, scrollable text block.
struct CodeText: View {
    let text: String
    var maxHeight: CGFloat? = nil

    var body: some View {
        ScrollView([.vertical, .horizontal]) {
            Text(text)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: true)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: maxHeight)
        .fixedSize(horizontal: false, vertical: maxHeight == nil)
        .background(.black.opacity(0.25), in: RoundedRectangle(cornerRadius: 14))
    }
}

struct OutputText: View {
    let text: String
    let isError: Bool
    let truncated: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            CodeText(text: text.isEmpty ? "(no output)" : text, maxHeight: 320)
                .foregroundStyle(isError ? Color.red : Color.primary)
            if truncated {
                Text("Output was truncated by the server.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

extension ToolCallItem {
    var isError: Bool { status == .failed }

    var symbol: String {
        switch name {
        case "Bash", "BashOutput", "KillShell": "terminal"
        case "Edit", "MultiEdit", "NotebookEdit": "pencil"
        case "Write": "doc.badge.plus"
        case "Read": "doc.text"
        case "Glob", "Grep": "magnifyingglass"
        case "WebFetch", "WebSearch": "globe"
        case "Task", "Agent": "person.2"
        case "TodoWrite": "checklist"
        default: name.hasPrefix("mcp__") ? "puzzlepiece.extension" : "wrench.and.screwdriver"
        }
    }
}

extension ToolCallStatus {
    var label: String {
        switch self {
        case .running: "Running"
        case .awaitingPermission: "Needs approval"
        case .denied: "Denied"
        case .succeeded: "Done"
        case .failed: "Failed"
        }
    }
}

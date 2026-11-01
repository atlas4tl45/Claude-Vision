import ClaudeVisionKit
import SwiftUI

/// Prominent Approve/Deny card for a pending permission request.
struct PermissionCard: View {
    @Environment(AppModel.self) private var model
    let permission: PermissionItem
    let sessionId: String
    /// Extra requests waiting behind this one (shown as "+N more").
    var queued: Int = 0

    @State private var responding = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline, spacing: 14) {
                Image(systemName: permission.kind.symbol)
                    .font(.title2)
                    .foregroundStyle(.orange)
                    .frame(width: 32)
                VStack(alignment: .leading, spacing: 4) {
                    Text(permission.title ?? permission.defaultTitle)
                        .font(.title3.weight(.semibold))
                    if let description = permission.description, !description.isEmpty {
                        Text(description)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
                if queued > 0 {
                    Text("+\(queued) more")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(.orange.opacity(0.3), in: Capsule())
                }
            }

            PermissionDetail(permission: permission)

            HStack(spacing: 16) {
                Button(role: .destructive) {
                    respond(.deny)
                } label: {
                    Label("Deny", systemImage: "xmark")
                        .frame(minWidth: 140, minHeight: 60)
                }
                .buttonStyle(.bordered)

                if permission.kind == .edit {
                    Button {
                        respond(.allow, enableAutoApprove: true)
                    } label: {
                        Text("Approve all edits")
                            .frame(minHeight: 60)
                    }
                    .buttonStyle(.bordered)
                    .help("Approve this and auto-approve future edits inside this session's folder")
                }

                Spacer(minLength: 0)

                Button {
                    respond(.allow)
                } label: {
                    Label("Approve", systemImage: "checkmark")
                        .frame(minWidth: 160, minHeight: 60)
                }
                .buttonStyle(.borderedProminent)
                .tint(.orange)
            }
            .disabled(responding || !model.isConnected)
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 28))
        .glassBackgroundEffect(in: RoundedRectangle(cornerRadius: 28))
        .overlay {
            RoundedRectangle(cornerRadius: 28)
                .strokeBorder(.orange.opacity(0.6), lineWidth: 2)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Permission request: \(permission.title ?? permission.defaultTitle)")
    }

    private func respond(_ decision: PermissionDecision, enableAutoApprove: Bool = false) {
        guard !responding else { return }
        responding = true
        Task {
            if enableAutoApprove {
                // The server approves pending in-folder edits when the toggle turns on;
                // respond explicitly too in case this edit is outside the folder.
                await model.setAutoApproveEdits(true, for: sessionId)
            }
            if model.transcript(sessionId).pendingPermissions.contains(where: { $0.requestId == permission.requestId }) {
                await model.respond(to: permission, in: sessionId, decision: decision)
            }
            responding = false
        }
    }
}

/// What exactly is being approved: the command, the proposed diff, or the raw input.
struct PermissionDetail: View {
    let permission: PermissionItem

    var body: some View {
        switch permission.kind {
        case .command:
            CodeText(text: "$ " + (permission.input["command"]?.stringValue ?? permission.input.prettyPrinted), maxHeight: 200)
        case .edit:
            VStack(alignment: .leading, spacing: 8) {
                if let path = permission.input["file_path"]?.stringValue ?? permission.input["notebook_path"]?.stringValue {
                    HStack {
                        Label(path, systemImage: "doc")
                            .font(.system(.callout, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.head)
                        Spacer(minLength: 0)
                        if let diff = permission.diff { DiffStatsLabel(diff: diff) }
                    }
                }
                if let diff = permission.diff, !diff.isEmpty {
                    ScrollView {
                        DiffView(diff: diff)
                    }
                    .frame(maxHeight: 320)
                } else {
                    CodeText(text: permission.input.prettyPrinted, maxHeight: 200)
                }
            }
        case .web:
            Label(permission.input["url"]?.stringValue ?? permission.input["query"]?.stringValue ?? "", systemImage: "globe")
                .font(.system(.callout, design: .monospaced))
        default:
            CodeText(text: permission.input.prettyPrinted, maxHeight: 200)
        }
    }
}

/// In-transcript record of a permission request. Pending ones show a compact
/// pointer (the full card lives in the tray above the composer).
struct PermissionRecordRow: View {
    let permission: PermissionItem

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(color)
                .frame(width: 22)
            Text(permission.title ?? permission.defaultTitle)
                .font(.callout)
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(statusText)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
    }

    private var icon: String {
        switch permission.decision {
        case .none: "hand.raised.fill"
        case .allow: "checkmark.shield"
        case .deny: permission.resolvedBy == .cancelled ? "slash.circle" : "xmark.shield"
        }
    }

    private var color: Color {
        switch permission.decision {
        case .none: .orange
        case .allow: .green
        case .deny: permission.resolvedBy == .cancelled ? .gray : .red
        }
    }

    private var statusText: String {
        switch (permission.decision, permission.resolvedBy) {
        case (.none, _): "Waiting for you below"
        case (.allow, .auto): "Auto-approved"
        case (.allow, _): "Approved"
        case (.deny, .cancelled): "Cancelled"
        case (.deny, _): "Denied"
        }
    }
}

extension PermissionItem {
    var defaultTitle: String {
        switch kind {
        case .command: "Run a command?"
        case .edit: toolName == "Write" ? "Write a file?" : "Edit a file?"
        case .read: "Read files?"
        case .web: "Access the web?"
        case .other: "Use \(toolName)?"
        }
    }
}

extension PermissionKind {
    var symbol: String {
        switch self {
        case .command: "terminal"
        case .edit: "pencil.line"
        case .read: "doc.text.magnifyingglass"
        case .web: "globe"
        case .other: "hand.raised"
        }
    }
}

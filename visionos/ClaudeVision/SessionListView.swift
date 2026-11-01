import ClaudeVisionKit
import SwiftUI

struct SessionListView: View {
    @Environment(AppModel.self) private var model
    @Binding var showingNewSession: Bool

    var body: some View {
        @Bindable var model = model
        List(selection: $model.selectedSessionID) {
            ForEach(model.sessions) { session in
                SessionRow(session: session, pendingPermissions: model.transcript(session.id).pendingPermissions.count)
                    .contextMenu {
                        if session.state == .running || session.state == .awaitingPermission {
                            Button("Interrupt", systemImage: "pause.circle") {
                                Task { await model.interrupt(session.id) }
                            }
                        }
                        if session.state != .stopped {
                            Button("Stop Session", systemImage: "stop.circle", role: .destructive) {
                                Task { await model.stop(session.id) }
                            }
                        }
                    }
            }
        }
        .refreshable { await model.refreshSessions() }
        .overlay {
            if model.sessions.isEmpty && model.isConnected {
                ContentUnavailableView {
                    Label("No Sessions", systemImage: "tray")
                } actions: {
                    Button("New Session") { showingNewSession = true }
                }
            }
        }
    }
}

struct SessionRow: View {
    let session: SessionInfo
    let pendingPermissions: Int

    var body: some View {
        HStack(spacing: 14) {
            SessionStateIcon(state: session.state)
            VStack(alignment: .leading, spacing: 4) {
                Text(session.title)
                    .font(.headline)
                    .lineLimit(1)
                Text(session.cwd.abbreviatingHome)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            Spacer(minLength: 0)
            if pendingPermissions > 0 {
                Text("\(pendingPermissions)")
                    .font(.caption.weight(.bold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.orange, in: Capsule())
                    .accessibilityLabel("\(pendingPermissions) pending approvals")
            }
        }
        .frame(minHeight: 60)
        .contentShape(.rect)
    }
}

struct SessionStateIcon: View {
    let state: SessionState

    var body: some View {
        Group {
            switch state {
            case .running, .starting:
                ProgressView().controlSize(.small)
            case .awaitingPermission:
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
            case .idle:
                Image(systemName: "circle.fill").foregroundStyle(.green)
            case .error:
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
            case .stopped, .unknown:
                Image(systemName: "circle").foregroundStyle(.secondary)
            }
        }
        .frame(width: 24, height: 24)
        .accessibilityLabel(state.label)
    }
}

extension SessionState {
    var label: String {
        switch self {
        case .starting: "Starting"
        case .idle: "Idle"
        case .running: "Working"
        case .awaitingPermission: "Needs approval"
        case .stopped: "Stopped"
        case .error: "Error"
        case .unknown: "Unknown"
        }
    }
}

extension String {
    /// "/Users/me/Projects/app" -> "~/Projects/app" when it looks like a home path.
    var abbreviatingHome: String {
        let parts = split(separator: "/", omittingEmptySubsequences: true)
        if parts.count >= 2, parts[0] == "Users" {
            return "~/" + parts.dropFirst(2).joined(separator: "/")
        }
        return self
    }
}

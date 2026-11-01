import ClaudeVisionKit
import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var showingSettings = false
    @State private var showingNewSession = false

    var body: some View {
        NavigationSplitView {
            SessionListView(showingNewSession: $showingNewSession)
                .navigationTitle("Sessions")
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            showingSettings = true
                        } label: {
                            Label("Settings", systemImage: "gearshape")
                        }
                        .help("Connection settings")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            showingNewSession = true
                        } label: {
                            Label("New Session", systemImage: "plus")
                        }
                        .disabled(!model.isConnected)
                        .help("New session")
                    }
                }
                .safeAreaInset(edge: .bottom) {
                    ConnectionStatusView(showingSettings: $showingSettings)
                        .padding()
                }
        } detail: {
            if let id = model.selectedSessionID, let session = model.session(id) {
                ChatView(session: session)
                    .id(id)
            } else {
                EmptyDetailView(showingSettings: $showingSettings, showingNewSession: $showingNewSession)
            }
        }
        .sheet(isPresented: $showingSettings) {
            SettingsView()
        }
        .sheet(isPresented: $showingNewSession) {
            NewSessionSheet()
        }
        .onAppear {
            if case .notConfigured = model.status {
                showingSettings = true
            } else {
                model.start()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.start() }
        }
    }
}

struct EmptyDetailView: View {
    @Environment(AppModel.self) private var model
    @Binding var showingSettings: Bool
    @Binding var showingNewSession: Bool

    var body: some View {
        switch model.status {
        case .notConfigured:
            ContentUnavailableView {
                Label("Connect to your Mac", systemImage: "desktopcomputer")
            } description: {
                Text("Enter your Claude Vision server's address and token to get started.")
            } actions: {
                Button("Open Settings") { showingSettings = true }
                    .buttonStyle(.borderedProminent)
            }
        case .connected:
            ContentUnavailableView {
                Label("No Session Selected", systemImage: "bubble.left.and.text.bubble.right")
            } description: {
                Text("Pick a session from the sidebar, or start a new one in a project folder.")
            } actions: {
                Button("New Session") { showingNewSession = true }
                    .buttonStyle(.borderedProminent)
            }
        default:
            ContentUnavailableView {
                Label(model.status.label, systemImage: "wifi.exclamationmark")
            } description: {
                Text(model.lastError ?? "Waiting for the server.")
            } actions: {
                Button("Retry Now") { model.reconnectNow() }
                    .buttonStyle(.borderedProminent)
            }
        }
    }
}

/// Compact connection indicator at the bottom of the sidebar.
struct ConnectionStatusView: View {
    @Environment(AppModel.self) private var model
    @Binding var showingSettings: Bool

    private var color: Color {
        switch model.status {
        case .connected: .green
        case .connecting, .reconnecting: .orange
        case .unauthorized: .red
        case .disconnected, .notConfigured: .secondary
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(color)
                .frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.status.label)
                    .font(.callout.weight(.medium))
                if case .reconnecting(_, let at) = model.status {
                    Text("Next try \(at, style: .relative)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if let error = model.lastError, !model.isConnected {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
            switch model.status {
            case .reconnecting, .disconnected:
                Button("Retry") { model.reconnectNow() }
                    .frame(minHeight: 44)
            case .unauthorized, .notConfigured:
                Button("Settings") { showingSettings = true }
                    .frame(minHeight: 44)
            default:
                EmptyView()
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(minHeight: 60)
        .glassBackgroundEffect(in: RoundedRectangle(cornerRadius: 20))
        .accessibilityElement(children: .combine)
    }
}

import ClaudeVisionKit
import SwiftUI

struct ChatView: View {
    @Environment(AppModel.self) private var model
    let session: SessionInfo

    private var transcript: Transcript { model.transcript(session.id) }

    private var isWorking: Bool {
        session.state == .running || session.state == .starting || session.state == .awaitingPermission
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(transcript.items) { item in
                        TranscriptItemView(item: item, sessionId: session.id)
                    }
                    if session.state == .running || session.state == .starting {
                        WorkingIndicator()
                    }
                }
                .padding(.horizontal, 32)
                .padding(.vertical, 24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .defaultScrollAnchor(.bottom)
            .overlay {
                if transcript.items.isEmpty && session.lastSeq == 0 {
                    ContentUnavailableView {
                        Label("New Session", systemImage: "sparkles")
                    } description: {
                        Text("Claude is ready to work in \(session.cwd.abbreviatingHome).")
                    }
                }
            }

            ComposerView(sessionId: session.id)
                .padding(.horizontal, 24)
                .padding(.vertical, 16)
        }
        .navigationTitle(session.title)
        .toolbar {
            ToolbarItemGroup(placement: .bottomOrnament) {
                Toggle(isOn: Binding(
                    get: { session.autoApproveEdits },
                    set: { enabled in Task { await model.setAutoApproveEdits(enabled, for: session.id) } }
                )) {
                    Label("Auto-approve edits", systemImage: "pencil.and.list.clipboard")
                }
                .toggleStyle(.button)
                .help("Apply file edits inside this folder without asking. Commands always ask.")

                Button {
                    Task { await model.interrupt(session.id) }
                } label: {
                    Label("Interrupt", systemImage: "pause.fill")
                }
                .disabled(!isWorking || !model.isConnected)
                .help("Stop the current turn")

                Button(role: .destructive) {
                    Task { await model.stop(session.id) }
                } label: {
                    Label("Stop Session", systemImage: "stop.fill")
                }
                .disabled(session.state == .stopped || !model.isConnected)
                .help("End the agent process (it resumes on your next message)")
            }
        }
    }
}

struct WorkingIndicator: View {
    var body: some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text("Claude is working…")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

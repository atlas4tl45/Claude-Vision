import ClaudeVisionKit
import SwiftUI

/// Message input. Dictation is available from the system keyboard's
/// microphone; with a hardware keyboard, Return inserts a newline and
/// Command-Return sends.
struct ComposerView: View {
    @Environment(AppModel.self) private var model
    let sessionId: String

    @FocusState private var focused: Bool
    @State private var sending = false
    @State private var error: String?

    private var draft: Binding<String> {
        Binding(
            get: { model.drafts[sessionId] ?? "" },
            set: { model.drafts[sessionId] = $0 }
        )
    }

    private var canSend: Bool {
        model.isConnected && !sending && !draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            HStack(alignment: .bottom, spacing: 14) {
                TextField("Message Claude…", text: draft, axis: .vertical)
                    .lineLimit(1...8)
                    .textFieldStyle(.plain)
                    .focused($focused)
                    .padding(.horizontal, 22)
                    .padding(.vertical, 18)
                    .frame(minHeight: 60)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 30))
                    .accessibilityLabel("Message")

                Button(action: send) {
                    Image(systemName: sending ? "ellipsis" : "arrow.up")
                        .font(.title2.weight(.semibold))
                        .frame(width: 60, height: 60)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.circle)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!canSend)
                .help("Send (⌘↩)")
                .accessibilityLabel("Send")
            }
        }
        .onAppear { focused = true }
    }

    private func send() {
        let text = draft.wrappedValue
        guard canSend else { return }
        sending = true
        error = nil
        Task {
            do {
                try await model.send(text, to: sessionId)
                model.drafts[sessionId] = ""
            } catch {
                self.error = error.localizedDescription
            }
            sending = false
        }
    }
}

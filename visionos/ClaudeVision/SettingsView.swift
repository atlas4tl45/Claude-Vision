import ClaudeVisionKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var address = ""
    @State private var token = ""
    @State private var error: String?
    @State private var confirmingForget = false

    private var normalizedURL: String? {
        ServerAddress.normalize(address)?.absoluteString
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("100.101.102.103:8787", text: $address)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Server address")
                } footer: {
                    if let normalizedURL {
                        Text("Connects to \(normalizedURL)")
                    } else {
                        Text("Your Mac's Tailscale IP or MagicDNS name, plus the port (default 8787).")
                    }
                }

                Section {
                    SecureField(model.hasToken ? "Saved. Leave empty to keep it." : "Paste the token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Auth token")
                } footer: {
                    Text("The CV_AUTH_TOKEN value from the server's .env. Stored in the Keychain on this device only.")
                }

                Section {
                    LabeledContent("Status", value: model.status.label)
                    if case .connected(let version) = model.status {
                        LabeledContent("Server version", value: version)
                        if let root = model.projectsRoot {
                            LabeledContent("Projects root", value: root)
                        }
                    }
                    if let lastError = model.lastError, !model.isConnected {
                        Text(lastError)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }

                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    if model.isConnected {
                        Button("Disconnect", role: .destructive) { model.disconnect() }
                    }
                    if model.hasToken {
                        Button("Forget Token", role: .destructive) { confirmingForget = true }
                    }
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save & Connect", action: save)
                        .disabled(normalizedURL == nil || (!model.hasToken && token.isEmpty))
                }
            }
            .confirmationDialog("Forget the saved token?", isPresented: $confirmingForget) {
                Button("Forget Token", role: .destructive) { model.forgetToken() }
            }
        }
        .frame(minWidth: 640, minHeight: 640)
        .onAppear { address = model.serverAddress }
    }

    private func save() {
        do {
            try model.saveSettings(address: address, token: token)
            token = ""
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

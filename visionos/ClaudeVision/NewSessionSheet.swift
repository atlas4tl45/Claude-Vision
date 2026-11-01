import ClaudeVisionKit
import SwiftUI

struct NewSessionSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var folder = ""
    @State private var title = ""
    @State private var autoApproveEdits = false
    @State private var creating = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("my-app", text: $folder)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit(create)
                } header: {
                    Text("Project folder")
                } footer: {
                    Text("A folder inside \(model.projectsRoot?.abbreviatingHome ?? "the server's projects root"). Use a relative path like my-app or clients/site.")
                }

                Section {
                    TextField("Defaults to the folder name", text: $title)
                } header: {
                    Text("Title")
                }

                Section {
                    Toggle("Auto-approve file edits", isOn: $autoApproveEdits)
                } footer: {
                    Text("Edits to files inside this folder are applied without asking. Commands and anything outside the folder still ask. You can change this later.")
                }

                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("New Session")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if creating {
                        ProgressView()
                    } else {
                        Button("Create", action: create)
                            .disabled(folder.trimmingCharacters(in: .whitespaces).isEmpty || !model.isConnected)
                    }
                }
            }
        }
        .frame(minWidth: 600, minHeight: 560)
    }

    private func create() {
        let path = folder.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty, !creating else { return }
        creating = true
        error = nil
        Task {
            do {
                let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
                _ = try await model.createSession(cwd: path, title: trimmedTitle.isEmpty ? nil : trimmedTitle, autoApproveEdits: autoApproveEdits)
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            creating = false
        }
    }
}

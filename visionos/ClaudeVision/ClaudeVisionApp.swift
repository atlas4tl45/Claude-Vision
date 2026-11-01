import SwiftUI

@main
struct ClaudeVisionApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup(id: WindowID.main) {
            ContentView()
                .environment(model)
        }
        .defaultSize(width: 1280, height: 820)
    }
}

enum WindowID {
    static let main = "main"
}

import ClaudeVisionKit
import Foundation
import OSLog

let log = Logger(subsystem: "ClaudeVision", category: "app")

/// One WebSocket connection to the server. Reconnect policy lives in AppModel;
/// this type just opens, receives, sends, and reports closure.
@MainActor
final class WebSocketConnection {
    enum Event {
        case message(ServerMessage)
        /// The socket closed or failed. `httpStatus` is set when the handshake was rejected (e.g. 401).
        case closed(error: Error?, httpStatus: Int?)
    }

    var onEvent: ((Event) -> Void)?

    private let session: URLSession
    private var task: URLSessionWebSocketTask?
    private var receiveLoop: Task<Void, Never>?
    /// Bumped on every open/close so callbacks from an old socket are ignored.
    private var generation = 0

    init() {
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = false
        // For WebSocket tasks this acts as an idle timeout, so keep it well
        // above the 20s app heartbeat. Connect hangs are caught by AppModel's
        // handshake timeout.
        config.timeoutIntervalForRequest = 90
        session = URLSession(configuration: config)
    }

    var isOpen: Bool { task != nil }

    func open(url: URL, token: String) {
        close()
        generation += 1
        let gen = generation

        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 90
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = 16 * 1024 * 1024
        self.task = task
        task.resume()

        receiveLoop = Task { [weak self] in
            while !Task.isCancelled {
                let message: URLSessionWebSocketTask.Message
                do {
                    message = try await task.receive()
                } catch {
                    guard let self, self.generation == gen else { return }
                    let status = (task.response as? HTTPURLResponse)?.statusCode
                    self.task = nil
                    self.onEvent?(.closed(error: error, httpStatus: status))
                    return
                }
                guard let self, self.generation == gen else { return }
                let data: Data
                switch message {
                case .string(let text): data = Data(text.utf8)
                case .data(let bytes): data = bytes
                @unknown default: continue
                }
                do {
                    self.onEvent?(.message(try ServerMessage.decode(data)))
                } catch {
                    log.error("Undecodable frame: \(error.localizedDescription, privacy: .public)")
                }
            }
        }
    }

    func send(_ data: Data) async throws {
        guard let task else { throw AppError.notConnected }
        try await task.send(.string(String(decoding: data, as: UTF8.self)))
    }

    func close() {
        generation += 1
        receiveLoop?.cancel()
        receiveLoop = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }
}

nonisolated enum AppError: LocalizedError {
    case notConnected
    case timeout
    case unexpectedReply
    case server(ServerError)

    var errorDescription: String? {
        switch self {
        case .notConnected: "Not connected to the server."
        case .timeout: "The server didn't respond in time."
        case .unexpectedReply: "The server sent an unexpected reply."
        case .server(let e): e.message
        }
    }
}

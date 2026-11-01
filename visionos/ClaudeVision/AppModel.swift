import ClaudeVisionKit
import Foundation
import Observation

enum ConnectionStatus: Equatable {
    /// No server address or token saved yet.
    case notConfigured
    case disconnected
    case connecting
    case connected(serverVersion: String)
    case reconnecting(attempt: Int, at: Date)
    /// The server rejected the token (HTTP 401). No automatic retry.
    case unauthorized

    var label: String {
        switch self {
        case .notConfigured: "Not configured"
        case .disconnected: "Disconnected"
        case .connecting: "Connecting…"
        case .connected: "Connected"
        case .reconnecting(let attempt, _): "Reconnecting (attempt \(attempt))…"
        case .unauthorized: "Token rejected"
        }
    }
}

@MainActor
@Observable
final class AppModel {
    // MARK: Settings

    static let addressKey = "serverAddress"
    static let tokenAccount = "authToken"

    private(set) var serverAddress: String = UserDefaults.standard.string(forKey: AppModel.addressKey) ?? ""
    private(set) var hasToken: Bool = Keychain.read(account: AppModel.tokenAccount) != nil

    // MARK: Connection state

    private(set) var status: ConnectionStatus = .disconnected
    private(set) var projectsRoot: String?
    private(set) var lastError: String?

    var isConnected: Bool {
        if case .connected = status { return true }
        return false
    }

    // MARK: Sessions

    private(set) var sessions: [SessionInfo] = []
    private(set) var transcripts: [String: Transcript] = [:]
    var drafts: [String: String] = [:]

    var selectedSessionID: String? {
        didSet {
            if let id = selectedSessionID { ensureSubscribed(id) }
        }
    }

    func session(_ id: String) -> SessionInfo? {
        sessions.first { $0.id == id }
    }

    func transcript(_ id: String) -> Transcript {
        transcripts[id] ?? Transcript()
    }

    // MARK: Private

    @ObservationIgnored private let connection = WebSocketConnection()
    @ObservationIgnored private var backoff = Backoff()
    @ObservationIgnored private var reconnectTask: Task<Void, Never>?
    @ObservationIgnored private var heartbeatTask: Task<Void, Never>?
    @ObservationIgnored private var handshakeTimeout: Task<Void, Never>?
    @ObservationIgnored private var pending: [String: CheckedContinuation<ServerMessage, Error>] = [:]
    @ObservationIgnored private var requestCounter = 0
    /// Sessions whose event stream we want; re-subscribed after every reconnect.
    @ObservationIgnored private var subscribed: Set<String> = []
    /// True when the user asked to disconnect, so we don't auto-reconnect.
    @ObservationIgnored private var userDisconnected = false

    init() {
        connection.onEvent = { [weak self] event in self?.handle(event) }
        if serverAddress.isEmpty || !hasToken { status = .notConfigured }
    }

    // MARK: - Settings

    var currentToken: String { Keychain.read(account: Self.tokenAccount) ?? "" }

    /// Save settings and (re)connect. An empty token keeps the existing one.
    func saveSettings(address: String, token: String) throws {
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard ServerAddress.normalize(trimmed) != nil else {
            throw SettingsError.invalidAddress
        }
        serverAddress = trimmed
        UserDefaults.standard.set(trimmed, forKey: Self.addressKey)
        let newToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if !newToken.isEmpty {
            try Keychain.save(newToken, account: Self.tokenAccount)
        }
        hasToken = Keychain.read(account: Self.tokenAccount) != nil
        guard hasToken else { throw SettingsError.missingToken }
        userDisconnected = false
        backoff.reset()
        connect()
    }

    func forgetToken() {
        Keychain.delete(account: Self.tokenAccount)
        hasToken = false
        disconnect()
        status = .notConfigured
    }

    nonisolated enum SettingsError: LocalizedError {
        case invalidAddress, missingToken
        var errorDescription: String? {
            switch self {
            case .invalidAddress: "Enter a server address like 100.101.102.103:8787 or ws://host:8787/v1/ws."
            case .missingToken: "Enter the server's auth token."
            }
        }
    }

    // MARK: - Connection lifecycle

    /// Called when the main window appears and when the app becomes active.
    func start() {
        guard !userDisconnected else { return }
        switch status {
        case .connected, .connecting, .unauthorized: return
        default: connect()
        }
    }

    func connect() {
        reconnectTask?.cancel()
        // Replacing an open socket emits no close event, so clean up here.
        tearDownSocket()
        guard let url = ServerAddress.normalize(serverAddress) else {
            status = .notConfigured
            return
        }
        let token = currentToken
        guard !token.isEmpty else {
            status = .notConfigured
            return
        }
        userDisconnected = false
        status = .connecting
        connection.open(url: url, token: token)
        // If we never get a welcome frame, treat it as a failed attempt.
        handshakeTimeout?.cancel()
        handshakeTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(20))
            guard !Task.isCancelled, let self, self.status == .connecting else { return }
            self.connection.close()
            self.connectionLost(error: AppError.timeout, httpStatus: nil)
        }
    }

    func disconnect() {
        userDisconnected = true
        reconnectTask?.cancel()
        tearDownSocket()
        status = serverAddress.isEmpty || !hasToken ? .notConfigured : .disconnected
    }

    private func tearDownSocket() {
        heartbeatTask?.cancel()
        handshakeTimeout?.cancel()
        connection.close()
        failAllPending(AppError.notConnected)
    }

    func reconnectNow() {
        backoff.reset()
        connect()
    }

    private func handle(_ event: WebSocketConnection.Event) {
        switch event {
        case .message(let message):
            handle(message)
        case .closed(let error, let httpStatus):
            connectionLost(error: error, httpStatus: httpStatus)
        }
    }

    private func connectionLost(error: Error?, httpStatus: Int?) {
        heartbeatTask?.cancel()
        handshakeTimeout?.cancel()
        failAllPending(AppError.notConnected)
        if httpStatus == 401 {
            status = .unauthorized
            lastError = "The server rejected the auth token. Check it in Settings."
            return
        }
        if let error { lastError = error.localizedDescription }
        guard !userDisconnected else {
            status = .disconnected
            return
        }
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        let delay = backoff.next()
        status = .reconnecting(attempt: backoff.attempt, at: Date().addingTimeInterval(delay))
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            self.connect()
        }
    }

    private func onWelcome(_ welcome: Welcome) {
        handshakeTimeout?.cancel()
        guard welcome.protocolVersion == protocolVersion else {
            lastError = "Server speaks protocol v\(welcome.protocolVersion); this app speaks v\(protocolVersion). Update one of them."
            userDisconnected = true
            tearDownSocket()
            status = .disconnected
            return
        }
        status = .connected(serverVersion: welcome.serverVersion)
        projectsRoot = welcome.projectsRoot
        lastError = nil
        backoff.reset()
        startHeartbeat()
        Task {
            await refreshSessions()
            // Resume every stream we care about from where we left off.
            for id in subscribed { await subscribe(id) }
        }
    }

    /// App-level ping so a half-open socket (e.g. after sleep) is noticed quickly.
    private func startHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                guard !Task.isCancelled, let self, self.isConnected else { return }
                do {
                    _ = try await self.request(.ping, timeout: .seconds(10))
                } catch {
                    guard !Task.isCancelled, self.isConnected else { return }
                    log.info("Heartbeat failed; reconnecting")
                    self.connection.close()
                    self.connectionLost(error: AppError.timeout, httpStatus: nil)
                    return
                }
            }
        }
    }

    // MARK: - Requests

    /// Send a request and await the reply with the matching reqId.
    /// Server `error` replies are thrown as `AppError.server`.
    @discardableResult
    func request(_ message: ClientMessage, timeout: Duration = .seconds(15)) async throws -> ServerMessage {
        guard connection.isOpen else { throw AppError.notConnected }
        requestCounter += 1
        let reqId = "c\(requestCounter)"
        let data = try message.encoded(reqId: reqId)
        return try await withCheckedThrowingContinuation { continuation in
            pending[reqId] = continuation
            Task {
                do {
                    try await connection.send(data)
                } catch {
                    resolve(reqId, .failure(error))
                }
            }
            Task {
                try? await Task.sleep(for: timeout)
                resolve(reqId, .failure(AppError.timeout))
            }
        }
    }

    private func resolve(_ reqId: String, _ result: Result<ServerMessage, Error>) {
        guard let continuation = pending.removeValue(forKey: reqId) else { return }
        continuation.resume(with: result)
    }

    private func failAllPending(_ error: Error) {
        let all = pending
        pending.removeAll()
        for continuation in all.values { continuation.resume(throwing: error) }
    }

    // MARK: - Incoming messages

    private func handle(_ message: ServerMessage) {
        if let reqId = message.reqId, pending[reqId] != nil {
            if case .error(let e) = message {
                resolve(reqId, .failure(AppError.server(e)))
            } else {
                resolve(reqId, .success(message))
            }
            // Replies that also carry state are applied below too.
        }
        switch message {
        case .welcome(let w):
            if message.reqId == nil { onWelcome(w) }
        case .sessionListResult(let r):
            mergeSessions(r.sessions, replacing: true)
        case .sessionCreated(let r):
            mergeSessions([r.session])
        case .sessionSubscribed(let r):
            mergeSessions([r.session])
        case .sessionUpdated(let u):
            mergeSessions([u.session])
        case .event(let e):
            transcripts[e.sessionId, default: Transcript()].apply(e)
        case .error(let e) where e.reqId == nil:
            lastError = e.message
        case .pong, .ack, .error, .fsListResult, .fsReadResult, .unknown:
            break
        }
    }

    private func mergeSessions(_ incoming: [SessionInfo], replacing: Bool = false) {
        var byId = replacing ? [:] : Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
        for s in incoming { byId[s.id] = s }
        sessions = byId.values.sorted { $0.updatedAt > $1.updatedAt }
    }

    // MARK: - Session actions

    func refreshSessions() async {
        do {
            try await request(.sessionList)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func ensureSubscribed(_ id: String) {
        guard !subscribed.contains(id) else { return }
        subscribed.insert(id)
        if isConnected { Task { await subscribe(id) } }
    }

    private func subscribe(_ id: String) async {
        let afterSeq = transcripts[id]?.lastSeq ?? 0
        do {
            try await request(.sessionSubscribe(sessionId: id, afterSeq: afterSeq), timeout: .seconds(60))
        } catch {
            lastError = "Couldn't open session: \(error.localizedDescription)"
        }
    }

    func createSession(cwd: String, title: String?, autoApproveEdits: Bool) async throws -> SessionInfo {
        let reply = try await request(.sessionCreate(cwd: cwd, title: title, autoApproveEdits: autoApproveEdits))
        guard case .sessionCreated(let created) = reply else { throw AppError.unexpectedReply }
        mergeSessions([created.session])
        selectedSessionID = created.session.id
        return created.session
    }

    func send(_ text: String, to sessionId: String) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        ensureSubscribed(sessionId)
        try await request(.sessionSend(sessionId: sessionId, text: trimmed))
    }

    func interrupt(_ sessionId: String) async {
        do { try await request(.sessionInterrupt(sessionId: sessionId)) } catch { lastError = error.localizedDescription }
    }

    func stop(_ sessionId: String) async {
        do { try await request(.sessionStop(sessionId: sessionId)) } catch { lastError = error.localizedDescription }
    }

    func setAutoApproveEdits(_ enabled: Bool, for sessionId: String) async {
        do {
            try await request(.setAutoApproveEdits(sessionId: sessionId, enabled: enabled))
        } catch {
            lastError = error.localizedDescription
        }
    }

    func respond(to permission: PermissionItem, in sessionId: String, decision: PermissionDecision) async {
        do {
            try await request(.permissionRespond(sessionId: sessionId, requestId: permission.requestId, decision: decision))
        } catch {
            lastError = error.localizedDescription
        }
    }

    func clearError() {
        lastError = nil
    }
}

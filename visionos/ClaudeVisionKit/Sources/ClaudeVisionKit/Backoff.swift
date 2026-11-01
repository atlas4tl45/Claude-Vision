import Foundation

/// Exponential reconnect backoff with full jitter.
public struct Backoff: Sendable {
    public var base: TimeInterval
    public var maximum: TimeInterval
    public private(set) var attempt: Int = 0

    public init(base: TimeInterval = 0.5, maximum: TimeInterval = 30) {
        self.base = base
        self.maximum = maximum
    }

    /// Upper bound of the delay for the given attempt (0-based), before jitter.
    public func ceiling(forAttempt n: Int) -> TimeInterval {
        min(maximum, base * pow(2, Double(min(n, 30))))
    }

    /// The next delay; advances the attempt counter. `random` is injectable for tests.
    public mutating func next(random: (ClosedRange<Double>) -> Double = { Double.random(in: $0) }) -> TimeInterval {
        let cap = ceiling(forAttempt: attempt)
        attempt += 1
        // Keep a small floor so we never spin.
        return max(0.25, random(0...cap))
    }

    public mutating func reset() {
        attempt = 0
    }
}

/// Normalizes what the user types into a WebSocket URL:
/// `100.64.0.1:8787` -> `ws://100.64.0.1:8787/v1/ws`.
public enum ServerAddress {
    public static let defaultPort = 8787
    public static let path = "/v1/ws"

    public static func normalize(_ input: String) -> URL? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if let range = text.range(of: "://") {
            let scheme = text[..<range.lowerBound].lowercased()
            let rest = text[range.upperBound...]
            switch scheme {
            case "http", "ws": text = "ws://" + rest
            case "https", "wss": text = "wss://" + rest
            default: return nil
            }
        } else if text.filter({ $0 == ":" }).count > 1, !text.contains("[") {
            // A bare IPv6 address (e.g. Tailscale's fd7a:115c:a1e0::1).
            text = "ws://[\(text)]"
        } else {
            text = "ws://" + text
        }
        guard var components = URLComponents(string: text),
              let scheme = components.scheme?.lowercased(), scheme == "ws" || scheme == "wss",
              let host = components.host, !host.isEmpty
        else { return nil }
        components.scheme = scheme
        if components.port == nil && scheme == "ws" { components.port = defaultPort }
        if components.path.isEmpty || components.path == "/" { components.path = path }
        return components.url
    }
}

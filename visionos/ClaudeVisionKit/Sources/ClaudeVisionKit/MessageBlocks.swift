import Foundation

/// Splits assistant Markdown into prose and fenced code blocks, so code can be
/// rendered in a monospaced container while prose uses inline Markdown.
/// Tolerates an unterminated fence (common mid-stream): the remainder is code.
public enum MessageBlock: Sendable, Hashable {
    case prose(String)
    case code(language: String?, code: String)
}

public enum MessageBlocks {
    public static func parse(_ text: String) -> [MessageBlock] {
        var blocks: [MessageBlock] = []
        var prose: [Substring] = []
        var code: [Substring] = []
        var language: String?
        var inCode = false
        var fence = ""

        func flushProse() {
            let joined = prose.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !joined.isEmpty { blocks.append(.prose(joined)) }
            prose.removeAll()
        }

        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.drop(while: { $0 == " " })
            if !inCode, let opening = openingFence(trimmed) {
                flushProse()
                fence = opening.fence
                language = opening.language
                inCode = true
            } else if inCode, isClosingFence(trimmed, for: fence) {
                blocks.append(.code(language: language, code: code.joined(separator: "\n")))
                code.removeAll()
                inCode = false
            } else if inCode {
                code.append(line)
            } else {
                prose.append(line)
            }
        }
        if inCode {
            blocks.append(.code(language: language, code: code.joined(separator: "\n")))
        } else {
            flushProse()
        }
        return blocks
    }

    /// A run of 3+ backticks or tildes, then an optional info string (whose first word is the language).
    /// Per CommonMark, a backtick fence's info string may not contain backticks.
    static func openingFence(_ line: Substring) -> (fence: String, language: String?)? {
        guard let first = line.first, first == "`" || first == "~" else { return nil }
        let run = line.prefix(while: { $0 == first })
        guard run.count >= 3 else { return nil }
        let info = line.dropFirst(run.count).trimmingCharacters(in: .whitespaces)
        if first == "`" && info.contains("`") { return nil }
        let language = info.split(separator: " ").first.map(String.init)
        return (String(run), language)
    }

    /// Closing fence: same character, at least as long as the opening run, nothing else but whitespace.
    static func isClosingFence(_ line: Substring, for fence: String) -> Bool {
        guard let fenceChar = fence.first else { return false }
        let run = line.prefix(while: { $0 == fenceChar })
        return run.count >= fence.count && line.dropFirst(run.count).allSatisfy { $0.isWhitespace }
    }
}

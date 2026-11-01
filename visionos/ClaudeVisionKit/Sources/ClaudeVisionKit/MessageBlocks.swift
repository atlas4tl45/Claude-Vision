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
            if !inCode, trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushProse()
                fence = String(trimmed.prefix(3))
                let info = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                language = info.isEmpty ? nil : String(info.split(separator: " ").first ?? "")
                inCode = true
            } else if inCode, let fenceChar = fence.first, trimmed.hasPrefix(fence),
                      trimmed.drop(while: { $0 == fenceChar }).allSatisfy({ $0.isWhitespace }) {
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
}

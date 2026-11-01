import Foundation

/// One rendered line of a unified diff.
public struct DiffLine: Sendable, Hashable, Identifiable {
    public enum Kind: Sendable, Hashable {
        case fileHeader   // --- a/x or +++ b/x
        case hunkHeader   // @@ -1,3 +1,4 @@ context
        case context
        case addition
        case deletion
        case meta         // "\ No newline at end of file", or anything unrecognized
    }

    public let id: Int
    public let kind: Kind
    /// Line text without the leading diff marker (headers keep their full text).
    public let text: String
    public let oldLine: Int?
    public let newLine: Int?
}

public struct DiffStats: Sendable, Hashable {
    public var additions: Int
    public var deletions: Int
}

/// The ranges in a hunk header: "@@ -oldStart,oldCount +newStart,newCount @@".
public struct HunkRange: Sendable, Hashable {
    public var oldStart: Int
    public var oldCount: Int
    public var newStart: Int
    public var newCount: Int
}

public enum UnifiedDiff {
    /// Parses one or more files' unified diffs. Hunk bodies are delimited by
    /// the counts in their headers, so content lines that happen to start with
    /// "---" or "+++" are never mistaken for file headers.
    public static func parse(_ diff: String) -> [DiffLine] {
        var out: [DiffLine] = []
        var oldLine = 0
        var newLine = 0
        var oldRemaining = 0
        var newRemaining = 0
        var id = 0
        func add(_ kind: DiffLine.Kind, _ text: String, old: Int? = nil, new: Int? = nil) {
            out.append(DiffLine(id: id, kind: kind, text: text, oldLine: old, newLine: new))
            id += 1
        }

        var lines = diff.components(separatedBy: "\n")
        if lines.last == "" { lines.removeLast() }
        for line in lines {
            let inHunk = oldRemaining > 0 || newRemaining > 0
            if inHunk, line.hasPrefix("+"), newRemaining > 0 {
                add(.addition, String(line.dropFirst()), new: newLine)
                newLine += 1
                newRemaining -= 1
            } else if inHunk, line.hasPrefix("-"), oldRemaining > 0 {
                add(.deletion, String(line.dropFirst()), old: oldLine)
                oldLine += 1
                oldRemaining -= 1
            } else if inHunk, line.hasPrefix(" ") || line.isEmpty {
                add(.context, line.isEmpty ? "" : String(line.dropFirst()), old: oldLine, new: newLine)
                oldLine += 1
                newLine += 1
                oldRemaining -= 1
                newRemaining -= 1
            } else if line.hasPrefix("@@"), let range = hunkRange(line) {
                // Zero-length ranges name the line *before* the hunk.
                oldLine = range.oldCount == 0 ? range.oldStart + 1 : range.oldStart
                newLine = range.newCount == 0 ? range.newStart + 1 : range.newStart
                oldRemaining = range.oldCount
                newRemaining = range.newCount
                add(.hunkHeader, line)
            } else if line.hasPrefix("--- ") || line.hasPrefix("+++ ") {
                add(.fileHeader, line)
            } else {
                add(.meta, line)
            }
        }
        return out
    }

    public static func stats(_ diff: String) -> DiffStats {
        var s = DiffStats(additions: 0, deletions: 0)
        for line in parse(diff) {
            if line.kind == .addition { s.additions += 1 }
            if line.kind == .deletion { s.deletions += 1 }
        }
        return s
    }

    /// Parses "@@ -12,3 +14,5 @@ optional context". A missing count means 1.
    public static func hunkRange(_ header: String) -> HunkRange? {
        let parts = header.split(separator: " ")
        guard parts.count >= 3, parts[0] == "@@", parts[1].hasPrefix("-"), parts[2].hasPrefix("+") else { return nil }
        func range(_ text: Substring) -> (Int, Int)? {
            let fields = text.dropFirst().split(separator: ",", omittingEmptySubsequences: false)
            guard let first = fields.first, let start = Int(first) else { return nil }
            if fields.count > 1 {
                guard let count = Int(fields[1]) else { return nil }
                return (start, count)
            }
            return (start, 1)
        }
        guard let old = range(parts[1]), let new = range(parts[2]) else { return nil }
        return HunkRange(oldStart: old.0, oldCount: old.1, newStart: new.0, newCount: new.1)
    }
}

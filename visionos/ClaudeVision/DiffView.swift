import ClaudeVisionKit
import SwiftUI

/// Renders a unified diff with line numbers and colored additions/deletions.
struct DiffView: View {
    let lines: [DiffLine]
    var showFileHeaders = false
    /// Limit for inline previews; nil shows everything.
    var maxLines: Int?

    init(diff: String, showFileHeaders: Bool = false, maxLines: Int? = nil) {
        self.lines = UnifiedDiff.parse(diff)
        self.showFileHeaders = showFileHeaders
        self.maxLines = maxLines
    }

    private var visible: [DiffLine] {
        let filtered = showFileHeaders ? lines : lines.filter { $0.kind != .fileHeader }
        if let maxLines, filtered.count > maxLines { return Array(filtered.prefix(maxLines)) }
        return filtered
    }

    private var hiddenCount: Int {
        let total = showFileHeaders ? lines.count : lines.filter { $0.kind != .fileHeader }.count
        return max(0, total - visible.count)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView(.horizontal) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(visible) { line in
                        DiffLineRow(line: line)
                    }
                }
                .padding(.vertical, 6)
            }
            if hiddenCount > 0 {
                Text("\(hiddenCount) more lines")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
            }
        }
        .background(.black.opacity(0.25), in: RoundedRectangle(cornerRadius: 14))
    }
}

struct DiffLineRow: View {
    let line: DiffLine

    private var marker: String {
        switch line.kind {
        case .addition: "+"
        case .deletion: "−"
        default: " "
        }
    }

    private var background: Color {
        switch line.kind {
        case .addition: .green.opacity(0.22)
        case .deletion: .red.opacity(0.22)
        case .hunkHeader: .blue.opacity(0.15)
        default: .clear
        }
    }

    private var foreground: Color {
        switch line.kind {
        case .hunkHeader, .fileHeader, .meta: .secondary
        default: .primary
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            if line.kind == .hunkHeader || line.kind == .fileHeader || line.kind == .meta {
                Text(line.text)
                    .padding(.horizontal, 12)
            } else {
                Text(line.oldLine.map { String($0) } ?? "")
                    .frame(width: 44, alignment: .trailing)
                    .foregroundStyle(.tertiary)
                Text(line.newLine.map { String($0) } ?? "")
                    .frame(width: 44, alignment: .trailing)
                    .foregroundStyle(.tertiary)
                Text(marker)
                    .frame(width: 24)
                    .foregroundStyle(foreground)
                Text(line.text.isEmpty ? " " : line.text)
                    .foregroundStyle(foreground)
                    .padding(.trailing, 12)
            }
        }
        .font(.system(.callout, design: .monospaced))
        .lineLimit(1)
        .fixedSize(horizontal: true, vertical: false)
        .frame(minWidth: 0, alignment: .leading)
        .background(background)
        .accessibilityElement(children: .combine)
    }
}

/// "+3 −1" summary chip.
struct DiffStatsLabel: View {
    let diff: String

    var body: some View {
        let stats = UnifiedDiff.stats(diff)
        HStack(spacing: 6) {
            Text("+\(stats.additions)").foregroundStyle(.green)
            Text("−\(stats.deletions)").foregroundStyle(.red)
        }
        .font(.caption.monospacedDigit().weight(.semibold))
        .accessibilityLabel("\(stats.additions) lines added, \(stats.deletions) removed")
    }
}

import Testing
@testable import ClaudeVisionKit

@Suite("Unified diff")
struct UnifiedDiffTests {
    @Test func parsesHunksWithLineNumbers() {
        let diff = "--- a/code.txt\n+++ b/code.txt\n@@ -2,7 +2,7 @@\n b\n c\n d\n-e\n+E!\n f\n g\n h\n"
        let lines = UnifiedDiff.parse(diff)
        #expect(lines.map(\.kind) == [.fileHeader, .fileHeader, .hunkHeader, .context, .context, .context, .deletion, .addition, .context, .context, .context])
        let deletion = lines[6]
        #expect(deletion.text == "e" && deletion.oldLine == 5 && deletion.newLine == nil)
        let addition = lines[7]
        #expect(addition.text == "E!" && addition.newLine == 5 && addition.oldLine == nil)
        #expect(lines[8].oldLine == 6 && lines[8].newLine == 6)
        #expect(UnifiedDiff.stats(diff) == DiffStats(additions: 1, deletions: 1))
    }

    @Test func newFile() {
        let lines = UnifiedDiff.parse("--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1,2 @@\n+alpha\n+beta\n")
        #expect(lines.filter { $0.kind == .addition }.map(\.newLine) == [1, 2])
    }

    @Test func contentThatLooksLikeHeadersIsContent() {
        let lines = UnifiedDiff.parse("@@ -1,1 +1,1 @@\n--- old comment\n+++ new comment\n")
        #expect(lines.map(\.kind) == [.hunkHeader, .deletion, .addition])
        #expect(lines[1].text == "-- old comment")
    }

    @Test func multipleFiles() {
        let diff = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n--- a/y\n+++ b/y\n@@ -3,0 +4,1 @@\n+new\n"
        let lines = UnifiedDiff.parse(diff)
        #expect(lines.map(\.kind) == [.fileHeader, .fileHeader, .hunkHeader, .deletion, .addition, .fileHeader, .fileHeader, .hunkHeader, .addition])
        #expect(lines.last?.newLine == 4)
    }

    @Test func noNewlineMarkerIsMeta() {
        let lines = UnifiedDiff.parse("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n")
        #expect(lines.map(\.kind) == [.hunkHeader, .deletion, .meta, .addition])
    }

    @Test func hunkHeaderParsing() {
        #expect(UnifiedDiff.hunkRange("@@ -12,3 +14,5 @@ func x()") == HunkRange(oldStart: 12, oldCount: 3, newStart: 14, newCount: 5))
        #expect(UnifiedDiff.hunkRange("@@ -1 +1 @@") == HunkRange(oldStart: 1, oldCount: 1, newStart: 1, newCount: 1))
        #expect(UnifiedDiff.hunkRange("@@ garbage") == nil)
    }
}

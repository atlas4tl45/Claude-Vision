#!/usr/bin/env python3
"""Publish compiler/test diagnostics from build logs as a GitHub check run.

Check runs (with annotations and a text body) are readable through the
public Checks API, so build results can be inspected without access to the
Actions log endpoints.

Usage: report-diagnostics.py --name NAME --outcome success|failure LOG [LOG...]
Env:   GITHUB_TOKEN, GITHUB_REPOSITORY, HEAD_SHA, GITHUB_WORKSPACE, GITHUB_SERVER_URL, GITHUB_RUN_ID
Standard library only.
"""

import argparse
import json
import os
import re
import sys
import urllib.request

DIAG = re.compile(r"^(?P<file>/[^:\n]+):(?P<line>\d+):(?:(?P<col>\d+):)? (?P<sev>error|warning): (?P<msg>.+)$")
# Other lines worth surfacing: xcodebuild/SwiftPM errors and Swift Testing failures.
NOTABLE = re.compile(r"(^error: |xcodebuild: error|\*\* BUILD FAILED \*\*|\*\* TEST FAILED \*\*|✘|recorded an issue|Expectation failed|fatal error"
                     r"|\*\* BUILD SUCCEEDED \*\*|Test run with \d+ tests|Executed \d+ tests|-sdk xrsimulator|^Xcode \d|^Build version|Swift version)")

MAX_TEXT = 60000


def parse(paths):
    diags, notable, tails = [], [], []
    seen = set()
    workspace = os.environ.get("GITHUB_WORKSPACE", "")
    for path in paths:
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                lines = f.read().splitlines()
        except FileNotFoundError:
            notable.append(f"(log not found: {path})")
            continue
        tails.append((path, lines[-120:]))
        for line in lines:
            m = DIAG.match(line)
            if m:
                file = m["file"]
                if workspace and file.startswith(workspace + "/"):
                    file = file[len(workspace) + 1:]
                key = (file, m["line"], m["col"], m["sev"], m["msg"])
                if key in seen:
                    continue
                seen.add(key)
                diags.append({"file": file, "line": int(m["line"]), "col": int(m["col"] or 0), "sev": m["sev"], "msg": m["msg"]})
            elif NOTABLE.search(line) and line not in seen:
                seen.add(line)
                notable.append(line.strip())
    return diags, notable, tails


def api(method, url, body):
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        method=method,
        headers={
            "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--outcome", required=True)
    ap.add_argument("logs", nargs="+")
    args = ap.parse_args()

    diags, notable, tails = parse(args.logs)
    errors = [d for d in diags if d["sev"] == "error"]
    warnings = [d for d in diags if d["sev"] == "warning"]
    ok = args.outcome == "success"

    summary = f"{'Succeeded' if ok else 'Failed'}: {len(errors)} compiler errors, {len(warnings)} warnings."
    run_url = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}"
    summary += f"\n\nWorkflow run: {run_url}"

    parts = []
    if errors or warnings:
        parts.append("## Compiler diagnostics\n")
        for d in errors + warnings:
            parts.append(f"- **{d['sev']}** `{d['file']}:{d['line']}:{d['col']}` {d['msg']}")
    if notable:
        parts.append("\n## Other notable lines\n```")
        parts.extend(notable[:300])
        parts.append("```")
    if not ok:
        for path, tail in tails:
            parts.append(f"\n## Last lines of {os.path.basename(path)}\n```")
            parts.extend(tail)
            parts.append("```")
    text = "\n".join(parts)
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT] + "\n… (truncated)"

    annotations = [
        {
            "path": d["file"],
            "start_line": d["line"],
            "end_line": d["line"],
            "annotation_level": "failure" if d["sev"] == "error" else "warning",
            "message": d["msg"][:60000],
        }
        for d in errors + warnings
        if not d["file"].startswith("/")  # only files inside the repo can be annotated
    ]

    repo = os.environ["GITHUB_REPOSITORY"]
    base = f"https://api.github.com/repos/{repo}/check-runs"
    output = {"title": summary.splitlines()[0], "summary": summary, "text": text or "No diagnostics."}
    run = api("POST", base, {
        "name": args.name,
        "head_sha": os.environ["HEAD_SHA"],
        "status": "completed",
        "conclusion": "success" if ok else "failure",
        "output": {**output, "annotations": annotations[:50]},
    })
    # The API accepts at most 50 annotations per request; add the rest in batches.
    for i in range(50, len(annotations), 50):
        api("PATCH", f"{base}/{run['id']}", {"output": {**output, "annotations": annotations[i:i + 50]}})
    print(f"Published check run {run['id']}: {summary.splitlines()[0]}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # never fail the job because reporting failed
        print(f"report-diagnostics: {e}", file=sys.stderr)

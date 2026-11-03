"""Preserve the external review's individual findings without copying credentials."""

from __future__ import annotations

import argparse
import hashlib
import re
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("review_root", type=Path)
    args = parser.parse_args()
    report = args.review_root / "reports/FactoriX_Commercial_Release_Review_VI.md"
    body = report.read_text(encoding="utf-8-sig")
    findings: dict[str, tuple[str, str]] = {}
    details: list[tuple[str, str, str]] = []
    section = ""
    for line in body.splitlines():
        if line.startswith("#"):
            section = line.lstrip("# ")
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if not cells or all(re.fullmatch(r"[-: ]*", cell) for cell in cells):
            continue
        ids = re.findall(r"CR-[A-Z]+\d{2}|RG-\d{2}", cells[0])
        if ids and len(cells) >= 3:
            for issue in ids:
                findings[issue] = (section, " | ".join(cells[1:]))
        if section.startswith(("5.", "6.", "7.")) and not ids:
            details.append((f"DETAIL-{len(details)+1:03}", section, " | ".join(cells)))
    all_ids = sorted(set(re.findall(r"CR-[A-Z]+\d{2}|RG-\d{2}", body)))
    output = [
        "# Review 2 coverage ledger", "",
        "Status: ACTIVE. An entry is not fixed until its behavior and required UI evidence are verified.", "",
        f"Report SHA-256: `{hashlib.sha256(report.read_bytes()).hexdigest()}`. Report IDs: **{len(all_ids)}**.", "",
        "Accepted scope and test journeys: [implementation plan](2026-11-02-collector-review2.md).", "",
        "## Report findings", "",
        "| ID | Disposition | Original finding and remedy | Evidence |",
        "|---|---|---|---|",
    ]
    deferred = {"CR-A01", "CR-A05", "CR-A06", "CR-A09", "CR-A11", "CR-A13"}
    partial = {"CR-A02", "CR-A03", "CR-A07", "CR-A08", "CR-A10", "CR-OG02", "CR-OG03", "CR-X01"}
    for issue in all_ids:
        _, description = findings.get(issue, ("", "See original report; expand during implementation."))
        status = "DEFERRED (user decision)" if issue in deferred else "OPEN (partially deferred; see plan)" if issue in partial else "OPEN"
        output.append(f"| {issue} | {status} | {description.replace('|', ' / ').replace('<br>', ' ')} | Pending |")
    output += ["", "## Unnumbered UI, copy and proposal details", "", "| ID | Section | Review detail | Status / evidence |", "|---|---|---|---|"]
    for issue, heading, description in details:
        output.append(f"| {issue} | {heading} | {description.replace('|', ' / ')} | OPEN |")
    output += ["", "## Additional source findings", "", "| ID | Finding | Status / evidence |", "|---|---|---|"]
    for issue, description in [
        ("SRC-01", "Request DB transaction commits but never flushes after-commit stream events."),
        ("SRC-02", "Resource/signal/latest caps silently truncate the model; cursor must include UUID when codes repeat."),
        ("SRC-03", "review2 sibling migration removes DB uniqueness; force placement can bypass archived-parent checks."),
        ("SRC-04", "Running connectors cached by ID ignore edited endpoint/topic/security; must reconcile and close."),
        ("SRC-05", "OPC subscription values mapped by notification order instead of NodeId; sessions leak."),
        ("SRC-06", "Site creation spans requests and can leave partial Site/Edge state."),
        ("SRC-07", "Outbox ACK rows persist indefinitely and blocking sources delay all acquisition/heartbeat."),
        ("SRC-08", "review2 Capture UI has no structured payload from Edge; mapping Pass checks nonempty JSON only."),
        ("SRC-09", "review2 MQTT import assigns fixed level types and misinterprets the actual datasource hierarchy."),
        ("SRC-10", "review2 connection PATCH uses public protocol alias in stored endpoint renderer."),
        ("USER-01", "One logo only: remove duplicated adjacent FactoriX brand block."),
    ]:
        output.append(f"| {issue} | {description} | OPEN |")
    target = Path(__file__).resolve().parents[1] / "docs/superpowers/plans/review2-issues.md"
    target.write_text("\n".join(output) + "\n", encoding="utf-8")
    print(f"Wrote {len(all_ids)} report IDs and {len(details)} unnumbered details to {target}")


if __name__ == "__main__":
    main()

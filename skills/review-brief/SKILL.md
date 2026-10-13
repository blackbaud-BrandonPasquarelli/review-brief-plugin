---
name: review-brief
description: >
  Use when the user wants a visual/graphical overview, digest, or summary of a set of code changes
  before reviewing them: uncommitted local changes, a branch or commit range, a GitHub PR, an Azure
  DevOps PR, a patch file, or two folder snapshots. Produces a temporary standalone HTML page (summary,
  ranked "hotspots" to read first, review notes and discrepancies, before/after mermaid diagrams, annotated
  file map, key code highlights)
  outside any repo. Works for Angular/SKY UX SPAs, .NET services, and any git-diffable project.
---

# Review brief

Builds one self-contained `index.html` that helps a developer digest a large change quickly. The page
does not replace code review, but it lets the reviewer read each file's changes in place. It answers: *what changed, where, how does the flow differ before vs after, what looks risky,
and — if the reviewer reads only a little code — which code it should be?* To pair the page with an
agent code review, see "Pairing with a code review".

The page is split into tabs: Summary (stats, a 🧭 "Where to start" line, and review notes) · 🗺️ Walkthrough
(only when configured) · 🔥 Hotspots ·
🧱 Reading path · 📊 Diagrams · 📄 Files (hotspot files get a 🔥 badge and a "Hotspots only" filter; each card
has a `🧱 n.m` chip and a "next →" link) · ✨ Highlights. The URL hash tracks the tab and the selected file, so
links, Back, and reload all work.

Walkthrough, Reading path and Files use a split view: ordered cards on the left, and the selected file on the right.
Drag the divider between them (or focus it and use ←/→) to resize; double-click resets it. The width is shared by
all tabs and remembered.
The right pane shows **Changes** (a unified diff) by default. A toggle switches to **Full file**, which shows
the whole head file with changes marked and scrolls to the first change. A second toggle switches either view
between **Unified** and **Split** (side-by-side: removed lines on the left, added lines on the right). Both
choices are remembered.
Full file is available for modified/renamed text files from local, GitHub and ADO sources (capped by
`--max-full-files`, default 300, and 5000 lines per file). It is not available for patch-file sources; new and
deleted files already show everything under Changes. Keys: `j`/`k` next/previous file, `f` toggle the view,
`s` toggle unified/split, `n` next unreviewed file (game mode). Below 1000px wide the split stacks vertically. `--no-diffs` drops the
diff pane for a small page with no code in it.

Each rendered diagram has a **⤢ Expand** button (clicking the diagram also works). It opens a near-fullscreen
viewer that fits the diagram to the window, including enlarging small ones. Controls: scroll to zoom, drag
to pan, double-click to zoom in, `+`/`-`, `0` fit, `1` 100%, ←/→ (or ◀ ▶) to switch diagrams, and Esc or a
backdrop click to close.

Guided walkthrough: the main aid for large or complex PRs. It is an authored, ordered story of the change at
the level of individual changes, not files: "the request enters here → is validated here → this changed
because…". Each step has a title, a short explanation, and optionally an anchor to specific lines. Selecting a
step opens that file on the right with the referenced lines highlighted (purple bar), in both Changes and Full
file, and scrolls to them. Text-only steps (no file) carry narrative and are skipped by `j`/`k`. The Summary
tab links to it ("New to this change? Take the guided walkthrough"), and `#w-N` links to a step. A
**⧉ Copy steps** button on the heading copies every step's numbered title and explanation as plain text, with no
code or diff.

Reading path: a building-block order for every file, for large PRs where the starting point is unclear.
By default it is computed from cross-file references (symbols each file defines and uses, plus relative
imports): each step only relies on earlier steps, so contracts and helpers come before the code that uses
them. Markup and CSS companions sit next to their component, and tests come after the code they exercise,
followed by config/build/docs and then removed files. Each file shows "builds on", "needed by" and "covers"
links. It is heuristic: it misses DI-only and cross-language links, and cycles share a step. A `readingPath`
config replaces it with curated steps.

Review quest (on by default): a light game layer that rewards careful review. Points come mostly from
ticking each hotspot's Verify checks and then clearing the hotspot (the "boss" is the first high hotspot),
acknowledging review notes, and viewing diagrams. Marking files reviewed earns less. The header has an XP
bar, ranks (🥚 Intern → 👑 Merge Master), achievements, a "Hide reviewed" filter, a reset button, and a 🎮
toggle. Progress is stored only in this browser's localStorage, keyed by the patch hash, so it survives
regenerating the same diff. In game mode, reading-path rows have mirror checkboxes, a per-step progress count
and a toast when a step is completed. A ▶ Next button (shortcut `n`) jumps to the next unreviewed file in
reading-path order. `--no-game` builds the page without the game layer.

Bundled files:
- `scripts/change-viz.js` — dependency-free Node (v18+) generator. Run `node change-viz.js --help`.
- `config.example.json` — shows every config feature.

## Hard rules

1. **Read-only on repos.** No git writes of any kind in the user's repos/worktrees (no add, commit, stash,
   checkout, reset, branch, or push). Do not create, edit, or delete files inside a repo.
2. **Outputs only under `%TEMP%`.** The default is `%TEMP%\change-viz\<slug>\`. ADO PRs use a temporary partial
   clone under `%TEMP%\change-viz-clones\`. Never put output inside a repo.
3. **Nothing leaves the machine.** Do not send code or diffs to third-party services. The page only loads the
   pinned mermaid script from jsdelivr; if that is unavailable, diagrams degrade to readable source text.
4. **For local repos, prove nothing changed.** Capture `git -C <repo> status --short` before and after,
   and report that they are identical.

## Sources

| Want | Command (from the skill's `scripts` folder) |
|---|---|
| Uncommitted changes (staged, unstaged, untracked) | `node change-viz.js --repo <path>` |
| Whole branch incl. local edits | `node change-viz.js --repo <path> --base origin/master --uncommitted` |
| Commit range | `node change-viz.js --repo <path> --base <ref> [--head <ref>]` |
| GitHub PR | `node change-viz.js --gh-pr https://github.com/o/r/pull/N` (or `o/r#N`; `--hostname` for GHES) |
| Azure DevOps PR | `node change-viz.js --ado-pr https://dev.azure.com/org/proj/_git/repo/pullrequest/N` |
| Patch file | `node change-viz.js --patch <file.patch>` |
| Two folders | `node change-viz.js --before-dir <a> --after-dir <b>` |

Common options: `--out <dir>`, `--config <file>`, `--title <text>`, `--no-diffs` (no diff pane; the old
`--include-diffs` flag is accepted and ignored), `--max-full-files <n>`, `--no-game` (no review-quest layer).
Prerequisites: `gh` authenticated for GitHub; `az` with the `azure-devops` extension, logged in, for ADO.

## Workflow

1. **Scope.** Confirm the source. If the user gave feature context (a ticket or description), keep it: you will
   check it against the diff.
2. **First pass (no config).** Run the script to produce `manifest.json` (files, statuses, +/−, kind,
   auto-area, extracted test names, heuristic `hotspotSuggestions`) and `changes.patch` in the out folder.
   The suggestions are also printed to the console. They are a starting point, not the answer.
3. **Understand the change.** Read `changes.patch`. Also read before/after versions of key files: for local
   repos read the working tree and use `git show <ref>:<path>`; for PRs use the clone or `gh api`.
   For very large changes, delegate per-area summaries to parallel `explore` agents. Give each one a list of
   paths and ask for a one-line description per file plus any concerns.
4. **Write `config.json` in the out folder** (see the schema below and `config.example.json`):
   - Describe **every** file in one plain-English line, saying what changed rather than what the file is.
   - Define `areas` that match how a reviewer thinks, e.g. feature folder, shared contracts, debug pages,
     tests-only fixture updates. For .NET, group by project and put test projects with their production
     project or in a tests area. List the tests-only area **last**: areas are matched in order and shown in
     order. To route exact test paths there, use `files.<path>.area` rather than a broad earlier glob.
   - Add `notes` for anything a reviewer should know:
     - `discrepancy` — stated context vs actual code.
     - `risk` — tests removed without replacement, call sites not updated, null-safety issues, contract or
       API breaking changes, security (e.g. untrusted input reaching prompts).
     - `warn` — leftover or commented-out code, inconsistencies, TODOs, magic numbers.
     - `info` — useful context such as consolidations or renames.
   - Add `diagrams` (see guidance below). **Before AND after** component/data-flow diagrams are the
     most valued part of the page.
   - Add 3–7 `hotspots` (see "Choosing hotspots" below): the code a reviewer **must** read if they read
     nothing else, ranked `high` / `medium` / `low`, each with *why* and concrete *checks*.
   - Add 4–12 `highlights`: the most important new or changed code (contracts, entry points, core logic,
     limits), using markers rather than line numbers. Highlights explain the change; hotspots point at risk.
   - Check the auto reading path, which is printed to the console. For large PRs (roughly 15+ prod files),
     or when it misses links (DI registrations, SQL called from C#, or an SPA calling an API), add a
     `readingPath` with 3–7 steps. Give each step a meaningful title and a `why` that says what the reader
     will understand after it. Files you don't list are appended in auto order.
   - For non-trivial PRs (roughly 5+ prod files, or any logic that crosses layers), add a `walkthrough` of
     5–12 steps. Order the steps for understanding, usually entry point → contracts/data → core logic → side
     effects and ripple changes → how it is tested. Each step should say **what changed and why it matters**
     in 1–3 sentences, not repeat the code. Anchor most steps to the exact lines (`find`, optionally with `to`,
     is the most robust), keep the ranges tight (a method or a block, not a whole file), and use a text-only
     step to summarise mechanical changes such as signature ripples. Add an `intro` (the goal of the PR in
     1–2 sentences) and optionally an `outro` (what was left out). Check the manifest's `walkthrough` ranges.
5. **Regenerate** with `--config <out>\config.json` (or run the out folder's `regenerate.cmd`). Iterate until
   there are **zero warnings**: undescribed files, unmatched config entries, and missing markers.
6. **Verify rendering.** Open `file:///<out>/index.html` in the `browser` canvas, then run `evaluate_javascript`:
   `return {m: document.body.dataset.mermaid, ok: document.body.dataset.mermaidOk, err: document.body.dataset.mermaidErr}`.
   `m` must be `ok` and `err` must be `0`. Possible `m` values are `ok`, `errors`, `unavailable`, and `none`.
   A failing diagram shows its error inline; fix its mermaid and regenerate. If the page looks stale, reload it
   with `navigate_page` and `reload`. Unless you used `--no-game`, `document.body.dataset.game` should be `on`
   and `dataset.xpTotal` should be greater than 0. `document.querySelectorAll('.pf').length` should equal the
   number of changed files and, unless you used `--no-diffs`, so should `document.querySelectorAll('template').length`.
   Diagrams live in a hidden tab but still render, so the mermaid check works from any tab. Do not tick anything during verification, because that
   saves progress in the user's browser.
7. **Report** in 100 words or fewer: the output path, the regenerate command, 3–5 bullets on what the page
   shows, the discrepancies found, and proof that `git status` was unchanged (local sources).

## Pairing with a code review

This page orients the human reviewer; it is not a code review. When the user wants the change reviewed too:

1. **Run a reviewer agent on the actual diff** (`code-review`, `mimir`, or similar) in parallel with building the page.
   It must review the code, not this page or its config. Optionally pass the hotspots as starting points, but
   say they are not the only places to check.
2. **Merge its findings into the page.** Add each confirmed finding as a `notes` entry with severity `risk` or
   `warn` and its `files`. If a finding falls outside every hotspot, add or adjust a hotspot. Regenerate.
3. **Hand off.** Tell the user to read the hotspot code themselves before approving. Do not post comments,
   votes, or approvals to the PR unless the user explicitly asks.

## Config schema

```jsonc
{
  "title": "string",
  "overview": "plain text" | ["bullet", ...],               // HTML-escaped; no markdown
  "areas": [{ "name": "Area", "match": ["glob/**", "/regex/"] }], // first match wins; listed order = display order
  "files": {
    "path/to/file": "one-line description",
    "path/to/other": { "desc": "...", "area": "Area", "kind": "prod|test", "tags": ["new UI"] }
  },
  "notes": [{ "title": "...", "text": "...", "severity": "risk|warn|discrepancy|info", "files": ["path"] }],
  "diagrams": [{ "title": "...", "mermaid": "string" | ["line", ...], "caption": "...", "wide": true }],
  "highlights": [{
    "title": "...", "file": "path", "side": "after|before", "lang": "ts|cs|...", "note": "...",
    // pick one of the following:
    "code": "literal snippet",
    "start": "marker text", "end": "inclusive end marker searched after start",
    "parts": [{ "start": "...", "end": "...", "side": "before" }]   // joined with "…"
    // no code, start, or parts = the whole file
  }],
  "hotspots": [{                                              // sorted high → medium → low, then config order
    "title": "...", "level": "high|medium|low",               // default high
    "why": "why this deserves a careful read",
    "check": ["specific question the reviewer should answer", "..."],
    "files": ["path", "..."],                                 // and/or "file"; all get the 🔥 badge
    "file": "path",                                           // optional excerpt source, same snippet options as highlights
    "code" | "start"/"end" | "parts", "side": "after|before", "lang": "ts"
    // unlike highlights, no snippet option = no excerpt (not the whole file)
  }],
  "readingPath": [{                                           // optional; replaces the auto order
    "title": "Contracts first",
    "why": "what the reader understands after this step",     // string or [lines]
    "files": ["path", "glob/**", "/regex/"]                   // each file is placed once, at its first match;
                                                              // globs skip tests/deleted files unless that is all they match
  }],                                                         // unlisted files are appended in auto order
  "walkthrough": {                                            // optional; a bare array of steps also works
    "intro": "text" | ["paragraph", ...],                     // text supports `code` and **bold**
    "outro": "text" | ["paragraph", ...],
    "steps": [{
      "title": "The new front door",
      "text": "what changed and why" | ["paragraph", ...],
      "file": "path or unique path suffix",                   // omit for a text-only step
      "side": "after|before",                                 // default after (before for deleted files)
      // pick one anchor (or none = open the file without a highlight):
      "lines": "40-72" | [40, 72] | 40,                       // line numbers on that side; a replaced line's
                                                              // old/new counterpart is highlighted too
      "find": "text on a diff line", "to": "inclusive end text after find",
                                                              // without "to": the surrounding change block
                                                              // (capped at 30 lines), or "count": N lines
      "hunk": 2                                               // 1-based; every changed line in that hunk
    }]
  }
}
```
Walkthrough anchors resolve against the diff (context and changed lines), so `find` text must appear in a
hunk. Unmatched files, lines, or text give a warning; the step still renders, without a highlight.
If `readingPath` is absent, the order is computed automatically. A pattern that matches nothing gives a warning.
If `hotspots` is absent, the page shows the heuristic suggestions labelled "auto-suggested". Use
`"hotspots": []` to hide the section.
Markers are matched on LF-normalised text, so `"\n  }"` is a reliable end for a method. `side: "before"`
reads the pre-change version, which is how you highlight deleted code.

## Choosing hotspots

Aim for 3–7 entries covering roughly 10–30% of changed lines. The page shows the coverage figure. If
everything is a hotspot, nothing is. Prioritise:
- **Contracts and API surface**: DTO/interface shape changes, removed fields, nullability, versioning, and
  deploy ordering between client and service.
- **Security and trust boundaries**: new endpoints, auth policies and filter bypasses, untrusted input
  reaching LLM prompts, HTML, SQL or logs, and missing encoding or validation.
- **State and concurrency**: forkJoin/switchMap orchestration, error paths that leave UI state half-set,
  ETags/optimistic concurrency, retries, Temporal/Durable determinism, and idempotency.
- **Data loss**: deletes, migrations, and lossy transforms (e.g. a multi-value field edited through a
  single-value UI).
- **Complex new logic with thin tests**, and removed tests without replacements.
- Skip pure renames, fixture-only spec updates, formatting, and generated code.

Write `check` items as answerable questions ("Is X ever null from the API?"), not as restated code. The
heuristic suggestions score churn, sensitive paths (contract/controller/auth/config/migration…), deleted
production files, risky added patterns (auth attributes, `innerHTML`/`bypassSecurityTrust`, raw SQL, prompt
string building, concurrency/async orchestration, `catch` swallowing, secrets), and new code with no matching
test changed. Confirm each one by reading the code.

## Diagram guidance

Tint changed nodes so the before/after difference is visible at a glance:
```
classDef new fill:#e6ffec,stroke:#2da44e
classDef gone fill:#ffebe9,stroke:#cf222e
A["NewThing"]:::new
```
The page uses a dark theme (mermaid `theme:'dark'`). The script automatically remaps common light GitHub fills
(`#e6ffec`, `#ffebe9`, `#fff8c5`, `#ddf4ff`, `#fbefff`, `#f6f8fa`, `#fff`) to dark equivalents and adds light text,
so these light colors are safe to use. Avoid other light custom fills.

**Angular / SKY UX SPA**
- UI structure before/after: tabs, routes, and modal sections.
- **Component / data flow before and after**: parent → child components (`input()`/`model()`/outputs),
  form models, services, HTTP contracts, and the backend endpoints. Tint removed nodes in "before" and new
  nodes in "after".
- Contract shape: a `classDiagram` of the interfaces before vs after.

**.NET service**
- Request flow before/after: endpoint/route → controller → service → repository/Cosmos/SQL and external
  clients (GenAI, other services).
- `sequenceDiagram` for messaging, Service Bus, Temporal/Durable workflows, and callbacks.
- DTO/entity `classDiagram` for changed models. Optionally show DI registration changes.

**Mermaid pitfalls**
- Quote labels that contain special characters: `A["save() / preview"]`. Use `<br/>` for line breaks.
- Never use `end` as a node id. Avoid unquoted `()[]{}` in labels.
- For generics in a classDiagram, write `List~T~`.
- Write classDiagram members **one per line** inside `{ }`, not all on one line.
- Use `"wide": true` for diagrams with many nodes so they span the full page width.

## Notes and limits

- One script handles every language. File kind (prod/test), auto-areas, and test-name extraction understand
  TS/JS specs and C# xUnit/NUnit/MSTest projects (`*.Tests`), with a generic fallback for others.
- ADO PRs are diffed as merge-base(target, source) → source, the same way the PR "Files" tab shows them.
- Tested: local uncommitted, local range, `--gh-pr`, `--ado-pr`, `--patch`, `--no-diffs`, and `--no-game`.
  Not yet exercised: `--before-dir/--after-dir`, and the ADO fallback that fetches `refs/pull/N/merge` when the
  source commit is unreachable.
- Output folders are temporary. Tell the user they can delete `%TEMP%\change-viz*` when they are done.

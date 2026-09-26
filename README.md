# Draft Weave

**Pick the paragraphs you trust, assemble the manuscript you want, and review connective edits one by one.**

[简体中文](README.zh-CN.md) · [Model setup](docs/MODELS.md) · [Development guide](https://github.com/liulinlin718-netizen/draft-weave/blob/codex/public-release/docs/DEVELOPMENT.md)

Writers often have several drafts where each version contains something worth keeping: one has the right structure, another explains a section better, and a third has the strongest ending. Draft Weave provides a visual canvas for combining those pieces without surrendering control of the final text.

## See it work

![Actual Draft Weave review showing a protected number change blocked](docs/images/review.png)

An actual browser capture using synthetic drafts and a labeled model fixture. The proposed edit changes a protected value from **20 to 21**: Draft Weave shows the text diff, flags the protected change, and disables acceptance. Neighboring paragraphs and original source text are available in the same review card.

Start with `node server.mjs`, import your candidate drafts, select paragraphs into the final draft, and lock text that must stay unchanged. **Save current project** keeps sources, edits, locks, and review state in a recovery file, excluding undo history. The screenshot demonstrates review safeguards, not model-writing quality.

## What it does

- Import Markdown or plain-text drafts.
- Select an entire chapter, a section, or individual paragraphs from each source.
- Complete a partly selected section in source order, keeping your edits and locks; source reading positions stay in place.
- Reorder, replace, edit, and lock blocks in the assembled manuscript.
- Preview the exact concatenated result before any rewriting.
- Ask an optional model for whole-document connective edits, then accept or reject every suggestion separately.
- Export Markdown or save a project file that preserves sources, selections, locks, and review decisions.
- Download a current-project recovery file when undo history makes a full save too large.

```mermaid
flowchart LR
    A[Draft A] --> D[Selection canvas]
    B[Draft B] --> D
    C[Draft C] --> D
    D --> E[Ordered manuscript]
    E --> F{Optional polish}
    F -->|Accept selected edits| G[Final Markdown]
    F -->|Keep original text| G
```

## Quick start

Requires Node.js 22 or later and a modern browser. There are no runtime npm dependencies and no build step.

```sh
node server.mjs
```

Open `http://127.0.0.1:6410` and use the sample drafts, paste text, or import `.md` / `.txt` files.

The core workflow is deliberately direct:

1. Choose paragraphs from one or more sources.
2. Arrange them on the manuscript canvas.
3. Edit or lock blocks that must remain unchanged.
4. Preview the literal assembly.
5. Export Markdown, or review optional connective edits before exporting.

## Human-controlled polishing

Draft Weave never replaces the manuscript with a single opaque model rewrite. When a model is configured, it returns discrete suggestions tied to the current text. Each suggestion can be accepted or rejected, and edits become stale if the relevant manuscript changes.

Each review card can show neighboring paragraphs and its source passage. **Accept and next** or **Reject and next** moves to the next pending suggestion; protected and stale edits cannot be accepted.

Before sending, the app checks whether every block is locked and whether the complete request fits the input limits. It keeps all source drafts in the request and asks you to adjust oversized input. If the complete input and backend configuration still match an existing review, choose **Continue existing review** to send no new model request, or explicitly request a new polish. Request details show size, elapsed time, and usage when the backend supplies it; missing usage does not mean zero cost.

Two optional backends are supported:

- an OpenAI-compatible external API using your endpoint and key environment variable;
- a local Codex CLI profile using normal ChatGPT sign-in and account allowance.

Offline assembly and export continue to work without either backend. See [model setup](docs/MODELS.md).

## Local-first drafts

Automatic drafts live in the browser. Each open window receives its own safe copy, and conflicting windows do not silently replace one another. For portable backup or cross-browser work, use **Save project** and keep the exported project file.

Typing records a small per-block recovery journal. Complete checkpoints follow pauses, bounded intervals, and focus changes; an uninterrupted edit keeps one undo point. Storage failures show recovery options and retain the last saved copy. If the browser cannot save a new input journal, download the current project or input recovery record before closing the window.

**Save current project** downloads a `.current.draftweave.json` file directly in the browser. It preserves sources, your current text, locks, protection settings, and review decisions, and omits undo history. Restore it with **Open project**. This option does not create a server-side export, remove older drafts, or enlarge browser storage.

Server-side exports and optional runtime data stay in the project directory by default. Set `DW_DATA_DIR` before starting the server to keep writing data in a separate location:

```powershell
$env:DW_DATA_DIR = 'D:\Writing\draft-weave-data'
node server.mjs
```

## Designed for

- merging interview, report, proposal, or essay drafts;
- creating one approved narrative from several agent-generated alternatives;
- preserving exact passages while improving transitions around them;
- reviewing editorial changes as decisions rather than accepting a full rewrite.

## Scope

- Input is Markdown or plain text; DOCX import is outside this editor’s scope.
- Headings, paragraphs, blank lines, and fenced code are preserved as blocks. Draft Weave is not a full rich-text or CommonMark rendering engine.
- Number, unit, and quotation guards catch common changes but do not verify factual correctness.
- Browser drafts are local working state, not a substitute for an exported project backup.

## Repository guide

- [`public/`](public/) — the selection canvas and browser logic
- [`server/`](server/) — local server, storage boundaries, and model bridge
- [`examples/`](examples/) — sample source drafts
- [`docs/MODELS.md`](docs/MODELS.md) — optional model configuration

## Contributing

```sh
npm test
```

Issues and pull requests are welcome for selection ergonomics, import behavior, accessible editing, and suggestion review.

Licensed under the [MIT License](LICENSE).

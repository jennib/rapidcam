# RapidCAM AI integration

RapidCAM is built so AI tools — chat assistants and autonomous agents alike —
can author, check, and iterate on real, machinable designs. This guide covers
every integration surface. It is published at
**`https://rapidcam.app/docs/ai-integration.md`**; the file-format contract it
builds on lives in the [.rcam format guide](rcam-format-v2.md).

The design principle behind all of it: **optimize the AI's second attempt, not
its first.** A language model authoring CAD blind will make mistakes; what
makes the workflow reliable is a tight feedback loop — validate, solve,
dry-run the toolpaths, render — with errors reported in a form the AI can act
on. Every surface below closes that loop at a different level.

---

## The AI Assistant (in the app)

**File ▸ AI Assistant** is the copy/paste loop for people using any AI chat
(Claude, ChatGPT, Gemini, …). No API keys, no accounts — the human is the
transport.

**Step 1 — Copy a prompt.** The dialog builds a self-contained prompt and
copies it to the clipboard. It bundles:

- your machine context: machine kind, post-processor, work area, stock size
  and thickness, origin, rotary/flip setup — everything the AI must respect
  and would otherwise guess;
- your tool library, so operations reference real tools by `toolId`;
- the **complete .rcam format guide**, embedded, so it works even for models
  without web access;
- your request (typed into the dialog, or left as a placeholder to fill in
  chat).

Two modes: **New design** authors from scratch for your machine; **Modify
current design** embeds the current document (minus font/image payloads) and
asks for the complete updated file back.

**Step 2 — Paste the reply.** Paste the AI's answer — code fences and
surrounding prose are stripped automatically — and click **Check & Import**.
The paste runs the full checking pipeline (see below). On success the design
loads; the import is **undoable** (Ctrl+Z restores your previous drawing), so
a wrong modification costs nothing. On failure, **Copy Error Report for AI**
puts a markdown fix-it report on the clipboard; paste it back into the chat
and the AI corrects its own file.

### What the checker verifies

Every pasted file passes through, in order:

| Check | Catches |
|-------|---------|
| JSON | malformed output, truncated replies |
| Schema | wrong/missing fields, bad enum values (violations name the allowed values) |
| Loader | anything RapidCAM itself cannot open |
| References | operations/constraints/dimensions/bindings pointing at entities that don't exist; unknown `toolId`s |
| Solver | contradictory constraint systems that don't converge |
| Bounds | geometry outside the work area |
| Toolpath dry-run | operations that would silently produce **no cutting moves** (e.g. a profile over geometry that doesn't close) |

The last one matters most: it is entirely possible to write a file that is
schema-valid, loads, and solves — and cuts air. The dry-run generates the
actual G-code and surfaces every skip the generator would emit.

---

## Stable URLs for web-connected AIs

Everything an AI needs to author `.rcam` files is served at stable URLs,
indexed by [`/llms.txt`](https://rapidcam.app/llms.txt):

| URL | Contents |
|-----|----------|
| `https://rapidcam.app/llms.txt` | index of all of the below |
| `https://rapidcam.app/llms-full.txt` | **single-fetch bundle**: the index, format guide, JSON Schema, and this guide inlined in one file — for fetch tools that cannot follow links out of a fetched page |
| `https://rapidcam.app/docs/rcam-format-v2.md` | the authoring guide: entity/constraint/dimension vocabulary, CAM operations, gotchas |
| `https://rapidcam.app/schema/rcam-v2.schema.json` | machine-readable JSON Schema (draft 2020-12; this URL is its `$id`) |
| `https://rapidcam.app/docs/ai-integration.md` | this document |
| `https://rapidcam.app/examples/index.json` | list of bundled golden examples |
| `https://rapidcam.app/examples/<name>.rcam` | any listed example (all schema-validated on every commit) |

---

## Headless CLI

For scripts and agents working in a RapidCAM checkout (`git clone` +
`npm install`), the same pipeline runs in Node with no browser window:

```bash
npm run cli -- validate part.rcam            # the full checking pipeline above
npm run cli -- post part.rcam -o out/        # G-code (.nc) + Apollo pre-flight lint
npm run cli -- render part.rcam -o part.png  # PNG of the design via headless Chromium
```

- **`validate`** exits 0 on success (warnings allowed), 1 when any check
  fails, printing the same fix-it report the dialog produces.
- **`post`** routes by machine kind exactly as the app's export button does —
  mill, laser, rotary wrap (one wrapped program), double-sided flip (side A +
  side B) — writes the `.nc` file(s), and runs the Apollo pre-flight lint
  (bounds, over-deep, rapid-through-stock, fast plunge, fixture collisions,
  missing tool-change pauses) on each. Exits 1 if any lint **error** is found
  (files are still written).
- **`render`** boots the real app on an ephemeral dev server and screenshots
  the drawing canvas — geometry, dimensions, and stock outline exactly as
  RapidCAM draws them. First call pays a ~10 s browser boot.

---

## MCP server

The [Model Context Protocol](https://modelcontextprotocol.io) server gives MCP
clients — Claude Code, Claude Desktop, and others — the full **author →
validate → post → look at a render** loop as tools. From a RapidCAM checkout:

```bash
claude mcp add rapidcam -- npx tsx mcp/server.ts   # Claude Code
npm run mcp                                        # or run it directly (stdio)
```

| Tool | Purpose |
|------|---------|
| `get_format_guide` | the complete .rcam authoring guide (read before authoring) |
| `list_examples` / `get_example` | bundled golden example projects |
| `validate_rcam` | the full checking pipeline; returns a fix-it report |
| `post_gcode` | machine program(s) + Apollo pre-flight lint findings |
| `render_preview` | a PNG **image** of the design — the agent can look at what it made and catch geometry that validates but is wrong |

`render_preview` boots a headless browser on first call (~10 s) and reuses it
afterwards.

An effective agent loop: `get_format_guide` → author → `validate_rcam` →
fix until clean → `render_preview` → eyeball → `post_gcode` → review lint.

---

## Tips for LLM authors

The [format guide](rcam-format-v2.md) is the contract; these are the
highest-leverage habits:

- **All lengths are millimetres and all angles radians (CCW), always** —
  `displayUnit` only changes what the human sees. The world frame is Y-up.
- **You don't need perfect coordinates.** Emit rough positions plus
  constraints and driving dimensions; the parametric solver snaps geometry
  exact. For simple parts, plain coordinates with no constraints are equally
  valid — don't add constraint systems you don't need.
- **Omit what doesn't apply.** `side` is required only on `profile`
  operations; `stepdown`/`stepover` are optional with sensible defaults. A
  drill needs none of them.
- **`depth` is negative for cuts** (mm below the stock surface). A through
  cut goes slightly past the stock thickness.
- **Closed shapes can be composite.** A rounded rectangle authored as 4 lines
  + 4 tangent fillet arcs profiles as one closed loop — endpoints just have
  to meet.
- **Never author `__origin__`**, and never include `fonts`/`images` arrays;
  keep existing `fontId`/`imageId` references intact when modifying.
- **Expect a report, not applause.** When the user (or agent harness) returns
  a "RapidCAM import report", fix every listed issue and reply with the
  complete corrected file as a single JSON code block — never a diff.

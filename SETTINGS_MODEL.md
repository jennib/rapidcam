# Settings Model — machine, job, preference

Design note, agreed 2026-07-27. **No code has been written against this yet.**
It records what a setting *is*, where it should live, and what travels in a
`.rcam` file — decisions that are prerequisites for tidying the three settings
surfaces, and for any later answer on machine profiles or accounts.

## The problem this fixes

Settings are spread across three surfaces — **New Project**
(`newProjectDialog.ts`), **Machine Settings** (`postSettingsDialog.ts`) and
**Project Settings** (`settingsBar.ts`) — with no rule for which holds what.

Ten settings appear in more than one: machine type, post-processor, auto tool
changer, machine has coolant, rotary Z0, units, work area W/H, stock thickness,
origin X/Y/Z, and cylinder diameter. `machineKind` is written from three
different files (`camBar.ts`, `postSettingsDialog.ts`, `settingsBar.ts`). And
there is a true name collision: **"Program End"** in Project Settings is a park
position, **"Program end"** in Machine Settings is a custom G-code snippet.

The sharpest evidence that no principle exists sits in two *adjacent rows* of
Machine Settings:

| Row | Stored in |
| --- | --- |
| "Automatic tool changer (emit T/M6)" | the `.rcam` document |
| "Machine has coolant (M7/M8/M9)" | localStorage |

Both are capabilities of your router. One travels with the file, one does not,
and nothing distinguishes them but history. The same split separates
post-processor (document) from custom program start/end (localStorage). The
dialog's own header comment already concedes it: *"Two scopes live here, but
both read as 'my machine' to the user."*

It runs the other way too — **cylinder diameter is the rotary job's stock** (the
code calls it "the per-job cylinder", and editing it resizes `doc.canvas`), yet
it lives in Machine Settings.

So misclassification runs in both directions, which is why there is no learnable
rule for where to find anything.

## Three buckets, not two

Sorting the inventory, a residue fits neither "machine" nor "job" — units is the
clearest case, being neither the router's nor the part's, but yours.

| Bucket | Settings |
| --- | --- |
| **Machine** | post-processor (see *post per head type*) · tool changer · coolant · custom program start/end · rotary axis word · arc tolerance · sender URLs + app · tool library · laser presets · **bed** (new, optional) |
| **Job** | name / revision / notes · **sheet** W/H · stock rect + thickness · cylinder ⌀ + length · origin (WCS) · wall depth · **machine type** · **rotary Z0** |
| **Preference** | units · save-as-default · dialog position |
| **Machine default, job may override** | park position · end position |

Override is deliberately a short list. Most settings are cleanly one thing;
making everything overridable would rebuild the confusion in a new shape.

## Sheet vs bed

"Work area" was being asked to be two different things that resemble each other
only in both being rectangles. `settingsBar.ts` calls it *"the drawing/travel
frame"* — drawing **or** travel, unresolved in the comment itself.

- **Sheet** — where you draw, and the frame stock and clamps are positioned
  within. Clamps overhang the stock edge, so the sheet must exceed the stock.
  A **job** fact. This is what `doc.canvas` already is.
- **Bed** — the machine's travel envelope. A **machine** fact, identical every
  job. **This does not exist in the codebase at all** — there is no bed size and
  no travel limit anywhere today.

Work area should be **renamed to sheet** so it stops implying the machine, and
**bed added separately and optionally**. Unset by default: nothing changes, no
setup, still rapid. Set it and you get a fit check.

Making the sheet the bed would be actively wrong: it would force machine
configuration *before you can draw anything* — the friction that makes settings
feel incongruous with "rapid" — and would make files non-portable, since a
design drawn on a 1200×600 bed would be malformed rather than merely large on a
400×400 machine.

The sheet **auto-sizes from the stock unless the user enters a value.**

## A `.rcam` is a drawing, not a job ticket

**The design travels; machine configuration does not.** On open, a file
reconciles against the machine you actually have.

This resolves what looked like a stock-vs-bed conflict: stock is design (a part
for a 300×200×19 blank cannot be made from anything else, so the blank is part
of the intent), bed is machine, and their relationship is not an arbitration but
a **fit check** at open time. The design declares what it needs; the machine
declares what it has.

### Head type is design, and cannot be adapted

`machineKind` is *head × stock* — mill/laser crossed with flat/cylinder. Both
axes are design facts, and the head axis more than it first appears: the
**operations live in the file**, and laser ops (cut / score / engrave) do not map
onto mill ops (profile / pocket / drill / v-carve).

So "adapt on open" means different things per field, and must not be applied
uniformly:

- **Post-processor, coolant, custom G-code** — reconcile silently against the
  opener's machine. This is the point of the whole model.
- **Head type** — **refuse and say so.** Opening a laser design on a mill has
  nothing to adapt *to*; silently remapping would emit confident, wrong G-code.

### Post-processor must be per head type

Machine configuration is deliberately **one flat set** for now — a machine
profile *library* is out of scope until profiles and possibly accounts are
decided.

But genuinely flat contradicts machine type being per-design: a laser design
meeting a stored `linuxcnc` post is an invalid combination, today surviving only
via a fallback. The code already knows this — `postSettingsDialog` keeps
`millPost` and `laserPost` in local variables *specifically* so toggling machine
type does not lose the other.

So the machine holds **two posts, one per head type**, not one. That is
promoting an existing local workaround into real storage — two fields, not a
profile library, and the door to profiles stays shut.

### Known limit: sharing carries the author's feeds

"Share the design, not my machine settings" is roughly 90% achievable. The
remainder is baked into the operations rather than into settings: every op
carries **feedrate, plunge rate, spindle speed, tool diameter, tool number,
laser power and passes, stepdown, stepover and safe Z**, and `doc.tools` embeds
the author's actual tool definitions.

Those are the most machine- and material-specific numbers in the file, and
classification cannot move them. Not a problem to solve now, but it points at a
distinction worth knowing exists: **sharing geometry** versus **sharing a job
with toolpaths**.

## Deliberately deferred

- **Machine profile library / multiple machines.** One flat set until profiles
  are decided.
- **Accounts and cloud storage.** Raised as an answer to durability; deferred.
  Manual export/import was considered and **rejected** — users will not do it,
  and a design depending on diligence fails. Note the app currently makes zero
  server calls, and share links keep the design in the URL *fragment* so the
  server never sees it; accounts would puncture that deliberately. Decide it on
  collaboration or commercial merits, not as somewhere to park a number.
- **Fixture clearance Z** (see the workholding notes) — gains an obvious home
  once "machine" is a real category rather than a dialog title.

## Open

- **Arc tolerance** is filed under machine (controller capability); the call was
  made without strong conviction.
- Whether `hasToolChanger` and `postProcessor` leaving the document needs a
  migration for `.rcam` files in the wild that already carry them.

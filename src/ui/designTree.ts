/**
 * Left flyout Design Tree (object list): a hierarchical, live view of
 * everything in the document — layers, feature groups, entities, dimensions
 * and constraints — with per-object visibility, locking and naming.
 *
 * The panel is a *view* of the document, never a second copy of it: every row
 * reads its state from the model on each rebuild, and every control mutates
 * the model and calls `emitChange()`. That keeps it in sync with the canvas
 * for free, including after undo (`CADDocument.restore` emits too).
 *
 * Rebuilds are coalesced onto an animation frame, and skipped entirely while
 * the panel is closed, because `emitChange()` fires on hot paths (a scale drag
 * restores a snapshot per pointer move) and this tree can hold hundreds of
 * rows. A closed panel marks itself dirty and rebuilds when it reopens.
 */

import {
  CONSTRAINT_GLYPH,
  CONSTRAINT_LABELS,
  type Constraint,
  lineRefEntityId,
  SEGMENT_SEP,
} from "../model/constraints";
import { type CADDocument, ORIGIN_ENTITY_ID, STOCK_ENTITY_ID } from "../model/document";
import type { Dimension } from "../model/dimensions";
import {
  ArcEntity,
  BezierEntity,
  CircleEntity,
  type Entity,
  LineEntity,
  PolylineEntity,
  RasterImageEntity,
  RectEntity,
  TextEntity,
} from "../model/entities";
import { formatAngle, formatLengthWithUnit } from "../core/units";
import type { SolveStatusLabel } from "./statusBar";

export interface DesignTreeOptions {
  container: HTMLElement;
  doc: CADDocument;
  /** Highlight an entity on the canvas while the pointer is over its row. */
  onHoverEntity: (id: string | null) => void;
  onHoverDimension: (id: string | null) => void;
  onHoverConstraint: (id: string | null) => void;
  /** Snapshot the document *before* a tree edit, so it lands on the undo stack. */
  pushHistory: () => void;
  /**
   * Delete whatever is currently selected. Row bins select their own subject and
   * then call this, rather than removing anything themselves — the app's delete
   * already warns when geometry belongs to a toolpath, spares locked entities,
   * pushes history and re-solves, and a second delete path would drift from it.
   */
  onDeleteSelection: () => void;
}

const TYPE_ICONS: Record<string, string> = {
  line: "╱",
  circle: "◯",
  arc: "⌒",
  rectangle: "▭",
  polyline: "⌇",
  bezier: "∿",
  text: "T",
  image: "▨",
  point: "•",
};

const DIM_LABELS: Record<string, string> = {
  distance: "Distance",
  horizontal: "Horizontal",
  vertical: "Vertical",
  radius: "Radius",
  diameter: "Diameter",
  angle: "Angle",
  arclength: "Arc length",
  "line-distance": "Point to line",
  "circle-gap": "Gap",
};

export class DesignTreePanel {
  private readonly doc: CADDocument;
  private readonly onHoverEntity: (id: string | null) => void;
  private readonly onHoverDimension: (id: string | null) => void;
  private readonly onHoverConstraint: (id: string | null) => void;
  private readonly pushHistory: () => void;
  private readonly onDeleteSelection: () => void;

  private readonly panelEl: HTMLElement;
  private readonly bodyEl: HTMLElement;

  private open = false;
  private dirty = true;
  private frame = 0;
  /** True between pointer-down and pointer-up on the canvas. See setSuspended. */
  private suspended = false;
  /** Folder id → collapsed. Absent = expanded, so new folders open by default. */
  private readonly folded: Record<string, boolean> = {};
  /**
   * Key of the row whose name is being edited (`null` when none). Held across
   * rebuilds so a document change mid-edit — the solver ticking, an autosave —
   * doesn't yank the input out from under the caret.
   */
  private editing: string | null = null;
  /** Selection key at the last rebuild, so we only auto-scroll on a real change. */
  private lastSelectionKey = "";
  /** Entity id → short label ("Line 2"), rebuilt each pass. See {@link shortLabels}. */
  private labels = new Map<string, string>();
  /** Entity id → entity, rebuilt each pass, for naming constrained points. */
  private byId = new Map<string, Entity>();
  /** Latest solve status, pushed in by the app. See {@link setSolveStatus}. */
  private solveStatus: SolveStatusLabel | null = null;

  constructor(opts: DesignTreeOptions) {
    this.doc = opts.doc;
    this.onHoverEntity = opts.onHoverEntity;
    this.onHoverDimension = opts.onHoverDimension;
    this.onHoverConstraint = opts.onHoverConstraint;
    this.pushHistory = opts.pushHistory;
    this.onDeleteSelection = opts.onDeleteSelection;

    this.panelEl = document.createElement("div");
    this.panelEl.className = "design-tree-panel";

    // The panel animates from 0 to its open width, so its contents live in a
    // shell of fixed width and get clipped. Laying the header out inside a
    // collapsing box instead would reflow it on every frame of the slide — and
    // would park the close button outside the panel while closed, which the
    // unreachable-controls sweep rightly calls a broken control.
    const shell = document.createElement("div");
    shell.className = "design-tree-shell";

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "design-tree-body";

    shell.append(this.buildHeader(), this.bodyEl);
    this.panelEl.appendChild(shell);
    opts.container.appendChild(this.panelEl);

    this.doc.onChange(() => this.refresh());
    this.setOpen(false);
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.panelEl.classList.toggle("open", open);
    // Both the palette button and the keyboard can open the panel, so the
    // button's lit state hangs off the document rather than off whoever asked.
    document.body.classList.toggle("design-tree-open", open);
    // The panel is a flex sibling of the canvas host: opening or closing it
    // changes the canvas width, and the canvas only resizes its backing store
    // on a resize event. Fire one after the width transition finishes.
    this.panelEl.addEventListener(
      "transitionend",
      () => window.dispatchEvent(new Event("resize")),
      { once: true },
    );
    if (open && this.dirty) this.rebuild();
  }

  /**
   * Take the sketch's solve status, for the badge on the Constraints folder.
   *
   * The app hands over the result of the very same `solveStatusLabel()` call the
   * status bar renders, from the same solve and the same `hasUnderDefined` — so
   * the badge and the bar cannot end up telling the user different things. Do
   * not compute definedness here.
   *
   * Ignores no-op updates because a solve runs on every frame of a drag, and a
   * tree rebuild per frame is exactly what the rAF coalescing exists to avoid.
   */
  setSolveStatus(label: SolveStatusLabel | null): void {
    if (label?.short === this.solveStatus?.short && label?.color === this.solveStatus?.color)
      return;
    this.solveStatus = label;
    this.refresh();
  }

  /**
   * Hold rebuilds for the duration of a pointer gesture.
   *
   * A scale or rotate drag restores a snapshot per pointer move, so the document
   * emits on every frame; rebuilding a few thousand rows each time costs far more
   * than everything else the drag does put together (6× the whole gesture at 2000
   * entities, measured — scripts/design-tree-probe.e2e.ts). Nothing STRUCTURAL
   * changes mid-drag anyway: the same objects, in the same groups, under the same
   * names. Only the geometry in each label moves, and no one is reading it while
   * dragging. So mark dirty and catch up on pointer-up, exactly as a closed panel
   * catches up when it opens.
   */
  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
    if (!suspended && this.dirty) this.refresh();
  }

  /** Queue a rebuild for the next frame (no-op while closed — see class docs). */
  refresh(): void {
    this.dirty = true;
    if (!this.open || this.suspended || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.dirty) this.rebuild();
    });
  }

  private buildHeader(): HTMLElement {
    const header = document.createElement("div");
    header.className = "design-tree-header";

    const title = document.createElement("div");
    title.className = "design-tree-title";
    title.textContent = "Design Tree";

    const closeBtn = document.createElement("button");
    closeBtn.className = "tree-close-btn";
    closeBtn.textContent = "«";
    closeBtn.title = "Close the Design Tree (Ctrl+B)";
    closeBtn.addEventListener("click", () => this.setOpen(false));

    header.append(title, closeBtn);
    return header;
  }

  private rebuild(): void {
    this.dirty = false;
    this.bodyEl.innerHTML = "";

    const drawable = this.doc.entities.filter((e) => e.id !== ORIGIN_ENTITY_ID);
    this.labels = shortLabels(this.doc);
    // Built once per rebuild rather than per constraint row: naming the exact
    // point a constraint holds means resolving its entity, and a sketch can
    // carry far more constraints than entities.
    this.byId = new Map(this.doc.entities.map((e) => [e.id, e]));

    for (const layer of this.doc.layers) {
      const layerEnts = drawable.filter((e) => e.layerId === layer.id);
      const folder = this.folderNode({
        id: `layer:${layer.id}`,
        title: layer.name,
        count: layerEnts.length,
        color: layer.color,
        visible: layer.visible,
        locked: layer.locked,
        labelTitle: "Click to make this the active layer",
        onLabelClick: () => {
          this.doc.activeLayerId = layer.id;
          this.doc.emitChange();
        },
        onToggleVisible: () => {
          this.pushHistory();
          layer.visible = !layer.visible;
          this.doc.clearSelection(); // never leave a hidden object selected
          this.doc.emitChange();
        },
        onToggleLock: () => {
          this.pushHistory();
          layer.locked = !layer.locked;
          this.doc.clearSelection();
          this.doc.emitChange();
        },
      });
      folder.rowEl.classList.toggle("active-layer", this.doc.activeLayerId === layer.id);

      // Feature groups first (they read as assemblies), then loose geometry.
      const grouped = new Map<string, Entity[]>();
      const loose: Entity[] = [];
      for (const ent of layerEnts) {
        const g = this.doc.groupOf(ent.id);
        if (!g) {
          loose.push(ent);
          continue;
        }
        const bucket = grouped.get(g.id);
        if (bucket) bucket.push(ent);
        else grouped.set(g.id, [ent]);
      }

      for (const [groupId, ents] of grouped) {
        const def = this.doc.groups.find((g) => g.id === groupId);
        if (!def) continue;
        folder.childrenEl.appendChild(this.groupNode(def.id, def.name, ents));
      }
      for (const ent of loose) folder.childrenEl.appendChild(this.entityNode(ent));

      this.bodyEl.appendChild(folder.nodeEl);
    }

    // Hidden dimensions are the parametric engine's internal formula carriers
    // (see model/dimensions.ts) — they draw nothing and mean nothing here.
    const dims = this.doc.dimensions.filter((d) => !d.hidden);
    if (dims.length > 0) {
      const folder = this.folderNode({
        id: "section:dimensions",
        title: "Dimensions",
        count: dims.length,
        badge: "⟷",
      });
      for (const dim of dims) folder.childrenEl.appendChild(this.dimensionNode(dim));
      this.bodyEl.appendChild(folder.nodeEl);
    }

    if (this.doc.constraints.length > 0) {
      const folder = this.folderNode({
        id: "section:constraints",
        title: "Constraints",
        count: this.doc.constraints.length,
        badge: "⚯",
        // Whether the sketch is over-, under- or fully constrained belongs here
        // because this folder is where it gets fixed — the status bar tells you
        // there is a problem, this list is what you delete from to resolve it.
        status: this.solveStatus,
      });
      for (const con of this.doc.constraints) folder.childrenEl.appendChild(this.constraintNode(con));
      this.bodyEl.appendChild(folder.nodeEl);
    }

    if (drawable.length === 0 && dims.length === 0) {
      const empty = document.createElement("div");
      empty.className = "design-tree-empty";
      empty.textContent = "Nothing drawn yet.";
      this.bodyEl.appendChild(empty);
    }

    this.revealSelection();
  }

  /**
   * Bring the selection into view, but only when it actually changed — a rebuild
   * triggered by something else (a solver tick, a hover) must not fight the
   * user's own scrolling.
   */
  private revealSelection(): void {
    const key = [
      ...this.doc.entities.filter((e) => e.selected).map((e) => e.id),
      this.doc.selectedDimensionId ?? "",
      this.doc.selectedConstraintId ?? "",
    ].join(",");
    if (key === this.lastSelectionKey) return;
    this.lastSelectionKey = key;
    this.bodyEl.querySelector(".tree-row.selected")?.scrollIntoView({ block: "nearest" });
  }

  // --- node builders --------------------------------------------------------

  private folderNode(opts: {
    id: string;
    title: string;
    count?: number;
    badge?: string;
    color?: string;
    visible?: boolean;
    locked?: boolean;
    labelTitle?: string;
    onLabelClick?: () => void;
    onToggleVisible?: () => void;
    onToggleLock?: () => void;
    onRename?: (name: string) => void;
    /** Identity for the rename editor, so an in-progress edit survives rebuilds. */
    editKey?: string;
    /** Solve-status badge shown at the right of the row. */
    status?: SolveStatusLabel | null;
  }): { nodeEl: HTMLElement; rowEl: HTMLElement; childrenEl: HTMLElement } {
    const nodeEl = document.createElement("div");
    nodeEl.className = "tree-node";

    const rowEl = document.createElement("div");
    rowEl.className = "tree-row tree-folder-row";

    const collapsed = this.folded[opts.id] === true;

    const arrow = document.createElement("button");
    arrow.className = "tree-arrow";
    arrow.textContent = collapsed ? "▸" : "▾";
    arrow.title = collapsed ? "Expand" : "Collapse";

    const label = document.createElement("div");
    label.className = "tree-label-group";
    if (opts.labelTitle) label.title = opts.labelTitle;

    if (opts.color) {
      const dot = document.createElement("span");
      dot.className = "tree-color-dot";
      dot.style.backgroundColor = opts.color;
      label.appendChild(dot);
    } else if (opts.badge) {
      const badge = document.createElement("span");
      badge.className = "tree-icon";
      badge.textContent = opts.badge;
      label.appendChild(badge);
    }

    const text = document.createElement("span");
    text.className = "tree-label";
    text.textContent = opts.title;
    label.appendChild(text);

    if (opts.count !== undefined) {
      const count = document.createElement("span");
      count.className = "tree-count";
      count.textContent = String(opts.count);
      label.appendChild(count);
    }

    if (opts.onLabelClick) label.addEventListener("click", opts.onLabelClick);
    if (opts.onRename && opts.editKey)
      this.wireRename(text, opts.title, opts.editKey, opts.onRename);

    if (opts.status) {
      const badge = document.createElement("span");
      badge.className = "tree-solve-badge";
      badge.textContent = opts.status.short;
      badge.style.color = opts.status.color;
      badge.title = opts.status.tooltip;
      label.appendChild(badge);
    }

    rowEl.append(arrow, label, this.actionsEl(opts));

    const childrenEl = document.createElement("div");
    childrenEl.className = "tree-children";
    if (collapsed) childrenEl.style.display = "none";

    const fold = (): void => {
      const next = !(this.folded[opts.id] === true);
      this.folded[opts.id] = next;
      childrenEl.style.display = next ? "none" : "";
      arrow.textContent = next ? "▸" : "▾";
      arrow.title = next ? "Expand" : "Collapse";
    };
    arrow.addEventListener("click", fold);
    // A label with its own job (select the group, activate the layer) keeps it;
    // otherwise clicking anywhere on the row folds, which is what users expect.
    if (!opts.onLabelClick) label.addEventListener("click", fold);

    nodeEl.append(rowEl, childrenEl);
    return { nodeEl, rowEl, childrenEl };
  }

  private groupNode(groupId: string, name: string, ents: Entity[]): HTMLElement {
    const anyVisible = ents.some((e) => e.visible);
    const allLocked = ents.every((e) => e.locked);
    const selected = ents.length > 0 && ents.every((e) => e.selected);

    const folder = this.folderNode({
      id: `group:${groupId}`,
      title: name || "Group",
      count: ents.length,
      badge: "▣",
      visible: anyVisible,
      locked: allLocked,
      labelTitle: "Click to select the whole feature · double-click to rename",
      editKey: `group:${groupId}`,
      onLabelClick: () => {
        this.doc.clearSelection();
        for (const e of ents) e.selected = true;
        this.doc.emitChange();
      },
      onToggleVisible: () => {
        this.pushHistory();
        for (const e of ents) e.visible = !anyVisible;
        if (anyVisible) this.doc.clearSelection();
        this.doc.emitChange();
      },
      onToggleLock: () => {
        this.pushHistory();
        for (const e of ents) e.locked = !allLocked;
        this.doc.emitChange();
      },
      onRename: (newName) => {
        const def = this.doc.groups.find((g) => g.id === groupId);
        if (!def) return;
        this.pushHistory();
        def.name = newName;
        this.doc.emitChange();
      },
    });
    folder.rowEl.classList.toggle("selected", selected);

    for (const ent of ents) folder.childrenEl.appendChild(this.entityNode(ent));
    return folder.nodeEl;
  }

  private entityNode(ent: Entity): HTMLElement {
    const row = document.createElement("div");
    row.className = "tree-row tree-item";
    row.classList.toggle("selected", ent.selected);
    row.classList.toggle("hidden-item", !ent.visible);

    const label = document.createElement("div");
    label.className = "tree-label-group";
    label.title = "Click to select · double-click to rename";

    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.textContent = TYPE_ICONS[ent.type] ?? "◇";

    const text = document.createElement("span");
    text.className = "tree-label";
    text.textContent = ent.name || describeEntity(ent, this.doc.displayUnit);
    if (ent.name) text.classList.add("named");

    label.append(icon, text);

    if (ent.isConstruction) {
      const badge = document.createElement("span");
      badge.className = "tree-construction-badge";
      badge.textContent = "✎";
      badge.title = "Construction geometry";
      label.appendChild(badge);
    }

    this.wireRename(
      text,
      ent.name ?? "",
      `entity:${ent.id}`,
      (name) => {
        this.pushHistory();
        // Cleared back to empty = drop the custom name and fall back to the
        // geometric description, which is why this can't just store the input.
        ent.name = name || undefined;
        this.doc.emitChange();
      },
      describeEntity(ent, this.doc.displayUnit),
    );

    label.addEventListener("click", (ev) => {
      if (!ev.shiftKey && !ev.ctrlKey && !ev.metaKey) this.doc.clearSelection();
      ent.selected = !ent.selected;
      this.doc.emitChange();
    });

    row.append(
      label,
      this.actionsEl({
        visible: ent.visible,
        locked: ent.locked,
        onToggleVisible: () => {
          this.pushHistory();
          ent.visible = !ent.visible;
          if (!ent.visible) ent.selected = false;
          this.doc.emitChange();
        },
        onToggleLock: () => {
          this.pushHistory();
          ent.locked = !ent.locked;
          this.doc.emitChange();
        },
      }),
    );
    row.appendChild(
      this.deleteEl(
        "object",
        () => {
          this.doc.clearSelection();
          ent.selected = true;
          this.onHoverEntity(null);
        },
        ent.locked ? "Locked — unlock it to delete" : undefined,
      ),
    );

    row.addEventListener("mouseenter", () => this.onHoverEntity(ent.id));
    row.addEventListener("mouseleave", () => this.onHoverEntity(null));
    return row;
  }

  private dimensionNode(dim: Dimension): HTMLElement {
    const row = document.createElement("div");
    row.className = "tree-row tree-item";
    row.classList.toggle("selected", this.doc.selectedDimensionId === dim.id);

    const label = document.createElement("div");
    label.className = "tree-label-group";

    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.textContent = dim.driving ? "⟷" : "⟨⟩";
    icon.title = dim.driving ? "Driving dimension" : "Reference dimension";

    const text = document.createElement("span");
    text.className = "tree-label";
    text.textContent = describeDimension(dim, this.doc.displayUnit);

    label.append(icon, text);

    if (dim.expr) {
      const fx = document.createElement("span");
      fx.className = "tree-construction-badge";
      fx.textContent = "ƒx";
      fx.title = `Driven by a formula: ${dim.expr}`;
      label.appendChild(fx);
    }

    row.appendChild(label);
    row.appendChild(
      this.deleteEl("dimension", () => {
        this.doc.selectDimension(dim.id);
        this.onHoverDimension(null);
      }),
    );

    row.addEventListener("mouseenter", () => this.onHoverDimension(dim.id));
    row.addEventListener("mouseleave", () => this.onHoverDimension(null));
    row.addEventListener("click", () => this.doc.selectDimension(dim.id));
    return row;
  }

  /**
   * One constraint row: `⟂  Perpendicular   Line 1 · Line 2   🗑`.
   *
   * The subject is the whole point of this section. A bare list of type names
   * is unreadable the moment a sketch has two of anything — "Coincident,
   * Coincident, Coincident" tells you nothing about which one is holding the
   * geometry you are trying to move, which is the only question anyone opens
   * this list to answer. So each row names what it joins, carries the same
   * glyph the canvas badge draws (so eye and list agree), and can be deleted
   * in place: identify, locate by hovering, remove.
   */
  private constraintNode(con: Constraint): HTMLElement {
    const row = document.createElement("div");
    row.className = "tree-row tree-item";
    row.classList.toggle("selected", this.doc.selectedConstraintId === con.id);

    const name = CONSTRAINT_LABELS[con.type] ?? con.type;
    const subject = constraintSubject(con, this.labels, (id) => this.byId.get(id));
    row.title = subject ? `${name} — ${subject}` : name;

    const label = document.createElement("div");
    label.className = "tree-label-group";

    const icon = document.createElement("span");
    icon.className = "tree-icon tree-constraint-glyph";
    icon.textContent = CONSTRAINT_GLYPH[con.type] ?? "⚯";

    const text = document.createElement("span");
    text.className = "tree-label";
    // A locked angle's target is the constraint's whole content — without it
    // two "Lock angle" rows on the same pair of lines are indistinguishable.
    text.textContent =
      con.type === "angle" && con.params?.[0] !== undefined
        ? `${name} ${formatAngle(con.params[0])}`
        : name;

    label.append(icon, text);

    if (subject) {
      const subjectEl = document.createElement("span");
      subjectEl.className = "tree-subject";
      subjectEl.textContent = subject;
      label.appendChild(subjectEl);
    }

    row.appendChild(label);

    row.appendChild(
      this.deleteEl("constraint", () => {
        this.doc.selectConstraint(con.id);
        this.onHoverConstraint(null); // the row is about to vanish under the pointer
      }),
    );

    row.addEventListener("mouseenter", () => this.onHoverConstraint(con.id));
    row.addEventListener("mouseleave", () => this.onHoverConstraint(null));
    row.addEventListener("click", () => this.doc.selectConstraint(con.id));
    return row;
  }

  /**
   * A row's delete bin. `select` puts this row's subject — and only it — into
   * the document's selection; the app's own delete then handles the rest.
   *
   * Only leaf rows get one. Folders (a layer, a feature group) are containers,
   * and a one-click bin on a container is too easy to hit for how much it
   * removes; select the group and press Delete if that is really the intent.
   */
  private deleteEl(what: string, select: () => void, blockedBy?: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "tree-actions";
    const btn = document.createElement("button");
    btn.className = "tree-action-btn tree-action-danger";
    btn.textContent = "🗑";
    if (blockedBy) {
      // Shown but refused, rather than hidden: a bin that silently does nothing
      // (which is what deleting a locked entity would do) is worse than one that
      // says why not.
      btn.disabled = true;
      btn.title = blockedBy;
    } else {
      btn.title = `Delete this ${what}`;
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        select();
        this.onDeleteSelection();
      });
    }
    el.appendChild(btn);
    return el;
  }

  private actionsEl(opts: {
    visible?: boolean;
    locked?: boolean;
    onToggleVisible?: () => void;
    onToggleLock?: () => void;
  }): HTMLElement {
    const el = document.createElement("div");
    el.className = "tree-actions";

    if (opts.onToggleVisible) {
      const btn = document.createElement("button");
      btn.className = "tree-action-btn";
      btn.classList.toggle("off", opts.visible === false);
      btn.textContent = opts.visible === false ? "🕶" : "👁";
      btn.title = opts.visible === false ? "Show" : "Hide";
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        opts.onToggleVisible?.();
      });
      el.appendChild(btn);
    }

    if (opts.onToggleLock) {
      const btn = document.createElement("button");
      btn.className = "tree-action-btn";
      btn.classList.toggle("on", opts.locked === true);
      btn.textContent = opts.locked ? "🔒" : "🔓";
      btn.title = opts.locked ? "Unlock" : "Lock (stays selectable, but won't move)";
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        opts.onToggleLock?.();
      });
      el.appendChild(btn);
    }

    return el;
  }

  /**
   * Turn a label into a double-click-to-rename field. `editKey` identifies the
   * row so an edit interrupted by a rebuild re-opens on the new row;
   * `placeholder` shows the fallback description, so clearing the field reads
   * as "use the default".
   */
  private wireRename(
    text: HTMLElement,
    current: string,
    editKey: string,
    commit: (name: string) => void,
    placeholder?: string,
  ): void {
    const start = (): void => {
      this.editing = editKey;
      const input = document.createElement("input");
      input.type = "text";
      input.className = "tree-rename-input";
      input.value = current;
      if (placeholder) input.placeholder = placeholder;

      let done = false;
      const finish = (save: boolean): void => {
        if (done) return;
        done = true;
        this.editing = null;
        const value = input.value.trim();
        if (save && value !== current) commit(value);
        else this.refresh();
      };

      input.addEventListener("blur", () => finish(true));
      input.addEventListener("keydown", (ev) => {
        ev.stopPropagation(); // the canvas owns single-key shortcuts otherwise
        if (ev.key === "Enter") finish(true);
        else if (ev.key === "Escape") finish(false);
      });
      // Rebuilds replace the row wholesale; keeping the editor's identity here
      // lets the next one restore it (see `resume`).
      text.replaceWith(input);
      input.focus();
      input.select();
    };

    text.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      start();
    });
    if (this.editing === editKey) queueMicrotask(start);
  }
}

/** Short type names for the constraint subjects — "Line 2", not "Line 40.00 mm". */
const SHORT_TYPE: Record<string, string> = {
  line: "Line",
  circle: "Circle",
  arc: "Arc",
  rectangle: "Rect",
  polyline: "Polyline",
  bezier: "Curve",
  text: "Text",
  image: "Image",
  point: "Point",
};

/**
 * Entity id → a short, *distinguishable* label: the user's custom name when
 * there is one, otherwise the type plus a per-type ordinal in document order —
 * `Line 1`, `Line 2`, `Circle 1`, the SolidWorks convention.
 *
 * The ordinal is what makes the constraints list usable. Without it every row
 * on a rectangle's four sides reads "Line", and the list cannot answer which
 * one it means.
 */
export function shortLabels(doc: CADDocument): Map<string, string> {
  const out = new Map<string, string>();
  const counts: Record<string, number> = {};
  for (const e of doc.entities) {
    if (e.id === ORIGIN_ENTITY_ID) continue;
    const type = SHORT_TYPE[e.type] ?? e.type;
    counts[type] = (counts[type] ?? 0) + 1;
    out.set(e.id, e.name || `${type} ${counts[type]}`);
  }
  // Both are real constraint targets but neither is in `entities`: the origin is
  // the document's own datum and the stock rectangle is derived geometry.
  out.set(ORIGIN_ENTITY_ID, "Origin");
  out.set(STOCK_ENTITY_ID, "Stock");
  return out;
}

/** Friendly names for the point-DOF keys entities expose (see entities.ts). */
const POINT_NAMES: Record<string, string> = {
  a: "start",
  b: "end",
  mid: "midpoint",
  c: "centre",
  center: "centre",
  start: "start",
  end: "end",
  bl: "bottom-left",
  br: "bottom-right",
  tr: "top-right",
  tl: "top-left",
  mid_b: "bottom edge",
  mid_r: "right edge",
  mid_t: "top edge",
  mid_l: "left edge",
  p0: "start",
  p1: "handle 1",
  p2: "handle 2",
  p3: "end",
};

/**
 * Which point of an entity a constraint means — `start`, `centre`, `vertex 3` —
 * or null when naming it adds nothing (a text/image anchor, a bare point: the
 * entity *is* the point).
 *
 * Polyline vertices are keyed by stable id rather than index (so constraints
 * survive an edit that renumbers them — see polyline vertex ids), which is
 * unreadable in a list; this resolves the id back to its current position.
 */
export function pointName(e: Entity | undefined, key: string): string | null {
  if (e instanceof PolylineEntity && key.startsWith("v")) {
    const i = e.vertexIds.indexOf(key.slice(1));
    return i >= 0 ? `vertex ${i + 1}` : null;
  }
  return POINT_NAMES[key] ?? null;
}

/** The polyline edge a segment reference points at, as `edge 2`, else null. */
function segmentName(e: Entity | undefined, ref: string): string | null {
  const sep = ref.indexOf(SEGMENT_SEP);
  if (sep < 0 || !(e instanceof PolylineEntity)) return null;
  const i = e.vertexIds.indexOf(ref.slice(sep + 1));
  return i >= 0 ? `edge ${i + 1}` : null;
}

/**
 * What a constraint joins, as a display string — `Line 1 start · Circle 2 centre`.
 *
 * Grouped by entity, because a constraint routinely names one entity several
 * times and repeating its name would be noise. Where it contributes a single
 * identifiable point that point is named, which is the difference between two
 * rows reading `Fix point Line 1` twice and reading `Fix point Line 1 start` /
 * `Fix point Line 1 end`. Where it contributes several, they collapse to a
 * count rather than a list, so a row cannot grow without bound.
 *
 * Empty when nothing resolves, so the caller can fall back to the bare type
 * name rather than render a dangling separator.
 */
export function constraintSubject(
  con: Constraint,
  labels: Map<string, string>,
  geo?: (id: string) => Entity | undefined,
): string {
  // Insertion-ordered so the subject reads in the order the constraint stores
  // its operands — "point on line" names the point first, as the user picked it.
  const parts = new Map<string, string[]>();
  const add = (id: string, detail: string | null): void => {
    const label = labels.get(id);
    if (!label) return;
    const list = parts.get(label);
    if (list) {
      if (detail) list.push(detail);
    } else parts.set(label, detail ? [detail] : []);
  };

  for (const ref of con.entities) {
    const id = lineRefEntityId(ref);
    add(id, segmentName(geo?.(id), ref));
  }
  for (const p of con.points) add(p.entityId, pointName(geo?.(p.entityId), p.key));

  return [...parts.entries()]
    .map(([label, details]) => {
      if (details.length === 0) return label;
      if (details.length === 1) return `${label} ${details[0]}`;
      return `${label} (${details.length} points)`;
    })
    .join(" · ");
}

/** One-line human description of an entity, used when it has no custom name. */
export function describeEntity(e: Entity, unit: "mm" | "in" = "mm"): string {
  const len = (mm: number): string => formatLengthWithUnit(mm, unit);
  if (e instanceof LineEntity) return `Line ${len(Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y))}`;
  if (e instanceof CircleEntity) return `Circle ⌀${len(e.radius * 2)}`;
  if (e instanceof ArcEntity) return `Arc R${len(e.radius)}`;
  if (e instanceof RectEntity) return `Rectangle ${len(e.width)} × ${len(e.height)}`;
  if (e instanceof PolylineEntity)
    return e.polygon
      ? `Polygon (${e.polygon.sides} sides)`
      : `${e.closed ? "Closed" : "Open"} polyline (${e.points.length} points)`;
  if (e instanceof BezierEntity) return "Bezier curve";
  if (e instanceof TextEntity)
    return `Text "${e.text.length > 18 ? `${e.text.slice(0, 18)}…` : e.text}"`;
  if (e instanceof RasterImageEntity) return `Image ${len(e.widthMM)} × ${len(e.heightMM)}`;
  return e.type;
}

/** One-line human description of a dimension, e.g. `Diameter 35.00 mm`. */
export function describeDimension(dim: Dimension, unit: "mm" | "in" = "mm"): string {
  const label = DIM_LABELS[dim.type] ?? dim.type;
  const value = dim.type === "angle" ? formatAngle(dim.value) : formatLengthWithUnit(dim.value, unit);
  return `${label} ${value}`;
}

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

import { CONSTRAINT_LABELS, type Constraint } from "../model/constraints";
import { type CADDocument, ORIGIN_ENTITY_ID } from "../model/document";
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

export interface DesignTreeOptions {
  container: HTMLElement;
  doc: CADDocument;
  /** Highlight an entity on the canvas while the pointer is over its row. */
  onHoverEntity: (id: string | null) => void;
  onHoverDimension: (id: string | null) => void;
  onHoverConstraint: (id: string | null) => void;
  /** Snapshot the document *before* a tree edit, so it lands on the undo stack. */
  pushHistory: () => void;
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

  private readonly panelEl: HTMLElement;
  private readonly bodyEl: HTMLElement;

  private open = false;
  private dirty = true;
  private frame = 0;
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

  constructor(opts: DesignTreeOptions) {
    this.doc = opts.doc;
    this.onHoverEntity = opts.onHoverEntity;
    this.onHoverDimension = opts.onHoverDimension;
    this.onHoverConstraint = opts.onHoverConstraint;
    this.pushHistory = opts.pushHistory;

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

  /** Queue a rebuild for the next frame (no-op while closed — see class docs). */
  refresh(): void {
    this.dirty = true;
    if (!this.open || this.frame) return;
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
        if (!allLocked) this.doc.clearSelection();
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
          if (ent.locked) ent.selected = false;
          this.doc.emitChange();
        },
      }),
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
    row.addEventListener("mouseenter", () => this.onHoverDimension(dim.id));
    row.addEventListener("mouseleave", () => this.onHoverDimension(null));
    row.addEventListener("click", () => this.doc.selectDimension(dim.id));
    return row;
  }

  private constraintNode(con: Constraint): HTMLElement {
    const row = document.createElement("div");
    row.className = "tree-row tree-item";
    row.classList.toggle("selected", this.doc.selectedConstraintId === con.id);

    const label = document.createElement("div");
    label.className = "tree-label-group";

    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.textContent = "⚯";

    const text = document.createElement("span");
    text.className = "tree-label";
    text.textContent = CONSTRAINT_LABELS[con.type] ?? con.type;

    label.append(icon, text);
    row.appendChild(label);

    row.addEventListener("mouseenter", () => this.onHoverConstraint(con.id));
    row.addEventListener("mouseleave", () => this.onHoverConstraint(null));
    row.addEventListener("click", () => this.doc.selectConstraint(con.id));
    return row;
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
      btn.title = opts.locked ? "Unlock" : "Lock (stops it being picked or moved)";
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

/**
 * Tabs/bridges section (profile ops only).
 */
import type { CADDocument } from "../../../../model/document";
import type { OpState } from "../opDialogState";
import { dSection, dField, paramRow } from "../dialogDom";

export function buildTabsSection(
  doc: CADDocument,
  state: OpState,
): { root: HTMLElement; update: () => void } {
  const tabsSec = dSection("Tabs / Bridges");

  const tabEnabledWrap = document.createElement("div");
  tabEnabledWrap.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px;";
  const tabEnabledCb = document.createElement("input");
  tabEnabledCb.type = "checkbox";
  tabEnabledCb.checked = state.tabsEnabled;
  const tabEnabledLbl = document.createElement("label");
  tabEnabledLbl.textContent = "Enable tabs";
  tabEnabledLbl.style.cssText = "font-size:12px;cursor:pointer;";
  tabEnabledLbl.addEventListener("click", () => {
    tabEnabledCb.click();
  });
  tabEnabledWrap.appendChild(tabEnabledCb);
  tabEnabledWrap.appendChild(tabEnabledLbl);
  tabsSec.appendChild(tabEnabledWrap);

  const tabStrategySel = document.createElement("select");
  tabStrategySel.className = "unit";
  for (const [v, l] of [
    ["count", "By count"],
    ["spacing", "By spacing"],
  ] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    tabStrategySel.appendChild(o);
  }
  tabStrategySel.value = state.tabStrategy;
  const tabStrategyRow = dField("Tabs by", tabStrategySel);

  const tabCountRow = paramRow(
    doc,
    state,
    "tabCount",
    "Tab count",
    () => state.tabCount,
    (v) => {
      state.tabCount = Math.max(1, Math.round(v));
    },
    undefined,
    { isInteger: true, min: 1 },
  );
  const tabSpacingRow = paramRow(
    doc,
    state,
    "tabSpacing",
    `Tab spacing (${doc.displayUnit})`,
    () => state.tabSpacing,
    (v) => {
      state.tabSpacing = Math.max(1, v);
    },
    "len",
    { min: 1 },
  );
  const tabWidthRow = paramRow(
    doc,
    state,
    "tabWidth",
    `Tab width (${doc.displayUnit})`,
    () => state.tabWidth,
    (v) => {
      state.tabWidth = Math.max(0.1, v);
    },
    "len",
    { min: 0.1 },
  );
  const tabHeightRow = paramRow(
    doc,
    state,
    "tabHeight",
    `Tab height (${doc.displayUnit})`,
    () => state.tabHeight,
    (v) => {
      state.tabHeight = Math.max(0.1, v);
    },
    "len",
    { min: 0.1 },
  );
  tabsSec.appendChild(tabStrategyRow);
  tabsSec.appendChild(tabCountRow.el);
  tabsSec.appendChild(tabSpacingRow.el);
  tabsSec.appendChild(tabWidthRow.el);
  tabsSec.appendChild(tabHeightRow.el);

  const update = () => {
    const isProfile = state.combo === "profile-outside" || state.combo === "profile-inside";
    tabsSec.style.display = isProfile ? "" : "none";
    const fieldsOn = isProfile && state.tabsEnabled;
    const byCount = state.tabStrategy !== "spacing";
    tabStrategyRow.style.display = fieldsOn ? "" : "none";
    tabCountRow.el.style.display = fieldsOn && byCount ? "" : "none";
    tabSpacingRow.el.style.display = fieldsOn && !byCount ? "" : "none";
    tabWidthRow.el.style.display = fieldsOn ? "" : "none";
    tabHeightRow.el.style.display = fieldsOn ? "" : "none";
  };
  tabStrategySel.addEventListener("change", () => {
    state.tabStrategy = tabStrategySel.value as "count" | "spacing";
    update();
  });
  update();

  tabEnabledCb.addEventListener("change", () => {
    state.tabsEnabled = tabEnabledCb.checked;
    update();
  });

  return { root: tabsSec, update };
}

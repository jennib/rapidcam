import { describe, it, expect } from "vitest";
import { varPickerEntries } from "../src/ui/propertiesBar";
import { makeVariable } from "../src/model/variables";
import type { ContextMenuItem } from "../src/ui/contextMenu";

const item = (e: ReturnType<typeof varPickerEntries>[number]): ContextMenuItem =>
  e as ContextMenuItem;

describe("varPickerEntries (ƒx variable picker)", () => {
  it("shows a single hint pointing at the Variables panel when there are none", () => {
    const entries = varPickerEntries([], () => {});
    expect(entries).toHaveLength(1);
    expect(item(entries[0]).enabled).toBe(false);
    expect(item(entries[0]).label).toMatch(/no variables/i);
  });

  it("lists each variable under a header and picks by NAME (not value)", () => {
    const vars = [makeVariable("plateW", "80", "mm"), makeVariable("hole", "6", "mm")];
    const picked: string[] = [];
    const entries = varPickerEntries(vars, (n) => picked.push(n));

    expect(entries).toHaveLength(3); // header + 2
    expect(item(entries[0]).enabled).toBe(false); // "Drive by variable:" header
    expect(item(entries[1]).label).toContain("plateW");
    expect(item(entries[2]).label).toContain("hole");

    item(entries[1]).onClick();
    item(entries[2]).onClick();
    expect(picked).toEqual(["plateW", "hole"]);
  });
});

import { describe, it, expect } from "vitest";
import { previewStatusMessage } from "../src/cam/webglPreview";

describe("previewStatusMessage (3D preview overlay wording)", () => {
  it("says nothing when the block shows cuts", () => {
    expect(previewStatusMessage(true, false)).toBeNull();
    expect(previewStatusMessage(true, true)).toBeNull();
  });

  it("gives a friendly next step (not an error) when there are no toolpaths", () => {
    const msg = previewStatusMessage(false, false);
    expect(msg).toMatch(/add a toolpath/i);
    // The old wording wrongly blamed the user's geometry selection.
    expect(msg).not.toMatch(/geometry selection/i);
  });

  it("points at cut depth/geometry when toolpaths exist but remove nothing", () => {
    const msg = previewStatusMessage(false, true);
    expect(msg).toMatch(/remove no material/i);
    expect(msg).toMatch(/depth/i);
  });
});

/**
 * Central registry of every localStorage key the app uses.
 *
 * One place to see all keys (so two features can't silently collide) and the
 * only place key strings are written as literals — importing a constant instead
 * of retyping a string removes the "a typo creates a brand-new key" bug class.
 *
 * The string VALUES are frozen: changing one orphans existing users' saved data
 * (their old entry stops resolving). Only ever ADD entries here. The historical
 * inconsistency in the values (`rapidcam_` vs `rapidcam-` vs `rapidcam:` vs
 * `rcam-`) is preserved deliberately for exactly that reason.
 */
export const StorageKeys = {
  /** Analytics consent choice ("granted" | "denied"). */
  analyticsConsent: "rapidcam_analytics_consent",
  /**
   * Session-replay consent choice ("granted" | "denied"). Separate from, and
   * stricter than, `analyticsConsent`: replay records the actual on-screen
   * drawing (canvas pixels), so it requires its own explicit opt-in and
   * defaults off even when usage analytics is allowed.
   */
  analyticsReplayConsent: "rapidcam_analytics_replay_consent",
  /** Serialized user tool library. */
  toolLibrary: "rapidcam-tool-library",
  /** Custom G-code program-start snippet. */
  gcodeCustomStart: "rapidcam:gcode:customStart",
  /** Custom G-code program-end snippet. */
  gcodeCustomEnd: "rapidcam:gcode:customEnd",
  /** Whether the machine has coolant (gates M7/M8 emission). */
  machineHasCoolant: "rapidcam:machine:hasCoolant",
  /** Recently opened project list. */
  recents: "rcam-recents",
  /** Autosaved working document, restored on next launch. */
  autosaveDraft: "rapidcam:autosave-draft",
  /** Last dragged position of the toolpath dialog. */
  toolpathDialogPosition: "rapidcam:toolpath-dialog-position",
  /** Default canvas/stock settings for new projects. */
  defaultProjectSettings: "rapidcam:defaultProjectSettings",
  /** Counter for share-prompt throttling (show every Nth export). */
  sharePromptCounter: "rapidcam:sharePromptCounter",
} as const;

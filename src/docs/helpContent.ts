/**
 * Structured content dataset for the RapidCAM in-app Help Viewer.
 */

export interface HelpTopic {
  id: string;
  title: string;
  category: "Getting Started" | "2D Drafting" | "Constraints" | "CAM & Toolpaths" | "Tool Library" | "Simulation & CNC" | "Shortcuts";
  summary: string;
  keywords: string[];
  sections: {
    heading: string;
    body: string;
    tips?: string[];
  }[];
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: "getting-started",
    title: "Getting Started & Interface",
    category: "Getting Started",
    summary: "Essential workflow guide and interface overview for RapidCAM.",
    keywords: ["getting started", "pan", "zoom", "interface", "viewport", "canvas", "grid", "snap"],
    sections: [
      {
        heading: "Overview",
        body: "RapidCAM is a browser-based parametric 2D vector editor built specifically for CNC machining, laser cutting, and engraving. Design 2D vector geometry, add geometric constraints, assign CAM toolpaths, and export G-code directly to your CNC machine.",
      },
      {
        heading: "Canvas & Navigation",
        body: "Navigate the 2D viewport using standard mouse and keyboard shortcuts:",
        tips: [
          "Pan: Hold Space and Drag, or Drag with Middle Mouse Button.",
          "Zoom: Mouse Scroll Wheel, or Pinch on touchpad.",
          "Select: Click on geometry, or drag a marquee box (Shift + Drag over objects).",
          "Deselect / Cancel: Press Escape.",
        ],
      },
      {
        heading: "Workspace Panels",
        body: "The application layout is organized into 5 primary zones:",
        tips: [
          "Top Bar: Access File, Edit, View, Insert, Settings, and Help menus.",
          "Tool Palette (Left): Select CAD drawing tools (Line, Rect, Circle, Arc, Spline, Text, etc.).",
          "Design Tree (Left Sidebar): Manage design elements, layers, variables, and history.",
          "Properties Panel (Right): View and edit exact coordinates, dimensions, and constraints for selected objects.",
          "CAM Bar (Bottom): Create and manage profile, pocket, drill, laser, and V-carve toolpaths.",
        ],
      },
    ],
  },
  {
    id: "2d-drafting",
    title: "2D Parametric Drafting Tools",
    category: "2D Drafting",
    summary: "Creating and editing 2D lines, shapes, text, offsets, and patterns.",
    keywords: ["line", "rectangle", "circle", "arc", "spline", "text", "offset", "fillet", "trim", "pattern", "array"],
    sections: [
      {
        heading: "Drawing Primitives",
        body: "Select a tool from the palette or use hotkeys to draw 2D geometry:",
        tips: [
          "Line (L): Click start point, then click end point. Double-click or Escape to end.",
          "Rectangle (R): Click to set origin corner or center, then drag to dimensions.",
          "Circle (C): Click center point and drag outward for radius.",
          "Arc (A): 3-point arc creation (Start, End, and Radius/Control point).",
          "Spline (S): Click sequential control points for smooth bezier curves.",
          "Text (T): Click canvas location to insert editable true-type single/multi-line text.",
        ],
      },
      {
        heading: "Modification Tools",
        body: "Transform and refine vector contours for machining:",
        tips: [
          "Offset (O): Select contours to generate inside, outside, or center offset paths.",
          "Fillet / Chamfer (F): Click intersecting corners to add smooth rounded fillets or angled chamfers.",
          "Trim / Extend (T): Click line segments to cut back to nearest intersection.",
          "Linear / Circular Patterns: Create repeating arrays of selected geometry along X/Y axes or around a pivot point.",
          "Construction Geometry (X): Toggle selected entities into non-machining reference lines.",
        ],
      },
    ],
  },
  {
    id: "constraints",
    title: "Geometric Constraints & Variables",
    category: "Constraints",
    summary: "Locking design intent with geometric rules and parametric equations.",
    keywords: ["constraint", "horizontal", "vertical", "coincident", "parallel", "perpendicular", "equal", "dimension", "variable"],
    sections: [
      {
        heading: "Applying Constraints",
        body: "Geometric constraints enforce relationships between points and entities:",
        tips: [
          "Horizontal (H) / Vertical (V): Force lines parallel to X or Y coordinate axes.",
          "Coincident (C): Connect endpoints or lock a point onto a curve.",
          "Parallel (P) / Perpendicular (K): Lock angle relationships between two lines.",
          "Equal (E): Set equal length for lines or equal radius for circles/arcs.",
          "Fix / Lock: Pin geometry to fixed workspace coordinates.",
        ],
      },
      {
        heading: "Parametric Variables & Expressions",
        body: "Use the Variables panel (`Ctrl+B`) to define named parameters (e.g. `stock_width = 120`, `pocket_depth = 6.35`). Dimension fields in the Properties panel accept math expressions using variables (e.g. `#stock_width / 2`).",
      },
    ],
  },
  {
    id: "cam-toolpaths",
    title: "CAM & Toolpath Generation",
    category: "CAM & Toolpaths",
    summary: "Creating profiles, pockets, v-carves, drills, and laser operations.",
    keywords: ["cam", "toolpath", "profile", "pocket", "engrave", "v-carve", "drill", "laser", "feed", "speed", "tab"],
    sections: [
      {
        heading: "Toolpath Operations",
        body: "Generate toolpaths from closed or open vector contours:",
        tips: [
          "Profile / Contour: Cut along, inside, or outside vector boundaries. Supports multi-pass stepdown and 3D holding tabs.",
          "Pocketing: Clear material inside enclosed contours with raster or offset clearing paths.",
          "V-Carve / Engraving: Carve variable-depth chamfers or decorative text using V-groove bits.",
          "Drill: Peck or direct drilling at center points of selected circles.",
          "Laser Cut / Engrave: Power presets, vector line cutting, and raster image engraving.",
        ],
      },
      {
        heading: "Machining Parameters & Tabs",
        body: "Configure Cut Depth (Z Start, Target Depth), Pass Depth (Stepdown), Stepover %, and Feeds & Speeds. Add holding tabs to profile paths to prevent parts from breaking free during final passes.",
      },
    ],
  },
  {
    id: "tool-library",
    title: "Tool Library & Post-Processors",
    category: "Tool Library",
    summary: "Managing cutting tools, endmills, lasers, and G-code dialects.",
    keywords: ["tool library", "endmill", "ballnose", "v-bit", "laser", "post processor", "grbl", "mach3", "linuxcnc"],
    sections: [
      {
        heading: "Tool Library Setup",
        body: "Manage your cutting tool roster in the Tool Library (`Help` -> `Tool Library` or CAM Bar). Define tool type, diameter, flute length, number of flutes, default RPM, and plunge/feed rates.",
      },
      {
        heading: "Post-Processor Selection",
        body: "Choose the target G-code dialect for your CNC controller in Post Settings (`CAM Bar` -> `Post Processor`):",
        tips: [
          "GRBL / Candle / Universal Gcode Sender (UGS)",
          "LinuxCNC / Machinekit",
          "Mach3 / Mach4",
          "Carbide Motion / Shapeoko / Nomad",
          "Custom G-code formatting (custom headers, footers, spindle control syntax)",
        ],
      },
    ],
  },
  {
    id: "simulation-cnc",
    title: "Simulation & Machine Control",
    category: "Simulation & CNC",
    summary: "2D/3D toolpath preview, stock rasterization, and direct G-code sending.",
    keywords: ["simulation", "3d preview", "stock", "gcode", "export", "webserial", "sender", "cnc"],
    sections: [
      {
        heading: "2D & 3D Toolpath Preview",
        body: "Verify toolpaths before cutting on raw stock. Toggle between 2D view and 3D Stock Preview to visualize depth of cut, rapid moves (G0), feed moves (G1/G2/G3), and remaining stock material.",
      },
      {
        heading: "G-Code Export & Direct Sender",
        body: "Export `.gcode` / `.nc` files via `File` -> `Export G-Code`, or open the built-in Machine Sender to stream commands directly over USB via WebSerial.",
      },
    ],
  },
  {
    id: "shortcuts-reference",
    title: "Keyboard Shortcuts & Hotkeys",
    category: "Shortcuts",
    summary: "Complete reference for single-key tools, editing, and viewport hotkeys.",
    keywords: ["shortcuts", "keyboard", "hotkeys", "reference", "f1", "ctrl", "undo", "redo"],
    sections: [
      {
        heading: "Drawing & Selection Tools",
        body: "Single key tool switches:",
        tips: [
          "S: Select Tool / Spline",
          "L: Line Tool",
          "R: Rectangle Tool",
          "C: Circle Tool",
          "A: Arc Tool",
          "T: Text Tool / Trim",
          "O: Offset Tool",
          "F: Fillet Tool",
          "X: Construction Geometry Toggle",
        ],
      },
      {
        heading: "Editing & Document Shortcuts",
        body: "Standard keyboard bindings:",
        tips: [
          "F1: Open User Documentation & Guide",
          "?: Open Quick Keyboard Shortcuts Reference",
          "Ctrl+Z / Ctrl+Y: Undo / Redo",
          "Ctrl+C / Ctrl+V / Ctrl+X: Copy / Paste / Cut",
          "Ctrl+D: Duplicate Selection",
          "Ctrl+A: Select All",
          "Delete / Backspace: Delete selected entities",
          "Ctrl+G / Ctrl+Shift+G: Group / Ungroup",
          "Ctrl+B: Toggle Design Tree",
        ],
      },
    ],
  },
];

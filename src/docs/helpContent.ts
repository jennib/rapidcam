/**
 * Structured content dataset for the RapidCAM in-app Help & Documentation Viewer.
 * Contains comprehensive guides for CAD drafting, geometric constraints, CAM strategies,
 * tool library, laser engraving, feeds & speeds, post-processors, 3D simulation, and CNC control.
 */

import { toolReferenceRows } from "../tools/shortcuts";

export interface HelpCallout {
  type: "tip" | "note" | "warning" | "best-practice";
  title?: string;
  text: string;
}

export interface HelpTable {
  headers: string[];
  rows: string[][];
}

export interface HelpCodeSnippet {
  title?: string;
  code: string;
}

export interface HelpSection {
  heading: string;
  body: string;
  tips?: string[];
  callout?: HelpCallout;
  table?: HelpTable;
  codeSnippet?: HelpCodeSnippet;
}

export interface HelpTopic {
  id: string;
  title: string;
  category:
    | "Getting Started"
    | "2D Drafting"
    | "Constraints"
    | "CAM & Toolpaths"
    | "Laser Machining"
    | "Tool Library & Speeds"
    | "Post-Processors & G-Code"
    | "Simulation & CNC"
    | "Shortcuts";
  summary: string;
  keywords: string[];
  sections: HelpSection[];
}

export const HELP_TOPICS: HelpTopic[] = [
  // ==========================================
  // 1. GETTING STARTED
  // ==========================================
  {
    id: "getting-started",
    title: "Getting Started & Interface Overview",
    category: "Getting Started",
    summary: "Welcome to RapidCAM — a modern parametric 2D CAD/CAM environment designed for CNC routers, mills, laser cutters, and engravers.",
    keywords: ["getting started", "welcome", "interface", "overview", "pan", "zoom", "canvas", "panels", "workflow"],
    sections: [
      {
        heading: "Welcome to RapidCAM",
        body: "RapidCAM brings parametric sketch modeling, 2D vector CAD, geometric constraint solving, and multi-operation CAM toolpath generation directly into a responsive, high-performance interface. From rough concept to finished G-code, your entire workflow stays synchronized in real time.",
        callout: {
          type: "tip",
          title: "Core Workflow at a Glance",
          text: "1. Draft 2D Vector Geometry → 2. Apply Geometric Constraints & Driving Dimensions → 3. Assign CAM Toolpaths (Profile, Pocket, Drill, V-Carve, Laser) → 4. Preview & 3D Simulate → 5. Export the G-Code, or send it to gSender, ncSender or GEditor.",
        },
      },
      {
        heading: "Viewport Navigation & Mouse Controls",
        body: "Seamlessly navigate the 2D design workspace using intuitive mouse gestures and keyboard shortcuts:",
        tips: [
          "Pan Canvas: Hold (Space + Left Click Drag), or click and drag with the (Middle Mouse Button).",
          "Zoom: Roll the (Mouse Scroll Wheel), or pinch on multi-touch trackpads. RapidCAM zooms directly toward your cursor position.",
          "Select Objects: Left-click on any line, arc, or shape. Hold (Shift) while clicking or dragging a marquee box to multi-select.",
          "Deselect / Cancel Action: Press (Escape) or click on empty canvas space.",
          "Fit View: View menu → Fit View, or right-click the canvas → Fit View, to auto-center and frame all geometry. (There is no single-key shortcut — F is the Fillet tool.)",
        ],
      },
      {
        heading: "Workspace Layout & Panels",
        body: "The RapidCAM interface is organized into dedicated functional zones to maximize drafting and machining efficiency:",
        tips: [
          "Top Menu Bar: Access project management (File), editing operations (Edit), viewport toggles (View), vector generator wizards (Insert), and documentation (Help).",
          "Tool Palette (Left Rail): Quick access to CAD drawing primitives (Line, Rect, Circle, Arc, Polyline, Bezier, Polygon, Slot, Text, Dimension, Measure, Fillet, Trim, Extend, Offset, Mirror, Rotate, Scale).",
          "Design Tree (Left Sidebar - Toggle with Ctrl+B): Hierarchical tree displaying all geometric entities, layers, and active constraints.",
          "Properties Panel (Right Sidebar): Real-time parameter inspector for selected entities, driving dimensions, constraint overrides, and layer styling.",
          "CAM Operations Bar (Bottom Dock): Configure stock dimensions, create toolpath operations (Profile, Pocket, V-Carve, Drill, Laser), manage the Tool Library, run 3D Simulation, and export G-Code.",
        ],
      },
    ],
  },

  // ==========================================
  // 2. 2D DRAFTING PRIMITIVES
  // ==========================================
  {
    id: "2d-drafting",
    title: "2D Drawing Primitives",
    category: "2D Drafting",
    summary: "Comprehensive guide to drawing lines, polylines, circles, arcs, beziers, slots, polygons, and text.",
    keywords: ["line", "polyline", "rectangle", "circle", "arc", "bezier", "spline", "polygon", "slot", "text", "font", "truetype", "primitives"],
    sections: [
      {
        heading: "CAD Drawing Tools Roster",
        body: "Select any tool from the left palette or tap its single-key shortcut to begin drawing on the active grid:",
        tips: [
          "Select Tool (V / Esc): Pick, move, stretch, or multi-select geometry. Drag vertices to dynamically solve constraints.",
          "Line Tool (L): Click start point, then click end point — or, after the first click, type an exact length and angle instead of clicking (Type to Draw). Either field alone works: a length keeps the direction you are pointing, an angle keeps the distance. Hold (Shift) to lock horizontal or vertical.",
          "Polyline Tool (P): Draw a connected chain of straight segments. Click each vertex, or type an exact length and angle for each one (Type to Draw). Click the first vertex again to close the loop; (Enter) or double-click finishes it open; (Backspace) steps back a vertex; (Esc) discards it.",
          "Rectangle Tool (R): Click first corner, then drag or click the opposite corner — or type an exact width and height (Type to Draw). Hold (Alt) to draw from the centre instead of a corner.",
          "Circle Tool (C): Click the centre and drag outward to define the radius, or type an exact diameter (Type to Draw).",
          "Arc Tool (A): Click Center → Start → End. Type an exact arc length instead of clicking the end, and press (Tab) to flip the arc's direction.",
          "Bezier Curve Tool (B): Create smooth cubic Bezier splines. Click the start and end anchors — or type the chord's exact length and angle — then click the two tangent control handles. The handles are mouse-only: a control arm has no dimension to type.",
          "Slot Tool (U): Create elongated obround slots. Click two centre points, then drag the width out or type it exactly.",
          "Polygon Tool (N): Generate regular polygons (triangles, pentagons, hexagons, octagons, etc.). Type the side count and an exact diameter — measured across the flats, the machinist convention — or click the centre then a vertex.",
          "Text Tool: Click where you want the text, then enter it and pick the font in the dialog that opens — the glyphs preview live on the canvas. Any outline font (TrueType, OpenType or WOFF) works: Roboto ships with the app; add more from a file on your computer or from the web.",
        ],
      },
      {
        heading: "Where Fonts Come From",
        body: "Text is cut from the glyph outlines of a real font, so every character becomes closed contours the toolpaths can follow. Roboto Regular and Bold ship with the app. Beyond those, load a .ttf, .otf or .woff from your computer, or use \"Add a font from the web…\" to search Google's families and download one. Either way the font is saved inside the .rcam project, so the design still cuts on a machine with no internet — unless the font's own license forbids embedding, which RapidCAM will tell you at the time.",
        callout: {
          type: "best-practice",
          title: "Text for CNC Machining",
          text: "Outline fonts give each stroke two edges, so an Engrave toolpath traces both sides of every letter. For sign lettering, V-Carve the text instead — the bit's angle produces the tapered serif look from the same outlines — or Pocket it to clear the interior.",
        },
      },
      {
        heading: "Construction Geometry & Snapping",
        body: "Any drawn entity can be converted to non-machining construction geometry by selecting it and pressing (X). Construction lines are drawn dashed and act as geometric reference guides for constraints without generating toolpaths.",
        tips: [
          "Grid Snapping: Automatically snaps cursor to defined grid intervals.",
          "Endpoint & Midpoint Snapping: Snaps to vertices and exact mid-lengths of lines and arcs.",
          "Center & Quadrant Snapping: Snaps to circle/arc centers and 0°, 90°, 180°, 270° cardinal points.",
          "Intersection Snapping: Snaps to exact intersections between intersecting entities.",
          "Orthogonal Snap: Hold (Shift) while drawing lines to snap along 0°, 45°, 90°, 135°, and 180° axes.",
        ],
      },
    ],
  },

  // ==========================================
  // 3. 2D MODIFICATION & TRANSFORMATION
  // ==========================================
  {
    id: "cad-modifications",
    title: "Modification, Transform & Vector Editing",
    category: "2D Drafting",
    summary: "Master trimming, fillets, chamfers, offsets, mirrors, rotational arrays, scaling, joining, and exploding vector paths.",
    keywords: ["fillet", "chamfer", "trim", "extend", "offset", "mirror", "rotate", "scale", "join", "explode", "measure", "dimension"],
    sections: [
      {
        heading: "Vector Modification Tools",
        body: "Shape, trim, and prepare your vector contours for optimal machining:",
        tips: [
          "Fillet Tool (F): Click two intersecting lines or a polyline vertex to insert a smooth tangential circular arc. Drag away from the corner to size it by eye, or click it and type an exact radius.",
          "Chamfer Tool: Bevel a sharp corner by a symmetric distance — the same setback along both legs. Drag away from the corner to size it by eye, or click it and type an exact distance.",
          "Trim Tool (T): Click any segment or curve to trim it back to the nearest intersecting boundary.",
          "Extend Tool (E): Click near the endpoint of a line or arc to extend it until it reaches the next boundary edge.",
          "Offset Tool (O): Select open or closed contours to generate concentric inside, outside, or dual offsets with sharp, miter, or rounded corners.",
          "Mirror Tool (M): Select entities, then click two points on the canvas to define a reflection axis line.",
          "Rotate Tool (Q): Select entities, then drag to rotate them about the pivot. For an exact angle, add an angle dimension or drive the entity's Angle field from the properties panel.",
          "Scale Tool (S): Select entities and drag to resize them uniformly about a reference point. For a non-uniform stretch, use the Select tool's transform box handles instead.",
        ],
      },
      {
        heading: "Path Joining & Exploding",
        body: "Toolpaths (especially Profile and Pocket) require closed, continuous vector loops for proper inside/outside detection.",
        tips: [
          "Join Paths (Ctrl+J): Select multiple touching line and arc segments and merge them into a single continuous closed polyline loop.",
          "Explode Paths (Ctrl+Shift+E): Break complex polylines, rectangles, and text blocks into individual fundamental line and arc primitives.",
          "Measure Tool (I): Measure distance, delta X/Y, angle, total perimeter, and enclosed area between any two points or contours.",
          "Dimension Tool (D): Click anywhere on two things, then click to place. What you picked decides what it measures — two points give a distance (or ΔX/ΔY, from the direction you drag out), a point and an edge give the perpendicular distance to that edge, two parallel edges give the gap between them, and two crossing edges give the angle. The value previews live as you position it.",
          "Dimension Tool — one thing on its own: pick it, then click open space. An edge gives its own length; a full circle gives its diameter, an arc its radius. Tab cycles the alternatives — radius vs diameter, an arc's length, or a line's angle from horizontal (the X axis has nothing to click, so Tab is the only way to reach it).",
        ],
        callout: {
          type: "note",
          title: "Closed Contours for Pockets & Profiles",
          text: "When creating a Pocket or Profile Outside toolpath, ensure your vector contour is fully closed (endpoints connected). RapidCAM's Join command (Ctrl+J) automatically detects endpoint tolerances and welds open chains.",
        },
      },
    ],
  },

  // ==========================================
  // 4. GEOMETRIC CONSTRAINTS ENGINE
  // ==========================================
  {
    id: "constraints",
    title: "Geometric Constraints & Parametric Engine",
    category: "Constraints",
    summary: "Lock design intent using 2D geometric rules, driving dimensions, parametric variables, and real-time solver feedback.",
    keywords: [
      "constraint",
      "parametric",
      "solver",
      "degrees of freedom",
      "dof",
      "coincident",
      "horizontal",
      "vertical",
      "parallel",
      "perpendicular",
      "equal",
      "concentric",
      "tangent",
      "midpoint",
      "collinear",
      "symmetric",
      "variables",
      "formula",
    ],
    sections: [
      {
        heading: "What are Geometric Constraints?",
        body: "Geometric constraints define mathematical relationships between points, lines, circles, and arcs. Instead of manually moving vertices when a dimension changes, constraints maintain your design intent (e.g., keeping two lines parallel, a hole centered, or two circles concentric) while the solver dynamically updates connected geometry.",
      },
      {
        heading: "Complete Constraints Roster & Visual Glyphs",
        body: "RapidCAM supports 18 distinct geometric constraint types. Select the relevant entities, then click the glyph on the CONSTRAINTS toolbar above the canvas — constraints have no keyboard shortcuts, because every letter is already bound to a drawing tool:",
        table: {
          headers: ["Constraint", "Glyph", "Description & Entity Requirements"],
          rows: [
            ["Coincident", "[+]", "Binds 2 endpoints together, or pins a point to a circle/arc center."],
            ["Horizontal", "[H]", "Forces a line horizontal, or aligns 2 points along the same Y level."],
            ["Vertical", "[V]", "Forces a line vertical, or aligns 2 points along the same X position."],
            ["Parallel", "[∥]", "Locks two lines to share the exact same slope/angle."],
            ["Perpendicular", "[⟂]", "Locks two lines to maintain a strict 90° right angle."],
            ["Equal", "[=]", "Enforces identical length on 2 lines, or identical radius on 2 circles/arcs."],
            ["Concentric", "[◎]", "Pins the center points of 2 or more circles/arcs together."],
            ["Tangent", "[T]", "Enforces smooth C1 tangential continuity between a line and circle/arc, or between 2 arcs."],
            ["Point on Line", "[—]", "Constrains a point to slide strictly along a line's infinite vector."],
            ["Point on Arc", "[⌒]", "Constrains a point to lie along an arc's curve perimeter."],
            ["Point on Circle", "[○]", "Constrains a point to lie along a circle's circumference."],
            ["Midpoint", "[M]", "Pins a point to the exact midpoint of a line segment."],
            ["Collinear", "[◀▶]", "Forces 2 or more line segments onto the same infinite straight trajectory."],
            ["Symmetric", "[↔]", "Mirrors 2 points symmetrically across a chosen center axis line."],
            ["Lock Angle", "[∠]", "Locks the exact angular opening between two intersecting lines."],
            ["Fix Point", "[⊕]", "Pins a specific point's X/Y coordinates in world space."],
            ["Follow Centre", "[⌖]", "Binds a child point to dynamically track an entity's center point."],
            ["Fix Entity", "[⚓]", "Locks an entire entity in place to prevent solver displacement."],
          ],
        },
      },
      {
        heading: "Parametric Variables & Formulas",
        body: "Define named variables in the Variables panel (right sidebar, Draw tab) with \"+ Add variable\", then drive an entire model from a few master values. Refer to a variable by its bare name — there is no prefix or sigil. Names must be valid identifiers: letters, digits and underscores, not starting with a digit.",
        codeSnippet: {
          title: "Example Parametric Variables & Formulas",
          code: "plate_width = 240\nplate_height = 120\nmaterial_thickness = 12.7mm\nhole_dia = 1/4in\nhole_margin = material_thickness * 1.5\npocket_depth = material_thickness - 3",
        },
        tips: [
          "Supported operators: + - * / and ^ (exponentiation), with parentheses for grouping. There are no functions (no sqrt/sin/min) and no modulo.",
          "A value can be a plain number, a length with units (50mm, 3.5in, 1/2in, 3 1/4in), or a formula referencing other variables. Variables may reference each other in any order — the solver resolves them in dependency order.",
          "Built-in keywords are available in any formula: `stock` (material thickness), `stock_width` / `stock_height` (the blank), `sheet_width` / `sheet_height` (the work area), `origin_x` / `origin_y` / `origin_z` (the WCS datum), `pi` and `e`, and `counter` / `serial` (an incrementing serial number). A rotary job offers `stock_diameter`, `stock_length`, `stock_circumference` and `stock_wall` instead of the flat width/height. A user variable with the same name overrides a built-in.",
          "Inside a FORMULA a bare number is millimetres, regardless of the project's display unit — the same rule dimension and CAM formulas use. A bare number entered on its own is read in the display unit, so write `12.7mm` or `0.5in` when you mean a specific length.",
          "Any numeric field with an ƒx badge can be driven by a formula too — click the badge to pick a variable, or type an expression straight into the field.",
          "Global propagation: updating a variable re-solves the sketch, regenerates parametric features, and re-evaluates CAM operation formulas.",
        ],
      },
      {
        heading: "Solver Health & Degrees of Freedom (DOF)",
        body: "The 2D constraint solver evaluates workspace health in real time, colour-coding each piece of geometry by how much freedom it has left. The status bar carries the whole-sketch summary — 'Fully constrained', or 'Under-constrained · N free' with the number of remaining degrees of freedom.",
        tips: [
          "Under-constrained (blue): the geometry has degrees of freedom left and can still move, turn or resize. This is the normal state while you are drafting.",
          "Fully constrained (its layer colour): every position, size and orientation is locked. Geometry drops back to the colour of its layer once nothing about it is free — that return to normal is the signal. Recommended for production parts.",
          "Over-constrained / conflict (red): redundant or contradictory constraints. Open the Design Tree (Ctrl+B) and delete one of the constraints involved from the Constraints section.",
          "The Design Tree (Ctrl+B) says the same thing per entity in words: its icon is blue for under-constrained, green for fully constrained and red for conflicting, with the state on hover.",
        ],
      },
    ],
  },

  // ==========================================
  // 5. CAM TOOLPATH GENERATION
  // ==========================================
  {
    id: "cam-toolpaths",
    title: "CAM Operations & Toolpath Strategies",
    category: "CAM & Toolpaths",
    summary: "In-depth guide to 2D Profile milling, pocketing strategies, V-carving, inlay, drilling, 3D holding tabs, and dogbone corner reliefs.",
    keywords: [
      "cam",
      "profile",
      "contour",
      "pocket",
      "v-carve",
      "inlay",
      "drill",
      "tabs",
      "dogbone",
      "t-bone",
      "stepdown",
      "stepover",
      "climb",
      "conventional",
      "roughing",
      "finishing",
    ],
    sections: [
      {
        heading: "Toolpath Operations Overview",
        body: "RapidCAM provides dedicated machining strategies for CNC routers, mills, and engraving machines:",
        tips: [
          "2D Profile / Contour: Cut along, outside, or inside closed/open vector contours. Ideal for cutting parts out of stock sheets.",
          "Pocketing: Clear enclosed cavities to a specified depth using raster or offset spiral clearing paths.",
          "V-Carve (3D Engraving): Create crisp lettering and decorative carvings with variable-depth 3D toolpaths using V-groove bits (60°, 90°, 120°).",
          "V-Carve Inlay: One design carved into two boards — a pocket in board A and a mirrored plug in board B — which you saw off, flip, and glue into the pocket.",
          "Drill Operation: Plunge or peck-drill holes at the centers of selected circles or points.",
          "Laser Cut / Engrave: Power presets, kerf compensation, vector scoring, and raster image engraving.",
        ],
      },
      {
        heading: "Profile Cutting & Holding Tabs",
        body: "When cutting completely through a sheet of stock material, parts will break loose and vibrate or jam the spinning cutter during the final pass. RapidCAM includes smart 3D holding tabs to keep parts firmly anchored to the stock frame until machining completes.",
        tips: [
          "Tab Width & Height: Configurable tab geometry (e.g. 5mm wide by 2mm high).",
          "Tab Styles: Triangular (ramped up/down for smoother high-speed machine motion) or Rectangular.",
          "Automatic & Manual Placement: Automatically place N tabs per contour, or click along the vector path to drop tabs at exact locations.",
        ],
        callout: {
          type: "tip",
          title: "Climb vs Conventional Milling",
          text: "Climb Milling (tool rotates in the direction of feed) produces superior surface finish and longer tool life on rigid CNC machines. Conventional Milling is recommended for manual machines or CNC routers with backlash.",
        },
      },
      {
        heading: "Automatic Dogbone & T-Bone Corner Relief",
        body: "Because CNC endmills are round cylinders, they cannot cut sharp internal 90° inside corners, leaving an uncut radius equal to the tool radius. This prevents square mating tenons or tabs from fitting flush in mortises and box joints.",
        callout: {
          type: "best-practice",
          title: "Automatic Corner Overcut (Dogbone Relief)",
          text: "Enable 'Dogbone Overcut' in your Profile operation settings. RapidCAM automatically calculates corner trajectories and extends the toolpath just enough into internal sharp corners so square parts slide together perfectly without manual filing!",
        },
      },
      {
        heading: "Facing & Surfacing",
        body: "A facing toolpath skims a surface flat, and is the one operation that needs no geometry selected — it takes its extent from the job. Choose whether it skims the blank or the spoilboard, and it runs the cutter a full tool radius past every edge, which is what cleans up a blank that is slightly over size or out of square.",
        callout: {
          type: "warning",
          title: "Surfacing the spoilboard is its own job",
          text: "It cuts your wasteboard, with the machine empty. Take the workpiece off, check no clamp stands in the way, and zero X, Y and Z on the spoilboard itself — not on stock. RapidCAM posts a setup banner into the program and refuses to pass pre-flight if a spoilboard pass shares a program with cutting toolpaths: one Z zero cannot be right for both.",
        },
      },
      {
        heading: "Pocketing Strategies: Offset, Adaptive and Raster",
        body: "Choose the clearing pattern for your pocket operations. The first two differ in how hard they work the cutter, not in the shape they leave:",
        tips: [
          "Offset (contour-parallel): concentric contours worked from the inside out, wrapping islands without lifting. Fast, but the load follows the shape of the wall — the first loop is a full-width slot in solid stock, a corner runs about 1.5× the straight-wall load, and a neck narrower than two passes is another slot.",
          "Adaptive: the same contours, with trochoidal circles wherever the cutter would otherwise be buried deeper than a straight stepover — so the load is set by the advance per circle instead of by the wall. Much kinder to small cutters and to deep passes in hard material; the path is several times longer, so it trades machine time for tool life.",
          "Raster Clearing: Scans back and forth across the pocket at a specified angle, followed by an optional perimeter cleanup pass.",
          "Rest machining: set \"Rest: previous tool ⌀\" to the cutter that already roughed the pocket, and this operation cuts only what that one couldn't reach — the corner radii it left, and any channel too narrow for it. A round pocket has nothing to leave, and the program says so rather than cutting air.",
          "Island Detection: Automatically detects and preserves internal features, bosses, and holes inside the pocket perimeter.",
          "Stepover Percentage: Recommended 40%–50% of tool diameter for roughing pockets in wood and plastics; 20%–40% in metals.",
        ],
      },
      {
        heading: "V-Carve & 3D Sign Making",
        body: "V-Carve calculates continuous 3D Z-height moves based on the width between opposing vector boundaries. Where boundaries are narrow, the V-bit lifts; where boundaries widen, the V-bit plunges deeper to form crisp, sharp corners that are impossible with standard cylindrical endmills. Enable 'Flat Depth' to clear wide pockets with a flat endmill before finishing details with the V-bit.",
      },
      {
        heading: "V-Carve Inlay",
        body: "A V-carve inlay cuts one design into two boards from a single operation. Board A gets the pocket (a V-carve to a flat floor at the pocket depth); board B gets the plug — the same design inside a boundary, the surrounding field cleared and mirrored so the plug is the correct hand once flipped and glued. The glue gap makes the plug slightly narrower than the pocket at every depth (by the gap times the tangent of half the bit angle), leaving room for the glue; the saw allowance deepens only the male, leaving stock to saw and plane flush.",
      },
    ],
  },

  // ==========================================
  // 6. LASER CUTTING & RASTER ENGRAVING
  // ==========================================
  {
    id: "laser-machining",
    title: "Laser Cutting & Raster Photo Engraving",
    category: "Laser Machining",
    summary: "Vector cutting, line scoring, kerf compensation, power scaling, and high-detail raster image engraving.",
    keywords: ["laser", "engrave", "vector cut", "kerf", "power", "s-value", "dither", "floyd-steinberg", "atkinson", "dpi", "m3", "m4"],
    sections: [
      {
        heading: "Vector Laser Cutting & Line Marking",
        body: "Generate laser toolpaths with precise power (S-value) and speed controls for CO2, Diode, and Fiber laser cutters:",
        tips: [
          "Vector Cut: Full-power pass to slice through acrylic, plywood, leather, cardboard, or veneer. Includes multi-pass cutting with Z-stepdown.",
          "Vector Marking / Score: Low-power, high-speed line tracing to etch sharp vector lines without cutting through.",
          "Kerf Compensation: Automatically offsets the laser beam path by half the laser spot beam diameter (typically 0.08mm – 0.2mm) to ensure parts assemble with exact press-fit dimensions.",
          "Air Assist Control: Outputs M7/M8 commands to toggle high-pressure air assist for clean, soot-free cut edges.",
        ],
      },
      {
        heading: "Raster Photo & Graphic Engraving",
        body: "Convert bitmap images (PNG, JPG, SVG) into high-resolution laser raster scan lines with advanced dithering algorithms:",
        tips: [
          "Floyd-Steinberg Dithering: High-fidelity error diffusion algorithm ideal for detailed portrait photography and smooth gradients.",
          "Atkinson Dithering: Crisp, high-contrast algorithm with reduced midtone grain, perfect for wood and slate engraving.",
          "Threshold / Grayscale: Direct linear laser power mapping (M4 dynamic laser power mode in GRBL).",
          "Line Density & Scan Angle: Set lines per mm (e.g. 10 lines/mm = ~254 DPI) and unidirectional or bidirectional scanning.",
        ],
        callout: {
          type: "note",
          title: "GRBL M4 Dynamic Laser Mode",
          text: "Always use M4 (Dynamic Laser Power) for raster engraving on GRBL controllers. M4 automatically scales laser output power with machine acceleration/deceleration, preventing burned, over-exposed edges at the ends of scan lines.",
        },
      },
    ],
  },

  // ==========================================
  // 7. TOOL LIBRARY & FEEDS/SPEEDS
  // ==========================================
  {
    id: "tool-library",
    title: "Tool Library & Feeds & Speeds Calculator",
    category: "Tool Library & Speeds",
    summary: "Manage cutting tools, endmills, lasers, and calculate optimal spindle RPM, feed rates, and chip loads for diverse materials.",
    keywords: ["tool library", "feeds", "speeds", "rpm", "feedrate", "chipload", "sfm", "endmill", "ballnose", "v-bit", "materials"],
    sections: [
      {
        heading: "Tool Library Management",
        body: "Define and save your custom tool catalog in the Tool Library (accessible from the CAM Bar or Help menu). Each tool stores geometric parameters and default cutting presets:",
        tips: [
          "Flat Endmill: Square bottom for profile cutting, facing, and pocket clearing.",
          "Ballnose Endmill: Hemispherical tip for 3D contoured surface carving and fluting.",
          "V-Groove Bit: 30°, 60°, 90°, 120° angled tip for V-carving, chamfering, and lettering.",
          "Bullnose / Corner Radius: Flat endmill with rounded corner edges for high-strength pockets.",
          "Drill Bit: Standard 118° or 135° split-point twist drills for hole boring.",
          "Laser Tool: Configurable beam spot diameter, max wattage, and PWM frequency.",
        ],
      },
      {
        heading: "Feeds & Speeds Calculation Guide",
        body: "Calculating correct feedrate and spindle RPM prevents tool breakage, chatter, poor surface finish, and burned material:",
        codeSnippet: {
          title: "Fundamental Feeds & Speeds Formulas",
          code: "Feed Rate (mm/min) = Spindle RPM × Number of Flutes × Chip Load (mm/tooth)\nSurface Speed (SFM) = (Spindle RPM × Tool Diameter in Inches × π) / 12\nChip Load per Tooth = Feed Rate / (RPM × Number of Flutes)",
        },
      },
      {
        heading: "Material Machining Guidelines",
        body: "Reference starting parameters for common CNC materials using a 1/4\" (6.35mm) 2-flute carbide endmill:",
        table: {
          headers: ["Material", "Spindle RPM", "Feed Rate (mm/min)", "Pass Depth (Stepdown)", "Chip Load (mm/tooth)"],
          rows: [
            ["Softwood (Pine, Cedar)", "18,000 – 20,000", "2,500 – 3,500", "3.0 – 6.0 mm", "0.07 – 0.10 mm"],
            ["Hardwood (Oak, Walnut, Maple)", "16,000 – 18,000", "1,800 – 2,500", "2.0 – 4.0 mm", "0.05 – 0.08 mm"],
            ["Plywood & MDF", "18,000 – 22,000", "2,200 – 3,200", "3.0 – 5.0 mm", "0.06 – 0.09 mm"],
            ["Plastics (Acrylic, Delrin, HDPE)", "14,000 – 16,000", "1,500 – 2,200", "1.5 – 3.0 mm", "0.05 – 0.08 mm"],
            ["Aluminum 6061 (with lubricant)", "12,000 – 16,000", "600 – 1,000", "0.3 – 0.8 mm", "0.02 – 0.04 mm"],
            ["Brass & Bronze", "10,000 – 14,000", "400 – 800", "0.2 – 0.5 mm", "0.015 – 0.03 mm"],
          ],
        },
        callout: {
          type: "warning",
          title: "Preventing Plastic Melting & Fire",
          text: "When cutting Acrylic or HDPE, use a single O-flute endmill with higher feedrates and lower RPM to eject large, cool chips. Rubbing without chip evacuation causes plastic to melt around the bit.",
        },
      },
    ],
  },

  // ==========================================
  // 8. POST-PROCESSORS & G-CODE
  // ==========================================
  {
    id: "post-processors-gcode",
    title: "Post-Processors & G-Code Reference",
    category: "Post-Processors & G-Code",
    summary: "Dialects for GRBL, LinuxCNC, Mach3/4, Carbide Motion, Marlin, plus a complete G-code command cheat sheet.",
    keywords: ["post processor", "gcode", "grbl", "mach3", "mach4", "linuxcnc", "carbide", "marlin", "g0", "g1", "g2", "g3", "arc fitting"],
    sections: [
      {
        heading: "Supported Post-Processor Dialects",
        body: "RapidCAM translates toolpaths into native machine code formatted for your specific CNC controller:",
        tips: [
          "GRBL 1.1 / Candle / OpenBuilds / UGS: Standard modal G-code with M3/M4 laser support and G2/G3 arcs.",
          "LinuxCNC / PathPilot: Full industrial CNC syntax with tool change routines (M6), coordinate offsets (G54-G59), and canned cycles.",
          "Mach3 / Mach4: Industry-standard Artsoft controller dialect with customizable spindle delays.",
          "Carbide Motion (Shapeoko / Nomad): Formatted for Carbide 3D machines with automated BitSetter tool offset probing.",
          "Marlin / RepRap: 3D printer CNC firmware compatible format with custom fan/spindle PWM commands.",
          "LightBurn / LaserGRBL Format: Optimized vector and raster formats for standalone laser software.",
        ],
      },
      {
        heading: "Arc Fitting (G2 / G3 Optimization)",
        body: "Instead of exporting thousands of tiny fragmented straight line segments (G1) that can cause controller stuttering, RapidCAM includes an intelligent Arc Fitting filter. It reconstructs smooth circular arcs (G2 clockwise / G3 counter-clockwise), reducing file size by up to 85% and producing glass-smooth cut contours.",
      },
      {
        heading: "G-Code Command Reference Cheat Sheet",
        body: "Quick reference for fundamental CNC G-code commands generated by RapidCAM:",
        table: {
          headers: ["Code", "Category", "Description & Usage"],
          rows: [
            ["G0", "Motion", "Rapid positioning move at maximum machine travel speed (non-cutting)."],
            ["G1", "Motion", "Linear coordinated feed move at programmed feedrate (F value)."],
            ["G2 / G3", "Motion", "Clockwise (G2) or Counter-Clockwise (G3) circular arc motion (I/J or R)."],
            ["G4", "Dwell", "Dwell / pause in seconds or milliseconds (P value)."],
            ["G17", "Plane", "Select XY working plane for arc interpolation."],
            ["G20 / G21", "Units", "Set units to Inches (G20) or Millimeters (G21)."],
            ["G28 / G30", "Homing", "Return to machine reference home position."],
            ["G90 / G91", "Distance", "Absolute programming (G90) vs Incremental relative programming (G91)."],
            ["G54 - G59", "Work Offset", "Select Work Coordinate System (WCS) offset 1 through 6."],
            ["G92", "Set Zero", "Set temporary coordinate offset / zero active axis positions."],
            ["M3 / M4 / M5", "Spindle / Laser", "Spindle CW (M3), Spindle CCW / Dynamic Laser (M4), Spindle Stop (M5)."],
            ["M7 / M8 / M9", "Coolant", "Mist Coolant (M7), Flood Coolant / Air Assist (M8), Coolant Off (M9)."],
            ["M30", "Program End", "Program end and reset / rewind."],
          ],
        },
      },
    ],
  },

  // ==========================================
  // 9. 3D SIMULATION
  // ==========================================
  {
    id: "simulation-cnc",
    title: "3D Simulation & Machining Preview",
    category: "Simulation & CNC",
    summary: "Simulate volumetric stock removal in 3D WebGL and inspect cycle times before the program reaches a machine.",
    keywords: ["simulation", "3d preview", "webgl", "stock", "cycle time", "verify", "preview"],
    sections: [
      {
        heading: "Real-Time 3D WebGL Stock Simulation",
        body: "Never risk raw stock or expensive carbide tooling on unverified toolpaths. RapidCAM's built-in 3D WebGL simulator renders the workpiece with dynamic volumetric stock removal:",
        tips: [
          "Color-Coded Path Visualizer: Rapid moves (G0) in Red, Linear feed cuts (G1) in Cyan, and Circular arcs (G2/G3) in Yellow.",
          "Depth & Stepdown Verification: Rotate, pan, and zoom around the 3D stock model to inspect each individual Z pass layer.",
          "Machining Time Estimator: Accurate cycle time estimation accounting for rapid moves, plunge decelerations, and cutting feeds.",
          "Collision & Machinability Checks: Flags unreachable tight radii, spindle collisions, or excessive plunge depths.",
        ],
      },
    ],
  },

  // ==========================================
  // 10. SHORTCUTS & PRODUCTIVITY
  // ==========================================
  {
    id: "shortcuts-reference",
    title: "Keyboard Shortcuts & Power-User Reference",
    category: "Shortcuts",
    summary: "Complete reference for single-key drawing tools, document editing, and viewport controls.",
    keywords: ["shortcuts", "hotkeys", "keyboard", "cheatsheet", "f1", "ctrl", "single key"],
    sections: [
      {
        heading: "Single-Key CAD Drawing Tools",
        body: "Activate CAD tools instantly with single-key shortcuts:",
        table: {
          headers: ["Key", "Tool", "Action / Workflow"],
          // GENERATED from the tool reference table, not written out here. The
          // hand-written copy that used to live at this spot is precisely what
          // drifted — it advertised typed input for tools that had none and
          // missed it on three that had it. See src/tools/shortcuts.ts.
          rows: [
            ...toolReferenceRows(),
            // Not a tool, so not in that table: a modifier on the current selection.
            ["X", "Construction Toggle", "Toggle selected entities to non-machining reference lines."],
          ],
        },
      },
      {
        heading: "Geometric Constraints",
        body: "Constraints are applied from the CONSTRAINTS toolbar above the canvas — select the geometry, then click the glyph. There are no single-key constraint shortcuts: every letter is already a drawing tool, so pressing one would switch tools instead.",
        table: {
          headers: ["Glyph", "Constraint", "Entity Selection"],
          rows: [
            ["+", "Coincident", "Select 2 points or a point + circle centre."],
            ["H", "Horizontal", "Select 1 line or 2 points."],
            ["V", "Vertical", "Select 1 line or 2 points."],
            ["∥", "Parallel", "Select 2 lines."],
            ["⟂", "Perpendicular", "Select 2 lines."],
            ["=", "Equal Length / Radius", "Select 2 lines or 2 circles/arcs."],
            ["◎", "Concentric", "Select 2 circles/arcs."],
            ["T", "Tangent", "Select a line + circle/arc, or 2 circles/arcs."],
            ["↔", "Symmetric", "Select 2 points + a line to mirror about."],
            ["⚓", "Fixed", "Select geometry to lock it in place."],
          ],
        },
      },
      {
        heading: "Editing & Viewport Shortcuts",
        body: "Standard document management and view controls:",
        table: {
          headers: ["Shortcut", "Function"],
          rows: [
            ["F1", "Open User Documentation & Help Guide modal."],
            ["?", "Open Quick Keyboard Shortcuts Overlay dialog."],
            ["Ctrl + Z", "Undo last operation or sketch edit."],
            ["Ctrl + Y", "Redo previously undone operation."],
            ["Ctrl + S", "Save project to local file (.rapidcam / .json)."],
            ["Ctrl + O", "Open existing project or import DXF / SVG file."],
            ["Ctrl + A", "Select all geometry on active sketch layer."],
            ["Ctrl + C / Ctrl + V", "Copy / Paste selected entities with offset."],
            ["Ctrl + D", "Duplicate selection in place."],
            ["Ctrl + J", "Join selected open chains into closed polylines."],
            ["Ctrl + Shift + E", "Explode polylines, rects, and text into primitives."],
            ["Ctrl + G / Ctrl+Shift+G", "Group / Ungroup selected objects."],
            ["Ctrl + B", "Toggle Design Tree & Variables Sidebar."],
            ["Delete / Backspace", "Delete selected entities or constraints."],
            ["Space + Drag", "Pan viewport canvas."],
            ["Mouse Wheel", "Zoom in / out at cursor location."],
            ["Escape", "Cancel active tool / Deselect all / Return to Select tool."],
          ],
        },
      },
    ],
  },
];

import { type HeightMap, LASER_BURN_DEPTH_MM } from "./stockRasterizer";

// ---------------------------------------------------------------------------
// GLSL sources
// ---------------------------------------------------------------------------

const VERT = `#version 300 es
precision highp float;

uniform sampler2D uHeightMap;
uniform vec2 uStockXZ;   // stock width (X) and depth (Z) in mm
uniform float uStockT;   // stock thickness in mm
uniform mat4 uMVP;

in vec2 aUV;

out vec2 vUV;
out float vHeight;
out vec3 vWorldPos;

void main() {
  float h = texture(uHeightMap, aUV).r;
  vUV = aUV;
  vHeight = h;
  float wx = (aUV.x - 0.5) * uStockXZ.x;
  // UV.y=0 = world Y=0 (canvas bottom) → near side; flip so canvas top = far side,
  // matching the Y-up 2D canvas orientation when viewed from the default camera.
  float wz = (0.5 - aUV.y) * uStockXZ.y;
  vec3 pos = vec3(wx, h, wz);
  vWorldPos = pos;
  gl_Position = uMVP * vec4(pos, 1.0);
}`;

/**
 * GLSL shared by the flat and cylinder surface shaders: the procedural wood
 * grain and the albedo ramp for removed material.
 *
 * Kept in one place so a laser burn looks the same on a board as it does on a
 * rod — the two shaders differ only in how they REACH the surface (a plane vs.
 * a wrapped cylinder), never in what that surface is made of. When the cylinder
 * shader carried its own copy it silently kept only the milled-wood ramp, so a
 * rotary laser rendered as a freshly machined dowel instead of a scorched one.
 */
const GLSL_SURFACE = `
// ---------------------------------------------------------------------------
// Procedural wood grain — surface-aligned (holds still while orbiting), subtle.
// Grain lines run along the stock's length and wander across it, like real wood.
// ---------------------------------------------------------------------------
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i),               b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.0; a *= 0.5; }
  return v;
}
float woodTone(vec2 mm) {
  float warp  = fbm(mm * 0.05) * 6.0;                                 // gentle wander
  float rings = sin((mm.y + warp) * 0.45) * 0.5 + 0.5;               // broad growth bands
  float fine  = sin((mm.y + fbm(mm * 0.2) * 2.0) * 2.6) * 0.5 + 0.5; // fine streaks
  float mott  = fbm(vec2(mm.x * 0.05, mm.y * 0.5));                  // soft mottling
  return clamp(rings * 0.55 + fine * 0.25 + mott * 0.20, 0.0, 1.0);
}

// Colour of a surface point, from how much material was removed there.
// \`grain\` is woodTone() sampled in that surface's own mm frame.
vec3 surfaceAlbedo(float cutDepth, float grain, float stockT, int laserMode, float burnDepth) {
  vec3 uncut = vec3(0.42, 0.28, 0.12);  // planed surface
  if (laserMode == 1) {
    // A laser SCORCHES the surface instead of gouging fresh wood: removed depth
    // is a proxy for burn intensity. Faint areas amber-scorch (grain still shows
    // through); dense areas char toward black. The near-flat relief + dark burn
    // reads as a laser engrave, not a milled pocket.
    float burn  = clamp(cutDepth / burnDepth, 0.0, 1.0);
    vec3 wood   = uncut * (0.86 + 0.22 * grain);
    vec3 scorch = vec3(0.14, 0.06, 0.028);   // light amber-brown burn
    vec3 charry = vec3(0.022, 0.016, 0.012); // deep char, near black
    vec3 burnt  = mix(scorch, charry, smoothstep(0.4, 1.0, burn));
    return mix(wood, burnt, smoothstep(0.03, 0.55, burn));
  }
  // Milled cuts read as fresh wood: deeper = lighter, then shadowed at the base.
  float depthFrac = clamp(cutDepth / stockT, 0.0, 1.0);
  vec3 machined = vec3(0.78, 0.60, 0.32);  // fresh-cut wood
  vec3 deep     = vec3(0.06, 0.03, 0.012); // shadow at the base of deep cuts
  vec3 albedo;
  if (depthFrac < 0.006) {
    albedo = uncut;
  } else if (depthFrac < 0.06) {
    albedo = mix(uncut, machined, depthFrac / 0.06);
  } else if (depthFrac < 0.82) {
    albedo = mix(machined, machined * 0.72, smoothstep(0.06, 0.82, depthFrac));
  } else {
    albedo = mix(machined * 0.72, deep, smoothstep(0.82, 1.0, depthFrac));
  }
  return albedo * (0.86 + 0.22 * grain);
}

// A charred surface is matte — drop most of the sheen in laser mode.
float surfaceSheenAmount(int laserMode) { return (laserMode == 1) ? 0.03 : 0.10; }
`;

const FRAG = `#version 300 es
precision highp float;

uniform sampler2D uHeightMap;
uniform vec2 uTexelSize;  // 1/gridW, 1/gridH
uniform vec2 uCellMM;     // mm per texel in X and Z
uniform float uStockT;
uniform vec2 uStockXZ;    // stock width (X) and depth (Z) in mm
uniform int uLaserMode;   // 1 = shade removed material as a laser burn, 0 = milled cut
uniform float uBurnDepth; // mm of removed depth mapped to a full-black char (laser mode)

in vec2 vUV;
in float vHeight;
in vec3 vWorldPos;

out vec4 fragColor;

float hAt(vec2 uv) { return texture(uHeightMap, clamp(uv, vec2(0.0), vec2(1.0))).r; }

${GLSL_SURFACE}

void main() {
  // --- Smoothed surface normal ---
  // The height field is a raster, so a per-texel central difference makes cut
  // walls stair-step into a bright zipper. A Sobel over a ~1.5-texel window
  // (with linear texture filtering) averages that staircase into a clean slope.
  vec2 e = uTexelSize * 1.5;
  float h00 = hAt(vUV + vec2(-e.x, -e.y)), h10 = hAt(vUV + vec2(0.0, -e.y)), h20 = hAt(vUV + vec2(e.x, -e.y));
  float h01 = hAt(vUV + vec2(-e.x,  0.0)),                                   h21 = hAt(vUV + vec2(e.x,  0.0));
  float h02 = hAt(vUV + vec2(-e.x,  e.y)), h12 = hAt(vUV + vec2(0.0,  e.y)), h22 = hAt(vUV + vec2(e.x,  e.y));

  float sobelX = (h00 + 2.0 * h01 + h02) - (h20 + 2.0 * h21 + h22);
  // Z axis is flipped (wz = (0.5-UV.y)*H), matching the +y/-y layout below.
  float sobelZ = (h02 + 2.0 * h12 + h22) - (h00 + 2.0 * h10 + h20);
  vec2 stepMM = 1.5 * uCellMM;                 // mm spanned by one Sobel step
  float gradX = sobelX / (8.0 * stepMM.x);     // Sobel side-weight = 4, central diff = 2Δ
  float gradZ = sobelZ / (8.0 * stepMM.y);
  vec3 normal = normalize(vec3(gradX, 1.0, gradZ));

  // --- Albedo from how much material was removed ---
  float cutDepth  = uStockT - vHeight;

  // Wood grain modulation — reconstruct world XZ (mm) from UV. Shared by both
  // surface modes so the grain reads through a light laser scorch too.
  float wx = (vUV.x - 0.5) * uStockXZ.x;
  float wz = (0.5 - vUV.y) * uStockXZ.y;
  float grain = woodTone(vec2(wx, wz));

  vec3 albedo = surfaceAlbedo(cutDepth, grain, uStockT, uLaserMode, uBurnDepth);

  // --- Lighting: hemisphere ambient + key + fill + a soft, tight sheen ---
  vec3 keyDir  = normalize(vec3( 0.5, 1.15,  0.75));
  vec3 fillDir = normalize(vec3(-0.7, 0.60, -0.40));
  float key  = max(dot(normal, keyDir),  0.0);
  float fill = max(dot(normal, fillDir), 0.0);
  // Sky above is brighter than the ground bounce below.
  float ambient = mix(0.22, 0.42, 0.5 + 0.5 * normal.y);

  vec3 viewDir = normalize(vec3(0.3, 1.0, 0.5));
  vec3 halfV   = normalize(keyDir + viewDir);
  float sheen  = pow(max(dot(normal, halfV), 0.0), 24.0) * surfaceSheenAmount(uLaserMode);

  float diffuse = ambient + key * 0.85 + fill * 0.25;
  vec3 col = albedo * diffuse + vec3(sheen);

  // Gamma correction: linear → sRGB.
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  fragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------
// Mat4 helpers (column-major)
// ---------------------------------------------------------------------------

type Mat4 = Float32Array;

function mat4(): Mat4 {
  return new Float32Array(16);
}

function perspective(m: Mat4, fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  m.fill(0);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

function lookAt(m: Mat4, eye: number[], center: number[], up: number[]): Mat4 {
  const fx = center[0] - eye[0],
    fy = center[1] - eye[1],
    fz = center[2] - eye[2];
  const fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
  const f0 = fx / fl,
    f1 = fy / fl,
    f2 = fz / fl;

  const s0 = f1 * up[2] - f2 * up[1];
  const s1 = f2 * up[0] - f0 * up[2];
  const s2 = f0 * up[1] - f1 * up[0];
  const sl = Math.sqrt(s0 * s0 + s1 * s1 + s2 * s2);
  const sx = s0 / sl,
    sy = s1 / sl,
    sz = s2 / sl;

  const u0 = sy * f2 - sz * f1;
  const u1 = sz * f0 - sx * f2;
  const u2 = sx * f1 - sy * f0;

  m[0] = sx;
  m[4] = sy;
  m[8] = sz;
  m[12] = -(sx * eye[0] + sy * eye[1] + sz * eye[2]);
  m[1] = u0;
  m[5] = u1;
  m[9] = u2;
  m[13] = -(u0 * eye[0] + u1 * eye[1] + u2 * eye[2]);
  m[2] = -f0;
  m[6] = -f1;
  m[10] = -f2;
  m[14] = f0 * eye[0] + f1 * eye[1] + f2 * eye[2];
  m[3] = 0;
  m[7] = 0;
  m[11] = 0;
  m[15] = 1;
  return m;
}

function mul4(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + i] * b[j * 4 + k];
      out[j * 4 + i] = s;
    }
  }
  return out;
}

/** Invert a 4×4 matrix (column-major). Returns null if singular. */
function inv4(m: Mat4): Mat4 | null {
  const o = new Float32Array(16);
  const m00 = m[0],
    m10 = m[1],
    m20 = m[2],
    m30 = m[3];
  const m01 = m[4],
    m11 = m[5],
    m21 = m[6],
    m31 = m[7];
  const m02 = m[8],
    m12 = m[9],
    m22 = m[10],
    m32 = m[11];
  const m03 = m[12],
    m13 = m[13],
    m23 = m[14],
    m33 = m[15];
  const b00 = m00 * m11 - m10 * m01,
    b01 = m00 * m21 - m20 * m01,
    b02 = m00 * m31 - m30 * m01;
  const b03 = m10 * m21 - m20 * m11,
    b04 = m10 * m31 - m30 * m11,
    b05 = m20 * m31 - m30 * m21;
  const b06 = m02 * m13 - m12 * m03,
    b07 = m02 * m23 - m22 * m03,
    b08 = m02 * m33 - m32 * m03;
  const b09 = m12 * m23 - m22 * m13,
    b10 = m12 * m33 - m32 * m13,
    b11 = m22 * m33 - m32 * m23;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-14) return null;
  const id = 1 / det;
  o[0] = (m11 * b11 - m21 * b10 + m31 * b09) * id;
  o[1] = (-m10 * b11 + m20 * b10 - m30 * b09) * id;
  o[2] = (m13 * b05 - m23 * b04 + m33 * b03) * id;
  o[3] = (-m12 * b05 + m22 * b04 - m32 * b03) * id;
  o[4] = (-m01 * b11 + m21 * b08 - m31 * b07) * id;
  o[5] = (m00 * b11 - m20 * b08 + m30 * b07) * id;
  o[6] = (-m03 * b05 + m23 * b02 - m33 * b01) * id;
  o[7] = (m02 * b05 - m22 * b02 + m32 * b01) * id;
  o[8] = (m01 * b10 - m11 * b08 + m31 * b06) * id;
  o[9] = (-m00 * b10 + m10 * b08 - m30 * b06) * id;
  o[10] = (m03 * b04 - m13 * b02 + m33 * b00) * id;
  o[11] = (-m02 * b04 + m12 * b02 - m32 * b00) * id;
  o[12] = (-m01 * b09 + m11 * b07 - m21 * b06) * id;
  o[13] = (m00 * b09 - m10 * b07 + m20 * b06) * id;
  o[14] = (-m03 * b03 + m13 * b01 - m23 * b00) * id;
  o[15] = (m02 * b03 - m12 * b01 + m22 * b00) * id;
  return o;
}

/**
 * Unproject a screen pixel to a world-space point on the horizontal plane Y=targetY.
 * Returns null if the ray is nearly parallel to the plane.
 */
function unprojectToY(
  px: number,
  py: number, // pixel coords (CSS, not device)
  canvasW: number,
  canvasH: number, // CSS canvas size
  MVP: Mat4,
  targetY: number,
): [number, number, number] | null {
  const invMVP = inv4(MVP);
  if (!invMVP) return null;

  // Two NDC points on the ray (near and far)
  const ndcX = (px / canvasW) * 2 - 1;
  const ndcY = -(py / canvasH) * 2 + 1; // flip Y: CSS y=0 is top

  const unproj = (ndcZ: number): [number, number, number] => {
    const ix = invMVP[0] * ndcX + invMVP[4] * ndcY + invMVP[8] * ndcZ + invMVP[12];
    const iy = invMVP[1] * ndcX + invMVP[5] * ndcY + invMVP[9] * ndcZ + invMVP[13];
    const iz = invMVP[2] * ndcX + invMVP[6] * ndcY + invMVP[10] * ndcZ + invMVP[14];
    const iw = invMVP[3] * ndcX + invMVP[7] * ndcY + invMVP[11] * ndcZ + invMVP[15];
    return [ix / iw, iy / iw, iz / iw];
  };

  const near = unproj(-1);
  const far = unproj(1);
  const dy = far[1] - near[1];
  if (Math.abs(dy) < 1e-6) return null; // ray parallel to plane
  const t = (targetY - near[1]) / dy;
  return [near[0] + t * (far[0] - near[0]), targetY, near[2] + t * (far[2] - near[2])];
}

// ---------------------------------------------------------------------------
// WebGLPreview
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Box shader — renders stock sides + bottom as a closed solid
// ---------------------------------------------------------------------------

const VERT_BOX = `#version 300 es
precision highp float;
uniform mat4 uMVP;
uniform vec2 uStockXZ;
in vec3 aPos;
in vec3 aNorm;
out vec3 vNorm;
out vec2 vWorldXZ;
void main() {
  vNorm = aNorm;
  vWorldXZ = aPos.xz;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const FRAG_BOX = `#version 300 es
precision highp float;

uniform vec2 uStockXZ;

in vec3 vNorm;
in vec2 vWorldXZ;
out vec4 fragColor;

float hash21(vec2 p) {
  float h = dot(p, vec2(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

float noise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  vec2 shift = vec2(100.0);
  for (int i = 0; i < 5; i++) {
    v += a * noise2D(p);
    p = p * 2.0 + shift;
    a *= 0.5;
  }
  return v;
}

float woodGrain(vec2 worldXZ) {
  float x = worldXZ.x;
  float z = worldXZ.y;

  float ringFreq = 0.28;
  float ringWobble = fbm(vec2(x * 0.12, z * 0.35)) * 4.5;
  float rings = sin(z * ringFreq + ringWobble) * 0.5 + 0.5;

  float latewoodEdge = sin(z * ringFreq * 5.5 + ringWobble * 2.1) * 0.5 + 0.5;
  latewoodEdge = smoothstep(0.48, 0.52, latewoodEdge);

  float fineFreq = 2.8;
  float fineWobble = fbm(vec2(x * 0.3, z * 0.8)) * 1.8;
  float fineLines = sin(z * fineFreq + fineWobble) * 0.5 + 0.5;

  float figure = sin(x * 0.55 + fbm(worldXZ * 0.38) * 3.0) * 0.5 + 0.5;

  float rayNoise = fbm(vec2(x * 1.9, z * 0.22));
  float rays = smoothstep(0.72, 0.78, rayNoise) * 0.35;

  float arch = sin(z * 0.35 + abs(x) * 0.06 + fbm(vec2(x * 0.08, z * 0.15)) * 2.5) * 0.5 + 0.5;
  float archBlend = smoothstep(80.0, 200.0, abs(x));

  float ringPattern = mix(rings, arch, archBlend * 0.45);

  float result = ringPattern       * 0.44
               + latewoodEdge      * 0.18
               + fineLines         * 0.22
               + figure            * 0.10
               + rays              * 1.0;

  return clamp(result, 0.0, 1.0);
}

void main() {
  vec3 base = vec3(0.82, 0.68, 0.38);
  // Modulate with wood grain
  float grain = woodGrain(vWorldXZ);
  base = base * (0.68 + grain * 0.64);

  // Improved lighting matching the top-surface shader
  vec3 L1 = normalize(vec3(0.6, 1.0, 0.4));
  vec3 L2 = normalize(vec3(-0.8, 1.0, -0.5));
  vec3 n = normalize(vNorm);

  float d1 = max(dot(n, L1), 0.0);
  float d2 = max(dot(n, L2), 0.0);

  // Blinn-Phong specular
  vec3 viewDir = normalize(vec3(0.35, 1.0, 0.55));
  vec3 halfVec = normalize(L1 + viewDir);
  float spec = pow(max(dot(n, halfVec), 0.0), 48.0);

  float d = 0.22 + d1 * 0.75 + d2 * 0.22 + spec * 0.28;
  fragColor = vec4(pow(clamp(base * d, 0.0, 1.0), vec3(1.0/2.2)), 1.0);
}`;

// ---------------------------------------------------------------------------
// Cylinder shader — the SAME unrolled height-map grid, wrapped onto a cylinder
// for a rotary (4th-axis) job. The rasterizer already produces the surface over
// the unrolled cylinder (stockW = length, stockH = circumference = π·D), so this
// is purely a vertex remap + a radial-normal fragment; no CPU geometry change.
// ---------------------------------------------------------------------------

/** Cylinder-preview parameters for a rotary job (null/omitted = flat stock). */
export interface RotaryView {
  diameter: number; // mm
  wrapAxis: "x" | "y";
}

const VERT_CYL = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uHeightMap;
uniform float uStockT;    // radial wall / max cut depth (mm)
uniform float uRadius;    // cylinder radius R = D/2 (mm)
uniform float uAxialLen;  // stock length along the cylinder axis (mm)
uniform float uCirc;      // circumference span mapped around (= 2πR) (mm)
uniform int   uWrapX;     // 1 = X wraps (Y = length); 0 = Y wraps (X = length)
uniform mat4  uMVP;

layout(location = 0) in vec2 aUV;

out vec2  vUV;
out float vHeight;
out float vTheta;
out float vAxial;
out vec3  vWorldPos;

void main() {
  float h = texture(uHeightMap, aUV).r;
  vUV = aUV;
  vHeight = h;

  // Which UV axis runs along the length vs around the circumference. The wrap
  // param is flipped (1 - v) so the surface curls the same way the flat preview
  // lays it out (which uses 0.5 - v for Z) — otherwise the outer surface is a
  // mirror image and text reads reflected. See the flat VERT's wz mapping.
  float axialParam = (uWrapX == 1) ? aUV.y : aUV.x;
  float wrapParam  = 1.0 - ((uWrapX == 1) ? aUV.x : aUV.y);

  float axial  = (axialParam - 0.5) * uAxialLen;   // along world X
  float theta  = wrapParam * (uCirc / uRadius);     // = 2π·wrapParam
  float radius = uRadius - (uStockT - h);           // cut eats into the radius

  vTheta = theta;
  vAxial = axial;
  vec3 pos = vec3(axial, radius * cos(theta), radius * sin(theta));
  vWorldPos = pos;
  gl_Position = uMVP * vec4(pos, 1.0);
}`;

const FRAG_CYL = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uHeightMap;
uniform vec2  uTexelSize;  // 1/gridW, 1/gridH
uniform vec2  uCellMM;     // mm per texel in u and v
uniform float uStockT;
uniform float uRadius;
uniform int   uWrapX;
uniform int   uLaserMode;   // 1 = shade removed material as a laser burn, 0 = milled cut
uniform float uBurnDepth;   // mm of removed depth mapped to a full-black char (laser mode)
uniform vec3  uEye;
uniform vec3  uKeyDir;
uniform vec3  uFillDir;
uniform vec3  uCameraUp;

in vec2  vUV;
in float vHeight;
in float vTheta;
in float vAxial;
in vec3  vWorldPos;

out vec4 fragColor;

float hAt(vec2 uv) { return texture(uHeightMap, clamp(uv, vec2(0.0), vec2(1.0))).r; }

${GLSL_SURFACE}

void main() {
  // Height gradient (Sobel over a ~1.5-texel window), in mm, along u and v.
  vec2 e = uTexelSize * 1.5;
  float h00 = hAt(vUV + vec2(-e.x, -e.y)), h10 = hAt(vUV + vec2(0.0, -e.y)), h20 = hAt(vUV + vec2(e.x, -e.y));
  float h01 = hAt(vUV + vec2(-e.x,  0.0)),                                   h21 = hAt(vUV + vec2(e.x,  0.0));
  float h02 = hAt(vUV + vec2(-e.x,  e.y)), h12 = hAt(vUV + vec2(0.0,  e.y)), h22 = hAt(vUV + vec2(e.x,  e.y));
  float sobelU = (h20 + 2.0 * h21 + h22) - (h00 + 2.0 * h01 + h02); // +u
  float sobelV = (h02 + 2.0 * h12 + h22) - (h00 + 2.0 * h10 + h20); // +v
  vec2 stepMM = 1.5 * uCellMM;
  float dHdU = sobelU / (8.0 * stepMM.x);
  float dHdV = sobelV / (8.0 * stepMM.y);
  // radius = R - stockT + h, so dR/d… = dH/d… ; assign to axial vs arc by wrap.
  float dRdAxial = (uWrapX == 1) ? dHdV : dHdU;
  float dRdArc   = (uWrapX == 1) ? dHdU : dHdV;

  // Frame: radial base normal + axial/circumferential tangents (arc-length param).
  float ct = cos(vTheta), st = sin(vTheta);
  vec3 nRad   = vec3(0.0,  ct, st);
  vec3 tAxial = vec3(1.0, 0.0, 0.0);
  vec3 tCirc  = vec3(0.0, -st, ct);
  vec3 normal = normalize(nRad - dRdAxial * tAxial - dRdArc * tCirc);

  // Albedo from removed material — the SHARED ramp, so a rotary laser scorches
  // exactly as a flat one does. Grain runs along the rod: x = axial (length),
  // y = arc length (θ·R).
  float cutDepth = uStockT - vHeight;
  float grain    = woodTone(vec2(vAxial, vTheta * uRadius));
  vec3 albedo    = surfaceAlbedo(cutDepth, grain, uStockT, uLaserMode, uBurnDepth);

  // Lighting: hemisphere ambient + key + fill + soft sheen (same as flat).
  float key  = max(dot(normal, uKeyDir),  0.0);
  float fill = max(dot(normal, uFillDir), 0.0);
  float ambient = mix(0.22, 0.42, 0.5 + 0.5 * dot(normal, uCameraUp));
  vec3 viewDir = normalize(uEye - vWorldPos);
  vec3 halfV   = normalize(uKeyDir + viewDir);
  float sheen  = pow(max(dot(normal, halfV), 0.0), 24.0) * surfaceSheenAmount(uLaserMode);
  float diffuse = ambient + key * 0.85 + fill * 0.25;
  vec3 col = albedo * diffuse + vec3(sheen);
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  fragColor = vec4(col, 1.0);
}`;

const DEFAULT_YAW = Math.PI / 4;
const DEFAULT_PITCH = Math.atan(1 / Math.sqrt(2)); // ~35.26° isometric
const DEFAULT_ZOOM = 1.0;

/**
 * The overlay message for the 3D preview, or null to show nothing. When the
 * block shows cuts, stay silent. When it doesn't, the message depends on WHY:
 * with no toolpaths this is the normal state for a geometry-only file (every
 * bundled example) — a friendly next step, not an error blaming the user's
 * "geometry selection"; with toolpaths present, point at the likely cause.
 * Pure, so the wording is unit-testable without a GL context.
 */
export function previewStatusMessage(hasCuts: boolean, hasToolpaths: boolean): string | null {
  if (hasCuts) return null;
  return hasToolpaths
    ? "These toolpaths remove no material — check their cut depth and the geometry they target."
    : "Add a toolpath in the CAM tab to see it carved here.";
}

export class WebGLPreview {
  private canvas: HTMLCanvasElement;
  private resetBtn: HTMLButtonElement;
  private statusEl: HTMLElement;
  private gl!: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private ebo: WebGLBuffer | null = null;
  private heightTex!: WebGLTexture;
  private indexCount = 0;
  private boxProgram!: WebGLProgram;
  private boxVAO: WebGLVertexArrayObject | null = null;
  private boxVBO: WebGLBuffer | null = null;
  private boxEBO: WebGLBuffer | null = null;
  private boxIndexCount = 0;

  // Cleanup and observer handles
  private abortController = new AbortController();
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;

  // Cylinder (rotary) preview: same grid VAO, wrapped by a dedicated program.
  // The box VAO is reused for the cylinder's end-cap disks in this mode.
  private cylProgram!: WebGLProgram;
  private rotary: RotaryView | null = null;
  private rotaryRadius = 0;
  /** Which solid the box VAO currently holds ("flat" box vs cylinder "caps"). */
  private builtMode: "flat" | "cyl" | null = null;

  // Last rendered height map dimensions (for uniform upload)
  private gridW = 0;
  private gridH = 0;
  private stockW = 0;
  private stockH = 0;
  private stockT = 0;
  /** Shade the flat top surface as a laser burn rather than a milled cut. */
  private laserMode = false;

  // Orbit state
  private yaw = DEFAULT_YAW;
  private pitch = DEFAULT_PITCH;
  private zoom = DEFAULT_ZOOM;
  private dragging = false;
  private panning = false;
  private lastMx = 0;
  private lastMy = 0;
  // Pan offset applied to the camera target (world-space)
  private panX = 0;
  private panY = 0;
  private panZ = 0;

  constructor(private host: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "display:block;width:100%;height:100%;";

    this.resetBtn = document.createElement("button");
    this.resetBtn.className = "webgl-reset-btn";
    this.resetBtn.textContent = "⟳ Reset View";
    this.resetBtn.addEventListener("click", () => this.resetView(), {
      signal: this.abortController.signal,
    });

    this.statusEl = document.createElement("div");
    this.statusEl.className = "webgl-status";
    this.statusEl.style.display = "none";

    host.appendChild(this.canvas);
    host.appendChild(this.resetBtn);
    host.appendChild(this.statusEl);

    // antialias:true → MSAA on the default framebuffer, which cleans up the
    // stepped silhouette where cut walls meet the floor.
    const gl = this.canvas.getContext("webgl2", { antialias: true, depth: true });
    if (!gl) {
      this.showError("WebGL 2 not supported in this browser.");
      return;
    }
    this.gl = gl;

    this.program = this.buildProgram(VERT, FRAG);
    this.boxProgram = this.buildProgram(VERT_BOX, FRAG_BOX);
    this.cylProgram = this.buildProgram(VERT_CYL, FRAG_CYL);
    this.heightTex = this.createHeightTexture();
    this.bindOrbitControls();

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(host);
    this.handleResize();
  }

  public get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Release all GPU resources (programs, shaders, buffers, textures, VAOs),
   * disconnect observers, remove window/element event listeners, and detach DOM nodes.
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.abortController.abort();

    this.canvas.remove();
    this.resetBtn.remove();
    this.statusEl.remove();

    const gl = this.gl;
    if (gl) {
      if (this.vao) {
        gl.deleteVertexArray(this.vao);
        this.vao = null;
      }
      if (this.vbo) {
        gl.deleteBuffer(this.vbo);
        this.vbo = null;
      }
      if (this.ebo) {
        gl.deleteBuffer(this.ebo);
        this.ebo = null;
      }

      if (this.boxVAO) {
        gl.deleteVertexArray(this.boxVAO);
        this.boxVAO = null;
      }
      if (this.boxVBO) {
        gl.deleteBuffer(this.boxVBO);
        this.boxVBO = null;
      }
      if (this.boxEBO) {
        gl.deleteBuffer(this.boxEBO);
        this.boxEBO = null;
      }

      if (this.heightTex) {
        gl.deleteTexture(this.heightTex);
      }

      this.deleteProgram(this.program);
      this.deleteProgram(this.boxProgram);
      this.deleteProgram(this.cylProgram);

      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }

  render(hm: HeightMap, rotary: RotaryView | null = null, hasToolpaths = false): void {
    if (this.disposed) return;
    const gl = this.gl;
    if (!gl) return;

    const mode: "flat" | "cyl" = rotary ? "cyl" : "flat";
    const needsMesh = this.indexCount === 0 || this.gridW !== hm.gridW || this.gridH !== hm.gridH;
    // The box VAO holds either the flat box or the cylinder end-caps; rebuild it
    // when the solid kind, the stock size, or the cylinder radius changes.
    const solidChanged =
      this.builtMode !== mode ||
      this.boxVAO === null ||
      hm.stockW !== this.stockW ||
      hm.stockH !== this.stockH ||
      hm.stockT !== this.stockT ||
      (rotary ? rotary.diameter / 2 !== this.rotaryRadius : false);

    this.gridW = hm.gridW;
    this.gridH = hm.gridH;
    this.stockW = hm.stockW;
    this.stockH = hm.stockH;
    this.stockT = hm.stockT;
    this.laserMode = hm.laser ?? false;
    this.rotary = rotary;
    this.rotaryRadius = rotary ? rotary.diameter / 2 : 0;

    if (needsMesh) this.buildMesh(hm.gridW, hm.gridH);
    if (solidChanged) {
      const modeChanged = this.builtMode !== mode;
      if (rotary) this.buildCapsMesh();
      else this.buildBoxMesh();
      this.builtMode = mode;
      if (modeChanged) this.resetView();
    }

    // Upload height data as R32F texture
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, hm.gridW, hm.gridH, 0, gl.RED, gl.FLOAT, hm.data);

    // Scan for any material removal so we can hint when the preview shows a bare
    // block. The message is context-aware: with no toolpaths this is the normal,
    // expected state (a geometry-only file — e.g. every bundled example), so it
    // reads as a friendly next step, not an error. Only when toolpaths exist but
    // remove nothing does it point at the likely cause.
    let minH = hm.stockT;
    for (let i = 0; i < hm.data.length; i++) {
      if (hm.data[i] < minH) minH = hm.data[i];
    }
    // A laser burn is shallow (< the mill threshold), so any surface removal counts.
    const hasCuts = minH < hm.stockT - (hm.laser ? 0.05 : 0.5);
    const msg = previewStatusMessage(hasCuts, hasToolpaths);
    this.statusEl.textContent = msg ?? "";
    this.statusEl.style.display = msg ? "block" : "none";

    this.draw();
  }

  resetView(): void {
    this.yaw = this.rotary ? 0 : DEFAULT_YAW;
    this.pitch = this.rotary ? -Math.PI / 2 : DEFAULT_PITCH;
    this.zoom = DEFAULT_ZOOM;
    this.panX = 0;
    this.panY = 0;
    this.panZ = 0;
    this.draw();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private handleResize(): void {
    if (this.disposed) return;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    if (this.gl) {
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this.draw();
    }
  }

  private buildMesh(gridW: number, gridH: number): void {
    const gl = this.gl;

    // Create UV vertices: one per grid cell corner
    const uvs = new Float32Array(gridW * gridH * 2);
    let vi = 0;
    for (let row = 0; row < gridH; row++) {
      for (let col = 0; col < gridW; col++) {
        uvs[vi++] = col / (gridW - 1);
        uvs[vi++] = row / (gridH - 1);
      }
    }

    // Create index buffer for GL_TRIANGLES
    const triCount = (gridW - 1) * (gridH - 1) * 2;
    const indices = new Uint32Array(triCount * 3);
    let ii = 0;
    for (let row = 0; row < gridH - 1; row++) {
      for (let col = 0; col < gridW - 1; col++) {
        const tl = row * gridW + col;
        const tr = tl + 1;
        const bl = tl + gridW;
        const br = bl + 1;
        indices[ii++] = tl;
        indices[ii++] = bl;
        indices[ii++] = tr;
        indices[ii++] = tr;
        indices[ii++] = bl;
        indices[ii++] = br;
      }
    }
    this.indexCount = indices.length;

    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.ebo) gl.deleteBuffer(this.ebo);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);

    const aUV = gl.getAttribLocation(this.program, "aUV");
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);

    this.ebo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
  }

  private buildBoxMesh(): void {
    const gl = this.gl;
    const hw = this.stockW / 2;
    const hd = this.stockH / 2;
    const t = this.stockT;

    // Interleaved: [x,y,z, nx,ny,nz] per vertex; 5 faces (no top — height map is the top)
    const verts: number[] = [];
    const idx: number[] = [];

    const addFace = (corners: [number, number, number][], norm: [number, number, number]) => {
      const base = verts.length / 6;
      for (const [x, y, z] of corners) verts.push(x, y, z, ...norm);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };

    addFace(
      [
        [-hw, 0, -hd],
        [hw, 0, -hd],
        [hw, 0, hd],
        [-hw, 0, hd],
      ],
      [0, -1, 0],
    ); // bottom
    addFace(
      [
        [-hw, 0, hd],
        [hw, 0, hd],
        [hw, t, hd],
        [-hw, t, hd],
      ],
      [0, 0, 1],
    ); // front
    addFace(
      [
        [hw, 0, -hd],
        [-hw, 0, -hd],
        [-hw, t, -hd],
        [hw, t, -hd],
      ],
      [0, 0, -1],
    ); // back
    addFace(
      [
        [-hw, 0, -hd],
        [-hw, 0, hd],
        [-hw, t, hd],
        [-hw, t, -hd],
      ],
      [-1, 0, 0],
    ); // left
    addFace(
      [
        [hw, 0, hd],
        [hw, 0, -hd],
        [hw, t, -hd],
        [hw, t, hd],
      ],
      [1, 0, 0],
    ); // right

    if (this.boxVAO) gl.deleteVertexArray(this.boxVAO);
    if (this.boxVBO) gl.deleteBuffer(this.boxVBO);
    if (this.boxEBO) gl.deleteBuffer(this.boxEBO);

    this.boxVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.boxVAO);

    this.boxVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

    this.boxEBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.boxEBO);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);

    const stride = 6 * 4;
    const aPos = gl.getAttribLocation(this.boxProgram, "aPos");
    const aNorm = gl.getAttribLocation(this.boxProgram, "aNorm");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(aNorm);
    gl.vertexAttribPointer(aNorm, 3, gl.FLOAT, false, stride, 3 * 4);

    gl.bindVertexArray(null);
    this.boxIndexCount = idx.length;
  }

  /**
   * Cylinder end caps: two disks (triangle fans) at the axial ends, radius R,
   * facing ±X, so the wrapped tube reads as a solid dowel. Rendered with the box
   * program (same interleaved pos+normal layout), so it reuses the box VAO — in
   * rotary mode the flat box is never drawn.
   */
  private buildCapsMesh(): void {
    const gl = this.gl;
    const R = this.rotaryRadius;
    const wrapX = this.rotary?.wrapAxis === "x";
    const half = (wrapX ? this.stockH : this.stockW) / 2;
    const SEG = 96;

    const verts: number[] = [];
    const idx: number[] = [];
    const addCap = (x: number, nx: number) => {
      const base = verts.length / 6;
      verts.push(x, 0, 0, nx, 0, 0); // fan centre
      for (let i = 0; i <= SEG; i++) {
        const th = (i / SEG) * Math.PI * 2;
        verts.push(x, R * Math.cos(th), R * Math.sin(th), nx, 0, 0);
      }
      for (let i = 1; i <= SEG; i++) {
        const a = base + i;
        const b = base + i + 1;
        // Wind so the outward (±x) face is front.
        if (nx > 0) idx.push(base, a, b);
        else idx.push(base, b, a);
      }
    };
    addCap(+half, +1);
    addCap(-half, -1);

    if (this.boxVAO) gl.deleteVertexArray(this.boxVAO);
    if (this.boxVBO) gl.deleteBuffer(this.boxVBO);
    if (this.boxEBO) gl.deleteBuffer(this.boxEBO);

    this.boxVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.boxVAO);

    this.boxVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

    this.boxEBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.boxEBO);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);

    const stride = 6 * 4;
    const aPos = gl.getAttribLocation(this.boxProgram, "aPos");
    const aNorm = gl.getAttribLocation(this.boxProgram, "aNorm");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(aNorm);
    gl.vertexAttribPointer(aNorm, 3, gl.FLOAT, false, stride, 3 * 4);

    gl.bindVertexArray(null);
    this.boxIndexCount = idx.length;
  }

  private createHeightTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // 1×1 placeholder
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array([0]));
    // Linear filtering smooths the raster's cell steps in BOTH the mesh vertex
    // heights and the shaded normals, so cut walls read as clean slopes instead
    // of a stair-stepped zipper. R32F linear needs OES_texture_float_linear;
    // fall back to NEAREST (still correct, just crisper steps) if unavailable.
    const linear = gl.getExtension("OES_texture_float_linear") != null;
    const filter = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /**
   * Camera framing: orbit distance basis (`diag`) and look-at target. Flat stock
   * frames on the block centre (Y = half thickness); a rotary cylinder frames on
   * the axis (origin) and sizes to its length × diameter. Shared by draw / zoom /
   * pan so they never drift.
   */
  private viewMetrics(): { diag: number; target: [number, number, number] } {
    if (this.rotary) {
      const axialLen = this.rotary.wrapAxis === "x" ? this.stockH : this.stockW;
      const dia = this.rotaryRadius * 2;
      return { diag: Math.hypot(axialLen, dia), target: [this.panX, this.panY, this.panZ] };
    }
    const diag = Math.sqrt(this.stockW ** 2 + this.stockH ** 2 + this.stockT ** 2);
    return { diag, target: [this.panX, this.stockT * 0.5 + this.panY, this.panZ] };
  }

  private draw(): void {
    if (this.disposed) return;
    const gl = this.gl;
    if (!gl || this.indexCount === 0 || this.stockW === 0) return;

    gl.clearColor(0.12, 0.13, 0.14, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    // Camera
    const { diag, target } = this.viewMetrics();
    const dist = (diag * 1.4) / this.zoom;
    const eye = [
      target[0] + dist * Math.cos(this.pitch) * Math.sin(this.yaw),
      target[1] + dist * Math.sin(this.pitch),
      target[2] + dist * Math.cos(this.pitch) * Math.cos(this.yaw),
    ];

    const V = mat4();
    const up = [
      -Math.sin(this.pitch) * Math.sin(this.yaw),
      Math.cos(this.pitch),
      -Math.sin(this.pitch) * Math.cos(this.yaw)
    ];
    lookAt(V, eye, target, up);
    const aspect = this.canvas.width / this.canvas.height;
    const P = mat4();
    perspective(P, 0.6, aspect, 0.1, diag * 10);
    const MVP = mat4();
    mul4(MVP, P, V);

    // Draw the solid underneath first so the depth test closes it: the flat
    // stock box (bottom + 4 sides), or the cylinder's two end-cap disks.
    if (this.boxVAO && this.boxIndexCount > 0) {
      gl.useProgram(this.boxProgram);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.boxProgram, "uMVP"), false, MVP);
      const stockXZLoc = gl.getUniformLocation(this.boxProgram, "uStockXZ");
      if (stockXZLoc) gl.uniform2f(stockXZLoc, this.stockW, this.stockH);
      gl.bindVertexArray(this.boxVAO);
      gl.drawElements(gl.TRIANGLES, this.boxIndexCount, gl.UNSIGNED_SHORT, 0);
      gl.bindVertexArray(null);
    }

    // Draw the height-map surface: the flat grid, or the same grid wrapped onto
    // the cylinder for a rotary job.
    const surf = this.rotary ? this.cylProgram : this.program;
    gl.useProgram(surf);
    const set = (name: string, ...v: number[]) => {
      const loc = gl.getUniformLocation(surf, name);
      if (v.length === 1) gl.uniform1f(loc, v[0]);
      else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
    };
    gl.uniformMatrix4fv(gl.getUniformLocation(surf, "uMVP"), false, MVP);
    set("uStockT", this.stockT);
    set("uTexelSize", 1 / this.gridW, 1 / this.gridH);
    set("uCellMM", this.stockW / (this.gridW - 1), this.stockH / (this.gridH - 1));
    if (this.rotary) {
      const wrapX = this.rotary.wrapAxis === "x";
      set("uRadius", this.rotaryRadius);
      set("uAxialLen", wrapX ? this.stockH : this.stockW);
      set("uCirc", wrapX ? this.stockW : this.stockH);
      gl.uniform1i(gl.getUniformLocation(surf, "uWrapX"), wrapX ? 1 : 0);
    } else {
      set("uStockXZ", this.stockW, this.stockH);
    }
    // Beam-vs-spindle shading applies to both surfaces: a rotary laser is still
    // a laser, so it must scorch rather than look freshly machined.
    gl.uniform1i(gl.getUniformLocation(surf, "uLaserMode"), this.laserMode ? 1 : 0);
    set("uBurnDepth", LASER_BURN_DEPTH_MM);
    
    // Upload camera-relative lighting uniforms (only used by cylProgram now)
    if (this.rotary) {
      gl.uniform3f(gl.getUniformLocation(surf, "uEye"), eye[0], eye[1], eye[2]);
      gl.uniform3f(gl.getUniformLocation(surf, "uCameraUp"), up[0], up[1], up[2]);
      
      const viewDir = [
        target[0] - eye[0],
        target[1] - eye[1],
        target[2] - eye[2]
      ];
      const len = Math.hypot(viewDir[0], viewDir[1], viewDir[2]);
      const fwd = [viewDir[0]/len, viewDir[1]/len, viewDir[2]/len];
      const right = [V[0], V[4], V[8]];
      
      const kx = -fwd[0] * 0.75 + right[0] * 0.5 + up[0] * 1.15;
      const ky = -fwd[1] * 0.75 + right[1] * 0.5 + up[1] * 1.15;
      const kz = -fwd[2] * 0.75 + right[2] * 0.5 + up[2] * 1.15;
      const kLen = Math.hypot(kx, ky, kz);
      gl.uniform3f(gl.getUniformLocation(surf, "uKeyDir"), kx/kLen, ky/kLen, kz/kLen);
      
      const fx = -fwd[0] * -0.40 + right[0] * -0.7 + up[0] * 0.60;
      const fy = -fwd[1] * -0.40 + right[1] * -0.7 + up[1] * 0.60;
      const fz = -fwd[2] * -0.40 + right[2] * -0.7 + up[2] * 0.60;
      const fLen = Math.hypot(fx, fy, fz);
      gl.uniform3f(gl.getUniformLocation(surf, "uFillDir"), fx/fLen, fy/fLen, fz/fLen);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.uniform1i(gl.getUniformLocation(surf, "uHeightMap"), 0);

    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  private bindOrbitControls(): void {
    const c = this.canvas;
    const signal = this.abortController.signal;

    c.addEventListener("mousedown", (e) => {
      if (e.button === 0) {
        this.dragging = true;
        this.lastMx = e.clientX;
        this.lastMy = e.clientY;
        c.style.cursor = "grabbing";
      } else if (e.button === 1) {
        e.preventDefault(); // stop browser auto-scroll mode
        this.panning = true;
        this.lastMx = e.clientX;
        this.lastMy = e.clientY;
        c.style.cursor = "move";
      }
    }, { signal });

    window.addEventListener("mousemove", (e) => {
      if (!this.dragging && !this.panning) return;
      const dx = e.clientX - this.lastMx;
      const dy = e.clientY - this.lastMy;
      this.lastMx = e.clientX;
      this.lastMy = e.clientY;

      if (this.dragging) {
        this.yaw -= dx * 0.006;
        // Flat stock is machined from the top, so orbit stays in the upper
        // hemisphere. A cylinder is cut all the way around, so let the camera go
        // completely around it.
        if (this.rotary) {
          this.pitch += dy * 0.006;
        } else {
          const limit = Math.PI / 2 - 0.05;
          this.pitch = Math.max(0.08, Math.min(limit, this.pitch + dy * 0.006));
        }
      } else {
        // Pan: translate target in camera right/up directions.
        // right = (cos(yaw), 0, -sin(yaw))
        // up    = (-sin(yaw)*sin(pitch), cos(pitch), -cos(yaw)*sin(pitch))
        const dist = (this.viewMetrics().diag * 1.4) / this.zoom;
        const speed = dist / (this.canvas.height || 1);
        const ry = this.yaw,
          rp = this.pitch;
        const rightX = Math.cos(ry),
          rightZ = -Math.sin(ry);
        const upX = -Math.sin(ry) * Math.sin(rp),
          upY = Math.cos(rp),
          upZ = -Math.cos(ry) * Math.sin(rp);
        this.panX -= dx * speed * rightX;
        this.panZ -= dx * speed * rightZ;
        this.panX += dy * speed * upX;
        this.panY += dy * speed * upY;
        this.panZ += dy * speed * upZ;
      }
      this.draw();
    }, { signal });

    window.addEventListener("mouseup", (e) => {
      if (e.button === 0 && this.dragging) {
        this.dragging = false;
        c.style.cursor = "grab";
      } else if (e.button === 1 && this.panning) {
        this.panning = false;
        c.style.cursor = "grab";
      }
    }, { signal });

    c.style.cursor = "grab";

    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.92 : 1.0 / 0.92;
        const newZoom = Math.max(0.15, Math.min(8, this.zoom * factor));
        if (newZoom === this.zoom) return;

        // A cylinder has no flat top plane to unproject onto, so just zoom
        // (centred) rather than toward the cursor.
        if (this.rotary) {
          this.zoom = newZoom;
          this.draw();
          return;
        }

        // Zoom toward the point under the cursor on the stock top face (Y = stockT).
        // Build the current MVP before applying the zoom change.
        const { diag, target } = this.viewMetrics();
        const dist = (diag * 1.4) / this.zoom;
        const eye = [
          target[0] + dist * Math.cos(this.pitch) * Math.sin(this.yaw),
          target[1] + dist * Math.sin(this.pitch),
          target[2] + dist * Math.cos(this.pitch) * Math.cos(this.yaw),
        ];
        const cssW = this.host.clientWidth || 1;
        const cssH = this.host.clientHeight || 1;
        const V = mat4();
        const up = [
          -Math.sin(this.pitch) * Math.sin(this.yaw),
          Math.cos(this.pitch),
          -Math.sin(this.pitch) * Math.cos(this.yaw)
        ];
        lookAt(V, eye, target, up);
        const P = mat4();
        perspective(P, 0.6, cssW / cssH, 0.1, diag * 10);
        const MVP = mat4();
        mul4(MVP, P, V);

        const hit = unprojectToY(e.offsetX, e.offsetY, cssW, cssH, MVP, this.stockT);
        if (hit) {
          // Shift pan target toward the hit point proportional to the zoom change.
          const blend = 1 - this.zoom / newZoom; // positive when zooming in
          this.panX += (hit[0] - target[0]) * blend;
          this.panY += (hit[1] - (this.stockT * 0.5 + this.panY)) * blend;
          this.panZ += (hit[2] - target[2]) * blend;
        }

        this.zoom = newZoom;
        this.draw();
      },
      { passive: false, signal },
    );
  }

  private buildProgram(vertSrc: string, fragSrc: string): WebGLProgram {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, vertSrc);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error(`WebGL link error: ${gl.getProgramInfoLog(prog)}`);
    return prog;
  }

  private deleteProgram(prog: WebGLProgram | null | undefined): void {
    if (!prog || !this.gl) return;
    const gl = this.gl;
    const shaders = gl.getAttachedShaders(prog);
    if (shaders) {
      for (const sh of shaders) {
        gl.detachShader(prog, sh);
        gl.deleteShader(sh);
      }
    }
    gl.deleteProgram(prog);
  }

  private compileShader(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
      throw new Error(`WebGL shader error: ${gl.getShaderInfoLog(sh)}`);
    return sh;
  }

  private showError(msg: string): void {
    const d = document.createElement("div");
    d.style.cssText = "color:#ff5d5d;padding:16px;font-size:13px;";
    d.textContent = msg;
    this.host.appendChild(d);
  }
}

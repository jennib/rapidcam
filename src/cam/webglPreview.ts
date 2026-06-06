import type { HeightMap } from "./stockRasterizer";

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

void main() {
  float h = texture(uHeightMap, aUV).r;
  vUV = aUV;
  vHeight = h;
  float wx = (aUV.x - 0.5) * uStockXZ.x;
  // UV.y=0 = world Y=0 (canvas bottom) → near side; flip so canvas top = far side,
  // matching the Y-up 2D canvas orientation when viewed from the default camera.
  float wz = (0.5 - aUV.y) * uStockXZ.y;
  gl_Position = uMVP * vec4(wx, h, wz, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;

uniform sampler2D uHeightMap;
uniform vec2 uTexelSize;  // 1/gridW, 1/gridH
uniform vec2 uCellMM;     // mm per texel in X and Z
uniform float uStockT;

in vec2 vUV;
in float vHeight;

out vec4 fragColor;

void main() {
  // Finite-difference surface normal
  float hL = texture(uHeightMap, vUV + vec2(-uTexelSize.x, 0.0)).r;
  float hR = texture(uHeightMap, vUV + vec2( uTexelSize.x, 0.0)).r;
  float hD = texture(uHeightMap, vUV + vec2(0.0, -uTexelSize.y)).r;
  float hU = texture(uHeightMap, vUV + vec2(0.0,  uTexelSize.y)).r;

  float gradX = (hL - hR) / (2.0 * uCellMM.x);
  // Z axis is flipped (wz = (0.5-UV.y)*H), so the Z gradient direction is negated.
  float gradZ = (hU - hD) / (2.0 * uCellMM.y);
  vec3 normal = normalize(vec3(gradX, 1.0, gradZ));

  // Wood color: uncut surface vs freshly cut vs through-cut shadow
  // All values in linear (pre-gamma) space.
  float t = clamp(vHeight / uStockT, 0.0, 1.0);
  vec3 deep     = vec3(0.06, 0.03, 0.01);   // shadow at base of deep cuts
  vec3 machined = vec3(0.76, 0.58, 0.30);   // fresh-cut pine, warm and bright
  vec3 uncut    = vec3(0.52, 0.34, 0.12);   // top surface, slightly darker/more worn

  vec3 baseColor;
  if (t < 0.08) {
    baseColor = mix(deep, machined, t / 0.08);
  } else {
    baseColor = mix(machined, uncut, smoothstep(0.0, 0.35, t - 0.08));
  }

  // Three-light rig — key from upper-right-front, fill from upper-left-back, top bounce.
  // Lights are in the same Y-up world space as the mesh normal.
  vec3 L1 = normalize(vec3( 0.6,  1.4,  0.8));
  vec3 L2 = normalize(vec3(-0.8,  1.0, -0.5));
  vec3 L3 = normalize(vec3( 0.1,  1.0,  0.3));

  float d1 = max(dot(normal, L1), 0.0);
  float d2 = max(dot(normal, L2), 0.0);
  float d3 = max(dot(normal, L3), 0.0);

  float light = 0.38               // ambient — raise floor so nothing goes black
              + d1 * 0.72          // key
              + d2 * 0.30          // fill
              + d3 * 0.18;         // bounce

  vec3 col = baseColor * light;

  // Gamma correction: linear → sRGB so the display looks correct.
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));

  // Edge highlight: cut walls have large height gradients — add a bright rim
  // so cuts read clearly from any orbit angle.
  float gradMag = length(vec2(gradX, gradZ));
  float edge = smoothstep(1.5, 6.0, gradMag) * 0.45;
  col = clamp(col + vec3(edge * 0.90, edge * 0.78, edge * 0.55), 0.0, 1.0);

  fragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------
// Mat4 helpers (column-major)
// ---------------------------------------------------------------------------

type Mat4 = Float32Array;

function mat4(): Mat4 { return new Float32Array(16); }

function perspective(m: Mat4, fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  m.fill(0);
  m[0]  = f / aspect;
  m[5]  = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

function lookAt(m: Mat4, eye: number[], center: number[], up: number[]): Mat4 {
  const fx = center[0] - eye[0], fy = center[1] - eye[1], fz = center[2] - eye[2];
  const fl = Math.sqrt(fx*fx + fy*fy + fz*fz);
  const f0 = fx/fl, f1 = fy/fl, f2 = fz/fl;

  const s0 = f1*up[2] - f2*up[1];
  const s1 = f2*up[0] - f0*up[2];
  const s2 = f0*up[1] - f1*up[0];
  const sl = Math.sqrt(s0*s0 + s1*s1 + s2*s2);
  const sx = s0/sl, sy = s1/sl, sz = s2/sl;

  const u0 = sy*f2 - sz*f1;
  const u1 = sz*f0 - sx*f2;
  const u2 = sx*f1 - sy*f0;

  m[ 0] = sx;  m[ 4] = sy;  m[ 8] = sz;  m[12] = -(sx*eye[0] + sy*eye[1] + sz*eye[2]);
  m[ 1] = u0;  m[ 5] = u1;  m[ 9] = u2;  m[13] = -(u0*eye[0] + u1*eye[1] + u2*eye[2]);
  m[ 2] = -f0; m[ 6] = -f1; m[10] = -f2; m[14] = f0*eye[0]  + f1*eye[1]  + f2*eye[2];
  m[ 3] = 0;   m[ 7] = 0;   m[11] = 0;   m[15] = 1;
  return m;
}

function mul4(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k*4+i] * b[j*4+k];
      out[j*4+i] = s;
    }
  }
  return out;
}

/** Invert a 4×4 matrix (column-major). Returns null if singular. */
function inv4(m: Mat4): Mat4 | null {
  const o = new Float32Array(16);
  const m00=m[0],m10=m[1],m20=m[2],m30=m[3];
  const m01=m[4],m11=m[5],m21=m[6],m31=m[7];
  const m02=m[8],m12=m[9],m22=m[10],m32=m[11];
  const m03=m[12],m13=m[13],m23=m[14],m33=m[15];
  const b00=m00*m11-m10*m01, b01=m00*m21-m20*m01, b02=m00*m31-m30*m01;
  const b03=m10*m21-m20*m11, b04=m10*m31-m30*m11, b05=m20*m31-m30*m21;
  const b06=m02*m13-m12*m03, b07=m02*m23-m22*m03, b08=m02*m33-m32*m03;
  const b09=m12*m23-m22*m13, b10=m12*m33-m32*m13, b11=m22*m33-m32*m23;
  const det=b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;
  if (Math.abs(det) < 1e-14) return null;
  const id = 1 / det;
  o[0] =( m11*b11-m21*b10+m31*b09)*id; o[1] =(-m10*b11+m20*b10-m30*b09)*id;
  o[2] =( m13*b05-m23*b04+m33*b03)*id; o[3] =(-m12*b05+m22*b04-m32*b03)*id;
  o[4] =(-m01*b11+m21*b08-m31*b07)*id; o[5] =( m00*b11-m20*b08+m30*b07)*id;
  o[6] =(-m03*b05+m23*b02-m33*b01)*id; o[7] =( m02*b05-m22*b02+m32*b01)*id;
  o[8] =( m01*b10-m11*b08+m31*b06)*id; o[9] =(-m00*b10+m10*b08-m30*b06)*id;
  o[10]=( m03*b04-m13*b02+m33*b00)*id; o[11]=(-m02*b04+m12*b02-m32*b00)*id;
  o[12]=(-m01*b09+m11*b07-m21*b06)*id; o[13]=( m00*b09-m10*b07+m20*b06)*id;
  o[14]=(-m03*b03+m13*b01-m23*b00)*id; o[15]=( m02*b03-m12*b01+m22*b00)*id;
  return o;
}

/**
 * Unproject a screen pixel to a world-space point on the horizontal plane Y=targetY.
 * Returns null if the ray is nearly parallel to the plane.
 */
function unprojectToY(
  px: number, py: number,           // pixel coords (CSS, not device)
  canvasW: number, canvasH: number, // CSS canvas size
  MVP: Mat4, targetY: number,
): [number, number, number] | null {
  const invMVP = inv4(MVP);
  if (!invMVP) return null;

  // Two NDC points on the ray (near and far)
  const ndcX =  (px / canvasW) * 2 - 1;
  const ndcY = -(py / canvasH) * 2 + 1; // flip Y: CSS y=0 is top

  const unproj = (ndcZ: number): [number, number, number] => {
    const ix = invMVP[0]*ndcX + invMVP[4]*ndcY + invMVP[8]*ndcZ  + invMVP[12];
    const iy = invMVP[1]*ndcX + invMVP[5]*ndcY + invMVP[9]*ndcZ  + invMVP[13];
    const iz = invMVP[2]*ndcX + invMVP[6]*ndcY + invMVP[10]*ndcZ + invMVP[14];
    const iw = invMVP[3]*ndcX + invMVP[7]*ndcY + invMVP[11]*ndcZ + invMVP[15];
    return [ix/iw, iy/iw, iz/iw];
  };

  const near = unproj(-1);
  const far  = unproj( 1);
  const dy = far[1] - near[1];
  if (Math.abs(dy) < 1e-6) return null; // ray parallel to plane
  const t = (targetY - near[1]) / dy;
  return [
    near[0] + t * (far[0] - near[0]),
    targetY,
    near[2] + t * (far[2] - near[2]),
  ];
}

// ---------------------------------------------------------------------------
// WebGLPreview
// ---------------------------------------------------------------------------

const DEFAULT_YAW   = Math.PI / 4;
const DEFAULT_PITCH = Math.atan(1 / Math.sqrt(2)); // ~35.26° isometric
const DEFAULT_ZOOM  = 1.0;

export class WebGLPreview {
  private canvas: HTMLCanvasElement;
  private resetBtn: HTMLButtonElement;
  private statusEl: HTMLElement;
  private gl!: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private heightTex!: WebGLTexture;
  private indexCount = 0;

  // Last rendered height map dimensions (for uniform upload)
  private gridW = 0;
  private gridH = 0;
  private stockW = 0;
  private stockH = 0;
  private stockT = 0;

  // Orbit state
  private yaw   = DEFAULT_YAW;
  private pitch = DEFAULT_PITCH;
  private zoom  = DEFAULT_ZOOM;
  private dragging = false;
  private panning  = false;
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
    this.resetBtn.addEventListener("click", () => this.resetView());

    this.statusEl = document.createElement("div");
    this.statusEl.className = "webgl-status";
    this.statusEl.style.display = "none";

    host.appendChild(this.canvas);
    host.appendChild(this.resetBtn);
    host.appendChild(this.statusEl);

    const gl = this.canvas.getContext("webgl2");
    if (!gl) { this.showError("WebGL 2 not supported in this browser."); return; }
    this.gl = gl;

    this.program = this.buildProgram(VERT, FRAG);
    this.heightTex = this.createHeightTexture();
    this.bindOrbitControls();

    new ResizeObserver(() => this.handleResize()).observe(host);
    this.handleResize();
  }

  render(hm: HeightMap): void {
    const gl = this.gl;
    if (!gl) return;

    const needsMesh = this.indexCount === 0 || this.gridW !== hm.gridW || this.gridH !== hm.gridH;

    this.gridW  = hm.gridW;
    this.gridH  = hm.gridH;
    this.stockW = hm.stockW;
    this.stockH = hm.stockH;
    this.stockT = hm.stockT;

    if (needsMesh) this.buildMesh(hm.gridW, hm.gridH);

    // Upload height data as R32F texture
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.R32F,
      hm.gridW, hm.gridH, 0,
      gl.RED, gl.FLOAT, hm.data,
    );

    // Scan for any material removal so we can warn when cuts are absent.
    let minH = hm.stockT;
    for (let i = 0; i < hm.data.length; i++) {
      if (hm.data[i] < minH) minH = hm.data[i];
    }
    const hasCuts = minH < hm.stockT - 0.5;
    this.statusEl.textContent = "No material removed — check geometry selection";
    this.statusEl.style.display = hasCuts ? "none" : "block";

    this.draw();
  }

  resetView(): void {
    this.yaw   = DEFAULT_YAW;
    this.pitch = DEFAULT_PITCH;
    this.zoom  = DEFAULT_ZOOM;
    this.panX  = 0;
    this.panY  = 0;
    this.panZ  = 0;
    this.draw();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private handleResize(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width  = Math.round(w * dpr);
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
        indices[ii++] = tl; indices[ii++] = bl; indices[ii++] = tr;
        indices[ii++] = tr; indices[ii++] = bl; indices[ii++] = br;
      }
    }
    this.indexCount = indices.length;

    if (this.vao) gl.deleteVertexArray(this.vao);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);

    const aUV = gl.getAttribLocation(this.program, "aUV");
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);

    const ebo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
  }

  private createHeightTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // 1×1 placeholder
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array([0]));
    // NEAREST avoids the OES_texture_float_linear extension requirement for R32F.
    // One texel = one height cell, so NEAREST is exact anyway.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private draw(): void {
    const gl = this.gl;
    if (!gl || this.indexCount === 0 || this.stockW === 0) return;

    gl.clearColor(0.12, 0.13, 0.14, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    gl.useProgram(this.program);

    // Camera
    const diag = Math.sqrt(this.stockW**2 + this.stockH**2 + this.stockT**2);
    const baseDist = diag * 1.4;
    const dist = baseDist / this.zoom;
    const target = [this.panX, this.stockT * 0.5 + this.panY, this.panZ];
    const eye = [
      target[0] + dist * Math.cos(this.pitch) * Math.sin(this.yaw),
      target[1] + dist * Math.sin(this.pitch),
      target[2] + dist * Math.cos(this.pitch) * Math.cos(this.yaw),
    ];

    const V = mat4(); lookAt(V, eye, target, [0, 1, 0]);
    const aspect = this.canvas.width / this.canvas.height;
    const P = mat4(); perspective(P, 0.6, aspect, 0.1, diag * 10);
    const MVP = mat4(); mul4(MVP, P, V);

    const set = (name: string, ...v: number[]) => {
      const loc = gl.getUniformLocation(this.program, name);
      if (v.length === 1) gl.uniform1f(loc, v[0]);
      else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
      else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
    };
    gl.uniformMatrix4fv(gl.getUniformLocation(this.program, "uMVP"), false, MVP);
    set("uStockXZ", this.stockW, this.stockH);
    set("uStockT",  this.stockT);
    set("uTexelSize", 1 / this.gridW, 1 / this.gridH);
    set("uCellMM",  this.stockW / (this.gridW - 1), this.stockH / (this.gridH - 1));

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.uniform1i(gl.getUniformLocation(this.program, "uHeightMap"), 0);

    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  private bindOrbitControls(): void {
    const c = this.canvas;

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
    });

    window.addEventListener("mousemove", (e) => {
      if (!this.dragging && !this.panning) return;
      const dx = e.clientX - this.lastMx;
      const dy = e.clientY - this.lastMy;
      this.lastMx = e.clientX;
      this.lastMy = e.clientY;

      if (this.dragging) {
        this.yaw   -= dx * 0.006;
        this.pitch  = Math.max(0.08, Math.min(Math.PI / 2 - 0.05, this.pitch + dy * 0.006));
      } else {
        // Pan: translate target in camera right/up directions.
        // right = (cos(yaw), 0, -sin(yaw))
        // up    = (-sin(yaw)*sin(pitch), cos(pitch), -cos(yaw)*sin(pitch))
        const diag     = Math.sqrt(this.stockW ** 2 + this.stockH ** 2 + this.stockT ** 2);
        const dist     = diag * 1.4 / this.zoom;
        const speed    = dist / (this.canvas.height || 1);
        const ry = this.yaw, rp = this.pitch;
        const rightX =  Math.cos(ry),                         rightZ = -Math.sin(ry);
        const upX    = -Math.sin(ry) * Math.sin(rp), upY = Math.cos(rp), upZ = -Math.cos(ry) * Math.sin(rp);
        this.panX -= dx * speed * rightX;
        this.panZ -= dx * speed * rightZ;
        this.panX += dy * speed * upX;
        this.panY += dy * speed * upY;
        this.panZ += dy * speed * upZ;
      }
      this.draw();
    });

    window.addEventListener("mouseup", (e) => {
      if (e.button === 0 && this.dragging) {
        this.dragging = false;
        c.style.cursor = "grab";
      } else if (e.button === 1 && this.panning) {
        this.panning = false;
        c.style.cursor = "grab";
      }
    });

    c.style.cursor = "grab";

    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor  = e.deltaY > 0 ? 0.92 : 1.0 / 0.92;
      const newZoom = Math.max(0.15, Math.min(8, this.zoom * factor));
      if (newZoom === this.zoom) return;

      // Zoom toward the point under the cursor on the stock top face (Y = stockT).
      // Build the current MVP before applying the zoom change.
      const diag     = Math.sqrt(this.stockW ** 2 + this.stockH ** 2 + this.stockT ** 2);
      const dist     = diag * 1.4 / this.zoom;
      const target   = [this.panX, this.stockT * 0.5 + this.panY, this.panZ];
      const eye      = [
        target[0] + dist * Math.cos(this.pitch) * Math.sin(this.yaw),
        target[1] + dist * Math.sin(this.pitch),
        target[2] + dist * Math.cos(this.pitch) * Math.cos(this.yaw),
      ];
      const cssW  = this.host.clientWidth  || 1;
      const cssH  = this.host.clientHeight || 1;
      const V   = mat4(); lookAt(V, eye, target, [0, 1, 0]);
      const P   = mat4(); perspective(P, 0.6, cssW / cssH, 0.1, diag * 10);
      const MVP = mat4(); mul4(MVP, P, V);

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
    }, { passive: false });
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
      throw new Error("WebGL link error: " + gl.getProgramInfoLog(prog));
    return prog;
  }

  private compileShader(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
      throw new Error("WebGL shader error: " + gl.getShaderInfoLog(sh));
    return sh;
  }

  private showError(msg: string): void {
    const d = document.createElement("div");
    d.style.cssText = "color:#ff5d5d;padding:16px;font-size:13px;";
    d.textContent = msg;
    this.host.appendChild(d);
  }
}

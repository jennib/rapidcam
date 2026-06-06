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
  float wz = (aUV.y - 0.5) * uStockXZ.y;
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

  vec3 normal = normalize(vec3(
    (hL - hR) / (2.0 * uCellMM.x),
    1.0,
    (hD - hU) / (2.0 * uCellMM.y)
  ));

  // Wood color: uncut surface vs freshly cut vs through-cut shadow
  float t = clamp(vHeight / uStockT, 0.0, 1.0);
  vec3 deep     = vec3(0.14, 0.09, 0.04);   // near-black shadow in deep cuts
  vec3 machined = vec3(0.88, 0.73, 0.48);   // fresh cut wood, lighter
  vec3 uncut    = vec3(0.60, 0.40, 0.18);   // top surface, darker/more worn

  vec3 baseColor;
  if (t < 0.08) {
    baseColor = mix(deep, machined, t / 0.08);
  } else {
    baseColor = mix(machined, uncut, smoothstep(0.0, 0.30, t - 0.08));
  }

  // Three-light rig so cuts read clearly from any orbit angle:
  //   L1 = warm key from top-right-front
  //   L2 = cool fill from top-left-back
  //   L3 = soft top bounce
  vec3 L1 = normalize(vec3( 0.8,  1.6,  0.6));
  vec3 L2 = normalize(vec3(-0.6,  0.9, -0.8));
  vec3 L3 = normalize(vec3( 0.0,  1.0,  0.0));

  float d1 = max(dot(normal, L1), 0.0);
  float d2 = max(dot(normal, L2), 0.0);
  float d3 = max(dot(normal, L3), 0.0);

  float light = 0.22               // ambient
              + d1 * 0.68          // key
              + d2 * 0.28          // fill
              + d3 * 0.12;         // bounce

  fragColor = vec4(baseColor * light, 1.0);
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

// ---------------------------------------------------------------------------
// WebGLPreview
// ---------------------------------------------------------------------------

const DEFAULT_YAW   = Math.PI / 4;
const DEFAULT_PITCH = Math.atan(1 / Math.sqrt(2)); // ~35.26° isometric
const DEFAULT_ZOOM  = 1.0;

export class WebGLPreview {
  private canvas: HTMLCanvasElement;
  private resetBtn: HTMLButtonElement;
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
  private lastMx = 0;
  private lastMy = 0;

  constructor(private host: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "display:block;width:100%;height:100%;";

    this.resetBtn = document.createElement("button");
    this.resetBtn.className = "webgl-reset-btn";
    this.resetBtn.textContent = "⟳ Reset View";
    this.resetBtn.addEventListener("click", () => this.resetView());

    host.appendChild(this.canvas);
    host.appendChild(this.resetBtn);

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

    this.draw();
  }

  resetView(): void {
    this.yaw   = DEFAULT_YAW;
    this.pitch = DEFAULT_PITCH;
    this.zoom  = DEFAULT_ZOOM;
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
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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
    const target = [0, this.stockT * 0.5, 0];
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
      if (e.button !== 0) return;
      this.dragging = true;
      this.lastMx = e.clientX;
      this.lastMy = e.clientY;
      c.style.cursor = "grabbing";
    });

    window.addEventListener("mousemove", (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastMx;
      const dy = e.clientY - this.lastMy;
      this.lastMx = e.clientX;
      this.lastMy = e.clientY;
      this.yaw   -= dx * 0.006;
      this.pitch  = Math.max(0.08, Math.min(Math.PI / 2 - 0.05, this.pitch + dy * 0.006));
      this.draw();
    });

    window.addEventListener("mouseup", () => {
      if (!this.dragging) return;
      this.dragging = false;
      c.style.cursor = "grab";
    });

    c.style.cursor = "grab";

    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.92 : 1.0 / 0.92;
      this.zoom = Math.max(0.15, Math.min(8, this.zoom * factor));
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

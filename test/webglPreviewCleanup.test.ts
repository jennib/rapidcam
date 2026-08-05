// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WebGLPreview } from "../src/cam/webglPreview";
import type { HeightMap } from "../src/cam/stockRasterizer";

describe("WebGLPreview resource cleanup and dispose()", () => {
  let host: HTMLDivElement;
  let mockGL: Record<string, any>;
  let loseContextMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);

    loseContextMock = vi.fn();
    const attachedShadersMap = new Map<any, any[]>();

    mockGL = {
      VERTEX_SHADER: 1,
      FRAGMENT_SHADER: 2,
      COMPILE_STATUS: 3,
      LINK_STATUS: 4,
      TEXTURE_2D: 3553,
      R32F: 33326,
      RED: 6403,
      FLOAT: 5126,
      STATIC_DRAW: 35044,
      ARRAY_BUFFER: 34962,
      ELEMENT_ARRAY_BUFFER: 34963,
      TRIANGLES: 4,
      UNSIGNED_INT: 5125,
      UNSIGNED_SHORT: 5123,
      COLOR_BUFFER_BIT: 16384,
      DEPTH_BUFFER_BIT: 256,
      DEPTH_TEST: 2929,
      TEXTURE_MIN_FILTER: 10241,
      TEXTURE_MAG_FILTER: 10240,
      TEXTURE_WRAP_S: 10242,
      TEXTURE_WRAP_T: 10243,
      CLAMP_TO_EDGE: 33071,
      LINEAR: 9729,
      NEAREST: 9728,
      TEXTURE0: 33984,
      activeTexture: vi.fn(),
      createProgram: vi.fn(() => {
        const prog = { id: Symbol("program") };
        attachedShadersMap.set(prog, []);
        return prog;
      }),
      createShader: vi.fn(() => ({ id: Symbol("shader") })),
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      getShaderParameter: vi.fn(() => true),
      attachShader: vi.fn((prog, sh) => {
        const list = attachedShadersMap.get(prog) ?? [];
        list.push(sh);
        attachedShadersMap.set(prog, list);
      }),
      detachShader: vi.fn((prog, sh) => {
        const list = attachedShadersMap.get(prog) ?? [];
        attachedShadersMap.set(
          prog,
          list.filter((s) => s !== sh)
        );
      }),
      getAttachedShaders: vi.fn((prog) => attachedShadersMap.get(prog) ?? []),
      linkProgram: vi.fn(),
      getProgramParameter: vi.fn(() => true),
      createTexture: vi.fn(() => ({ id: Symbol("texture") })),
      bindTexture: vi.fn(),
      texImage2D: vi.fn(),
      texParameteri: vi.fn(),
      createVertexArray: vi.fn(() => ({ id: Symbol("vao") })),
      bindVertexArray: vi.fn(),
      createBuffer: vi.fn(() => ({ id: Symbol("buffer") })),
      bindBuffer: vi.fn(),
      bufferData: vi.fn(),
      getAttribLocation: vi.fn(() => 0),
      enableVertexAttribArray: vi.fn(),
      vertexAttribPointer: vi.fn(),
      getUniformLocation: vi.fn(() => ({ id: Symbol("uniform") })),
      uniform1i: vi.fn(),
      uniform1f: vi.fn(),
      uniform2f: vi.fn(),
      uniform3f: vi.fn(),
      uniformMatrix4fv: vi.fn(),
      viewport: vi.fn(),
      clearColor: vi.fn(),
      clear: vi.fn(),
      enable: vi.fn(),
      useProgram: vi.fn(),
      drawElements: vi.fn(),
      deleteVertexArray: vi.fn(),
      deleteBuffer: vi.fn(),
      deleteTexture: vi.fn(),
      deleteProgram: vi.fn(),
      deleteShader: vi.fn(),
      getExtension: vi.fn((name: string) => {
        if (name === "WEBGL_lose_context") return { loseContext: loseContextMock };
        if (name === "OES_texture_float_linear") return {};
        return null;
      }),
    };

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((type: string) => {
      if (type === "webgl2") return mockGL as any;
      return null;
    });
  });

  it("attaches DOM elements and creates resources on construction", () => {
    const preview = new WebGLPreview(host);
    expect(host.children.length).toBe(3); // canvas, resetBtn, statusEl
    expect(preview.isDisposed).toBe(false);
    expect(mockGL.createProgram).toHaveBeenCalledTimes(3); // flat, box, cyl
  });

  it("tracks and cleans up previous mesh buffers when rebuilt with new dimensions", () => {
    const preview = new WebGLPreview(host);
    const hm1: HeightMap = {
      gridW: 10,
      gridH: 10,
      stockW: 100,
      stockH: 100,
      stockT: 10,
      data: new Float32Array(100).fill(10),
    };
    preview.render(hm1);

    const initialBufferDeletions = mockGL.deleteBuffer.mock.calls.length;

    // Render with different grid size to trigger mesh rebuild
    const hm2: HeightMap = {
      gridW: 20,
      gridH: 20,
      stockW: 100,
      stockH: 100,
      stockT: 10,
      data: new Float32Array(400).fill(10),
    };
    preview.render(hm2);

    expect(mockGL.deleteBuffer.mock.calls.length).toBeGreaterThan(initialBufferDeletions);
    expect(mockGL.deleteVertexArray).toHaveBeenCalled();
  });

  it("disposes all GPU resources, DOM elements, and listeners on dispose()", () => {
    const preview = new WebGLPreview(host);
    const hm: HeightMap = {
      gridW: 10,
      gridH: 10,
      stockW: 100,
      stockH: 100,
      stockT: 10,
      data: new Float32Array(100).fill(10),
    };
    preview.render(hm);

    preview.dispose();

    expect(preview.isDisposed).toBe(true);
    expect(host.children.length).toBe(0); // canvas, resetBtn, statusEl removed
    expect(mockGL.deleteTexture).toHaveBeenCalled();
    expect(mockGL.deleteVertexArray).toHaveBeenCalled();
    expect(mockGL.deleteBuffer).toHaveBeenCalled();
    expect(mockGL.deleteProgram).toHaveBeenCalledTimes(3);
    expect(mockGL.deleteShader).toHaveBeenCalled();
    expect(mockGL.detachShader).toHaveBeenCalled();
    expect(loseContextMock).toHaveBeenCalledTimes(1);

    // Double dispose should be a safe no-op
    expect(() => preview.dispose()).not.toThrow();

    // Calling render after dispose should be a no-op and not throw
    expect(() => preview.render(hm)).not.toThrow();
  });
});

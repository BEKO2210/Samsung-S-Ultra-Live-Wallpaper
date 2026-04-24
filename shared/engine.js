// Shared WebGL2 bootstrap for every wallpaper.
// Dependency-free; one file; every helper is allocation-frugal.

export function createCanvas(opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.id = 'stage';
  document.body.appendChild(canvas);

  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    ...opts,
  });

  if (!gl) throw new Error('WebGL2 not supported on this device');
  return { canvas, gl };
}

export function fitCanvas(canvas, maxDpr = 2) {
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.floor(window.innerWidth * dpr);
  const h = Math.floor(window.innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { width: w, height: h, dpr };
}

export function onResize(canvas, cb, maxDpr = 2) {
  const handler = () => cb(fitCanvas(canvas, maxDpr));
  handler();
  window.addEventListener('resize', handler, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', handler, { passive: true });
  }
}

export function startLoop(render) {
  let running = true;
  let last = performance.now();
  let frameId;

  const tick = (now) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    render(dt, now / 1000);
    frameId = requestAnimationFrame(tick);
  };
  frameId = requestAnimationFrame(tick);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && running) {
      running = false;
      cancelAnimationFrame(frameId);
    } else if (!document.hidden && !running) {
      running = true;
      last = performance.now();
      frameId = requestAnimationFrame(tick);
    }
  });
}

// Normalized input. Pointer and tilt share one [-1,1] signal so wallpapers
// don't need to know the source. tap* are latched on pointerdown for
// wallpapers that want touch-reactive effects (e.g. cosmic nebula).
export function createInput(target = window) {
  const state = {
    x: 0, y: 0,
    targetX: 0, targetY: 0,
    tapX: 0, tapY: 0, tapPulse: 0,
  };

  target.addEventListener('pointermove', (e) => {
    state.targetX = (e.clientX / window.innerWidth) * 2 - 1;
    state.targetY = -((e.clientY / window.innerHeight) * 2 - 1);
  }, { passive: true });

  target.addEventListener('pointerdown', (e) => {
    state.tapX = (e.clientX / window.innerWidth) * 2 - 1;
    state.tapY = -((e.clientY / window.innerHeight) * 2 - 1);
    state.tapPulse = 1;
  }, { passive: true });

  window.addEventListener('deviceorientation', (e) => {
    if (e.gamma == null || e.beta == null) return;
    state.targetX = Math.max(-1, Math.min(1, e.gamma / 30));
    state.targetY = Math.max(-1, Math.min(1, (e.beta - 45) / 45));
  }, { passive: true });

  state.update = (dt) => {
    const k = 1 - Math.exp(-dt * 6);
    state.x += (state.targetX - state.x) * k;
    state.y += (state.targetY - state.y) * k;
    state.tapPulse *= Math.exp(-dt * 1.5);
  };

  return state;
}

export function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile error: ' + log + '\n' + src);
  }
  return sh;
}

export function link(gl, vsSrc, fsSrc, attribs = {}) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  for (const [name, loc] of Object.entries(attribs)) {
    gl.bindAttribLocation(p, loc, name);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error('Program link error: ' + log);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return p;
}

export function uniformLocs(gl, program, names) {
  const out = {};
  for (const n of names) out[n] = gl.getUniformLocation(program, n);
  return out;
}

export function uploadAttrib(gl, loc, data, components) {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, components, gl.FLOAT, false, 0, 0);
  return buf;
}

// ---- mat4 (column-major, right-handed, -Z forward) ----
// All helpers accept an optional `out` to avoid per-frame allocations.

export function mat4Identity(out = new Float32Array(16)) {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

export function mat4Perspective(fovY, aspect, near, far, out = new Float32Array(16)) {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

export function mat4LookAt(ex, ey, ez, cx, cy, cz, ux, uy, uz, out = new Float32Array(16)) {
  let zx = ex - cx, zy = ey - cy, zz = ez - cz;
  let l = 1 / Math.hypot(zx, zy, zz); zx *= l; zy *= l; zz *= l;
  let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
  l = 1 / Math.hypot(xx, xy, xz); xx *= l; xy *= l; xz *= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * ex + xy * ey + xz * ez);
  out[13] = -(yx * ex + yy * ey + yz * ez);
  out[14] = -(zx * ex + zy * ey + zz * ez);
  out[15] = 1;
  return out;
}

// Render-to-texture target. Call `resize(w, h)` whenever the viewport
// changes; it lazily (re)allocates an RGBA8 color texture and FBO. Useful
// for post-effects that need to sample the scene (e.g. gravitational
// lensing of the galaxy fog around a black hole).
export function createRenderTarget(gl) {
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  let w = 0, h = 0;

  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return {
    tex, fbo,
    get width() { return w; },
    get height() { return h; },
    resize(nw, nh) {
      if (nw === w && nh === h) return;
      w = nw; h = nh;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA,
        w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    },
    bind() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, w, h);
    },
  };
}

// Catches throws from a wallpaper entry and shows them on screen without
// using innerHTML (avoids DOM-XSS from shader error strings).
export function runWallpaper(mainFn) {
  try {
    mainFn();
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const pre = document.createElement('pre');
    pre.style.cssText = 'color:#fff;padding:20px;font-size:12px;white-space:pre-wrap;';
    pre.textContent = msg;
    document.body.replaceChildren(pre);
    throw err;
  }
}

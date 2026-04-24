import {
  createCanvas, onResize, startLoop, createInput,
  link, uniformLocs, uploadAttrib, runWallpaper, fadeHud,
  mat4Perspective, mat4LookAt,
} from '../../shared/engine.js';

// Spacetime grid — a square mesh in the xz plane rendered as GL_LINES.
// Up to MAX_MASSES invisible point masses deflect every vertex downward
// by the softened-Newtonian profile y = −M / √(r² + ε²). The sum over
// masses gives the Flamm-paraboloid embedding look. The last slot
// (index MAX_MASSES−1) is reserved for a touch-driven well that tracks
// the finger while the user holds a pointer.
const GRID_N      = 180;              // vertices per side → (N−1)² cells
const GRID_EXTENT = 5.5;              // world-unit half-width
const ORBIT_MASSES = 4;               // autonomous orbiting wells
const MAX_MASSES  = 5;                // hard cap — also GLSL array size (last = touch)
const TOUCH_SLOT  = MAX_MASSES - 1;
const TOUCH_STRENGTH = 1.1;           // fully-engaged finger well depth
const SOFTEN      = 0.06;             // ε² in Newtonian softening
const STAR_COUNT  = 2400;             // sphere-distributed background stars

const GRID_VS = /* glsl */ `#version 300 es
precision highp float;

#define MAX_MASSES ${MAX_MASSES}

layout(location = 0) in vec2 aXZ;     // vertex grid coord in [-1..1]

uniform mat4  uProj;
uniform mat4  uView;
uniform float uExtent;
uniform float uSoften;
uniform int   uMassCount;
// Each mass: (x, z, strength) in world units / world units / unitless.
uniform vec3  uMasses[MAX_MASSES];

out float vViewDist;
out float vY;

void main() {
  vec2 xz = aXZ * uExtent;

  // Sum softened wells. Loop is bounded so WebGL2 unrolls it cleanly
  // on mobile GPUs. Break once we pass the active count.
  float y = 0.0;
  for (int i = 0; i < MAX_MASSES; i++) {
    if (i >= uMassCount) break;
    vec2 dp = xz - uMasses[i].xy;
    float r2 = dot(dp, dp) + uSoften;
    y -= uMasses[i].z / sqrt(r2);
  }

  vec4 viewPos = uView * vec4(xz.x, y, xz.y, 1.0);
  vY = y;
  vViewDist = -viewPos.z;
  gl_Position = uProj * viewPos;
}
`;

const GRID_FS = /* glsl */ `#version 300 es
precision highp float;

in float vViewDist;
in float vY;
out vec4 outColor;

uniform float uMaxDepth;   // typical deepest y (negative), used to normalize

void main() {
  // Depth of this vertex into the well (0 at surface, 1+ deep).
  float t = clamp(-vY / uMaxDepth, 0.0, 1.4);

  // Colour gradient — flat lattice reads cool cyan, deep wells slide
  // through teal → magenta → warm-orange ("gravitational redshift"
  // vibe). The surface colour is dim so the bright wells dominate.
  vec3 surface  = vec3(0.28, 0.70, 1.00);
  vec3 midWell  = vec3(0.55, 0.45, 1.00);
  vec3 deepWell = vec3(1.00, 0.35, 0.55);
  vec3 col = mix(surface, midWell, smoothstep(0.10, 0.60, t));
  col      = mix(col,     deepWell, smoothstep(0.60, 1.10, t));

  // Brightness rises with depth — wells glow because spacetime is
  // more "compressed" there (lines get denser in screen space too).
  float depthGain = 0.55 + 1.80 * smoothstep(0.0, 1.0, t);

  // Exponential depth fog so distant lines melt into the void.
  float fog = exp(-vViewDist * 0.11);

  float lum = depthGain * fog;
  outColor = vec4(col * lum, lum);
}
`;

// Distant starfield drawn as GL_POINTS on a sphere centered on the
// camera. We subtract the camera position in the VS so the stars stay
// locked to the sky and don't move with the grid — pure parallax
// background, no gravity deflection.
const STAR_VS = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec3  aDir;    // unit direction in world space
layout(location = 1) in float aSize;
layout(location = 2) in float aColor;  // stellar class: 0 blue → 1 red
layout(location = 3) in float aTwinkle;

uniform mat4  uProj;
uniform mat4  uView;
uniform float uPixelScale;
uniform float uTime;
uniform float uSphereRadius;
uniform vec3  uCamPos;

out vec3  vColor;
out float vAlpha;

void main() {
  vec3 pos = uCamPos + aDir * uSphereRadius;
  vec4 viewPos = uView * vec4(pos, 1.0);
  gl_Position = uProj * viewPos;

  gl_PointSize = clamp(aSize * uPixelScale, 1.0, 8.0);

  vec3 hot  = vec3(0.70, 0.82, 1.10);    // O/B
  vec3 warm = vec3(1.00, 0.88, 0.65);    // G
  vec3 cool = vec3(1.00, 0.55, 0.40);    // M
  vec3 c = mix(hot, warm, smoothstep(0.0, 0.6, aColor));
  c      = mix(c,   cool, smoothstep(0.6, 1.0, aColor));
  vColor = c;

  float tw = 0.75 + 0.25 * sin(uTime * 2.0 + aTwinkle * 6.283);
  vAlpha = tw * 0.75;
}
`;

const STAR_FS = /* glsl */ `#version 300 es
precision highp float;

in vec3  vColor;
in float vAlpha;
out vec4 outColor;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d2 = dot(uv, uv) * 4.0;
  if (d2 > 1.0) discard;
  float core = exp(-d2 * 7.0);
  float halo = exp(-d2 * 1.5) * 0.30;
  float a = (core + halo) * vAlpha;
  outColor = vec4(vColor * a, a);
}
`;

// Uniformly-distributed directions on the unit sphere (Marsaglia).
function buildStars(count) {
  const dir     = new Float32Array(count * 3);
  const size    = new Float32Array(count);
  const color   = new Float32Array(count);
  const twinkle = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let x, y, s;
    do {
      x = Math.random() * 2 - 1;
      y = Math.random() * 2 - 1;
      s = x * x + y * y;
    } while (s >= 1);
    const f = 2 * Math.sqrt(1 - s);
    dir[i * 3]     = x * f;
    dir[i * 3 + 1] = 1 - 2 * s;
    dir[i * 3 + 2] = y * f;
    // Rare bright stars, majority faint.
    size[i]    = 0.9 + (Math.random() < 0.03 ? Math.random() * 3.5 : Math.random() * 1.4);
    color[i]   = Math.random();
    twinkle[i] = Math.random();
  }
  return { dir, size, color, twinkle };
}

// Build an indexed line list over an N×N lattice. N ≤ 255 so the largest
// index fits in a Uint16 (65 535); larger grids need Uint32.
function buildGrid(n) {
  if (n * n > 65535) throw new Error('buildGrid: N too large for Uint16 indices');
  const verts = new Float32Array(n * n * 2);
  for (let j = 0; j < n; j++) {
    const v = (j / (n - 1)) * 2.0 - 1.0;
    for (let i = 0; i < n; i++) {
      const u = (i / (n - 1)) * 2.0 - 1.0;
      const k = (j * n + i) * 2;
      verts[k]     = u;
      verts[k + 1] = v;
    }
  }

  // 2·N·(N−1) segments · 2 indices/segment.
  const indices = new Uint16Array(4 * n * (n - 1));
  let p = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n - 1; i++) {
      indices[p++] = j * n + i;
      indices[p++] = j * n + i + 1;
    }
  }
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n; i++) {
      indices[p++] = j * n + i;
      indices[p++] = (j + 1) * n + i;
    }
  }

  return { verts, indices };
}

// Each mass orbits on its own slow ellipse with an independent phase.
// Strengths and periods are randomized so the grid feels alive without
// any clear rhythm. Positions are regenerated once; only their
// time-evaluated x/z change every frame.
function buildMasses(count) {
  const m = [];
  for (let i = 0; i < count; i++) {
    m.push({
      ax:     1.8 + Math.random() * 2.2,          // semi-major in x
      az:     1.6 + Math.random() * 2.0,          // semi-major in z
      phase:  Math.random() * Math.PI * 2,
      speed:  0.10 + Math.random() * 0.18,
      skew:   (Math.random() - 0.5) * 0.8,        // rotates the ellipse
      strength: 0.45 + Math.random() * 0.55,      // well depth M
    });
  }
  return m;
}

function main() {
  const { canvas, gl } = createCanvas();

  const prog = link(gl, GRID_VS, GRID_FS);
  const u = uniformLocs(gl, prog, [
    'uProj', 'uView', 'uExtent', 'uSoften', 'uMassCount', 'uMasses',
    'uMaxDepth',
  ]);

  // --- Background starfield program ---
  const starProg = link(gl, STAR_VS, STAR_FS);
  const su = uniformLocs(gl, starProg, [
    'uProj', 'uView', 'uPixelScale', 'uTime', 'uSphereRadius', 'uCamPos',
  ]);
  const stars = buildStars(STAR_COUNT);
  const starVao = gl.createVertexArray();
  gl.bindVertexArray(starVao);
  uploadAttrib(gl, 0, stars.dir,     3);
  uploadAttrib(gl, 1, stars.size,    1);
  uploadAttrib(gl, 2, stars.color,   1);
  uploadAttrib(gl, 3, stars.twinkle, 1);

  const { verts, indices } = buildGrid(GRID_N);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

  gl.clearColor(0, 0, 0, 1);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);

  const proj = new Float32Array(16);
  const view = new Float32Array(16);
  let pixelScale = 1;

  onResize(canvas, (size) => {
    gl.viewport(0, 0, size.width, size.height);
    // Far plane 80 gives us room for the star sphere at radius 30.
    mat4Perspective(Math.PI / 3.2, size.width / size.height, 0.05, 80.0, proj);
    pixelScale = size.height * 0.0016;
  });

  const input = createInput();
  // Grid lies flat on the display: tilt ≈ 88° (straight down with a hint
  // of 3D parallax). Distance sized so the (−5.5..5.5) extent fills the
  // portrait frame with a little horizon margin.
  const cam = { distance: 7.0, tilt: 1.45, yaw: 0 };

  const orbitMasses = buildMasses(ORBIT_MASSES);
  // Packed (x, z, strength) for each mass, uploaded via uniform3fv.
  const massBuf = new Float32Array(MAX_MASSES * 3);

  // Touch well state: position in world XZ, interpolated strength
  // (eased toward TOUCH_STRENGTH while holding, toward 0 on release).
  const touch = { x: 0, z: 0, strength: 0 };

  // Bound on uMaxDepth: the deepest well we'll ever produce. Touch can
  // dominate, so use its strength as the upper bound.
  const maxStrength = Math.max(
    TOUCH_STRENGTH,
    orbitMasses.reduce((a, m) => Math.max(a, m.strength), 0),
  );
  gl.useProgram(prog);
  gl.uniform1f(u.uExtent,    GRID_EXTENT);
  gl.uniform1f(u.uSoften,    SOFTEN);
  gl.uniform1f(u.uMaxDepth,  maxStrength / Math.sqrt(SOFTEN));
  gl.uniform1i(u.uMassCount, MAX_MASSES);
  gl.useProgram(starProg);
  gl.uniform1f(su.uSphereRadius, 30.0);

  fadeHud();

  // Unproject a normalized-device-coord pointer (ndcX, ndcY) onto the
  // grid plane y=0 given a camera at (ex, ey, ez) looking at the origin
  // with world-up. Sets `out = {x, z}` to the world-space hit, or
  // returns false if the ray misses the plane (grazing or above).
  const FOV_Y  = Math.PI / 3.2;
  const tmpOut = { x: 0, z: 0 };
  function unprojectToPlane(ndcX, ndcY, ex, ey, ez, aspect, out) {
    // Orthonormal camera frame (forward points at the origin).
    const invLen = 1 / Math.hypot(ex, ey, ez);
    const fx = -ex * invLen, fy = -ey * invLen, fz = -ez * invLen;
    // right = normalize(forward × worldUp), worldUp = (0,1,0).
    let rx = -fz, ry = 0, rz = fx;
    const rl = 1 / Math.hypot(rx, ry, rz);
    rx *= rl; ry *= rl; rz *= rl;
    // up' = right × forward  (already unit length because right ⟂ forward).
    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;

    const halfH = Math.tan(FOV_Y * 0.5);
    const halfW = halfH * aspect;

    const dx = fx + rx * ndcX * halfW + ux * ndcY * halfH;
    const dy = fy + ry * ndcX * halfW + uy * ndcY * halfH;
    const dz = fz + rz * ndcX * halfW + uz * ndcY * halfH;

    // Ray-plane (y=0) intersect: ey + t·dy = 0. Require ray pointing down.
    if (dy > -1e-4) return false;
    const tt = -ey / dy;
    out.x = ex + dx * tt;
    out.z = ez + dz * tt;
    return true;
  }

  startLoop((dt, t) => {
    input.update(dt);

    const yaw  = t * 0.03 + input.x * 0.10;
    const tilt = cam.tilt + input.y * 0.04;
    const cosT = Math.cos(tilt);
    const ex = Math.sin(yaw) * cosT * cam.distance;
    const ey = Math.sin(tilt)       * cam.distance;
    const ez = Math.cos(yaw) * cosT * cam.distance;
    mat4LookAt(ex, ey, ez, 0, 0, 0, 0, 1, 0, view);

    const aspect = canvas.width / canvas.height;

    // --- Touch well tracking ---
    // While holding, unproject the current pointer onto the grid plane
    // and ease the touch mass toward it; strength ramps up to
    // TOUCH_STRENGTH. When released, strength decays back to 0 and the
    // position stays put so the well fades in place.
    if (input.holding && unprojectToPlane(input.holdX, input.holdY, ex, ey, ez, aspect, tmpOut)) {
      const k = 1 - Math.exp(-dt * 14);
      touch.x += (tmpOut.x - touch.x) * k;
      touch.z += (tmpOut.z - touch.z) * k;
    }
    const targetStrength = input.holding ? TOUCH_STRENGTH : 0;
    const strengthK = 1 - Math.exp(-dt * (input.holding ? 9 : 3));
    touch.strength += (targetStrength - touch.strength) * strengthK;

    // Pack orbit masses into slots 0..ORBIT_MASSES-1.
    for (let i = 0; i < orbitMasses.length; i++) {
      const m = orbitMasses[i];
      const phi = m.phase + t * m.speed;
      const cs = Math.cos(m.skew), sn = Math.sin(m.skew);
      const x0 = Math.cos(phi) * m.ax;
      const z0 = Math.sin(phi) * m.az;
      massBuf[i * 3]     = x0 * cs - z0 * sn;
      massBuf[i * 3 + 1] = x0 * sn + z0 * cs;
      massBuf[i * 3 + 2] = m.strength;
    }
    // Touch slot.
    massBuf[TOUCH_SLOT * 3]     = touch.x;
    massBuf[TOUCH_SLOT * 3 + 1] = touch.z;
    massBuf[TOUCH_SLOT * 3 + 2] = touch.strength;

    gl.clear(gl.COLOR_BUFFER_BIT);

    // --- Pass 0: distant starfield (additive, locked to camera) ---
    gl.useProgram(starProg);
    gl.bindVertexArray(starVao);
    gl.uniformMatrix4fv(su.uProj, false, proj);
    gl.uniformMatrix4fv(su.uView, false, view);
    gl.uniform1f(su.uPixelScale, pixelScale);
    gl.uniform1f(su.uTime, t);
    gl.uniform3f(su.uCamPos, ex, ey, ez);
    gl.drawArrays(gl.POINTS, 0, STAR_COUNT);

    // --- Pass 1: spacetime grid ---
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.uniformMatrix4fv(u.uProj, false, proj);
    gl.uniformMatrix4fv(u.uView, false, view);
    gl.uniform3fv(u.uMasses, massBuf);
    gl.drawElements(gl.LINES, indices.length, gl.UNSIGNED_SHORT, 0);
  });
}

runWallpaper(main);

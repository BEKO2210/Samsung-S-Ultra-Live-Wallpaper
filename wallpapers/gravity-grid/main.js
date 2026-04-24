import {
  createCanvas, onResize, startLoop, createInput,
  link, uniformLocs, runWallpaper,
  mat4Perspective, mat4LookAt,
} from '../../shared/engine.js';

// Spacetime grid — a square mesh in the xz plane rendered as GL_LINES.
// Step 1 draws it flat; subsequent steps will warp it around moving
// masses in the vertex shader.
const GRID_N      = 180;             // vertices per side → (N−1)² cells
const GRID_EXTENT = 5.5;              // world-unit half-width

const GRID_VS = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 aXZ;     // vertex grid coord in [-1..1]

uniform mat4  uProj;
uniform mat4  uView;
uniform float uExtent;

out float vViewDist;
out float vY;

void main() {
  vec2 xz = aXZ * uExtent;
  float y = 0.0;
  vec4 worldPos = vec4(xz.x, y, xz.y, 1.0);
  vec4 viewPos  = uView * worldPos;
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

void main() {
  // Exponential depth fog so distant lines melt into the void.
  float fog  = exp(-vViewDist * 0.12);
  float lum  = clamp(fog, 0.0, 1.0);

  // Subtle cyan baseline; future steps will shift color by depth (vY).
  vec3 col = vec3(0.30, 0.70, 1.00) * 0.55 * lum;
  outColor = vec4(col, lum);
}
`;

// Build an indexed line list over an N×N lattice: horizontal + vertical
// segments. Index buffer as Uint32 to stay safe for N > 256.
function buildGrid(n) {
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
  const indices = new Uint32Array(4 * n * (n - 1));
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

function main() {
  const { canvas, gl } = createCanvas();

  const prog = link(gl, GRID_VS, GRID_FS);
  const u = uniformLocs(gl, prog, ['uProj', 'uView', 'uExtent']);

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

  onResize(canvas, (size) => {
    gl.viewport(0, 0, size.width, size.height);
    mat4Perspective(Math.PI / 3.2, size.width / size.height, 0.05, 40.0, proj);
  });

  const input = createInput();
  const cam = { distance: 7.0, tilt: 0.95, yaw: 0 };

  const hud = document.getElementById('hud');
  if (hud) {
    hud.style.transition = 'opacity 1.8s ease 2.5s';
    requestAnimationFrame(() => { hud.style.opacity = '0'; });
  }

  startLoop((dt, t) => {
    input.update(dt);

    const yaw  = t * 0.04 + input.x * 0.22;
    const tilt = cam.tilt + input.y * 0.08;
    const cosT = Math.cos(tilt);
    const ex = Math.sin(yaw) * cosT * cam.distance;
    const ey = Math.sin(tilt)       * cam.distance;
    const ez = Math.cos(yaw) * cosT * cam.distance;
    mat4LookAt(ex, ey, ez, 0, 0, 0, 0, 1, 0, view);

    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.uniformMatrix4fv(u.uProj, false, proj);
    gl.uniformMatrix4fv(u.uView, false, view);
    gl.uniform1f(u.uExtent, GRID_EXTENT);
    gl.drawElements(gl.LINES, indices.length, gl.UNSIGNED_INT, 0);
  });
}

runWallpaper(main);

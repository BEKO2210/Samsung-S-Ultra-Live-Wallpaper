import {
  createCanvas, onResize, startLoop, createInput,
  link, uniformLocs, uploadAttrib, runWallpaper,
  mat4Perspective, mat4LookAt,
} from '../../shared/engine.js';

const STAR_COUNT = 120000;
const ARMS = 4;
const BULGE_FRACTION = 0.22;
const ARM_SPREAD = 0.22;
const DISK_THICKNESS = 0.035;

const VS = /* glsl */ `#version 300 es
precision highp float;

#define ARMS ${ARMS}
#define SPIRAL_TIGHTNESS 0.42
#define GALAXY_RADIUS 1.0
#define TAU 6.28318530718

layout(location = 0) in float aRadius;
layout(location = 1) in float aAngle;
layout(location = 2) in float aArm;
layout(location = 3) in float aZ;
layout(location = 4) in vec3  aColor;
layout(location = 5) in float aSize;
layout(location = 6) in float aTwinkle;

uniform mat4  uProj;
uniform mat4  uView;
uniform float uTime;
uniform float uPixelScale;
uniform vec2  uParallax;

out vec3  vColor;
out float vBrightness;

void main() {
  // Differential rotation — inner radii orbit much faster than outer.
  float rotSpeed = 0.55 / (aRadius * 1.4 + 0.18);
  float spiralOffset = log(aRadius + 0.08) * SPIRAL_TIGHTNESS * 8.0;
  float armBase = aArm * (TAU / float(ARMS)) + spiralOffset;
  float angle = armBase + aAngle + uTime * rotSpeed;

  float r = aRadius * GALAXY_RADIUS;
  vec3 pos = vec3(cos(angle) * r, aZ, sin(angle) * r);
  pos.xy += uParallax * 0.04;

  vec4 viewPos = uView * vec4(pos, 1.0);
  gl_Position  = uProj * viewPos;

  // Clamp guards against GPU point-size caps (~64px on many mobile GPUs).
  float dist = max(-viewPos.z, 0.25);
  gl_PointSize = clamp(aSize * uPixelScale / dist, 1.0, 48.0);

  float tw = 0.78 + 0.22 * sin(uTime * 2.3 + aTwinkle * TAU);
  float edgeFade = smoothstep(1.02, 0.75, aRadius);
  float nearFade = smoothstep(0.15, 0.4, dist);

  vColor = aColor;
  vBrightness = tw * edgeFade * nearFade;
}
`;

const FS = /* glsl */ `#version 300 es
precision highp float;

in vec3  vColor;
in float vBrightness;
out vec4 outColor;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d2 = dot(uv, uv) * 4.0;
  if (d2 > 1.0) discard;
  float core = exp(-d2 * 6.5);
  float halo = exp(-d2 * 1.6) * 0.35;
  float a = (core + halo) * vBrightness;
  outColor = vec4(vColor * a, a);
}
`;

function mixColor(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function gaussian() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function buildStars(count) {
  const radius  = new Float32Array(count);
  const angle   = new Float32Array(count);
  const arm     = new Float32Array(count);
  const zOff    = new Float32Array(count);
  const color   = new Float32Array(count * 3);
  const size    = new Float32Array(count);
  const twinkle = new Float32Array(count);

  const CORE_YELLOW = [1.00, 0.82, 0.52];
  const HOT_WHITE   = [0.85, 0.92, 1.00];
  const BLUE_GIANT  = [0.55, 0.75, 1.00];
  const DUST_RED    = [1.00, 0.55, 0.40];

  const bulgeCount = Math.floor(count * BULGE_FRACTION);

  for (let i = 0; i < count; i++) {
    const inBulge = i < bulgeCount;
    const u = Math.random();
    const r = inBulge ? Math.pow(u, 2.2) * 0.28 : 0.22 + Math.pow(u, 0.65) * 0.78;
    radius[i] = Math.min(r, 1.0);

    arm[i] = Math.floor(Math.random() * ARMS);
    angle[i] = gaussian() * ARM_SPREAD * (1.0 - 0.55 * radius[i]);

    const bulgeBoost = Math.exp(-radius[i] * 6.0);
    zOff[i] = gaussian() * DISK_THICKNESS * (1.0 + bulgeBoost * 4.0);

    let c;
    if (inBulge) {
      c = mixColor(CORE_YELLOW, DUST_RED, Math.random() * 0.4);
    } else if (radius[i] > 0.82 && Math.random() < 0.22) {
      c = mixColor(DUST_RED, CORE_YELLOW, Math.random() * 0.4);
    } else if (Math.random() < 0.08) {
      c = BLUE_GIANT.slice();
    } else {
      c = mixColor(HOT_WHITE, BLUE_GIANT, Math.random() * 0.55);
    }

    const lum = 0.55 + Math.random() * 0.55;
    color[i * 3 + 0] = c[0] * lum;
    color[i * 3 + 1] = c[1] * lum;
    color[i * 3 + 2] = c[2] * lum;

    let s = 1.0 + Math.random() * 1.2;
    if (Math.random() < 0.012) s += 2.0 + Math.random() * 2.5;
    if (inBulge) s *= 0.85;
    size[i] = s;

    twinkle[i] = Math.random();
  }

  return { radius, angle, arm, zOff, color, size, twinkle };
}

function main() {
  const { canvas, gl } = createCanvas();
  const program = link(gl, VS, FS);
  const u = uniformLocs(gl, program, ['uProj', 'uView', 'uTime', 'uPixelScale', 'uParallax']);

  const stars = buildStars(STAR_COUNT);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  uploadAttrib(gl, 0, stars.radius,  1);
  uploadAttrib(gl, 1, stars.angle,   1);
  uploadAttrib(gl, 2, stars.arm,     1);
  uploadAttrib(gl, 3, stars.zOff,    1);
  uploadAttrib(gl, 4, stars.color,   3);
  uploadAttrib(gl, 5, stars.size,    1);
  uploadAttrib(gl, 6, stars.twinkle, 1);

  gl.clearColor(0, 0, 0, 1);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);

  gl.useProgram(program);
  gl.bindVertexArray(vao);

  const proj = new Float32Array(16);
  const view = new Float32Array(16);
  let pixelScale = 1;

  onResize(canvas, (size) => {
    gl.viewport(0, 0, size.width, size.height);
    mat4Perspective(Math.PI / 3.4, size.width / size.height, 0.05, 12.0, proj);
    gl.uniformMatrix4fv(u.uProj, false, proj);
    pixelScale = size.height * 0.0018;
    gl.uniform1f(u.uPixelScale, pixelScale);
  });

  const input = createInput();
  const cam = { distance: 2.05, tilt: 0.32, yaw: 0 };

  const hud = document.getElementById('hud');
  if (hud) {
    hud.style.transition = 'opacity 1.8s ease 2.5s';
    requestAnimationFrame(() => { hud.style.opacity = '0'; });
  }

  startLoop((dt, t) => {
    input.update(dt);

    const yaw = t * 0.035 + input.x * 0.18;
    const tilt = cam.tilt + input.y * 0.08;
    const cosT = Math.cos(tilt);
    const ex = Math.sin(yaw) * cosT * cam.distance;
    const ey = Math.sin(tilt)       * cam.distance;
    const ez = Math.cos(yaw) * cosT * cam.distance;
    mat4LookAt(ex, ey, ez, 0, 0, 0, 0, 1, 0, view);

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniformMatrix4fv(u.uView, false, view);
    gl.uniform1f(u.uTime, t);
    gl.uniform2f(u.uParallax, input.x, input.y);
    gl.drawArrays(gl.POINTS, 0, STAR_COUNT);
  });
}

runWallpaper(main);

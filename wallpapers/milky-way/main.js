import {
  createCanvas, onResize, startLoop, createInput,
  link, uniformLocs, uploadAttrib, runWallpaper, fadeHud,
  createRenderTarget,
  mat4Perspective, mat4LookAt,
} from '../../shared/engine.js';

// Textbook / planetarium view of the Milky Way: a barred spiral (SBbc)
// seen nearly face-on, 4 major arms, central bar, dust lanes, halo
// globular clusters. No black hole, no lensing — just the galaxy.
const STAR_COUNT      = 180000;
const ARMS            = 4;            // Milky Way has 4 major arms
const BULGE_FRACTION  = 0.18;
const HALO_FRACTION   = 0.14;         // off-plane globular-cluster halo
const ARM_SPREAD      = 0.14;
const DISK_THICKNESS  = 0.028;
const FOG_QUAD_RADIUS = 1.40;
const BAR_ANGLE       = 0.44;         // ≈25° — Milky Way bar orientation

const STAR_VS = /* glsl */ `#version 300 es
precision highp float;

#define ARMS ${ARMS}
#define SPIRAL_PITCH 0.42
#define GALAXY_RADIUS 1.0
#define BAR_HALF 0.22                 // arms start outside the bar tips
#define TAU 6.28318530718

layout(location = 0) in float aRadius;
layout(location = 1) in float aAngle;
layout(location = 2) in float aArm;
layout(location = 3) in float aZ;
layout(location = 4) in vec3  aColor;
layout(location = 5) in float aSize;
layout(location = 6) in float aTwinkle;
layout(location = 7) in float aKind;  // 0 = disk, 1 = halo / globular

uniform mat4  uProj;
uniform mat4  uView;
uniform float uTime;
uniform float uPixelScale;
uniform vec2  uParallax;

out vec3  vColor;
out float vBrightness;

void main() {
  // Differential rotation matching the fog. Halo stars rotate very slowly
  // (pressure-supported population).
  float rotSpeed = (aKind > 0.5)
    ? 0.02
    : 0.12 / (aRadius * 1.2 + 0.22);

  // Arms emerge from the tips of the bar, not the very center, so pin
  // the spiral phase to aRadius - BAR_HALF (clamped to keep log finite).
  float rArm = max(aRadius - BAR_HALF * 0.4, 0.04);
  float spiralOffset = log(rArm + 0.05) / SPIRAL_PITCH;
  float armBase = aArm * (TAU / float(ARMS)) + spiralOffset;
  float angle = armBase + aAngle + uTime * rotSpeed;

  float r = aRadius * GALAXY_RADIUS;
  vec3 pos = vec3(cos(angle) * r, aZ, sin(angle) * r);
  pos.xy += uParallax * 0.025;

  vec4 viewPos = uView * vec4(pos, 1.0);
  gl_Position  = uProj * viewPos;

  float dist = max(-viewPos.z, 0.25);
  gl_PointSize = clamp(aSize * uPixelScale / dist, 1.0, 48.0);

  float tw = 0.82 + 0.18 * sin(uTime * 2.1 + aTwinkle * TAU);
  float edgeFade = smoothstep(1.05, 0.78, aRadius);
  float nearFade = smoothstep(0.15, 0.4, dist);

  vColor = aColor;
  vBrightness = tw * edgeFade * nearFade;
}
`;

const STAR_FS = /* glsl */ `#version 300 es
precision highp float;

in vec3  vColor;
in float vBrightness;
out vec4 outColor;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d2 = dot(uv, uv) * 4.0;
  if (d2 > 1.0) discard;
  // Three-layer star sprite — narrow core for a punched-out pixel, a
  // mid halo for size, and a very wide faint halo so hero stars have
  // the soft "airbrushed" glow the bloom pass picks up.
  float core  = exp(-d2 *  8.0);
  float halo  = exp(-d2 *  1.8) * 0.42;
  float flare = exp(-d2 *  0.5) * 0.16;
  float a = (core + halo + flare) * vBrightness;
  outColor = vec4(vColor * a, a);
}
`;

// Procedural barred-spiral galaxy fog, drawn on a quad in the xz plane.
// 4 logarithmic arms, a central bar rotated by BAR_ANGLE, dust lanes,
// and pink HII regions along the outer arms. This is what a textbook
// Milky Way diagram looks like.
const FOG_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
uniform mat4 uProj;
uniform mat4 uView;
uniform float uQuadRadius;
uniform vec2  uParallax;
out vec2  vPlane;
out float vViewZ;
void main() {
  vec2 xz = aPos * uQuadRadius;
  vec3 world = vec3(xz.x, 0.0, xz.y);
  world.xy += uParallax * 0.025;
  vec4 viewPos = uView * vec4(world, 1.0);
  vPlane = xz;
  vViewZ = -viewPos.z;
  gl_Position = uProj * viewPos;
}
`;

const FOG_FS = /* glsl */ `#version 300 es
precision highp float;

#define ARMS 4.0
#define PITCH 0.42
#define BAR_ANGLE ${BAR_ANGLE.toFixed(5)}
#define TAU 6.28318530718

in vec2  vPlane;
in float vViewZ;
uniform float uTime;
out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p *= 2.03; a *= 0.5;
  }
  return s;
}

void main() {
  float r = length(vPlane);
  if (r > 1.30) discard;

  // Differential rotation (matches star VS so arm stars stay on ridges).
  float rotRate = 0.12 / (r * 1.2 + 0.22);
  float theta = atan(vPlane.y, vPlane.x) - uTime * rotRate;

  // --- Domain warping of the arm coordinates.
  // Straight log-spirals look geometric and dead; a small fbm-driven
  // shift in both theta and r bends the arms into organic, photographic
  // shapes like what you see on NGC 1232 / the 100,000 Stars background.
  float nr = fbm(vPlane * 1.6);
  float nt = fbm(vPlane * 1.6 + vec2(9.1, 3.7));
  float warpedTheta = theta + 0.24 * (nt - 0.5);
  float warpedR     = max(r + 0.05 * (nr - 0.5) - 0.09, 0.04);
  float armPhase    = warpedTheta - log(warpedR + 0.05) / PITCH;

  // Irregular dust lane: offset by a noise-dithered phase so lanes
  // branch and break instead of marching in parallel with the arms.
  float dustJitter = 0.22 * (fbm(vPlane * 4.5 + 31.0) - 0.5);
  float armCos  = cos(ARMS * armPhase);
  float dustCos = cos(ARMS * (armPhase - 0.55 + dustJitter));
  float hiiCos  = cos(ARMS * (armPhase + 0.22 + 0.1 * (nt - 0.5)));

  float armsBroad = pow(max(armCos * 0.5 + 0.5, 0.0), 1.7);
  float armsRidge = pow(max(armCos, 0.0), 12.0);
  float arms = (armsBroad * 0.55 + armsRidge * 0.65) * smoothstep(0.14, 0.34, r);

  // Multi-scale dust: broad lanes + fine streaks inside them.
  float dustBroad   = pow(max(dustCos, 0.0), 14.0);
  float dustStreaks = pow(fbm(vPlane * 9.0 + vec2(uTime * 0.04, 0.0)), 3.0);
  float dust = dustBroad * (0.55 + 0.9 * dustStreaks)
             * smoothstep(0.18, 0.32, r)
             * smoothstep(1.15, 0.5, r);

  // --- Bar + bulge + tight inner core + outer disk halo.
  float cb = cos(BAR_ANGLE), sb = sin(BAR_ANGLE);
  vec2  pBar = vec2(vPlane.x * cb + vPlane.y * sb,
                   -vPlane.x * sb + vPlane.y * cb);
  float bar   = exp(-pow(pBar.x / 0.34, 4.0) - pow(pBar.y / 0.085, 4.0));
  float bulge = exp(-r * 5.2);                 // broad yellow bulge
  float core  = exp(-r * 18.0) * 2.2;          // very bright nucleus
  float halo  = exp(-r * 2.3) * 0.38;          // soft stellar haze
  float disk  = exp(-r * 1.6) * (1.0 - smoothstep(1.05, 1.28, r)) * 0.55;
  float base  = bulge * 1.1 + bar * 1.05 + core + halo + disk;

  // Large-scale turbulence breaks the smooth radial density into clumps.
  vec2 turb = vec2(cos(theta), sin(theta)) * r;
  float tn  = fbm(turb * 3.2 + vec2(uTime * 0.015, 0.0));
  float clumps = 0.60 + 0.85 * tn;

  // Interarm filler — a faint fbm-driven haze that fills the gaps so the
  // galaxy reads continuous (NGC 1232's inter-arm dust has this).
  float filler = fbm(vPlane * 2.2 + vec2(17.0, 4.0)) * 0.35
               * smoothstep(1.18, 0.22, r);

  float density = base + arms * 1.55 * clumps + filler;
  density *= (1.0 - dust * 0.82);
  density = max(density, 0.0);

  // HII (Hα) star-forming regions — small pink knots along arm ridges.
  float hiiArm   = pow(max(hiiCos, 0.0), 22.0);
  float hiiRing  = smoothstep(0.30, 0.55, r) * (1.0 - smoothstep(0.95, 1.18, r));
  float hiiNoise = pow(fbm(vPlane * 8.5 + 11.0), 2.4);
  float hii = hiiArm * hiiRing * hiiNoise * 1.4;

  // Soft, photographic palette — less neon than before.
  vec3 warm  = vec3(1.00, 0.76, 0.44);    // bulge / bar
  vec3 mid   = vec3(0.95, 0.93, 1.00);    // arm ridge
  vec3 outer = vec3(0.66, 0.80, 1.12);    // cool blue rim
  vec3 dustC = vec3(0.45, 0.25, 0.15);    // warm-brown dust tint
  vec3 pink  = vec3(1.00, 0.56, 0.78);    // Hα (softer than before)

  vec3 color = mix(mid, outer, smoothstep(0.35, 1.02, r));
  color = mix(color, warm, smoothstep(0.60, 0.0, r));
  // Dust doesn't just darken — it also tints with warm red-brown
  // reflection nebulosity, just like photographs of grand-design spirals.
  color = mix(color, dustC, dust * 0.35);
  color += pink * hii;

  // Output raw HDR emission — tone-mapping and dither happen in the
  // composite pass after bloom, so bright regions can bloom properly.
  vec3 emit = color * density;
  float edgeFade = smoothstep(1.25, 0.35, r);
  emit *= edgeFade;
  outColor = vec4(emit, 1.0);
}
`;

// ---- Post-process: scene → threshold → H-blur → V-blur → composite ----
// A single fullscreen-triangle vertex shader is reused by every pass.
const POST_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

// Threshold / bright-pass: keep only the pixels above a soft knee so
// only stars and the galactic core contribute to the bloom.
const THRESHOLD_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
out vec4 outColor;
void main() {
  vec3 c = texture(uScene, vUv).rgb;
  float lum = max(max(c.r, c.g), c.b);
  float knee = smoothstep(0.50, 1.10, lum);
  outColor = vec4(c * knee, 1.0);
}
`;

// 9-tap separable Gaussian (1D). Weights from σ≈2.4.
const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2      uStep;    // one-texel step in blur direction
out vec4 outColor;
void main() {
  const float w0 = 0.227027;
  const float w1 = 0.194595;
  const float w2 = 0.121622;
  const float w3 = 0.054054;
  const float w4 = 0.016216;
  vec3 sum = texture(uSrc, vUv).rgb * w0;
  sum += texture(uSrc, vUv + uStep * 1.0).rgb * w1;
  sum += texture(uSrc, vUv - uStep * 1.0).rgb * w1;
  sum += texture(uSrc, vUv + uStep * 2.0).rgb * w2;
  sum += texture(uSrc, vUv - uStep * 2.0).rgb * w2;
  sum += texture(uSrc, vUv + uStep * 3.0).rgb * w3;
  sum += texture(uSrc, vUv - uStep * 3.0).rgb * w3;
  sum += texture(uSrc, vUv + uStep * 4.0).rgb * w4;
  sum += texture(uSrc, vUv - uStep * 4.0).rgb * w4;
  outColor = vec4(sum, 1.0);
}
`;

// Final composite: HDR scene + bloom, tone-mapped, vignetted, dithered.
const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float     uBloomStrength;
out vec4 outColor;
float hash12(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}
void main() {
  vec3 scene = texture(uScene, vUv).rgb;
  vec3 bloom = texture(uBloom, vUv).rgb;
  vec3 col = scene + bloom * uBloomStrength;
  // Soft-knee tonemap so the bloomed core doesn't clip.
  col = 1.0 - exp(-col * 1.25);
  // Photographic vignette — 100,000-Stars / planetarium trademark.
  // vUv is [0..1]; distance from centre fades corners subtly.
  float vign = smoothstep(1.05, 0.30, length(vUv - 0.5));
  col *= mix(0.60, 1.0, vign);
  col += (hash12(gl_FragCoord.xy) - 0.5) * (1.0 / 255.0);
  outColor = vec4(col, 1.0);
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
  const kind    = new Float32Array(count);  // 0 disk, 1 halo

  const CORE_YELLOW = [1.00, 0.82, 0.52];
  const HOT_WHITE   = [0.90, 0.94, 1.00];
  const BLUE_GIANT  = [0.55, 0.72, 1.00];
  const YOUNG_BLUE  = [0.70, 0.80, 1.10];
  const DUST_RED    = [1.00, 0.55, 0.40];
  const GLOBULAR    = [1.00, 0.90, 0.65];

  const bulgeCount = Math.floor(count * BULGE_FRACTION);
  const haloStart  = Math.floor(count * (1.0 - HALO_FRACTION));

  for (let i = 0; i < count; i++) {
    const inBulge = i < bulgeCount;
    const inHalo  = i >= haloStart;
    const u = Math.random();

    let r;
    if (inBulge) {
      // Bar-dominated core: clustered near centre, slightly elongated.
      r = 0.02 + Math.pow(u, 1.6) * 0.26;
    } else if (inHalo) {
      // Halo: broad, extends well past the disk for globular clusters.
      r = 0.35 + Math.pow(u, 0.55) * 0.95;
    } else {
      r = 0.24 + Math.pow(u, 0.7) * 0.80;
    }
    radius[i] = Math.min(r, 1.25);

    arm[i] = Math.floor(Math.random() * ARMS);
    const spread = inHalo
      ? 3.14                             // halo stars are isotropic
      : ARM_SPREAD * (1.0 - 0.55 * Math.min(radius[i], 1.0));
    angle[i] = gaussian() * spread;

    // Thick halo, thin disk — matches observed galactic structure.
    const bulgeBoost = Math.exp(-radius[i] * 6.0);
    if (inHalo) {
      zOff[i] = gaussian() * 0.22;
    } else {
      zOff[i] = gaussian() * DISK_THICKNESS * (1.0 + bulgeBoost * 4.0);
    }

    let c;
    if (inHalo) {
      // Old stellar population: yellow / orange.
      c = mixColor(GLOBULAR, DUST_RED, Math.random() * 0.35);
    } else if (inBulge) {
      c = mixColor(CORE_YELLOW, DUST_RED, Math.random() * 0.45);
    } else if (radius[i] > 0.55 && Math.random() < 0.22) {
      c = mixColor(YOUNG_BLUE, BLUE_GIANT, Math.random());
    } else if (radius[i] > 0.82 && Math.random() < 0.15) {
      c = mixColor(DUST_RED, CORE_YELLOW, Math.random() * 0.4);
    } else if (Math.random() < 0.05) {
      c = BLUE_GIANT.slice();
    } else {
      c = mixColor(HOT_WHITE, BLUE_GIANT, Math.random() * 0.45);
    }

    const lum = 0.55 + Math.random() * 0.55;
    color[i * 3 + 0] = c[0] * lum;
    color[i * 3 + 1] = c[1] * lum;
    color[i * 3 + 2] = c[2] * lum;

    let s = 1.0 + Math.random() * 1.1;
    if (!inHalo && Math.random() < 0.010) s += 2.0 + Math.random() * 2.8;
    if (inHalo && Math.random() < 0.05) s += 1.8; // brighter globular cores
    if (inBulge) s *= 0.85;
    if (inHalo)  s *= 0.85;
    size[i] = s;

    twinkle[i] = Math.random();
    kind[i]    = inHalo ? 1.0 : 0.0;
  }

  return { radius, angle, arm, zOff, color, size, twinkle, kind };
}

function main() {
  const { canvas, gl } = createCanvas();

  // --- Stars ---
  const starProg = link(gl, STAR_VS, STAR_FS);
  const su = uniformLocs(gl, starProg, [
    'uProj', 'uView', 'uTime', 'uPixelScale', 'uParallax',
  ]);
  const stars = buildStars(STAR_COUNT);
  const starVao = gl.createVertexArray();
  gl.bindVertexArray(starVao);
  uploadAttrib(gl, 0, stars.radius,  1);
  uploadAttrib(gl, 1, stars.angle,   1);
  uploadAttrib(gl, 2, stars.arm,     1);
  uploadAttrib(gl, 3, stars.zOff,    1);
  uploadAttrib(gl, 4, stars.color,   3);
  uploadAttrib(gl, 5, stars.size,    1);
  uploadAttrib(gl, 6, stars.twinkle, 1);
  uploadAttrib(gl, 7, stars.kind,    1);

  // --- Galaxy fog plane (drawn behind stars) ---
  const fogProg = link(gl, FOG_VS, FOG_FS);
  const fu = uniformLocs(gl, fogProg, [
    'uProj', 'uView', 'uTime', 'uQuadRadius', 'uParallax',
  ]);
  const fogVao = gl.createVertexArray();
  gl.bindVertexArray(fogVao);
  const fogBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, fogBuf);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1, -1,  1, -1,  -1, 1,  -1, 1,  1, -1,  1, 1]),
    gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // --- Post-process programs (threshold, blur, composite) ---
  const thresholdProg = link(gl, POST_VS, THRESHOLD_FS);
  const tu = uniformLocs(gl, thresholdProg, ['uScene']);
  const blurProg = link(gl, POST_VS, BLUR_FS);
  const blu = uniformLocs(gl, blurProg, ['uSrc', 'uStep']);
  const compositeProg = link(gl, POST_VS, COMPOSITE_FS);
  const cu = uniformLocs(gl, compositeProg, ['uScene', 'uBloom', 'uBloomStrength']);

  // Fullscreen triangle shared by every post pass.
  const postVao = gl.createVertexArray();
  gl.bindVertexArray(postVao);
  const postBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, postBuf);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // Three render targets: full-res HDR scene + two quarter-res half-float
  // ping-pong targets for the separable Gaussian blur.
  const sceneRt = createRenderTarget(gl);
  const bloomA  = createRenderTarget(gl);
  const bloomB  = createRenderTarget(gl);

  gl.clearColor(0, 0, 0, 1);
  gl.disable(gl.DEPTH_TEST);

  const proj = new Float32Array(16);
  const view = new Float32Array(16);
  let pixelScale = 1;
  let fullW = 1, fullH = 1;
  let bloomW = 1, bloomH = 1;

  onResize(canvas, (size) => {
    fullW = size.width;
    fullH = size.height;
    bloomW = Math.max(1, Math.floor(fullW / 4));
    bloomH = Math.max(1, Math.floor(fullH / 4));
    sceneRt.resize(fullW, fullH);
    bloomA .resize(bloomW, bloomH);
    bloomB .resize(bloomW, bloomH);
    const aspect = fullW / fullH;
    mat4Perspective(Math.PI / 3.4, aspect, 0.05, 12.0, proj);
    pixelScale = fullH * 0.0018;
  });

  const input = createInput();
  // Closer to the 100,000-Stars default: tilted enough to read as 3D
  // but face-on enough that all four arms and the bar are visible.
  const cam = { distance: 2.40, tilt: 0.92 };

  gl.useProgram(fogProg);
  gl.uniform1f(fu.uQuadRadius, FOG_QUAD_RADIUS);

  fadeHud();

  startLoop((dt, t) => {
    input.update(dt);

    const yaw  = t * 0.025 + input.x * 0.12;
    const tilt = cam.tilt + input.y * 0.05;
    const cosT = Math.cos(tilt);
    const ex = Math.sin(yaw) * cosT * cam.distance;
    const ey = Math.sin(tilt)       * cam.distance;
    const ez = Math.cos(yaw) * cosT * cam.distance;
    mat4LookAt(ex, ey, ez, 0, 0, 0, 0, 1, 0, view);

    // --- Pass 1: render HDR scene (fog + stars) into sceneRt -----------
    sceneRt.bind();
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.useProgram(fogProg);
    gl.bindVertexArray(fogVao);
    gl.uniformMatrix4fv(fu.uProj, false, proj);
    gl.uniformMatrix4fv(fu.uView, false, view);
    gl.uniform1f(fu.uTime, t);
    gl.uniform2f(fu.uParallax, input.x, input.y);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.useProgram(starProg);
    gl.bindVertexArray(starVao);
    gl.uniformMatrix4fv(su.uProj, false, proj);
    gl.uniformMatrix4fv(su.uView, false, view);
    gl.uniform1f(su.uTime, t);
    gl.uniform1f(su.uPixelScale, pixelScale);
    gl.uniform2f(su.uParallax, input.x, input.y);
    gl.drawArrays(gl.POINTS, 0, STAR_COUNT);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(postVao);

    // --- Pass 2: threshold sceneRt → bloomA (quarter res) -------------
    bloomA.bind();
    gl.useProgram(thresholdProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneRt.tex);
    gl.uniform1i(tu.uScene, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // --- Pass 3: horizontal blur bloomA → bloomB ---------------------
    bloomB.bind();
    gl.useProgram(blurProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bloomA.tex);
    gl.uniform1i(blu.uSrc, 0);
    gl.uniform2f(blu.uStep, 1.0 / bloomW, 0.0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // --- Pass 4: vertical blur bloomB → bloomA -----------------------
    bloomA.bind();
    gl.bindTexture(gl.TEXTURE_2D, bloomB.tex);
    gl.uniform2f(blu.uStep, 0.0, 1.0 / bloomH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // --- Pass 5: composite scene + bloom → default framebuffer --------
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, fullW, fullH);
    gl.useProgram(compositeProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneRt.tex);
    gl.uniform1i(cu.uScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomA.tex);
    gl.uniform1i(cu.uBloom, 1);
    gl.uniform1f(cu.uBloomStrength, 0.75);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  });
}

runWallpaper(main);

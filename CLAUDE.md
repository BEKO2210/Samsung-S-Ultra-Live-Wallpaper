# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project goal

Five code-based animated live wallpapers rendered with WebGL / GLSL / Three.js, targeted at the Samsung Galaxy S Ultra display family (portrait, ~1440x3088, 120 Hz OLED). Each wallpaper is developed as a standalone, self-contained entry point — **one wallpaper per run**, never generate them together.

Themes (in run order):
1. `milky-way` — deep rotating particle system (Milchstraße)
2. `gravity-grid` — 3D grid bent by invisible masses (Spacetime)
3. `quantum-starfield` — parallax starfield coming toward the viewer
4. `accretion-disk` — light bending around a black-hole singularity
5. `cosmic-nebula` — fluid/noise shader reacting to touch

## Architecture

Static site, no build step. Each wallpaper lives in `wallpapers/<name>/` with:
- `index.html` — full-viewport canvas, minimal DOM, pinned to portrait
- `main.js` — ES module, owns the render loop and teardown
- `shaders/*.glsl` — GLSL source loaded as text (optional; small shaders may be inlined)

Shared infrastructure in `shared/`:
- `shared/engine.js` — WebGL/Three.js bootstrap: DPR clamp, resize on `visualViewport`, `requestAnimationFrame` loop with delta-time, pause on `visibilitychange`
- `shared/style.css` — reset, `background:#000`, `overscroll-behavior:none`, hides scrollbars
- `index.html` at repo root — gallery that links to each wallpaper

The root `index.html` is a launcher only; it must never import a wallpaper's code. This keeps each wallpaper independently shippable as a standalone Live Wallpaper asset.

## Performance & display constraints (non-negotiable)

- **60 fps minimum** on a Galaxy S Ultra-class device; profile on throttled CPU before claiming done.
- **Portrait 1440x3088** is the reference resolution. Lock aspect via CSS (`100vw`/`100vh`), size the drawing buffer from `devicePixelRatio` clamped to `[1, 2]` — never blindly use `window.devicePixelRatio` (often 3–4 on these phones and kills fill-rate).
- **OLED-true black**: clear color must be `(0,0,0,1)`. No near-black greys in backgrounds — they cause visible banding on OLED. Prefer additive blending over dark gradients.
- **Power**: pause `requestAnimationFrame` on `document.hidden`; avoid allocating inside the loop; reuse typed arrays and geometry buffers.
- **Touch / parallax**: use `pointermove` + `deviceorientation` (with permission on iOS-style gates) behind a single normalized `{x,y}` input so wallpapers share input handling.
- No external network calls at runtime. All assets ship in-repo.

## Commands

No package manager yet. For local preview:

```
python3 -m http.server 8000    # then open http://localhost:8000/wallpapers/<name>/
```

There is no lint/test/build pipeline. If one is added later, update this section.

## Workflow rules

- **One wallpaper per run.** Do not pre-create scaffolding for wallpapers that are not the current run's target.
- Commit each run as its own commit on branch `claude/galaxy-wallpapers-webgl-QhSIW`.
- Never push to `main`.

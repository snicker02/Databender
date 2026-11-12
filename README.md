# DATABENDER

Databends images by corrupting their raw bytes — as a real 24-bit BMP or as a real JPEG scan — with a non-destructive effect stack, recipes, and a 3D-terrain view for glitch art.

No dependencies, no build step. WebGL1 for the terrain view.

## Run

ES modules need to be served over http (opening `index.html` straight from disk won't load them):

```
python3 -m http.server 8000      # then open http://localhost:8000
```

GitHub Pages serves it as-is.

## What it does

- **Two containers.**
  - **BMP**: raw pixels. Every effect is available.
  - **JPEG**: the compressed entropy-coded scan. The header and Huffman/quant tables are protected, and a *marker-safe decode* neutralizes stray `FF` bytes so the scan keeps decoding. Load a `.jpg` and its original bytes are used directly; progressive JPEGs are re-encoded as baseline.
- **Non-destructive stack.** Every Apply adds a step with its own params and seed.
  - Click a step to edit it live; the controls drive that step and it replays from there (cached).
  - Steps can be toggled, reordered, reseeded or deleted.
  - Undo/redo covers stack edits, decode view, container switches, bakes and image loads. **Reset to source** clears the stack, selection and decode view in one (undoable) click.
- **Recipes.** Save the stack as JSON and load it onto any other image, with the same seeds and the same result. "Keep stack when loading" re-applies the current stack to each new image you drop.
- **Selection mask.** Drag a rectangle on the image to limit new steps (or the step you're editing) to it.
  - Length-preserving effects are composited into the exact rectangle.
  - Length-changing effects run on that row band.
  - In JPEG mode the rectangle maps to a proportional slice of the scan.
- **55 effects in 10 groups**:
  - Bytes: noise, bit rotate, XOR, invert, bit crush, byte add, dither, emboss, sine bands
  - Displace: shift, sort, reverse, wave, smear, interlace, ghost
  - Channels: corrupt, RGB split, swap, hue
  - Pixel sort
  - Art · colour: gradient map (12 palettes, cycles/phase for psychedelic banding), duotone, solar curves (folded cosine tone curves, chrome/liquid metal)
  - Art · form: kaleidoscope/mirror, twirl, radial chroma (zoom/spin), self-displace, pixel drip, crystallize/shatter (Voronoi, stained-glass grout), quadtree mosaic, halftone (ink/light/colour), CRT scanlines, neon edges (source/white/rainbow-by-direction), topographic contours, bloom
  - Find/replace
  - Structural: echo, move, carve, row jitter, stutter, slice/block shuffle
  - Manual chunk: move/echo/carve/rotate/reverse
  - Audio, Audacity-style on u8 or s16 samples: echo, reverb, amplify/distort (clip/wrap/fold), low-pass, high-pass, tremolo, decimate
- **Decode as** (BMP, view only): reinterpret width (±64 px), pixel format (BGR24/RGB24/BGRA32/Gray8/RGB565), row padding, byte nudge, bottom-up, and height-fills-bytes for raw-import shears. **Bake** freezes the current view into a new source.
- **Variations.** A 3×3 grid of alternatives: *extend current* (adds 1–2 random steps), *reseed stack* (same steps, new seeds) or *fresh stack*. Click a tile to adopt it.
- **Hex view.** Shows the result bytes; hand edits become steps.
- **3D terrain** of the result, plus Save PNG / Save .bmp / Save .jpg.

Keys: `R` random · `V` variations · hold `\` for source · `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo · `Esc` clear selection or stop editing.

## Layout

```
index.html  styles.css  main.js        app shell + wiring
engine/     util.js  bmp.js  jpeg.js   byte helpers, BMP codec + decode-as, JPEG scan/marker safety
            effects.js  audio.js  art.js  effect registry (param schemas drive UI, random, recipes)
            pipeline.js                regions, selection compositing, cached replay, recipes
ui/         panel.js  stack.js  hex.js  selection.js  variations.js  terrain.js
test/       engine.test.mjs            node test/engine.test.mjs
            browser_test.py            Playwright end-to-end (needs Chrome)
```

Adding an effect means appending one object to `engine/effects.js`. Its controls, stack summary, random ranges and recipe support come from that object automatically.

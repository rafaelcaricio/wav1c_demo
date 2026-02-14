# wav1c Demo — AV1 Encoding in Your Browser

A browser demo for [wav1c](https://github.com/rafaelcaricio/wav1c), the world's first AV1 video encoder written in pure safe Rust.

Your webcam feed is captured, converted to YUV420, encoded to AV1 by wav1c compiled to WebAssembly, packaged into fragmented MP4, and played back through Media Source Extensions — all client-side, no server involved.

## What You're Looking At

Two retro CRT televisions connected by a hardware encoder box:

- **INPUT TV** — Raw webcam feed. Press the power button to start.
- **OUTPUT TV** — AV1-encoded video decoded by your browser.
- **Encoder Box** — Controls for quantizer (QP), keyframe interval, and resolution.

Below the TVs: a real-time signal path diagram and telemetry panel showing encode FPS, frame sizes, bitrate, and a per-frame histogram.

## Running

Serve the directory with any static HTTP server:

```
cd wav1c_demo
python3 -m http.server 8080
```

Open http://localhost:8080 in Chrome 94+ or Edge 94+ (requires AV1 MSE support).

## How It Works

```
Webcam → Canvas → RGBA→YUV420 → wav1c WASM → fMP4 fragment → MSE SourceBuffer → <video>
         getImageData   JS         152 KB      hand-rolled        browser AV1
                                   Rust/WASM   ISO BMFF muxer     decoder
```

1. `getUserMedia` captures webcam frames
2. Frames are drawn to an offscreen canvas and converted from RGBA to YUV420 in JavaScript
3. Y, U, V planes are passed to the wav1c WASM encoder which returns raw AV1 OBU data
4. OBU data is stripped of temporal delimiters and wrapped in fMP4 fragments (moof+mdat) by a hand-rolled 200-line JS muxer
5. Fragments are appended to an MSE `SourceBuffer` for live decoded preview
6. On stop, all fragments are concatenated into a downloadable `.mp4` file

## Key Numbers

| | |
|---|---|
| WASM binary | 152 KB |
| External dependencies | 0 |
| Languages | Rust (encoder), JavaScript (glue), CSS (UI) |
| Frameworks | None |
| Build tool | `wasm-pack` |

## Rebuilding the WASM Module

From the [wav1c](https://github.com/rafaelcaricio/wav1c) repository:

```
cd wav1c-wasm
wasm-pack build --target web --release
cp pkg/wav1c_wasm_bg.wasm pkg/wav1c_wasm.js pkg/wav1c_wasm_bg.wasm.d.ts ../path/to/wav1c_demo/
```

## Browser Requirements

- Chrome 94+, Edge 94+, or any browser with AV1 MSE support
- Webcam access (HTTPS or localhost)

## File Structure

```
wav1c_demo/
├── index.html              Single-page app
├── style.css               Retro TV styling (pure CSS, no images)
├── app.js                  Capture loop, MSE, power/record flow
├── yuv.js                  RGBA → YUV420 conversion
├── mp4mux.js               Hand-rolled fMP4 muxer (ISO BMFF)
├── wav1c_wasm.js           wasm-bindgen JS glue (generated)
├── wav1c_wasm_bg.wasm      wav1c AV1 encoder (generated, 152 KB)
└── wav1c_wasm_bg.wasm.d.ts TypeScript definitions (generated)
```

## License

Same as [wav1c](https://github.com/rafaelcaricio/wav1c).

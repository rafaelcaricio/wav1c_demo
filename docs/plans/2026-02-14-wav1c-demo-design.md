# wav1c Browser Demo — Design Document

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A single-page web app that captures webcam video and encodes it to AV1 entirely in the browser using wav1c compiled to WASM, with live preview via fMP4+MSE and downloadable MP4 output.

**Architecture:** wav1c Rust encoder compiled to WASM via wasm-bindgen. Webcam frames captured via getUserMedia, converted to YUV420 in JS, encoded by WASM module, packaged into fMP4 fragments by mp4box.js, and fed to a `<video>` element via Media Source Extensions for real-time decoded preview.

**Tech Stack:** Rust/wasm-bindgen (encoder), mp4box.js (fMP4 muxer), vanilla HTML/CSS/JS (UI), MSE (playback)

---

## UI Layout

### Header
- Title: "wav1c — AV1 encoding in your browser"
- Tagline: "Pure safe Rust. Zero dependencies. No server."

### Pipeline Visualization (animated, between header and panels)
A horizontal flow diagram showing data moving through the pipeline in real-time:

```
[Webcam] → [Canvas/YUV] → [wav1c WASM] → [mp4box.js fMP4] → [MSE Decode] → [Display]
  30fps      RGB→YUV420     AV1 encode      ISOBMFF mux       Browser AV1    <video>
              ↓                ↓                ↓
           1.2 MB/s         45 KB/s          frame #127
```

Each node pulses/animates when active. Throughput numbers update live under each stage. Data "packets" animate flowing between nodes.

### Two-Panel Main Area

| Left: Raw Webcam Input | Right: Decoded AV1 Output |
|---|---|
| `<video>` from getUserMedia | `<video>` via MSE fMP4 playback |
| Label: "Raw input" | Label: "AV1 decoded output" |

### Controls Bar
- **Record** / **Stop** / **Download MP4** buttons
- QP slider (0-255, default 128)
- Keyframe interval selector (10, 25, 30, 60)
- Resolution selector (320x240, 640x480)

### Stats Panel (below video panels)
- Encode FPS (actual throughput)
- Average frame size (bytes)
- Total encoded size
- Average bitrate
- Frame size bar chart (live, scrolling, keyframes highlighted in accent color)

## Data Flow

### Initialization
1. Request webcam via `getUserMedia({ video: { width, height } })`
2. Load wav1c WASM module
3. Create `WasmEncoder(width, height, qp, keyint)`
4. Create `MediaSource`, attach to right-panel `<video>`
5. On `sourceopen`, create `SourceBuffer` with MIME `video/mp4; codecs="av01.0.13M.08"`

### Per-Frame Loop (requestAnimationFrame or setInterval at target fps)
1. Draw webcam frame to offscreen `<canvas>`
2. `getImageData()` → RGBA pixels
3. Convert RGBA → YUV420 (JS: simple weighted sum per pixel)
4. Call `wasmEncoder.encode_frame(y, u, v)` → returns AV1 OBU `Uint8Array`
5. Update pipeline visualization (pulse encoder node, show packet size)
6. Feed OBU data to mp4box.js:
   - First frame: generate init segment (ftyp + moov with av1C)
   - Each frame: `addSample()` → extract fragment (moof + mdat)
7. `sourceBuffer.appendBuffer(fragment)`
8. Update stats (frame size, total bytes, FPS, bitrate chart)
9. Accumulate fragments for download

### On Stop
1. Stop capture loop
2. Flush encoder
3. Finalize mp4box.js file
4. Create `Blob` from accumulated fMP4 data
5. Enable "Download MP4" button with blob URL

## WASM Module (wav1c-wasm crate)

New crate in `/Users/rafaelcaricio/development/wav1c/wav1c-wasm/`:

```rust
#[wasm_bindgen]
pub struct WasmEncoder {
    encoder: wav1c::Encoder,
    last_keyframe: bool,
    last_frame_number: u64,
}

#[wasm_bindgen]
impl WasmEncoder {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32, base_q_idx: u8, keyint: usize) -> Self;

    pub fn encode_frame(&mut self, y: &[u8], u: &[u8], v: &[u8]) -> Vec<u8>;
    pub fn is_keyframe(&self) -> bool;
    pub fn frame_number(&self) -> u64;
    pub fn sequence_header(&self) -> Vec<u8>;
}
```

Built with: `wasm-pack build --target web`

## fMP4 + MSE Integration

### Init Segment (once)
Constructed from mp4box.js:
- `createFile()`, `addTrack({ type: 'av01', ... })`
- Manually build av1C box: 4-byte header + sequence_header OBU from wav1c
- Extract init segment bytes, append to MSE SourceBuffer

### Media Segments (per-frame or per-GOP)
- `addSample(trackId, obuData, { duration, dts, cts, is_sync })`
- Extract fragment bytes (moof + mdat)
- Append to MSE SourceBuffer
- Also accumulate into download buffer

### av1C Box Construction
Manually construct 4 bytes + configOBUs:
```
byte 0: 0x81 (marker=1, version=1)
byte 1: (seq_profile << 5) | seq_level_idx_0
byte 2: (seq_tier_0 << 7) | (high_bitdepth << 6) | ... | chroma_sample_position
byte 3: 0x00 (no initial_presentation_delay)
bytes 4+: sequence header OBU from wav1c
```

## Pipeline Visualization Details

Horizontal chain of rounded-rect nodes connected by animated arrows:

```
┌──────────┐    ┌───────────┐    ┌────────────┐    ┌───────────┐    ┌──────────┐
│  Webcam   │───▶│  RGB→YUV   │───▶│ wav1c WASM │───▶│  fMP4 Mux  │───▶│  Decode   │
│  Capture  │    │  Convert   │    │  AV1 Encode│    │  mp4box.js │    │  & Play   │
└──────────┘    └───────────┘    └────────────┘    └───────────┘    └──────────┘
   30 fps        921,600 B/f       2,847 B/f         fragment ok       playing
```

- Nodes glow/pulse when processing
- Animated dots flow along the arrows between nodes
- Each node shows its live metric below
- Color-coded: green=active, gray=idle, blue=data flowing

## File Structure

```
wav1c_demo/
├── index.html          # Single page app
├── style.css           # Layout and pipeline animation styles
├── app.js              # Main app logic, capture loop, MSE
├── yuv.js              # RGBA→YUV420 conversion
├── pipeline.js         # Pipeline visualization (SVG or Canvas)
├── stats.js            # Stats panel, frame size chart
├── mp4mux.js           # mp4box.js wrapper for fMP4 fragment extraction
└── pkg/                # wasm-pack output (wav1c_wasm.js + .wasm)
```

Plus in wav1c repo:
```
wav1c/wav1c-wasm/
├── Cargo.toml          # wasm-bindgen dep, cdylib crate type
└── src/lib.rs          # WasmEncoder wrapper
```

## Not Building
- No server / backend
- No audio
- No React / Vue / any framework
- No WebCodecs API (we ARE the codec)
- No streaming to remote server
- No multi-threading (single-threaded WASM is fine for demo)

import init, { WasmEncoder } from './wav1c_wasm.js';
import { rgbaToYuv420 } from './yuv.js';
import { FragmentedMuxer } from './mp4mux.js';

const $ = (id) => document.getElementById(id);

const webcamVideo = $('webcam');
const previewVideo = $('preview');
const canvas = $('capture-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const btnPower = $('btn-power');
const btnRecord = $('btn-record');
const btnStop = $('btn-stop');
const btnDownload = $('btn-download');
const qpSlider = $('qp-slider');
const qpValue = $('qp-value');
const keyintSelect = $('keyint-select');
const resSelect = $('res-select');

const screenInput = $('screen-input');
const screenOutput = $('screen-output');
const staticInput = $('static-input');
const staticOutput = $('static-output');
const outputOsd = $('output-osd');

const ledPower = $('led-power');
const ledEncode = $('led-encode');
const ledKey = $('led-key');
const inputOsd = $('input-osd');

const step1 = $('step-1');
const step2 = $('step-2');
const step3 = $('step-3');

let encoder = null;
let muxer = null;
let mediaSource = null;
let sourceBuffer = null;
let recording = false;
let powered = false;
let webcamStream = null;
let captureTimer = null;
let staticTimers = [];
let wasmLoaded = false;
let mseSupported = false;

let frameCount = 0;
let totalBytes = 0;
let startTime = 0;
let frameSizes = [];
let encodeTimes = [];

const TARGET_FPS = 15;
const CHART_MAX_FRAMES = 120;

qpSlider.addEventListener('input', () => { qpValue.textContent = qpSlider.value; });
btnPower.addEventListener('click', togglePower);
btnRecord.addEventListener('click', startRecording);
btnStop.addEventListener('click', stopRecording);

function drawStatic(canvasEl) {
    const ctx2 = canvasEl.getContext('2d');
    const w = canvasEl.width;
    const h = canvasEl.height;
    const imageData = ctx2.createImageData(w, h);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
        const v = Math.random() * 200 | 0;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 255;
    }
    ctx2.putImageData(imageData, 0, 0);
}

function startStatic(canvasEl) {
    canvasEl.classList.add('active');
    const timer = setInterval(() => drawStatic(canvasEl), 80);
    staticTimers.push({ canvas: canvasEl, timer });
    drawStatic(canvasEl);
}

function stopStatic(canvasEl) {
    canvasEl.classList.remove('active');
    const idx = staticTimers.findIndex(s => s.canvas === canvasEl);
    if (idx >= 0) {
        clearInterval(staticTimers[idx].timer);
        staticTimers.splice(idx, 1);
    }
}

function playWarmup(screenEl) {
    return new Promise(resolve => {
        screenEl.classList.add('warming-up');
        setTimeout(() => {
            screenEl.classList.remove('warming-up');
            resolve();
        }, 1300);
    });
}

async function togglePower() {
    if (powered) {
        powerOff();
        return;
    }

    btnPower.disabled = true;

    if (!wasmLoaded) {
        await init();
        wasmLoaded = true;
    }

    const mimeType = 'video/mp4; codecs="av01.0.13M.08"';
    mseSupported = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mimeType);

    if (!mseSupported) {
        showInfo('Live preview unavailable (no AV1 MSE support). You can still record and download MP4 files — play them with VLC or a desktop browser.');
    }

    startStatic(staticInput);
    playWarmup(screenInput);

    try {
        webcamStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: TARGET_FPS } }
        });
    } catch (e) {
        showError(`Webcam access denied: ${e.message}`);
        stopStatic(staticInput);
        btnPower.disabled = false;
        return;
    }

    webcamVideo.srcObject = webcamStream;
    await webcamVideo.play();

    await new Promise(r => setTimeout(r, 800));
    stopStatic(staticInput);
    inputOsd.classList.remove('visible');
    webcamVideo.classList.add('visible');

    powered = true;
    btnPower.classList.add('on');
    btnPower.disabled = false;
    ledPower.classList.add('on-green');
    btnRecord.disabled = false;

    startStatic(staticOutput);
    outputOsd.classList.add('visible');

    setStep(2);
}

function powerOff() {
    if (recording) stopRecording();

    webcamVideo.classList.remove('visible');
    if (webcamStream) {
        webcamStream.getTracks().forEach(t => t.stop());
        webcamStream = null;
    }

    stopStatic(staticInput);
    stopStatic(staticOutput);
    outputOsd.classList.remove('visible');
    inputOsd.classList.add('visible');

    setStep(1);
    powered = false;
    btnPower.classList.remove('on');
    ledPower.classList.remove('on-green');
    btnRecord.disabled = true;
}

function getResolution() {
    return resSelect.value.split('x').map(Number);
}

function startRecording() {
    const [w, h] = getResolution();
    const qp = parseInt(qpSlider.value);
    const keyint = parseInt(keyintSelect.value);

    canvas.width = w;
    canvas.height = h;

    encoder = new WasmEncoder(w, h, qp, keyint);

    const seqHdr = encoder.sequence_header();
    const av1Config = buildAv1C(seqHdr);

    muxer = new FragmentedMuxer(w, h, av1Config, TARGET_FPS);

    frameCount = 0;
    totalBytes = 0;
    frameSizes = [];
    encodeTimes = [];
    startTime = performance.now();

    btnRecord.disabled = true;
    btnStop.disabled = false;
    btnDownload.style.display = 'none';
    ledEncode.classList.add('on-red');
    document.body.classList.add('encoding');
    setStep(3);

    lockControls(true);

    if (mseSupported) {
        setupMSE();
    } else {
        outputOsd.textContent = 'ENCODE ONLY';
        recording = true;
        captureTimer = setInterval(captureFrame, 1000 / TARGET_FPS);
    }
}

function setupMSE() {
    mediaSource = new MediaSource();
    previewVideo.src = URL.createObjectURL(mediaSource);

    mediaSource.addEventListener('sourceopen', () => {
        sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="av01.0.13M.08"');
        sourceBuffer.mode = 'segments';

        appendToSourceBuffer(muxer.getInitSegment());

        sourceBuffer.addEventListener('updateend', function onReady() {
            sourceBuffer.removeEventListener('updateend', onReady);

            outputOsd.classList.remove('visible');
            stopStatic(staticOutput);
            playWarmup(screenOutput);

            setTimeout(() => {
                previewVideo.classList.add('visible');
                recording = true;
                captureTimer = setInterval(captureFrame, 1000 / TARGET_FPS);
            }, 900);
        });
    });
}

let pendingBuffers = [];

function appendToSourceBuffer(data) {
    pendingBuffers.push(data);
    flushPending();
}

function flushPending() {
    if (!sourceBuffer || sourceBuffer.updating || pendingBuffers.length === 0) return;
    const next = pendingBuffers.shift();
    try {
        sourceBuffer.appendBuffer(next);
    } catch (e) {
        console.warn('appendBuffer error:', e);
    }
    sourceBuffer.addEventListener('updateend', function flush() {
        sourceBuffer.removeEventListener('updateend', flush);
        flushPending();
    });
}

function captureFrame() {
    if (!recording) return;

    const [w, h] = [canvas.width, canvas.height];

    ctx.drawImage(webcamVideo, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);

    const { y, u, v } = rgbaToYuv420(imageData.data, w, h);

    const t0 = performance.now();
    const packet = encoder.encode_frame(y, u, v);
    const encodeMs = performance.now() - t0;

    const isKey = encoder.is_keyframe();
    const sampleData = stripTemporalDelimiter(packet);
    const fragment = muxer.addFrame(sampleData, isKey);

    if (mseSupported) {
        appendToSourceBuffer(fragment);
        if (previewVideo.paused) {
            previewVideo.play().catch(() => {});
        }
    }

    frameCount++;
    totalBytes += packet.byteLength;
    frameSizes.push({ size: packet.byteLength, isKey });
    encodeTimes.push(encodeMs);
    if (frameSizes.length > CHART_MAX_FRAMES) frameSizes.shift();
    if (encodeTimes.length > 30) encodeTimes.shift();

    if (isKey) {
        ledKey.classList.add('on-amber');
        setTimeout(() => ledKey.classList.remove('on-amber'), 200);
    }

    updateSignalPath(w, h, packet.byteLength, encodeMs, fragment.byteLength);
    updateStats();
    drawChart();
}

function stopRecording() {
    recording = false;
    if (captureTimer) {
        clearInterval(captureTimer);
        captureTimer = null;
    }

    document.body.classList.remove('encoding');
    ledEncode.classList.remove('on-red');

    if (mseSupported && mediaSource && mediaSource.readyState === 'open') {
        try { mediaSource.endOfStream(); } catch (e) {}
    }

    if (encoder) {
        encoder.free();
        encoder = null;
    }

    const blob = muxer.getDownloadBlob();
    btnDownload.href = URL.createObjectURL(blob);
    btnDownload.download = `wav1c_${Date.now()}.mp4`;
    btnDownload.style.display = '';

    btnStop.disabled = true;
    btnRecord.disabled = false;
    lockControls(false);
    setStep(2);
}

function setStep(n) {
    [step1, step2, step3].forEach((el, i) => {
        el.classList.remove('active', 'done');
        if (i + 1 < n) el.classList.add('done');
        else if (i + 1 === n) el.classList.add('active');
    });
}

function lockControls(locked) {
    qpSlider.disabled = locked;
    keyintSelect.disabled = locked;
    resSelect.disabled = locked;
}

function buildAv1C(seqHeaderObu) {
    const config = new Uint8Array(4 + seqHeaderObu.length);
    config[0] = 0x81;
    config[1] = 0x0D;
    config[2] = 0x0C;
    config[3] = 0x00;
    config.set(seqHeaderObu, 4);
    return config;
}

function stripTemporalDelimiter(data) {
    if (data.length >= 2 && data[0] === 0x12 && data[1] === 0x00) {
        return data.subarray(2);
    }
    return data;
}

function updateSignalPath(w, h, packetSize, encodeMs, fragSize) {
    const nodes = ['webcam', 'yuv', 'encode', 'mux', 'decode'];
    nodes.forEach(id => {
        const el = $(`sig-${id}`);
        el.classList.add('active');
        clearTimeout(el._deact);
        el._deact = setTimeout(() => el.classList.remove('active'), 250);
    });

    $('sig-stat-webcam').textContent = `${w}x${h}`;
    $('sig-stat-yuv').textContent = `${(w * h * 1.5 / 1024).toFixed(0)} KB`;
    $('sig-stat-encode').textContent = `${(packetSize / 1024).toFixed(1)} KB`;
    $('sig-stat-mux').textContent = `${(fragSize / 1024).toFixed(1)} KB`;
    $('sig-stat-decode').textContent = `#${frameCount}`;
}

function updateStats() {
    const elapsed = (performance.now() - startTime) / 1000;
    const avgEncode = encodeTimes.reduce((a, b) => a + b, 0) / encodeTimes.length;
    const fps = frameCount / elapsed;
    const avgSize = totalBytes / frameCount;
    const bitrate = (totalBytes * 8) / elapsed;

    $('stats-fps').textContent = fps.toFixed(1);
    $('stats-framesize').textContent = formatBytes(avgSize);
    $('stats-total').textContent = formatBytes(totalBytes);
    $('stats-bitrate').textContent = formatBitrate(bitrate);
    $('stats-encodetime').textContent = `${avgEncode.toFixed(1)}ms`;
}

function drawChart() {
    const chartCanvas = $('frame-chart');
    const cctx = chartCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = chartCanvas.getBoundingClientRect();

    chartCanvas.width = rect.width * dpr;
    chartCanvas.height = rect.height * dpr;
    cctx.scale(dpr, dpr);

    const W = rect.width;
    const H = rect.height;

    cctx.fillStyle = '#0a0a08';
    cctx.fillRect(0, 0, W, H);

    if (frameSizes.length === 0) return;

    const maxSize = Math.max(...frameSizes.map(f => f.size), 1);
    const barWidth = Math.max(2, (W - 20) / CHART_MAX_FRAMES);
    const gap = 1;

    for (let i = 0; i < frameSizes.length; i++) {
        const f = frameSizes[i];
        const barH = (f.size / maxSize) * (H - 20);
        const x = 10 + i * barWidth;
        const y = H - 10 - barH;

        cctx.fillStyle = f.isKey ? '#ff5252' : '#ffb000';
        cctx.globalAlpha = f.isKey ? 1 : 0.7;
        cctx.fillRect(x, y, barWidth - gap, barH);
    }
    cctx.globalAlpha = 1;

    cctx.fillStyle = '#5a5540';
    cctx.font = '9px monospace';
    cctx.textAlign = 'right';
    cctx.fillText(formatBytes(maxSize), W - 8, 14);
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatBitrate(bps) {
    if (bps < 1000) return `${Math.round(bps)} bps`;
    if (bps < 1000000) return `${(bps / 1000).toFixed(0)} kbps`;
    return `${(bps / 1000000).toFixed(1)} Mbps`;
}

function showError(msg) {
    const banner = document.createElement('div');
    banner.className = 'error-banner';
    banner.textContent = msg;
    document.querySelector('header').after(banner);
}

function showInfo(msg) {
    const banner = document.createElement('div');
    banner.className = 'info-banner';
    banner.textContent = msg;
    document.querySelector('header').after(banner);
}

async function boot() {
    const wasmResp = await fetch('wav1c_wasm_bg.wasm', { method: 'HEAD' });
    const wasmSize = wasmResp.headers.get('content-length') || '155230';
    const sizeEl = document.querySelector('.wasm-size');
    if (sizeEl) {
        sizeEl.textContent = `${(parseInt(wasmSize) / 1024).toFixed(0)} KB of pure Rust WASM`;
    }
}

boot();

import init, { WasmEncoder } from './wav1c_wasm.js';
import { rgbaToYuv420 } from './yuv.js';
import { FragmentedMuxer } from './mp4mux.js';

const $ = (id) => document.getElementById(id);

const webcamVideo = $('webcam');
const previewVideo = $('preview');
const canvas = $('capture-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const btnStart = $('btn-start');
const btnStop = $('btn-stop');
const btnDownload = $('btn-download');
const qpSlider = $('qp-slider');
const qpValue = $('qp-value');
const keyintSelect = $('keyint-select');
const resSelect = $('res-select');

let encoder = null;
let muxer = null;
let mediaSource = null;
let sourceBuffer = null;
let recording = false;
let webcamStream = null;
let captureTimer = null;

let frameCount = 0;
let totalBytes = 0;
let startTime = 0;
let frameSizes = [];
let encodeTimes = [];

const TARGET_FPS = 15;
const CHART_MAX_FRAMES = 120;

qpSlider.addEventListener('input', () => { qpValue.textContent = qpSlider.value; });
btnStart.addEventListener('click', startRecording);
btnStop.addEventListener('click', stopRecording);

async function main() {
    await init();

    const wasmResp = await fetch('wav1c_wasm_bg.wasm');
    const wasmSize = (wasmResp.headers.get('content-length') || '155230');
    document.querySelector('.wasm-size').textContent =
        `${(parseInt(wasmSize) / 1024).toFixed(0)} KB of pure Rust WASM`;

    const mimeType = 'video/mp4; codecs="av01.0.13M.08"';
    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(mimeType)) {
        showError('Your browser does not support AV1 playback via MSE. Try Chrome 94+ or Edge 94+.');
        return;
    }

    try {
        webcamStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: TARGET_FPS } }
        });
        webcamVideo.srcObject = webcamStream;
        await webcamVideo.play();
        btnStart.disabled = false;
        setPipelineStat('webcam', `${webcamVideo.videoWidth}x${webcamVideo.videoHeight}`);
    } catch (e) {
        showError(`Webcam access denied: ${e.message}`);
    }
}

function getResolution() {
    const [w, h] = resSelect.value.split('x').map(Number);
    return [w, h];
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

    setupMSE();

    btnStart.disabled = true;
    btnStop.disabled = false;
    btnDownload.style.display = 'none';
    $('preview-placeholder').style.display = 'none';
    previewVideo.style.display = '';
    document.body.classList.add('recording');

    lockControls(true);
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
            recording = true;
            captureTimer = setInterval(captureFrame, 1000 / TARGET_FPS);
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

    setPipelineStat('yuv', `${(w * h * 1.5 / 1024).toFixed(0)} KB`);
    activateNode('yuv');

    const t0 = performance.now();
    const packet = encoder.encode_frame(y, u, v);
    const encodeMs = performance.now() - t0;

    const isKey = encoder.is_keyframe();
    const sampleData = stripTemporalDelimiter(packet);
    const fragment = muxer.addFrame(sampleData, isKey);

    appendToSourceBuffer(fragment);

    if (previewVideo.paused) {
        previewVideo.play().catch(() => {});
    }

    frameCount++;
    totalBytes += packet.byteLength;
    frameSizes.push({ size: packet.byteLength, isKey });
    encodeTimes.push(encodeMs);
    if (frameSizes.length > CHART_MAX_FRAMES) frameSizes.shift();
    if (encodeTimes.length > 30) encodeTimes.shift();

    activateNode('webcam');
    activateNode('encode');
    activateNode('mux');
    activateNode('decode');
    setPipelineStat('webcam', `${w}x${h}`);
    setPipelineStat('encode', `${(packet.byteLength / 1024).toFixed(1)} KB`);
    setPipelineStat('mux', `frag #${frameCount}`);
    setPipelineStat('decode', 'playing');

    updateStats(encodeMs);
    drawChart();
}

function stopRecording() {
    recording = false;
    if (captureTimer) {
        clearInterval(captureTimer);
        captureTimer = null;
    }

    document.body.classList.remove('recording');

    if (mediaSource && mediaSource.readyState === 'open') {
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
    btnStart.disabled = false;
    lockControls(false);

    document.querySelectorAll('.pipeline-node').forEach(n => n.classList.remove('active'));
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

function activateNode(name) {
    const node = $(`node-${name}`);
    if (!node) return;
    node.classList.add('active');
    clearTimeout(node._deactivate);
    node._deactivate = setTimeout(() => node.classList.remove('active'), 200);
}

function setPipelineStat(name, text) {
    const el = $(`stat-${name}`);
    if (el) el.textContent = text;
}

function updateStats(encodeMs) {
    const elapsed = (performance.now() - startTime) / 1000;
    const avgEncode = encodeTimes.reduce((a, b) => a + b, 0) / encodeTimes.length;
    const fps = frameCount / elapsed;
    const avgSize = totalBytes / frameCount;
    const bitrate = (totalBytes * 8) / elapsed;

    $('stats-fps').textContent = `${fps.toFixed(1)}`;
    $('stats-framesize').textContent = formatBytes(avgSize);
    $('stats-total').textContent = formatBytes(totalBytes);
    $('stats-bitrate').textContent = formatBitrate(bitrate);
    $('stats-encodetime').textContent = `${avgEncode.toFixed(1)} ms`;
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

    cctx.fillStyle = '#0a0a14';
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

        cctx.fillStyle = f.isKey ? '#ff5252' : '#00b4d8';
        cctx.fillRect(x, y, barWidth - gap, barH);
    }

    cctx.fillStyle = '#6b6b8a';
    cctx.font = '10px monospace';
    cctx.textAlign = 'right';
    cctx.fillText(formatBytes(maxSize), W - 10, 16);
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

main();

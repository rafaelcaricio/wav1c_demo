export class FragmentedMuxer {
    constructor(width, height, av1Config, timescale = 25) {
        this.width = width;
        this.height = height;
        this.av1Config = av1Config;
        this.timescale = timescale;
        this.frameIndex = 0;
        this.allSegments = [];
        this.initSegment = this._buildInitSegment();
        this.allSegments.push(this.initSegment);
    }

    getInitSegment() {
        return this.initSegment;
    }

    addFrame(obuData, isKeyframe, duration = 1) {
        const decodeTime = this.frameIndex * duration;
        this.frameIndex++;
        const fragment = this._buildMediaSegment(
            this.frameIndex,
            decodeTime,
            obuData,
            duration,
            isKeyframe
        );
        this.allSegments.push(fragment);
        return fragment;
    }

    getDownloadBlob() {
        return new Blob(this.allSegments, { type: "video/mp4" });
    }

    _buildInitSegment() {
        const ftyp = box("ftyp",
            str("isom"),
            u32(0),
            str("isom"), str("iso5"), str("av01")
        );

        const av1C = box("av1C", raw(this.av1Config));

        const av01Entry = box("av01",
            zeros(6),
            u16(1),
            zeros(16),
            u16(this.width), u16(this.height),
            u32(0x00480000),
            u32(0x00480000),
            zeros(4),
            u16(1),
            zeros(32),
            u16(0x0018),
            i16(-1),
            av1C
        );

        const stsd = fullbox("stsd", 0, 0, u32(1), raw(av01Entry));
        const stts = fullbox("stts", 0, 0, u32(0));
        const stsc = fullbox("stsc", 0, 0, u32(0));
        const stsz = fullbox("stsz", 0, 0, u32(0), u32(0));
        const stco = fullbox("stco", 0, 0, u32(0));

        const stbl = box("stbl", raw(stsd), raw(stts), raw(stsc), raw(stsz), raw(stco));
        const durl = fullbox("url ", 0, 1);
        const dref = fullbox("dref", 0, 0, u32(1), raw(durl));
        const dinf = box("dinf", raw(dref));
        const vmhd = fullbox("vmhd", 0, 1, zeros(8));
        const minf = box("minf", raw(vmhd), raw(dinf), raw(stbl));

        const mdhd = fullbox("mdhd", 0, 0,
            u32(0), u32(0),
            u32(this.timescale),
            u32(0),
            u16(0x55C4),
            u16(0)
        );
        const hdlr = fullbox("hdlr", 0, 0,
            u32(0),
            str("vide"),
            zeros(12),
            strz("wav1c AV1")
        );
        const mdia = box("mdia", raw(mdhd), raw(hdlr), raw(minf));

        const tkhd = fullbox("tkhd", 0, 3,
            u32(0), u32(0),
            u32(1),
            zeros(4),
            u32(0),
            zeros(8),
            u16(0), u16(0),
            u16(0), u16(0),
            identity2x2(),
            u32(this.width << 16),
            u32(this.height << 16)
        );
        const trak = box("trak", raw(tkhd), raw(mdia));

        const mvhd = fullbox("mvhd", 0, 0,
            u32(0), u32(0),
            u32(this.timescale),
            u32(0),
            u32(0x00010000),
            u16(0x0100),
            zeros(10),
            identity3x3(),
            zeros(24),
            u32(2)
        );

        const trex = fullbox("trex", 0, 0,
            u32(1),
            u32(1),
            u32(0),
            u32(0),
            u32(0)
        );
        const mvex = box("mvex", raw(trex));

        const moov = box("moov", raw(mvhd), raw(trak), raw(mvex));

        return concat(ftyp, moov);
    }

    _buildMediaSegment(seqNum, decodeTime, obuData, duration, isSync) {
        const mfhd = fullbox("mfhd", 0, 0, u32(seqNum));
        const tfhd = fullbox("tfhd", 0, 0x020000, u32(1));
        const tfdt = fullbox("tfdt", 1, 0, u64(decodeTime));

        const sampleFlags = isSync ? 0x02000000 : 0x01010000;

        const trunSize = 12 + 4 + 4 + 4 + 4 + 4;
        const trafSize = 8 + tfhd.byteLength + tfdt.byteLength + trunSize;
        const moofSize = 8 + mfhd.byteLength + trafSize;
        const dataOffset = moofSize + 8;

        const trun = fullbox("trun", 0, 0x000701,
            u32(1),
            i32(dataOffset),
            u32(duration),
            u32(obuData.byteLength),
            u32(sampleFlags)
        );

        const traf = box("traf", raw(tfhd), raw(tfdt), raw(trun));
        const moof = box("moof", raw(mfhd), raw(traf));
        const mdat = box("mdat", raw(obuData));

        return concat(moof, mdat);
    }
}

function box(type, ...parts) {
    const payload = concatParts(parts);
    const result = new Uint8Array(8 + payload.byteLength);
    new DataView(result.buffer).setUint32(0, result.byteLength);
    result[4] = type.charCodeAt(0);
    result[5] = type.charCodeAt(1);
    result[6] = type.charCodeAt(2);
    result[7] = type.charCodeAt(3);
    result.set(payload, 8);
    return result;
}

function fullbox(type, version, flags, ...parts) {
    const vf = new Uint8Array(4);
    new DataView(vf.buffer).setUint32(0, (version << 24) | flags);
    return box(type, raw(vf), ...parts);
}

function concatParts(parts) {
    let total = 0;
    for (const p of parts) total += p.byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.byteLength;
    }
    return out;
}

function concat(...arrays) {
    let total = 0;
    for (const a of arrays) total += a.byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
        out.set(a, offset);
        offset += a.byteLength;
    }
    return out;
}

function raw(data) { return data instanceof Uint8Array ? data : new Uint8Array(data); }
function str(s) { return new Uint8Array([...s].map(c => c.charCodeAt(0))); }
function strz(s) { const a = new Uint8Array(s.length + 1); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
function zeros(n) { return new Uint8Array(n); }
function u16(v) { const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, v); return a; }
function i16(v) { const a = new Uint8Array(2); new DataView(a.buffer).setInt16(0, v); return a; }
function u32(v) { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, v >>> 0); return a; }
function i32(v) { const a = new Uint8Array(4); new DataView(a.buffer).setInt32(0, v); return a; }
function u64(v) { const a = new Uint8Array(8); const dv = new DataView(a.buffer); dv.setUint32(0, Math.floor(v / 0x100000000)); dv.setUint32(4, v >>> 0); return a; }

function identity2x2() {
    const m = new Uint8Array(36);
    const dv = new DataView(m.buffer);
    dv.setUint32(0, 0x00010000);
    dv.setUint32(16, 0x00010000);
    dv.setUint32(32, 0x40000000);
    return m;
}

function identity3x3() {
    const m = new Uint8Array(36);
    const dv = new DataView(m.buffer);
    dv.setUint32(0, 0x00010000);
    dv.setUint32(16, 0x00010000);
    dv.setUint32(32, 0x40000000);
    return m;
}

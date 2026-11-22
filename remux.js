// remux.js — MPEG-TS (H.264 + AAC) -> MP4 without re-encoding. No dependencies; runs in a page and in Node.
//
//   const mux = new Remux.Mp4Muxer();
//   for (const seg of segments) for (const chunk of mux.push(seg)) await out.write(chunk);
//   const end = mux.finish();                       // { chunks, patch:{pos,data}, info }
//   for (const c of end.chunks) await out.write(c);
//   await out.write({ type: 'write', position: end.patch.pos, data: end.patch.data });
//
// Layout of the result:  ftyp | mdat (64-bit size, patched at the end) | moov.
// Timing is taken from the TS (DTS/PTS, 90 kHz); the A/V offset is kept with edit lists, B-frame delay with ctts + edit list.
// Unsupported streams (HEVC, AC-3, MP3, ...) are detected up front by Remux.probe() — nothing is ever renamed or faked.
var Remux = (() => {
  'use strict';
  const enc = new TextEncoder();
  const u32 = n => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  const u16 = n => Uint8Array.of((n >>> 8) & 255, n & 255);
  const u64 = n => cat([u32(Math.floor(n / 4294967296)), u32(n >>> 0)]);
  const str = s => enc.encode(s);
  function cat(parts) {
    let n = 0; for (const p of parts) n += p.length;
    const o = new Uint8Array(n); let k = 0;
    for (const p of parts) { o.set(p, k); k += p.length; }
    return o;
  }
  const box = (type, ...parts) => { const body = cat(parts); return cat([u32(8 + body.length), str(type), body]); };
  const fbox = (type, ver, flags, ...parts) => box(type, Uint8Array.of(ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);
  const zeros = n => new Uint8Array(n);

  // ---------------- H.264 helpers ----------------
  function unescapeRbsp(nal) {
    const o = [];
    for (let i = 0; i < nal.length; i++) { if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue; o.push(nal[i]); }
    return Uint8Array.from(o);
  }
  class Bits {
    constructor(b) { this.b = b; this.p = 0; }
    bit() { const v = (this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1; this.p++; return v; }
    bits(n) { let v = 0; while (n--) v = v * 2 + this.bit(); return v; }
    ue() { let z = 0; while (this.bit() === 0 && z < 32) z++; return z ? (2 ** z - 1 + this.bits(z)) : 0; }
    se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -k / 2; }
  }
  function parseSps(nal) {
    const r = new Bits(unescapeRbsp(nal.subarray(1)));
    const profile = r.bits(8), compat = r.bits(8), level = r.bits(8); r.ue();
    let chroma = 1, bitL = 8, bitC = 8;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = r.ue(); if (chroma === 3) r.bit();
      bitL = 8 + r.ue(); bitC = 8 + r.ue(); r.bit();
      if (r.bit()) {
        const n = chroma !== 3 ? 8 : 12;
        for (let i = 0; i < n; i++) if (r.bit()) {
          let last = 8, next = 8; const size = i < 6 ? 16 : 64;
          for (let j = 0; j < size; j++) { if (next !== 0) next = (last + r.se() + 256) % 256; last = next === 0 ? last : next; }
        }
      }
    }
    r.ue();
    const poc = r.ue();
    if (poc === 0) r.ue(); else if (poc === 1) { r.bit(); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
    r.ue(); r.bit();
    const w = r.ue() + 1, hmap = r.ue() + 1, frameMbsOnly = r.bit();
    if (!frameMbsOnly) r.bit();
    r.bit();
    let cl = 0, cr = 0, ct = 0, cb = 0;
    if (r.bit()) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
    const subW = chroma === 3 ? 1 : 2, subH = chroma === 1 ? 2 : 1;
    const cux = chroma === 0 ? 1 : subW, cuy = (chroma === 0 ? 1 : subH) * (2 - frameMbsOnly);
    return { profile, compat, level, chroma, bitL, bitC,
      width: w * 16 - (cl + cr) * cux, height: (2 - frameMbsOnly) * hmap * 16 - (ct + cb) * cuy };
  }
  // first slice header: first_mb_in_slice, slice_type  -> is it an I slice
  function sliceIsI(nal) {
    try { const r = new Bits(unescapeRbsp(nal.subarray(1, 12))); r.ue(); const t = r.ue() % 5; return t === 2 || t === 4; } catch { return false; }
  }
  function hasRecoveryPoint(nal) {
    let p = 1;
    while (p < nal.length - 2) {
      let type = 0, size = 0;
      while (nal[p] === 255) { type += 255; p++; } type += nal[p++];
      while (nal[p] === 255) { size += 255; p++; } size += nal[p++];
      if (type === 6) return true;
      p += size;
    }
    return false;
  }
  function splitAnnexB(d) {
    const out = [], n = d.length;
    let i = 0, start = -1;
    while (i + 2 < n) {
      if (d[i + 2] > 1) { i += 3; continue; }
      if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) {
        if (start >= 0) { let e = i; while (e > start && d[e - 1] === 0) e--; if (e > start) out.push(d.subarray(start, e)); }
        start = i + 3; i += 3;
      } else i++;
    }
    if (start >= 0 && start < n) { let e = n; while (e > start && d[e - 1] === 0) e--; if (e > start) out.push(d.subarray(start, e)); }
    return out;
  }
  const ts33 = (b, o) => (((b[o] >> 1) & 7) * 1073741824) + (((b[o + 1] << 22) | ((b[o + 2] >> 1) << 15) | (b[o + 3] << 7) | (b[o + 4] >> 1)) >>> 0);
  const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const WRAP = 2 ** 33, HALF = 2 ** 32;
  const sdiff = (a, b) => ((a - b + WRAP + HALF) % WRAP) - HALF;          // signed difference of two 33-bit timestamps

  // ---------------- MPEG-TS demuxer ----------------
  const UNSUP_VIDEO = { 0x01: 'MPEG-1 video', 0x02: 'MPEG-2 video', 0x24: 'HEVC', 0x10: 'MPEG-4 video' };
  const UNSUP_AUDIO = { 0x03: 'MP3', 0x04: 'MP3', 0x11: 'AAC-LATM', 0x81: 'AC-3', 0x87: 'E-AC-3' };
  class TsDemux {
    constructor(h) { this.h = h; this.carry = null; this.pmt = -1; this.vpid = -1; this.apid = -1; this.pes = new Map(); this.unsupported = []; this.pmtSeen = false; }
    push(buf) {
      if (this.carry) { buf = cat([this.carry, buf]); this.carry = null; }
      let p = 0; const n = buf.length;
      while (p + 188 <= n) {
        if (buf[p] !== 0x47 || (p + 188 < n && buf[p + 188] !== 0x47)) { p++; continue; }   // resync
        this.packet(buf.subarray(p, p + 188)); p += 188;
      }
      if (p < n) this.carry = buf.slice(p);
    }
    packet(b) {
      if (b[1] & 0x80) return;
      const pid = ((b[1] & 0x1f) << 8) | b[2], pusi = !!(b[1] & 0x40), afc = (b[3] >> 4) & 3;
      let o = 4;
      if (afc & 2) o += 1 + b[4];
      if (!(afc & 1) || o >= 188) return;
      const pl = b.subarray(o);
      if (pid === 0) return this.pat(pl, pusi);
      if (pid === this.pmt) return this.pmtParse(pl, pusi);
      if (pid === this.vpid || pid === this.apid) this.pesAdd(pid, pl, pusi);
    }
    pat(pl, pusi) {
      if (!pusi || this.pmt >= 0) return;
      const s = 1 + pl[0], end = s + 3 + (((pl[s + 1] & 15) << 8) | pl[s + 2]) - 4;
      for (let i = s + 8; i + 4 <= end && i + 4 <= pl.length; i += 4) {
        if (((pl[i] << 8) | pl[i + 1]) !== 0) { this.pmt = ((pl[i + 2] & 0x1f) << 8) | pl[i + 3]; break; }
      }
    }
    pmtParse(pl, pusi) {
      if (!pusi || this.pmtSeen) return;
      const s = 1 + pl[0], end = Math.min(pl.length, s + 3 + (((pl[s + 1] & 15) << 8) | pl[s + 2]) - 4);
      let i = s + 12 + (((pl[s + 10] & 15) << 8) | pl[s + 11]);
      while (i + 5 <= end) {
        const type = pl[i], pid = ((pl[i + 1] & 0x1f) << 8) | pl[i + 2], esl = ((pl[i + 3] & 15) << 8) | pl[i + 4];
        if (type === 0x1b && this.vpid < 0) this.vpid = pid;
        else if (type === 0x0f && this.apid < 0) this.apid = pid;
        else if (UNSUP_VIDEO[type]) this.unsupported.push({ kind: 'video', codec: UNSUP_VIDEO[type] });
        else if (UNSUP_AUDIO[type]) this.unsupported.push({ kind: 'audio', codec: UNSUP_AUDIO[type] });
        i += 5 + esl;
      }
      this.pmtSeen = true;
    }
    pesAdd(pid, pl, pusi) {
      let s = this.pes.get(pid); if (!s) this.pes.set(pid, s = { parts: [] });
      if (pusi) this.pesEnd(pid, s);
      else if (!s.parts.length) return;
      s.parts.push(pl);
    }
    pesEnd(pid, s) {
      if (!s.parts.length) return;
      const d = s.parts.length === 1 ? s.parts[0] : cat(s.parts); s.parts = [];
      if (d.length < 9 || d[0] !== 0 || d[1] !== 0 || d[2] !== 1) return;
      const flags = d[7] >> 6, hl = d[8], plen = (d[4] << 8) | d[5];
      let pts, dts;
      if (flags & 2) pts = ts33(d, 9);
      if (flags === 3) dts = ts33(d, 14);
      let data = d.subarray(9 + hl);
      if (plen > 0 && 6 + plen <= d.length) data = d.subarray(9 + hl, 6 + plen);
      if (pid === this.vpid) this.h.video(data, pts, dts); else this.h.audio(data, pts);
    }
    flush() { for (const [pid, s] of this.pes) this.pesEnd(pid, s); }
  }

  // ---------------- MP4 muxer ----------------
  class Mp4Muxer {
    constructor() {
      this.demux = new TsDemux({ video: (d, p, t) => this.onVideo(d, p, t), audio: (d, p) => this.onAudio(d, p) });
      this.fatal = ''; this.warnings = [];
      this.parts = []; this.pos = 0;
      this.sps = null; this.pps = []; this.spsInfo = null;
      this.V = { sizes: [], chunks: [], dts: [], pts: [], sync: [] }; this.A = { sizes: [], chunks: [], cfg: null };
      this.pv = []; this.pa = []; this.pbytes = 0;
      this.lastDtsRaw = undefined; this.lastDts = undefined; this.lastDelta = 0; this.shift = 0; this.discont = 0;
      this.vFirstRaw = undefined; this.aFirstRaw = undefined; this.aCarry = null; this.aN = 0; this.aDrift = 0;
      this.write(box('ftyp', str('isom'), u32(512), str('isom'), str('iso2'), str('avc1'), str('mp41')));
      this.mdatStart = this.pos;
      this.write(cat([u32(1), str('mdat'), u64(0)]));                       // 64-bit size, patched in finish()
    }
    write(u8) { this.parts.push(u8); this.pos += u8.length; }

    addSps(n) {
      let info; try { info = parseSps(n); } catch { return; }
      if (!this.sps) { this.sps = Uint8Array.from(n); this.spsInfo = info; }
      else if (info.width !== this.spsInfo.width || info.height !== this.spsInfo.height) this.fatal = 'The video resolution changes inside the stream';
    }
    addPps(n) { if (!this.pps.some(x => x.length === n.length && x.every((v, i) => v === n[i]))) this.pps.push(Uint8Array.from(n)); }

    onVideo(data, pts, dts) {
      if (this.fatal) return;
      let size = 0, idr = false, recovery = false, isI = false; const vcl = [];
      for (const n of splitAnnexB(data)) {
        const t = n[0] & 31;
        if (t === 7) this.addSps(n);
        else if (t === 8) this.addPps(n);
        else if (t >= 1 && t <= 5) { if (t === 5) idr = true; if (!vcl.length) isI = sliceIsI(n); vcl.push(n); size += 4 + n.length; }
        else if (t === 6 && hasRecoveryPoint(n)) recovery = true;
      }
      if (!vcl.length || !this.sps) return;                                    // nothing to decode / no SPS yet
      const sync = idr || (recovery && isI);
      if (!this.V.dts.length && !sync) return;                                 // do not start in the middle of a GOP
      const body = new Uint8Array(size); let o = 0;
      for (const n of vcl) { body.set(u32(n.length), o); body.set(n, o + 4); o += 4 + n.length; }
      const draw = dts !== undefined ? dts : pts, praw = pts !== undefined ? pts : draw;
      let d;
      if (this.lastDtsRaw === undefined) { d = draw; this.vFirstRaw = draw; }
      else d = this.lastDts - this.shift + sdiff(draw, this.lastDtsRaw);
      let delta = d + this.shift - (this.lastDts === undefined ? -Infinity : this.lastDts);
      if (this.lastDts !== undefined && (delta <= 0 || delta > 900000)) {      // timestamp jump: continue the timeline smoothly
        this.shift += (this.lastDts + (this.lastDelta || 3600)) - (d + this.shift); this.discont++;
        delta = this.lastDelta || 3600;
      }
      const D = d + this.shift, P = D + sdiff(praw, draw);
      if (this.lastDts !== undefined) this.lastDelta = D - this.lastDts;
      this.lastDtsRaw = draw; this.lastDts = D;
      this.V.dts.push(D); this.V.pts.push(P); this.V.sync.push(sync ? 1 : 0);
      this.pv.push(body); this.pbytes += body.length;
      if (this.pbytes > (8 << 20)) this.flushGroup();
    }

    onAudio(data, pts) {
      if (this.fatal) return;
      let d = this.aCarry ? cat([this.aCarry, data]) : data; this.aCarry = null;
      let p = 0, first = true;
      while (p + 7 <= d.length) {
        if (d[p] !== 0xff || (d[p + 1] & 0xf0) !== 0xf0) { p++; continue; }
        const prot = d[p + 1] & 1, sfi = (d[p + 2] >> 2) & 15, flen = ((d[p + 3] & 3) << 11) | (d[p + 4] << 3) | (d[p + 5] >> 5);
        if (flen < 7 || sfi > 12) { p++; continue; }
        if (p + flen > d.length) { this.aCarry = d.slice(p); return; }
        const hl = prot ? 7 : 9, aot = ((d[p + 2] >> 6) & 3) + 1, ch = ((d[p + 2] & 1) << 2) | (d[p + 3] >> 6);
        if (!this.A.cfg) this.A.cfg = { aot, sfi, ch, rate: RATES[sfi] };
        if (first && pts !== undefined) {
          if (this.aFirstRaw === undefined) this.aFirstRaw = pts;
          else {                                                               // drift of the sample-count timeline vs. the PES timestamps
            const expect = (this.aFirstRaw + this.aN * 1024 * 90000 / this.A.cfg.rate) % WRAP;
            this.aDrift = Math.max(this.aDrift, Math.abs(sdiff(pts, expect)) / 90);
          }
        }
        first = false;
        this.pa.push(d.subarray(p + hl, p + flen)); this.pbytes += flen - hl; this.aN++;
        p += flen;
      }
      if (p < d.length) this.aCarry = d.slice(p);
    }

    // one chunk of video samples, then one chunk of audio samples (interleaved per segment, ~6 s)
    flushGroup() {
      if (this.pv.length) {
        this.V.chunks.push({ off: this.pos, n: this.pv.length });
        for (const s of this.pv) { this.write(s); this.V.sizes.push(s.length); }
        this.pv = [];
      }
      if (this.pa.length) {
        this.A.chunks.push({ off: this.pos, n: this.pa.length });
        for (const s of this.pa) { this.write(s); this.A.sizes.push(s.length); }
        this.pa = [];
      }
      this.pbytes = 0;
    }
    take() { const c = this.parts.length > 1 ? cat(this.parts) : this.parts[0]; this.parts = []; return c ? [c] : []; }

    // feed TS bytes; returns the chunks that must be written to the file (in order)
    push(buf) {
      this.demux.push(buf);
      if (this.demux.pmtSeen && !this.fatal) {
        const bad = this.demux.unsupported.find(u => (u.kind === 'video' && this.demux.vpid < 0) || (u.kind === 'audio' && this.demux.apid < 0));
        if (bad) this.fatal = `Unsupported ${bad.kind} codec: ${bad.codec}`;
      }
      this.flushGroup();
      return this.take();
    }

    finish() {
      this.demux.flush(); this.flushGroup();
      if (this.fatal) throw new Error(this.fatal);
      if (!this.V.sizes.length) throw new Error('No decodable video found in the stream');
      const mdatSize = this.pos - this.mdatStart;
      const moov = this.buildMoov();
      this.write(moov);
      return { chunks: this.take(), patch: { pos: this.mdatStart + 8, data: u64(mdatSize) }, info: this.info };
    }

    buildMoov() {
      const V = this.V, A = this.A, n = V.sizes.length, SI = this.spsInfo, TS = 90000;
      // --- video timing
      const d0 = V.dts[0], deltas = [];
      for (let i = 0; i + 1 < n; i++) deltas.push(V.dts[i + 1] - V.dts[i]);
      deltas.push(deltas.length ? deltas[deltas.length - 1] : 3600);
      let vMediaDur = 0; for (const x of deltas) vMediaDur += x;
      let minPts = Infinity, neg = 0; const offs = new Array(n);
      for (let i = 0; i < n; i++) {
        let o = V.pts[i] - V.dts[i]; if (o < 0) { o = 0; neg++; }
        offs[i] = o; if (V.pts[i] < minPts) minPts = V.pts[i];
      }
      if (neg) this.warnings.push(`${neg} frames had PTS < DTS`);
      let maxEnd = 0;                                                          // end of presentation of the last shown frame (B-frames show later than the last DTS)
      for (let i = 0; i < n; i++) maxEnd = Math.max(maxEnd, (V.pts[i] - d0) + deltas[i]);
      const vMinCts = Math.max(0, minPts - d0);                                // presentation of the first shown frame, media time
      const vStartRel = vMinCts;                                               // relative to the first video DTS
      let aStartRel = null;
      if (A.sizes.length && this.aFirstRaw !== undefined) aStartRel = sdiff(this.aFirstRaw, this.vFirstRaw);
      const base = aStartRel === null ? vStartRel : Math.min(vStartRel, aStartRel);
      const vDelay = Math.round(vStartRel - base), aDelay = aStartRel === null ? 0 : Math.round(aStartRel - base);

      const run = (arr, eq) => { const r = []; for (const x of arr) { const l = r[r.length - 1]; if (l && eq(l.v, x)) l.c++; else r.push({ c: 1, v: x }); } return r; };
      const sttsV = run(deltas, (a, b) => a === b);
      const cttsV = run(offs, (a, b) => a === b);
      const stss = []; V.sync.forEach((s, i) => { if (s) stss.push(i + 1); });
      const stsc = ch => { const r = []; ch.forEach((c, i) => { const l = r[r.length - 1]; if (!l || l.n !== c.n) r.push({ first: i + 1, n: c.n }); }); return r; };
      const co = ch => ch.some(c => c.off > 0xFFFFFFFF)
        ? fbox('co64', 0, 0, u32(ch.length), cat(ch.map(c => u64(c.off))))
        : fbox('stco', 0, 0, u32(ch.length), cat(ch.map(c => u32(c.off))));
      const sizes = arr => fbox('stsz', 0, 0, u32(0), u32(arr.length), cat(arr.map(u32)));
      const edts = (delay, dur, mediaTime) => fbox('elst', 0, 0, u32(delay ? 2 : 1),
        ...(delay ? [u32(delay), u32(0xFFFFFFFF), u16(1), u16(0)] : []), u32(dur), u32(mediaTime), u16(1), u16(0));

      const vPresDur = Math.max(0, Math.max(maxEnd, vMediaDur) - vMinCts), vTrackDur = vDelay + vPresDur;
      const avcc = [Uint8Array.of(1, SI.profile, SI.compat, SI.level, 0xFF, 0xE0 | 1), u16(this.sps.length), this.sps, Uint8Array.of(this.pps.length)];
      for (const p of this.pps) avcc.push(u16(p.length), p);
      if ([100, 110, 122, 144].includes(SI.profile)) avcc.push(Uint8Array.of(0xFC | SI.chroma, 0xF8 | (SI.bitL - 8), 0xF8 | (SI.bitC - 8), 0));
      const avc1 = box('avc1', zeros(6), u16(1), zeros(16), u16(SI.width), u16(SI.height), u32(0x00480000), u32(0x00480000), zeros(4), u16(1),
        zeros(32), u16(0x18), u16(0xFFFF), box('avcC', ...avcc));
      const matrix = cat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);
      const tkhd = (id, dur, vol, w, h) => fbox('tkhd', 0, 7, u32(0), u32(0), u32(id), u32(0), u32(dur), zeros(8), u16(0), u16(0), u16(vol), u16(0), matrix, u32(w << 16), u32(h << 16));
      const hdlr = (t, name) => fbox('hdlr', 0, 0, u32(0), str(t), zeros(12), str(name + '\0'));
      const dinf = box('dinf', fbox('dref', 0, 0, u32(1), fbox('url ', 0, 1)));

      const vtrak = box('trak', tkhd(1, vTrackDur, 0, SI.width, SI.height),
        box('edts', edts(vDelay, vPresDur, vMinCts)),
        box('mdia', fbox('mdhd', 0, 0, u32(0), u32(0), u32(TS), u32(vMediaDur), u16(0x55C4), u16(0)), hdlr('vide', 'VideoHandler'),
          box('minf', fbox('vmhd', 0, 1, zeros(8)), dinf,
            box('stbl', fbox('stsd', 0, 0, u32(1), avc1),
              fbox('stts', 0, 0, u32(sttsV.length), cat(sttsV.map(r => cat([u32(r.c), u32(r.v)])))),
              ...(cttsV.length > 1 || cttsV[0].v !== 0 ? [fbox('ctts', 0, 0, u32(cttsV.length), cat(cttsV.map(r => cat([u32(r.c), u32(r.v)]))))] : []),
              fbox('stss', 0, 0, u32(stss.length), cat(stss.map(u32))),
              fbox('stsc', 0, 0, u32(stsc(V.chunks).length), cat(stsc(V.chunks).map(e => cat([u32(e.first), u32(e.n), u32(1)])))),
              sizes(V.sizes), co(V.chunks)))));

      let atrak = null, aDur = 0, aTrackDur = 0;
      if (A.sizes.length && A.cfg) {
        const c = A.cfg; aDur = A.sizes.length * 1024;
        const aMovieDur = Math.round(aDur * TS / c.rate); aTrackDur = aDelay + aMovieDur;
        const asc = Uint8Array.of(((c.aot & 31) << 3) | (c.sfi >> 1), ((c.sfi & 1) << 7) | ((c.ch & 15) << 3));
        const bytes = A.sizes.reduce((a, b) => a + b, 0), avg = Math.round(bytes * 8 / (aDur / c.rate));
        const dsi = cat([Uint8Array.of(0x05, asc.length), asc]);
        const dcd = cat([Uint8Array.of(0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0), u32(Math.round(avg * 1.5)), u32(avg), dsi]);
        const esd = cat([Uint8Array.of(0x03, 3 + dcd.length + 3, 0, 0, 0), dcd, Uint8Array.of(0x06, 1, 0x02)]);
        const channels = c.ch === 7 ? 8 : (c.ch || 2);
        const mp4a = box('mp4a', zeros(6), u16(1), zeros(8), u16(channels), u16(16), u16(0), u16(0), u32(Math.min(c.rate, 65535) << 16), fbox('esds', 0, 0, esd));
        atrak = box('trak', tkhd(2, aTrackDur, 0x0100, 0, 0),
          box('edts', edts(aDelay, aMovieDur, 0)),
          box('mdia', fbox('mdhd', 0, 0, u32(0), u32(0), u32(c.rate), u32(aDur), u16(0x55C4), u16(0)), hdlr('soun', 'SoundHandler'),
            box('minf', fbox('smhd', 0, 0, zeros(4)), dinf,
              box('stbl', fbox('stsd', 0, 0, u32(1), mp4a),
                fbox('stts', 0, 0, u32(1), u32(A.sizes.length), u32(1024)),
                fbox('stsc', 0, 0, u32(stsc(A.chunks).length), cat(stsc(A.chunks).map(e => cat([u32(e.first), u32(e.n), u32(1)])))),
                sizes(A.sizes), co(A.chunks)))));
      } else if (this.demux.apid < 0 && this.demux.unsupported.some(u => u.kind === 'audio')) {
        throw new Error('The audio codec is not supported');
      }
      const movieDur = Math.max(vTrackDur, aTrackDur);
      const mvhd = fbox('mvhd', 0, 0, u32(0), u32(0), u32(TS), u32(movieDur), u32(0x00010000), u16(0x0100), zeros(10), matrix, zeros(24), u32(atrak ? 3 : 2));
      const nsamp = n, dur = movieDur / TS;
      this.info = {
        duration: dur, width: SI.width, height: SI.height, videoSamples: nsamp, audioSamples: A.sizes.length, syncSamples: stss.length,
        fps: nsamp / Math.max(0.001, vMediaDur / TS), hasAudio: !!atrak, sampleRate: A.cfg ? A.cfg.rate : 0, channels: A.cfg ? (A.cfg.ch || 2) : 0,
        videoDelayMs: vDelay / 90, audioDelayMs: aDelay / 90, audioDriftMs: Math.round(this.aDrift), discontinuities: this.discont,
        codec: `avc1.${[SI.profile, SI.compat, SI.level].map(x => x.toString(16).padStart(2, '0')).join('')}`, warnings: this.warnings, bytes: this.pos
      };
      if (this.discont) this.warnings.push(`${this.discont} timestamp discontinuities were smoothed`);
      if (this.aDrift > 150) this.warnings.push(`audio timestamps drift up to ${Math.round(this.aDrift)} ms`);
      if (stss.length < 2 && n > 300) this.warnings.push('very few keyframes: seeking may be coarse');
      return box('moov', mvhd, vtrak, ...(atrak ? [atrak] : []));
    }
  }

  // Can this TS be remuxed? Looks at the first segment only (nothing is written anywhere).
  function probe(firstSegment) {
    const m = new Mp4Muxer();
    try { m.push(firstSegment); } catch (e) { return { ok: false, reason: String(e.message || e) }; }
    if (m.fatal) return { ok: false, reason: m.fatal };
    if (!m.demux.pmtSeen) return { ok: false, reason: 'No MPEG-TS program table found (not a plain TS stream)' };
    if (m.demux.vpid < 0) return { ok: false, reason: 'No H.264 video stream' };
    if (!m.sps) return { ok: false, reason: 'No H.264 parameters (SPS) in the first segment' };
    return { ok: true, video: { width: m.spsInfo.width, height: m.spsInfo.height, profile: m.spsInfo.profile }, hasAudio: m.demux.apid >= 0 };
  }

  // ---------------- verification of a finished file ----------------
  // Reads the boxes of the file (ftyp / mdat / moov) and checks that the tables agree with the data.
  async function verifyFile(file, expected = {}) {
    const rd = async (a, b) => new Uint8Array(await file.slice(a, b).arrayBuffer());
    const dv = u => new DataView(u.buffer, u.byteOffset, u.byteLength);
    const problems = []; const out = { ok: false, problems, tracks: [] };
    const head = await rd(0, 64);
    if (str('ftyp').some((c, i) => head[4 + i] !== c)) { problems.push('no ftyp box'); return out; }
    const ftypSize = dv(head).getUint32(0);
    const mh = await rd(ftypSize, ftypSize + 16);
    if (str('mdat').some((c, i) => mh[4 + i] !== c)) { problems.push('mdat box not found after ftyp'); return out; }
    const m = dv(mh); let mdatSize = m.getUint32(0), hdr = 8;
    if (mdatSize === 1) { mdatSize = m.getUint32(8) * 4294967296 + m.getUint32(12); hdr = 16; }
    if (mdatSize <= hdr) { problems.push('empty mdat (the size was never patched)'); return out; }
    const moovAt = ftypSize + mdatSize;
    if (moovAt + 8 > file.size) { problems.push('moov box missing — the file is truncated'); return out; }
    const mv = await rd(moovAt, moovAt + 8);
    if (str('moov').some((c, i) => mv[4 + i] !== c)) { problems.push('moov box not found after mdat'); return out; }
    const moovSize = dv(mv).getUint32(0);
    if (moovAt + moovSize !== file.size) problems.push('unexpected bytes after moov');
    const moov = await rd(moovAt + 8, moovAt + moovSize);
    const kids = (u, from = 0, to = u.length) => { const r = []; let p = from; while (p + 8 <= to) { const sz = dv(u).getUint32(p); const t = String.fromCharCode(...u.subarray(p + 4, p + 8)); if (sz < 8) break; r.push({ t, a: p + 8, b: p + sz }); p += sz; } return r; };
    const find = (u, par, t) => kids(u, par.a, par.b).find(k => k.t === t);
    const payloadStart = ftypSize + hdr, payloadEnd = moovAt;
    for (const trak of kids(moov).filter(k => k.t === 'trak')) {
      const mdia = find(moov, trak, 'mdia'), minf = find(moov, mdia, 'minf'), stbl = find(moov, minf, 'stbl');
      const v = dv(moov), mdhd = find(moov, mdia, 'mdhd'), hd = find(moov, mdia, 'hdlr');
      const type = String.fromCharCode(...moov.subarray(hd.a + 8, hd.a + 12));
      const timescale = v.getUint32(mdhd.a + 12), dur = v.getUint32(mdhd.a + 16);
      const stsz = find(moov, stbl, 'stsz'), cnt = v.getUint32(stsz.a + 8);
      let total = 0; for (let i = 0; i < cnt; i++) total += v.getUint32(stsz.a + 12 + 4 * i);
      const co = find(moov, stbl, 'stco') || find(moov, stbl, 'co64'), nco = v.getUint32(co.a + 4), is64 = co.t === 'co64';
      let minOff = Infinity, maxOff = 0;
      for (let i = 0; i < nco; i++) { const o = is64 ? v.getUint32(co.a + 8 + 8 * i) * 4294967296 + v.getUint32(co.a + 12 + 8 * i) : v.getUint32(co.a + 8 + 4 * i); minOff = Math.min(minOff, o); maxOff = Math.max(maxOff, o); }
      const stss = find(moov, stbl, 'stss');
      out.tracks.push({ type, samples: cnt, bytes: total, duration: dur / timescale, chunks: nco, minOff, maxOff, sync: stss ? v.getUint32(stss.a + 4) : cnt });
      if (cnt === 0) problems.push(`${type}: no samples`);
      if (minOff < payloadStart || maxOff > payloadEnd) problems.push(`${type}: chunk offsets point outside mdat`);
    }
    const sum = out.tracks.reduce((a, t) => a + t.bytes, 0);
    if (sum !== payloadEnd - payloadStart) problems.push(`sample sizes (${sum}) do not add up to the mdat payload (${payloadEnd - payloadStart})`);
    const vt = out.tracks.find(t => t.type === 'vide'), at = out.tracks.find(t => t.type === 'soun');
    if (!vt) problems.push('no video track');
    if (expected.hasAudio && !at) problems.push('the audio track is missing');
    if (expected.duration && vt && Math.abs(vt.duration - expected.duration) > Math.max(2, expected.duration * 0.03)) problems.push(`video duration ${vt.duration.toFixed(1)} s differs from the playlist (${expected.duration.toFixed(1)} s)`);
    if (vt && at && Math.abs(vt.duration - at.duration) > 3) problems.push(`audio (${at.duration.toFixed(1)} s) and video (${vt.duration.toFixed(1)} s) lengths differ`);
    if (vt && vt.sync < 1) problems.push('no keyframes: seeking is impossible');
    out.ok = !problems.length;
    return out;
  }

  return { Mp4Muxer, TsDemux, probe, verifyFile, parseSps, splitAnnexB };
})();
if (typeof module !== 'undefined') module.exports = Remux;

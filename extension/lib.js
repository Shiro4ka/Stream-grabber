// Shared helpers — used by the service worker, the content script and all extension pages.
var SG = (() => {
  const UNTITLED = 'Untitled';

  const DEFAULTS = {
    lang: 'auto',            // auto | ru | en
    concurrency: 8,          // parallel segment downloads
    retries: 3,              // retries per segment
    shortSec: 90,            // videos shorter than this are unchecked in "Download all" (ads / trailers)
    perRow: 12,              // max episodes per row in the queue grid (rows are created automatically)
    maxHistory: 500,         // how many videos are remembered per tab
    subfolder: true,         // put files into a folder named after the series
    template: '{anime} - {ep}',
    format: 'mp4',           // mp4 (remux, no re-encoding) | ts (raw segments)
    bat: true,               // drop Convert-to-HEVC.bat into the download folder
    ignore: 'youtube.com\nyoutube-nocookie.com\nyoutu.be\ngooglevideo.com\nytimg.com'
  };
  async function getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return { ...DEFAULTS, ...(settings || {}) };
  }

  const abs = (u, base) => new URL(u, base).href;
  const dirOf = u => { try { const x = new URL(u); x.search = ''; x.hash = ''; return x.href.replace(/[^/]*$/, ''); } catch { return ''; } };

  function attrs(l) {
    const o = {};
    for (const m of l.slice(l.indexOf(':') + 1).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) o[m[1]] = m[2].replace(/^"|"$/g, '');
    return o;
  }

  // Quality variants: higher resolution first, then HEVC, then bitrate
  function parseMaster(txt, base) {
    const L = txt.split(/\r?\n/), out = [];
    for (let i = 0; i < L.length; i++) {
      if (!L[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const a = attrs(L[i]);
      let j = i + 1;
      while (j < L.length && (!L[j].trim() || L[j].startsWith('#'))) j++;
      if (j >= L.length) continue;
      const res = a.RESOLUTION || '';
      out.push({
        url: abs(L[j].trim(), base), bw: +a.BANDWIDTH || 0, res,
        h: +(res.split('x')[1]) || 0, codecs: a.CODECS || '', hevc: /hvc1|hev1/i.test(a.CODECS || '')
      });
    }
    return out.sort((a, b) => b.h - a.h || (b.hevc - a.hevc) || b.bw - a.bw);
  }

  function parseMedia(txt, base) {
    let seq = 0, key = null, map = null, dur = 0, pd = 0, unsupported = '';
    const segs = [];
    for (const raw of txt.split(/\r?\n/)) {
      const l = raw.trim();
      if (!l) continue;
      if (l[0] === '#') {
        if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = +l.split(':')[1] || 0;
        else if (l.startsWith('#EXTINF:')) pd = parseFloat(l.slice(8)) || 0;
        else if (l.startsWith('#EXT-X-KEY:')) {
          const a = attrs(l);
          if (a.METHOD === 'AES-128' && a.URI) key = { uri: abs(a.URI, base), iv: a.IV || null };
          else if (!a.METHOD || a.METHOD === 'NONE') key = null;
          else { unsupported = 'DRM (' + a.METHOD + ')'; key = null; }
          if (/widevine|playready|fairplay/i.test(a.KEYFORMAT || '')) unsupported = 'DRM';
        } else if (l.startsWith('#EXT-X-MAP:')) {
          const a = attrs(l); if (a.URI) map = abs(a.URI, base);
        } else if (l.startsWith('#EXT-X-BYTERANGE')) unsupported = unsupported || 'byte-range';
        continue;
      }
      segs.push({ url: abs(l, base), seq: seq++, key, dur: pd });
      dur += pd; pd = 0;
    }
    return { segs, map, duration: dur, unsupported };
  }

  // Fingerprint of a playlist (segment count + hash of segment durations).
  // The same video served under a different URL / token / quality gets the same fingerprint.
  function fingerprint(segs) {
    let h = 5381;
    for (const s of segs) h = ((h * 33) ^ Math.round((s.dur || 0) * 1000)) >>> 0;
    return segs.length + ':' + h.toString(36);
  }

  async function fetchText(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }

  async function parsePlaylist(url) {
    const txt = await fetchText(url);
    if (!txt.includes('#EXTM3U')) throw new Error('not a playlist');
    if (txt.includes('#EXT-X-STREAM-INF')) {
      const variants = parseMaster(txt, url);
      const out = {
        role: 'master', variants,
        dirs: [...new Set(variants.map(v => dirOf(v.url)))],
        sepAudio: /#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI=/.test(txt)
      };
      if (variants.length) {   // peek into the best variant: duration + fingerprint
        try {
          const p = parseMedia(await fetchText(variants[0].url), variants[0].url);
          if (p.segs.length) Object.assign(out, { fp: fingerprint(p.segs), duration: p.duration, segCount: p.segs.length, unsup: p.unsupported });
        } catch {}
      }
      return out;
    }
    const p = parseMedia(txt, url);
    let pre = '';
    if (p.segs.length) {
      const a = p.segs[0].url.split('?')[0], b = p.segs[p.segs.length - 1].url.split('?')[0];
      let i = 0; while (i < a.length && a[i] === b[i]) i++;
      pre = a.slice(0, i);
    }
    return {
      role: 'media', segCount: p.segs.length, duration: p.duration, unsup: p.unsupported,
      fp: p.segs.length ? fingerprint(p.segs) : '',
      dirs: [...new Set([dirOf(url), p.segs[0] ? dirOf(p.segs[0].url) : '', pre].filter(x => x && x.length > 8))]
    };
  }

  function ivBytes(k, seq) {
    const b = new Uint8Array(16);
    if (k.iv) {
      const h = k.iv.replace(/^0x/i, '').padStart(32, '0');
      for (let i = 0; i < 16; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
    } else new DataView(b.buffer).setUint32(12, seq);
    return b;
  }

  // The "current" stream of a frame = the one with the freshest activity
  function currentOf(st, frameId) {
    let best = null;
    for (const s of st.streams) if (s.frameId === frameId && !s.parent && s.activeAt && (!best || s.activeAt > best.activeAt)) best = s;
    return best;
  }

  // By default: everything that was actually played (history). all=true: everything found.
  function visibleStreams(st, all) {
    const top = st.streams.filter(s => !s.parent);
    return all ? top : top.filter(s => s.activeAt);
  }

  // The same video = the same series + the same voice-over + the same episode number (a new token in the URL,
  // another quality, a re-opened player). Equal length / equal segment layout is NOT a reason to merge:
  // many episodes are exactly the same length (24:30), that is what used to hide episodes 1-2.
  // Without a trusted episode number only an identical URL path counts.
  const pathOf = u => { try { const x = new URL(u); return x.host + x.pathname; } catch { return u; } };
  function uniqueStreams(list) {
    const seen = new Set(), keep = [];
    for (const s of list.slice().sort((a, b) => (b.activeAt || b.t) - (a.activeAt || a.t))) {      // newest first = freshest token
      const k = (s.akey && s.ep && s.epSrc !== 'seq') ? `e|${s.akey}|${s.tkey || ''}|${s.ep}` : 'u|' + pathOf(s.url);
      if (!seen.has(k)) { seen.add(k); keep.push(s); }
    }
    return keep;
  }

  const epNum = e => { const m = String(e || '').match(/\d+/); return m ? +m[0] : NaN; };

  function cleanTitle(s) {
    s = (s || '').replace(/\s+/g, ' ').trim();
    s = s.replace(/\s+(смотреть|смотрите|watch|stream)(?=\s|$).*$/i, '');
    s = s.split(/\s[|•·»]\s/)[0];
    s = s.replace(/\s[-–—]\s[^-–—]*(anime|аниме|\.[a-z]{2,4}\b|\btv\b)[^-–—]*$/i, '');
    s = s.replace(/^(аниме|anime|сериал|watch)\s+/i, '');
    s = s.replace(/[\s,.:;\-–—]*\(?\s*\d{1,4}\s*(серия|эпизод|ep\w*)\)?.*$/i, '');
    s = s.replace(/[\s,.:;\-–—]*(серия|эпизод|episode|ep)\.?\s*[№#]?\s*\d{1,4}.*$/i, '');
    s = s.replace(/\s+(онлайн|все серии|online)(?=\s|$).*$/i, '');
    s = s.replace(/\s*\(\d{4}\)\s*$/, '');
    return s.replace(/[\s,.:;\-–—]+$/, '').trim();
  }

  function guessEpInfo(list) {
    for (const s of list || []) {
      const m = s.match(/(\d{1,4})\s*[- ]?\s*(?:сери[яию]|эпизод|ep(?:isode)?s?\b)/i)
        || s.match(/(?:сери[яию]|эпизод|episode|\bep)\.?\s*[№#:]?\s*(\d{1,4})/i)
        || s.match(/\bS\d{1,2}E(\d{1,3})\b/i)
        || s.match(/(?:episode|seriya|seria|ep)[-_\/](\d{1,4})/i)
        || s.match(/\/(\d{1,4})-(?:seriya|seria|серия)\b/i)
        || s.match(/[?&#](?:episode|ep|seria|seriya|series|e|number|num)=(\d{1,4})/i);
      if (m) return { ep: String(+m[1]), src: m[0].trim() };
    }
    return { ep: '', src: '' };
  }
  const guessEp = list => guessEpInfo(list).ep;

  const safeName = s => (s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim().slice(0, 100);

  // File name from a template: {anime} {ep} {quality}
  function fileName(tpl, v) {
    const ep = v.ep ? String(v.ep).padStart(2, '0') : '';
    let s = (tpl || DEFAULTS.template).replace(/\{anime\}/g, v.anime || '').replace(/\{ep\}/g, ep).replace(/\{quality\}/g, v.quality || '').replace(/\{dub\}/g, v.dub || '');
    s = s.replace(/\[\s*\]|\(\s*\)/g, '').replace(/\s*[-–_]\s*$/g, '').replace(/^\s*[-–_]\s*/, '').replace(/\s{2,}/g, ' ');
    return safeName(s) || safeName(v.anime) || 'video';
  }

  // ---------- series identity, voice-over and per-series episode state ----------
  // Episode number priority: 1) the player itself  2) the page / episode list  3) own sequence counter.
  // The result is stored per (series, voice-over) and per stream, so it never changes by accident.
  const pageKey = u => {
    try {
      const x = new URL(u);
      const p = x.pathname.replace(/\/+$/, '').replace(/\/(?:episode|ep|seria|seriya|series|серия)[-_]?\d+$/i, '');
      return x.origin + p;
    } catch { return ''; }
  };
  function animeKey(pageUrl, kd, title) {
    let k = pageKey(pageUrl);
    if (!k || /^https?:\/\/[^/]+$/.test(k)) k = 't:' + String(title || '').toLowerCase().replace(/\s+/g, ' ').trim();   // site root -> title
    if (kd && kd.seasons > 1 && kd.season) k += '#s' + kd.season;
    return k;
  }
  function streamKey(s, kd) {
    if (kd && kd.ids && kd.ep) return 'k:' + kd.ids.kind + ':' + kd.ids.id + ':' + kd.ep;   // serial/season ids are per voice-over, not per episode
    try { const u = new URL(s.url); return 'u:' + u.host + u.pathname; } catch { return 'u:' + s.url; }
  }
  const epsKey = (akey, tkey) => 'eps:' + akey + '|' + (tkey || '');
  // one state per (series, voice-over): numbering counter + THE list of episodes (one record per episode number)
  async function getEps(key) {
    const o = await chrome.storage.local.get(key), S = o[key] || { name: '', last: 0, map: {}, eps: {} };
    S.map ||= {}; S.eps ||= {};
    return S;
  }
  const fmtList = a => a.slice(0, 15).join(', ') + (a.length > 15 ? '…' : '');
  // checks before a mass download; returns [{code, args}] — nothing is skipped silently
  function validateEpisodes(sel, expected) {
    const issues = [], eps = sel.map(Number).filter(n => n > 0).sort((a, b) => a - b);
    if (sel.length - eps.length) issues.push({ code: 'noNum', args: [sel.length - eps.length] });
    const dups = [...new Set(eps.filter((n, i) => i && n === eps[i - 1]))];
    if (dups.length) issues.push({ code: 'dup', args: [fmtList(dups)] });
    const have = new Set(eps);
    if (expected && expected.length) {
      const ex = [...new Set(expected)].sort((a, b) => a - b);
      if (!have.has(ex[0])) issues.push({ code: 'first', args: [ex[0]] });
      const miss = ex.filter((n, i) => i && !have.has(n));
      if (miss.length) issues.push({ code: 'missing', args: [fmtList(miss)] });
    } else if (eps.length) {
      const gaps = []; for (let n = eps[0]; n <= eps[eps.length - 1]; n++) if (!have.has(n)) gaps.push(n);
      if (gaps.length) issues.push({ code: 'gaps', args: [fmtList(gaps)] });
    }
    return issues;
  }
  const normName = s => String(s || '').toLowerCase().replace(/\s*\(\d+\s*эп\.?\)\s*$/i, '').replace(/\s+/g, ' ').trim();
  const sameTrans = (a, b) => !!a && !!b && ((a.id && b.id) ? String(a.id) === String(b.id) : normName(a.name) === normName(b.name));
  // the voice-over of the most recently played video (= what is selected in the player right now)
  function defaultDub(list) {
    let best = null;
    for (const s of list) if (s.dub && (!best || (s.activeAt || 0) > (best.activeAt || 0))) best = s;
    return best ? best.dub : '';
  }

  const fmtDur = s => {
    s = Math.round(s || 0); if (!s) return '';
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60, p = n => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(x)}` : `${m}:${p(x)}`;
  };

  return {
    UNTITLED, DEFAULTS, getSettings, abs, dirOf, parseMaster, parseMedia, parsePlaylist, fingerprint, ivBytes,
    currentOf, visibleStreams, uniqueStreams, epNum, cleanTitle, guessEp, guessEpInfo, safeName, fileName, fmtDur,
    pageKey, animeKey, streamKey, epsKey, getEps, normName, sameTrans, defaultDub, validateEpisodes
  };
})();

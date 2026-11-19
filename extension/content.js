(() => {
  if (window.__sgContent) return;
  window.__sgContent = true;
  const isTop = window === window.top;
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const meta = p => { const e = document.querySelector(`meta[property="${p}"],meta[name="${p}"]`); return e ? e.content : ''; };
  const send = m => { try { chrome.runtime.sendMessage(m).catch(() => {}); } catch {} };

  const EPRE = /^(?:серия|эпизод|episode|ep)?\s*[№#]?\s*(\d{1,4})\s*(?:серия|эпизод|episode|ep)?$/i;
  const EPCTX = '[class*="episod" i],[class*="serie" i],[class*="seri" i],[id*="episod" i],[id*="serie" i],[class*="playlist" i]';

  // «включённый» элемент: active / selected / current / playing, но не inactive / not-active
  function isOn(e) {
    if (e.getAttribute('aria-selected') === 'true' || /^(true|page)$/.test(e.getAttribute('aria-current') || '')) return true;
    for (const c of e.classList) {
      if (/(^|[-_])(in|not|non|un)[-_]?(active|selected|current)/i.test(c)) continue;
      if (/(^|[-_])(active|selected|current|playing|watching)($|[-_])/i.test(c)) return true;
    }
    return false;
  }

  const RANGE = /^\s*(\d{1,4})\s*[-–—]\s*(\d{1,4})\s*$/;     // "11–20" — a page of a paginated episode list
  const PURE = /^[№#]?\s*\d{1,4}$/;
  let lastClick = null;                                       // the episode the user clicked a moment ago

  document.addEventListener('click', e => {
    let n = e.target;
    for (let i = 0; i < 4 && n && n !== document.body; i++, n = n.parentElement) {
      const t = clean(n.textContent);
      if (!t || t.length > 30 || !EPRE.test(t)) continue;
      if (PURE.test(t)) { if (!n.closest(EPCTX)) continue; lastClick = { n: +t.replace(/\D/g, ''), at: Date.now() }; }
      else lastClick = { t, at: Date.now() };
      break;
    }
  }, true);

  function hints() {
    const out = [document.title, location.href];
    const h1 = document.querySelector('h1'); if (h1) out.push(h1.textContent);
    let rangeStart = 0;
    document.querySelectorAll('select option:checked').forEach(o => {
      const t = clean(o.textContent), m = t.match(RANGE);
      if (m) rangeStart = +m[1]; else out.push(t);
    });
    const cand = [];
    let seen = 0;
    for (const e of document.querySelectorAll('li,a,button,div,span,option,[aria-selected],[aria-current]')) {
      if (++seen > 4000 || cand.length > 40) break;
      if (e.childElementCount > 3 || !isOn(e)) continue;
      const inCtx = !!e.closest(EPCTX);
      const dn = e.getAttribute('data-episode') || e.getAttribute('data-ep') || e.getAttribute('data-number') || e.getAttribute('data-num') || e.getAttribute('data-series');
      if (dn && /^\d{1,4}$/.test(dn.trim())) { cand.push({ t: 'Серия ' + dn.trim(), inCtx }); continue; }
      const t = clean(e.textContent);
      if (!t || t.length > 30) continue;
      const rm = t.match(RANGE);
      if (rm) { rangeStart = rangeStart || +rm[1]; continue; }   // the active page tab of the list
      if (!EPRE.test(t)) continue;
      if (PURE.test(t)) { if (inCtx) cand.push({ n: +t.replace(/\D/g, ''), inCtx }); }
      else cand.push({ t, inCtx });
    }
    // a paginated list shows local numbers (1..10 on every page): add the start of the active page
    const adj = n => (rangeStart > 1 && n < rangeStart) ? rangeStart + n - 1 : n;
    const txt = c => c.n !== undefined ? 'Серия ' + adj(c.n) : c.t;
    const ctx = cand.filter(c => c.inCtx).map(txt), other = cand.filter(c => !c.inCtx).map(txt);
    const click = lastClick && Date.now() - lastClick.at < 180000 ? [lastClick.n !== undefined ? 'Серия ' + adj(lastClick.n) : lastClick.t] : [];
    return [...new Set([...ctx, ...click, ...out, ...other].map(s => clean(s).slice(0, 200)).filter(Boolean))];
  }

  function frameInfo() {
    let image = meta('og:image');
    try { if (image) image = new URL(image, location.href).href; } catch {}
    return {
      top: isTop, url: location.href, title: clean(document.title),
      h1: clean((document.querySelector('h1') || {}).textContent).slice(0, 150),
      og: clean(meta('og:title')), image, hints: hints()
    };
  }

  function snap(v) {
    try {
      const w = 192, h = Math.max(1, Math.round(w * (v.videoHeight || 9) / (v.videoWidth || 16)));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(v, 0, 0, w, h);
      const d = x.getImageData(0, 0, w, h).data;
      let s = 0, n = 0;
      for (let i = 0; i < d.length; i += 16) { s += d[i] + d[i + 1] + d[i + 2]; n += 3; }
      return { thumb: c.toDataURL('image/jpeg', 0.7), dark: s / n < 14 };
    } catch { return { thumb: '', dark: true }; }
  }

  function thumbLater(v, attempt) {
    setTimeout(() => {
      const t = snap(v);
      if (t.thumb && (!t.dark || attempt >= 2)) send({ type: 'thumb', thumb: t.thumb });
      else if (attempt < 2) thumbLater(v, attempt + 1);
    }, attempt === 0 ? 1500 : 4000);
  }

  // media events do not bubble — listen in the capture phase
  function report(v) {
    const now = Date.now();
    if (v.__sgAt && now - v.__sgAt < 2000) return;            // one report per video start
    v.__sgAt = now;
    send({
      type: 'playing', duration: isFinite(v.duration) ? v.duration : 0,
      w: v.videoWidth, h: v.videoHeight, hints: hints().slice(0, 12).map(x => x.slice(0, 80)), title: clean(document.title),
      kodik: kodikCompact()
    });
    thumbLater(v, 0);
    if (scanActive) setTimeout(() => { try { v.pause(); } catch {} }, 2500);   // scan mode: we only need the stream, not the playback
  }
  document.addEventListener('playing', e => { if (e.target instanceof HTMLVideoElement) report(e.target); }, true);
  // Scan mode: Chrome may refuse to start playback without a real click; the stream is requested anyway,
  // so the video that has loaded its metadata is reported too.
  for (const ev of ['loadedmetadata', 'canplay']) document.addEventListener(ev, e => { if (scanActive && e.target instanceof HTMLVideoElement) report(e.target); }, true);
  document.addEventListener('loadstart', e => { if (scanActive && e.target instanceof HTMLVideoElement) e.target.muted = true; }, true);

  // Соседние качества: ищем тот же плейлист с другой высотой (…/720/… , 720.mp4:hls:… , _720.m3u8)
  const HS = [2160, 1440, 1080, 720, 576, 480, 360, 240];
  async function siblings(url, segCount) {
    let u; try { u = new URL(url); } catch { return []; }
    const rest = u.pathname + u.search;
    const m = rest.match(/(?<![0-9a-zA-Z])(2160|1440|1080|720|576|480|360|240)(?=p?(?![0-9a-zA-Z]))/);
    if (!m) return [];
    const cur = +m[1];
    const found = [{ url, h: cur, cur: true }];
    await Promise.all(HS.filter(h => h !== cur).map(async h => {
      const cand = u.origin + rest.slice(0, m.index) + h + rest.slice(m.index + m[0].length);
      try {
        const r = await fetch(cand, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) return;
        const t = await r.text();
        if (!t.includes('#EXTM3U') || t.includes('#EXT-X-STREAM-INF')) return;
        const n = (t.match(/#EXTINF:/g) || []).length;
        if (!n) return;
        if (segCount && Math.abs(n - segCount) > Math.max(2, segCount * 0.03)) return;
        found.push({ url: cand, h });
      } catch {}
    }));
    return found.sort((a, b) => b.h - a.h);
  }

  // ---------- Kodik: context for the popup + "collect all episodes" driver ----------
  const kodikCompact = () => {
    const c = Kodik.context();
    return c ? { ids: c.ids, season: c.season, seasons: c.seasons, ep: c.ep, translation: c.translation } : null;
  };
  let scanActive = false, lastCtx = '', wasMuted = null, lastNudge = 0, nudges = 0, nudgeEp = 0, lastSwitch = { ep: 0, at: 0 }, restoreTried = {};
  if (Kodik.isKodik()) {
    const pushCtx = () => {
      const c = Kodik.context(); if (!c) return;
      const j = JSON.stringify(c);
      if (j !== lastCtx) { lastCtx = j; send({ type: 'kodik', ctx: c }); }
    };
    setTimeout(pushCtx, 1500);
    setInterval(pushCtx, 4000);
    setInterval(async () => {
      let poll = null;
      try { poll = await chrome.runtime.sendMessage({ type: 'scanPoll' }); } catch {}
      const v = document.querySelector('video');
      if (!poll || !poll.active) {
        if (scanActive) { scanActive = false; if (v && wasMuted !== null) { v.muted = wasMuted; wasMuted = null; } }   // scan finished: give the sound back
        return;
      }
      scanActive = true;
      const c = Kodik.context();
      if (!c || !c.ready) return;
      const target = poll.target, now = Date.now();
      // the voice-over must stay the selected one — it is never substituted
      if (poll.trans && c.translation && !SG.sameTrans(c.translation, poll.trans)) {
        if (!restoreTried[target]) { restoreTried[target] = 1; Kodik.restoreTranslation(poll.trans); }
        else send({ type: 'scanFail', ep: target, reason: 'dub:' + (c.translation.name || '?') });
        return;
      }
      if (c.ep !== target) {
        if (lastSwitch.ep !== target || now - lastSwitch.at > 9000) {
          lastSwitch = { ep: target, at: now };
          const r = Kodik.gotoEpisode(target);
          if (!r.ok) send({ type: 'scanFail', ep: target, reason: r.reason });
        }
      } else if (now - lastNudge > 3500) {
        // on the target episode but nothing was captured yet: press Play like a person (button -> middle of the player -> video.play())
        if (nudgeEp !== target) { nudgeEp = target; nudges = 0; }
        lastNudge = now; nudges++;
        if (wasMuted === null && v) wasMuted = v.muted;
        Kodik.startPlayback(nudges);
      }
    }, 1500);
  }

  chrome.runtime.onMessage.addListener((msg, _s, respond) => {
    if (msg.type === 'kodikDiag') { respond(Kodik.diagnostics()); return; }
    if (msg.type === 'frameInfo') { respond(frameInfo()); return; }
    if (msg.type === 'parse') {
      SG.parsePlaylist(msg.url).then(respond, e => respond({ error: String(e.message || e) }));
      return true;
    }
    if (msg.type === 'siblings') {
      siblings(msg.url, msg.segCount).then(respond, () => respond([]));
      return true;
    }
  });
})();

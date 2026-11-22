// Kodik player helper (runs inside the Kodik iframe).
// What is known for sure (Kodik API wrappers): every voice-over is a separate player object with its own id/hash in
// the URL (/serial|season|seria|video/<id>/<hash>/720p[/<episode>]). The page layout (selects for season / episode /
// voice-over) is read with several fallbacks, and Kodik.diagnostics() dumps what was found so a layout change is easy to fix.
var Kodik = (() => {
  const URLRE = /\/(seria|serial|season|video)\/(\d+)\/([0-9a-f]{16,})(?:\/(\d{3,4}p))?(?:\/(\d+))?/i;
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const RE_SEASON = /сезон|season/i, RE_EP = /сери|эпизод|episode|\bep\b/i, RE_Q = /^\d{3,4}p?$/i;
  const numOf = (value, label) => {
    const v = String(value == null ? '' : value).trim();
    if (/^\d{1,4}$/.test(v)) return +v;
    const m = String(label || '').match(/(\d{1,4})/);
    return m ? +m[1] : 0;
  };
  const stripCount = s => clean(s).replace(/\s*\(\d+\s*эп\.?\)\s*$/i, '');

  const isKodik = () => URLRE.test(location.pathname);
  function idsFromUrl() {
    const m = location.pathname.match(URLRE);
    return m ? { kind: m[1].toLowerCase(), id: m[2], hash: m[3], q: m[4] || '', ep: m[5] ? +m[5] : 0 } : null;
  }

  // data: [{cls, selected, opts:[{label,value,title}]}] — pure function (unit-tested)
  function classify(data) {
    const out = { seasons: null, episodes: null, translations: null };
    for (const s of data) {
      if (!s.opts || !s.opts.length) continue;
      const labels = s.opts.map(o => o.label), cls = String(s.cls || '').toLowerCase();
      if (labels.every(l => RE_Q.test(l))) continue;                                  // quality select
      if (/seasons/.test(cls) || labels.every(l => RE_SEASON.test(l))) { out.seasons ||= s; continue; }
      if (/series|episodes/.test(cls) || labels.every(l => RE_EP.test(l) || /^\d{1,4}$/.test(l))) { out.episodes ||= s; continue; }
      if (/translations/.test(cls) || s.opts.some(o => o.title || o.id)) out.translations ||= s;
      else out.translations ||= out.translations;                                     // unknown select: ignore
    }
    return out;
  }

  function readSelects() {
    return [...document.querySelectorAll('select')].map(el => {
      const box = el.closest('[class*="serial-"]');
      return {
        el, cls: box ? box.className : (el.parentElement ? el.parentElement.className : ''), selected: el.selectedIndex,
        opts: [...el.options].map(o => ({ label: clean(o.textContent), value: o.value, id: o.dataset.id || '', title: o.dataset.title || '' }))
      };
    });
  }
  const pick = s => (s && s.opts[Math.max(0, s.selected)]) || null;

  // fallback for custom (non-<select>) dropdowns: texts of the top bar, e.g. "2 сезон", "2 серия", "AniDUB"
  function barTexts() {
    const out = [];
    for (const e of document.querySelectorAll('div,span,button,a,li')) {
      if (e.childElementCount) continue;
      const r = e.getBoundingClientRect();
      if (!r.width || r.top > 90 || r.bottom < 0) continue;
      const t = clean(e.textContent);
      if (t && t.length <= 40) out.push(t);
    }
    return out;
  }
  function parseBar(texts) {
    let season = 0, ep = 0, name = '';
    for (const t of texts) {
      let m;
      if ((m = t.match(/^(\d{1,3})\s*сезон/i))) season = season || +m[1];
      else if ((m = t.match(/^(\d{1,4})\s*сери/i))) ep = ep || +m[1];
      else if (!name && t.length >= 2 && !/дальше|далее|назад|поиск|next|prev|^\d{3,4}p$/i.test(t)) name = t;
    }
    return { season, ep, name };
  }

  function context() {
    if (!isKodik()) return null;
    const ids = idsFromUrl(), sel = classify(readSelects());
    let ep = 0, season = 0, seasons = 0, episodes = [], tr = null, nTrans = 0, via = 'url';
    if (sel.episodes) {
      const o = pick(sel.episodes); ep = numOf(o.value, o.label); via = 'select';
      episodes = sel.episodes.opts.map(o => numOf(o.value, o.label)).filter(Boolean);
    }
    if (sel.seasons) { const o = pick(sel.seasons); season = numOf(o.value, o.label); seasons = sel.seasons.opts.length; }
    if (sel.translations) {
      const o = pick(sel.translations); nTrans = sel.translations.opts.length;
      const num = /^\d+$/.test(o.value) ? o.value : '';
      tr = { id: num, name: stripCount(o.title || o.label) };
    }
    if (!ep || !tr || !season) {
      const b = parseBar(barTexts());
      if (!ep) { ep = b.ep; if (ep) via = 'text'; }
      if (!season) season = b.season;
      if (!tr && b.name) tr = { id: '', name: stripCount(b.name) };
    }
    if (!ep && ids && ids.ep) ep = ids.ep;
    return { host: location.hostname, ids, season, seasons, ep, episodes, translation: tr, nTrans, via, ready: !!(ep || episodes.length) };
  }

  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
  function nextButton() {
    for (const e of document.querySelectorAll('button,a,div,span')) {
      if (e.childElementCount > 2) continue;
      if (/^(дальше|далее|next)\b/i.test(clean(e.textContent))) return e;
    }
    return null;
  }

  // Switch to episode n exactly like the user would: the episode select, else the documented URL form, else "Next".
  function gotoEpisode(n) {
    const sel = classify(readSelects());
    if (sel.episodes) {
      const i = sel.episodes.opts.findIndex(o => numOf(o.value, o.label) === n);
      if (i < 0) return { ok: false, reason: 'noEpisode' };
      const el = sel.episodes.el; el.selectedIndex = i; fire(el, 'input'); fire(el, 'change');
      return { ok: true, how: 'select' };
    }
    const ids = idsFromUrl();
    if (ids && ids.kind === 'serial') {
      location.href = `${location.origin}/serial/${ids.id}/${ids.hash}/${ids.q || '720p'}/${n}${location.search}`;
      return { ok: true, how: 'url' };
    }
    const c = context();
    if (c && c.ep && n === c.ep + 1) { const b = nextButton(); if (b) { b.click(); return { ok: true, how: 'next' }; } }
    return { ok: false, reason: 'noControl' };
  }

  // Put the voice-over back if the player changed it. Never picks "something else".
  function restoreTranslation(tr) {
    const sel = classify(readSelects());
    if (!sel.translations || !tr) return false;
    const i = sel.translations.opts.findIndex(o => (tr.id && o.value === String(tr.id)) || stripCount(o.title || o.label).toLowerCase() === String(tr.name || '').toLowerCase());
    if (i < 0) return false;
    const el = sel.translations.el; el.selectedIndex = i; fire(el, 'input'); fire(el, 'change');
    return true;
  }

  // ---- start playback like a person would: Play button, then the middle of the player, then video.play() ----
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
  function clickAt(e, x, y) {
    for (const t of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
      e.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }));
  }
  const PLAY_SELECTORS = ['.fp-play', '.play_button', '.play-button', '.big-play-button', '[class*="play" i][class*="btn" i]',
    '[class*="play" i][class*="button" i]', 'button[aria-label*="play" i]', '[title*="воспроизв" i]', '.fp-ui'];
  function muteAll() { document.querySelectorAll('video').forEach(v => { try { v.muted = true; } catch {} }); }

  // attempt = 1, 2, 3 ... : each call tries something different, so a stuck player is retried in other ways
  function startPlayback(attempt) {
    muteAll();
    const v = document.querySelector('video');
    if (v && !v.paused && attempt === 1) { try { v.pause(); } catch {} v.play().catch(() => {}); return 'restart'; }   // already playing: re-fire "playing"
    const step = attempt % 3;
    if (step === 1) {
      for (const q of PLAY_SELECTORS) {
        const e = document.querySelector(q);
        if (e && visible(e)) { const r = e.getBoundingClientRect(); clickAt(e, r.left + r.width / 2, r.top + r.height / 2); return 'button ' + q; }
      }
    }
    if (step === 1 || step === 2) {
      const x = Math.round(innerWidth / 2), y = Math.round(innerHeight / 2), e = document.elementFromPoint(x, y);
      if (e) { clickAt(e, x, y); return 'center'; }
    }
    if (v) { v.play().catch(() => {}); return 'video.play'; }
    return 'nothing';
  }

  function diagnostics() {
    const data = readSelects(), sel = classify(data);
    return {
      url: location.href, ids: idsFromUrl(), context: context(),
      selects: data.map(d => ({ cls: d.cls, selected: d.selected, n: d.opts.length, sample: d.opts.slice(0, 3) })),
      found: { seasons: !!sel.seasons, episodes: !!sel.episodes, translations: !!sel.translations },
      serialBoxes: [...document.querySelectorAll('[class*="serial-"]')].map(e => e.className).slice(0, 10),
      barTexts: barTexts().slice(0, 15), hasVideo: !!document.querySelector('video'), next: !!nextButton()
    };
  }

  return { isKodik, idsFromUrl, classify, parseBar, numOf, context, gotoEpisode, restoreTranslation, startPlayback, muteAll, diagnostics };
})();

importScripts('lib.js');

let chain = Promise.resolve();
const run = fn => { chain = chain.then(fn).catch(e => console.warn('SG', e)); return chain; };
const K = id => 'tab_' + id;
const rid = () => Math.random().toString(36).slice(2, 10);
const SEG = /\.(ts|m4s|aac|m4a|cmfv|cmfa|mts|m2ts)$/i;
const PL = /\.m3u8$/i;
const FILE = /\.(mp4|webm|m4v|mkv)$/i;

// ---------- settings: on/off switch + ignored sites ----------
let enabled = true, ignoreHosts = [], maxHistory = SG.DEFAULTS.maxHistory;
const hostOf = u => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const parseIgnore = txt => String(txt || '').split(/[\s,;]+/)
  .map(x => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*?\./, '')).filter(Boolean);
const ignored = d => [d.url, d.initiator, d.documentUrl].some(u => {
  const h = u && hostOf(u);
  return h && ignoreHosts.some(x => h === x || h.endsWith('.' + x));
});
const ready = chrome.storage.local.get(['enabled', 'settings']).then(o => {
  enabled = o.enabled !== false;
  ignoreHosts = parseIgnore({ ...SG.DEFAULTS, ...(o.settings || {}) }.ignore);
  maxHistory = { ...SG.DEFAULTS, ...(o.settings || {}) }.maxHistory;
}).catch(() => {});
ready.then(() => applyEnabled());
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.settings) {
    const cfg = { ...SG.DEFAULTS, ...(ch.settings.newValue || {}) };
    ignoreHosts = parseIgnore(cfg.ignore); maxHistory = cfg.maxHistory;
  }
  if (ch.enabled) { enabled = ch.enabled.newValue !== false; run(applyEnabled); }
});
chrome.commands.onCommand.addListener(c => {
  if (c === 'toggle-detection') chrome.storage.local.set({ enabled: !enabled });
});

async function load(tabId) {
  const o = await chrome.storage.session.get(K(tabId));
  return o[K(tabId)] || { streams: [] };
}
async function countVisible(tabId, st) {
  const hk = 'hide_' + tabId;
  const hidden = new Set((await chrome.storage.session.get(hk))[hk] || []);
  const cur = st.streams.filter(s => s.akey && s.ep && s.activeAt).sort((a, b) => b.activeAt - a.activeAt)[0];
  if (!cur) return 0;
  const key = SG.epsKey(cur.akey, cur.tkey), S = (await chrome.storage.local.get(key))[key];   // the same list the popup shows
  return S && S.eps ? Object.values(S.eps).filter(r => !hidden.has(r.skey)).length : 0;
}
async function setBadge(tabId, st) {
  try {
    if (!enabled) {
      await chrome.action.setBadgeText({ tabId, text: 'OFF' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#6b7280' });
      return;
    }
    const n = st ? await countVisible(tabId, st) : 0;   // same number as in the popup
    await chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#e11d48' });
    try { await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' }); } catch {}
  } catch {}
}
async function save(tabId, st) {
  try { await chrome.storage.session.set({ [K(tabId)]: st }); }
  catch {                                                   // quota: the raw detection layer may shrink, the episode registry (storage.local) never does
    st.streams = st.streams.filter(s => s.activeAt || s.t > Date.now() - 600000).slice(-150);
    try { await chrome.storage.session.set({ [K(tabId)]: st }); } catch (e) { console.warn('SG session', e); }
  }
  await setBadge(tabId, st);
}
async function applyEnabled() {
  try {
    await chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
    await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
    for (const t of await chrome.tabs.query({})) await setBadge(t.id, enabled ? await load(t.id) : null);
  } catch {}
}

// History lives while the tab stays on the same site; navigating to another site clears it
chrome.webRequest.onBeforeRequest.addListener(d => {
  if (d.tabId < 0) return;
  run(async () => {
    const st = await load(d.tabId);
    if (!st.streams.length) return;
    let o = ''; try { o = new URL(d.url).origin; } catch {}
    if (st.origin && o && st.origin !== o) {
      await chrome.storage.session.remove([K(d.tabId), 'hide_' + d.tabId]);
      await setBadge(d.tabId, { streams: [] });
    }
  });
}, { urls: ['<all_urls>'], types: ['main_frame'] });

const hv = (d, n) => ((d.responseHeaders || []).find(h => h.name.toLowerCase() === n) || {}).value || '';
function sizeOf(d) {
  const m = hv(d, 'content-range').match(/\/(\d+)$/);
  if (m) return +m[1];
  return d.statusCode === 200 ? (+hv(d, 'content-length') || 0) : 0;
}

chrome.webRequest.onHeadersReceived.addListener(d => {
  if (!enabled || d.tabId < 0 || d.statusCode >= 400) return;
  let path; try { path = new URL(d.url).pathname; } catch { return; }
  const ct = hv(d, 'content-type');
  if (PL.test(path) || /mpegurl/i.test(ct)) { run(() => addStream(d, 'm3u8', 'ts', 0)); return; }
  if (d.type === 'media' && (FILE.test(path) || /^video\//i.test(ct))) {
    const ext = ((path.match(FILE) || [])[1] || (/webm/i.test(ct) ? 'webm' : 'mp4')).toLowerCase();
    run(() => addStream(d, 'file', ext, sizeOf(d)));
    return;
  }
  if (SEG.test(path) || (/^(xmlhttprequest|other)$/.test(d.type) && FILE.test(path))) run(() => segment(d));
}, { urls: ['<all_urls>'] }, ['responseHeaders']);

function prune(st) {
  const MAX = Math.max(50, +maxHistory || 500);
  if (st.streams.length <= MAX) return;
  // The newest streams are NEVER dropped: they are the ones about to be played (dropping them lost new episodes).
  // Then unplayed old ones go first, then the oldest played ones — harmless, the episode registry keeps the truth.
  const fresh = new Set(st.streams.slice().sort((a, b) => b.t - a.t).slice(0, 8).map(s => s.id));
  const drop = new Set(st.streams.filter(s => !fresh.has(s.id))
    .sort((a, b) => ((a.activeAt ? 1 : 0) - (b.activeAt ? 1 : 0)) || a.t - b.t)
    .slice(0, st.streams.length - MAX).map(s => s.id));
  st.streams = st.streams.filter(s => !drop.has(s.id));
}

async function addStream(d, kind, ext, size) {
  await ready; if (!enabled || ignored(d)) return;
  const st = await load(d.tabId);
  if (!st.origin) { try { const t = await chrome.tabs.get(d.tabId); if (t.url) st.origin = new URL(t.url).origin; } catch {} }
  const old = st.streams.find(s => s.url === d.url);
  if (old) {
    // the same stream requested again — it is "fresh" again
    if (Date.now() - old.t > 3000) {
      old.t = Date.now(); old.frameId = d.frameId;
      if (d.documentUrl) old.ref = d.documentUrl;
      await save(d.tabId, st);
    }
    return;
  }
  const s = { id: rid(), url: d.url, kind, ext, frameId: d.frameId, ref: d.documentUrl || d.initiator || '', t: Date.now(), size, activeAt: 0 };
  st.streams.push(s);
  prune(st);
  await save(d.tabId, st);
  if (kind === 'm3u8') parse(d.tabId, s);
}

async function parse(tabId, s) {
  let info = null;
  try { info = await chrome.tabs.sendMessage(tabId, { type: 'parse', url: s.url }, { frameId: s.frameId }); } catch {}
  if (!info || info.error) {
    try { info = await SG.parsePlaylist(s.url); } catch (e) { info = { role: 'unknown', perr: String(e.message || e) }; }
  }
  run(async () => {
    const st = await load(tabId);
    const t = st.streams.find(x => x.id === s.id);
    if (!t) return;
    Object.assign(t, info);
    link(st);
    if (t.akey && t.ep) await regSync(t);
    await save(tabId, st);
  });
}

// media playlists that belong to a master are hidden (only the master is listed)
function link(st) {
  const masters = st.streams.filter(s => s.role === 'master');
  for (const x of st.streams) {
    if (x.kind !== 'm3u8' || x.role === 'master' || x.parent) continue;
    const m = masters.find(m => m.frameId === x.frameId && m.variants && m.variants.some(v => v.url === x.url));
    if (m) { x.parent = m.id; if ((x.activeAt || 0) > (m.activeAt || 0)) m.activeAt = x.activeAt; }
  }
}

// A segment request means: this stream is playing right now
async function segment(d) {
  await ready; if (!enabled || ignored(d)) return;
  const st = await load(d.tabId);
  let best = 0, hit = [];
  for (const s of st.streams) {
    if (s.frameId !== d.frameId || s.kind !== 'm3u8' || !s.dirs) continue;
    for (const dir of s.dirs) {
      if (!d.url.startsWith(dir)) continue;
      if (dir.length > best) { best = dir.length; hit = [s]; }
      else if (dir.length === best && !hit.includes(s)) hit.push(s);
    }
  }
  if (!hit.length) return;
  const tops = [...new Set(hit.map(s => s.parent || s.id))].map(id => st.streams.find(x => x.id === id)).filter(Boolean);
  if (!tops.length) return;
  const now = Date.now();
  if (tops.every(s => now - (s.activeAt || 0) < 5000)) return;   // refresh at most every 5 s per stream
  for (const s of tops) s.activeAt = now;
  await save(d.tabId, st);
}

// ---------- the episode registry: ONE record per (series, voice-over, episode number) ----------
// Episode number priority: 1) the player  2) the page / episode list  3) own counter (previous + 1).
// Resolved once per stream and stored, so reloads, tab changes and the 500-stream history limit can never shift or lose it.
const tkeyOf = tr => tr ? (tr.id || SG.normName(tr.name)) : '';

function recOf(c, old) {
  const m = c.meta || {}, pg = m.page || {};
  return {
    ep: c.ep, src: c.epSrc, skey: c.skey, url: c.url, kind: c.kind, ext: c.ext, ref: c.ref, frameId: c.frameId, role: c.role,
    variants: (c.variants || []).slice(0, 8), sepAudio: !!c.sepAudio, unsup: c.unsup || '', segCount: c.segCount || 0,
    duration: c.duration || m.duration || 0, w: m.w || 0, h: m.h || 0, fp: c.fp || '', name: c.name, dub: c.dub, dubId: c.dubId,
    akey: c.akey, tkey: c.tkey, pageUrl: pg.url || '', image: pg.image || '', t: Date.now(), thumb: (old && old.thumb) || ''
  };
}

async function assignEpisode(c) {
  const m = c.meta || {}, pg = m.page || {}, kd = m.kodik || null;
  const title = pg.h1 || pg.og || pg.title || m.title || '';
  const akey = SG.animeKey(pg.url, kd, title);
  const tr = kd && kd.translation ? kd.translation : null, tkey = tkeyOf(tr);
  const key = SG.epsKey(akey, tkey), sk = SG.streamKey(c, kd);
  const S = await SG.getEps(key);
  if (!S.name) S.name = SG.cleanTitle(title) || SG.UNTITLED;           // the first name wins: the folder name stays stable
  S.akey = akey; S.tkey = tkey; S.dub = tr ? { id: tr.id, name: tr.name } : null; S.t = Date.now();
  Object.assign(c, { akey, tkey, skey: sk, name: S.name, dub: tr ? tr.name : '', dubId: tr ? tr.id : '' });
  const known = S.map[sk];
  if (known && (known.src === 'user' || known.src === 'player' || !(kd && kd.ep))) { c.ep = known.ep; c.epSrc = known.src; }
  else {
    let ep = 0, src = '';
    if (kd && kd.ep) { ep = kd.ep; src = 'player'; }
    else {
      const g = SG.guessEpInfo([...(pg.hints || []), ...(m.hints || [])]);   // page / list of episodes (URLs are not used: they only caused trouble)
      if (g.ep && !Object.entries(S.map).some(([k, v]) => k !== sk && v.ep === +g.ep)) { ep = +g.ep; src = 'page'; }
    }
    if (!ep) { ep = (S.last || 0) + 1; src = 'seq'; }                      // fallback: +1 after the previous episode of this series
    S.map[sk] = { ep, src, t: Date.now() };
    S.last = ep;
    c.ep = ep; c.epSrc = src;
  }
  S.eps[c.ep] = recOf(c, S.eps[c.ep]);                                    // newest wins: the same episode re-opened = ONE record, never two
  await chrome.storage.local.set({ [key]: S });
}

async function regSync(c) {
  const key = SG.epsKey(c.akey, c.tkey), S = await SG.getEps(key), rec = S.eps[c.ep];
  if (!rec || rec.skey !== c.skey) return;                                // the record already belongs to another stream
  S.eps[c.ep] = recOf(c, rec);
  await chrome.storage.local.set({ [key]: S });
}

// ---------- "collect all episodes" (Kodik): the real player is flipped through the episodes of the selected voice-over ----------
function advance(sc) {
  sc.idx++;
  while (sc.idx < sc.targets.length && sc.got[sc.targets[sc.idx]]) sc.idx++;
  sc.targetAt = Date.now();
  if (sc.idx >= sc.targets.length) sc.status = 'finishing';
}

async function scanStart(msg) {
  const st = await load(msg.tabId), k = st.kodik;
  if (!k || !k.ctx) return { ok: false, reason: 'noCtx' };
  const ctx = k.ctx;
  if (!ctx.translation || !(ctx.translation.id || ctx.translation.name)) return { ok: false, reason: 'noDub' };   // never guess the voice-over
  const all = [...new Set(ctx.episodes || [])].sort((a, b) => a - b);                                            // numeric, first episode first
  if (!all.length) return { ok: false, reason: 'noEpisodes' };
  const from = +msg.from || all[0], to = +msg.to || all[all.length - 1];
  const targets = all.filter(n => n >= from && n <= to);
  if (!targets.length) return { ok: false, reason: 'empty' };
  let akey = '';
  try { akey = SG.animeKey((await chrome.tabs.get(msg.tabId)).url, ctx, ''); } catch {}
  const tkey = tkeyOf(ctx.translation), S = await SG.getEps(SG.epsKey(akey, tkey)), got = {};
  const fresh = Date.now() - 90 * 60 * 1000;                              // links older than 90 min may have expired: such episodes are collected again
  for (const ep of targets) { const r = S.eps[ep]; if (r && r.t > fresh && r.skey) got[ep] = 1; }
  const sc = {
    id: rid(), frameId: k.frameId, akey, tkey, trans: { id: ctx.translation.id, name: ctx.translation.name }, season: ctx.season,
    targets, idx: 0, got, fails: {}, status: 'running', auto: !!msg.auto, startedAt: Date.now(), targetAt: Date.now(), result: null
  };
  while (sc.idx < targets.length && got[targets[sc.idx]]) sc.idx++;        // first target that is not collected yet
  if (sc.idx >= targets.length) sc.status = 'finishing';
  st.scan = sc;
  await save(msg.tabId, st);
  if (sc.status === 'finishing') setTimeout(() => finishScan(msg.tabId), 0);
  return { ok: true };
}

async function scanPoll(sender) {
  const tabId = sender.tab.id, st = await load(tabId), sc = st.scan;
  if (!sc || sc.status !== 'running' || sender.frameId !== sc.frameId) return { active: false };
  if (Date.now() - sc.targetAt > 30000) {                                  // this episode never started: report and go on
    sc.fails[sc.targets[sc.idx]] = sc.fails[sc.targets[sc.idx]] || 'timeout';
    advance(sc); await save(tabId, st);
    if (sc.status === 'finishing') { setTimeout(() => finishScan(tabId), 0); return { active: false }; }
  }
  return { active: true, target: sc.targets[sc.idx], trans: sc.trans };
}

async function bestVariant(tabId, s) {
  if (s.kind !== 'm3u8' || (s.variants && s.variants.length)) return { url: '', label: '' };   // a master playlist: the queue picks the best itself
  try {
    const res = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'siblings', url: s.url, segCount: s.segCount || 0 }, { frameId: s.frameId }),
      new Promise(r => setTimeout(() => r(null), 8000))]);
    if (res && res.length > 1) return { url: res[0].url, label: res[0].h + 'p' };
  } catch {}
  return { url: '', label: '' };
}

async function finishScan(tabId) {
  let sc = null;
  await run(async () => {
    const st = await load(tabId);
    if (!st.scan || st.scan.status !== 'finishing') return;
    st.scan.status = 'finalizing'; sc = st.scan;
    await save(tabId, st);
  });
  if (!sc) return;
  const S = await SG.getEps(SG.epsKey(sc.akey, sc.tkey));                  // THE list of episodes (same one the popup shows)
  const have = sc.targets.filter(ep => S.eps[ep] && S.eps[ep].skey);
  const missing = sc.targets.filter(ep => !have.includes(ep) && !sc.fails[ep]);
  let queued = 0; const skipped = [];
  if (sc.auto) {
    const all = await chrome.storage.local.get(null);
    const live = Object.entries(all).filter(([k, v]) => k.startsWith('job:') && ['queued', 'running', 'done'].includes(v.status)).map(([, v]) => v);
    const fresh = have.map(ep => ({ ep, rec: S.eps[ep] })).filter(({ ep, rec }) => {   // no duplicates: series + voice-over + episode is queued once
      const dup = live.some(j => (j.akey && j.akey === sc.akey && (j.tkey || '') === (sc.tkey || '') && String(j.ep) === String(ep))
        || (!j.akey && j.anime === rec.name && String(j.ep) === String(ep) && (j.translation || '') === (rec.dub || '')));
      if (dup) skipped.push(ep);
      return !dup;
    });
    const q = new Array(fresh.length); let next = 0;
    await Promise.all([0, 1, 2, 3].map(async () => { while (next < fresh.length) { const i = next++; q[i] = await bestVariant(tabId, fresh[i].rec); } }));
    const upd = {};
    fresh.forEach(({ ep, rec }, i) => {                                    // ascending by episode number: the first episode is first
      const id = rid() + rid();
      upd['job:' + id] = {
        id, created: Date.now() + i, status: 'queued', url: rec.url, kind: rec.kind, ext: rec.ext, ref: rec.ref, variantUrl: q[i].url,
        anime: rec.name || SG.UNTITLED, ep: String(ep), translation: rec.dub || '', akey: sc.akey, tkey: sc.tkey, thumb: rec.thumb || '',
        duration: rec.duration || 0, quality: q[i].label
      };
    });
    if (Object.keys(upd).length) await chrome.storage.local.set(upd);
    queued = Object.keys(upd).length;
  }
  await run(async () => {
    const st = await load(tabId);
    if (st.scan && st.scan.id === sc.id) {
      st.scan.status = 'done';
      st.scan.result = { queued, skipped, missing, firstOk: have.includes(sc.targets[0]), first: sc.targets[0] };
      await save(tabId, st);
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  // commands from the popup
  if (msg.type === 'scanStart') { run(async () => respond(await scanStart(msg))); return true; }
  if (msg.type === 'scanStop') {
    run(async () => {
      const st = await load(msg.tabId);
      if (st.scan && st.scan.status === 'running') { st.scan.status = 'stopped'; await save(msg.tabId, st); }
      respond({ ok: true });
    });
    return true;
  }
  if (!sender.tab || !enabled) return;
  const tabId = sender.tab.id, frameId = sender.frameId;
  if (msg.type === 'scanPoll') { run(async () => respond(await scanPoll(sender))); return true; }
  if (msg.type === 'scanFail') {
    run(async () => {
      const st = await load(tabId), sc = st.scan;
      if (!sc || sc.status !== 'running' || frameId !== sc.frameId || sc.targets[sc.idx] !== msg.ep) return;
      sc.fails[msg.ep] = msg.reason; advance(sc); await save(tabId, st);
      if (sc.status === 'finishing') setTimeout(() => finishScan(tabId), 0);
    });
  } else if (msg.type === 'kodik') {
    run(async () => {
      const st = await load(tabId);
      st.kodik = { frameId, ctx: msg.ctx, at: Date.now() };
      if (st.scan && st.scan.status === 'running' && SG.sameTrans(msg.ctx.translation, st.scan.trans)) st.scan.frameId = frameId;   // the player frame was recreated
      await save(tabId, st);
    });
  } else if (msg.type === 'playing') {
    run(async () => {
      await ready; if (!enabled) return;
      const st = await load(tabId);
      // The video that just started = the stream whose playlist was requested most recently in this frame —
      // but never a stream that already belongs to another episode (a prefetch / replay must not steal the number).
      const kdEp = msg.kodik && msg.kodik.ep;
      const c = st.streams.filter(s => s.frameId === frameId && !s.parent).sort((a, b) => b.t - a.t)
        .find(s => !(s.ep && kdEp) || s.ep === kdEp);
      if (!c) return;
      const now = Date.now();
      if (!c.activeAt) c.activeAt = now;
      else { const cur0 = SG.currentOf(st, frameId); if (cur0 && c !== cur0 && c.t > cur0.activeAt) c.activeAt = now; }
      (st.playId ||= {})[frameId] = c.id;       // the thumbnail that arrives a moment later belongs to this stream
      let top = null;
      try { top = await chrome.tabs.sendMessage(tabId, { type: 'frameInfo' }, { frameId: 0 }); } catch {}
      const trim = a => (a || []).slice(0, 12).map(x => String(x).slice(0, 80));
      c.meta = {
        duration: msg.duration, w: msg.w, h: msg.h, hints: trim(msg.hints), title: msg.title, kodik: msg.kodik || null,
        page: top ? { url: top.url, h1: top.h1, og: top.og, title: top.title, image: top.image, hints: trim(top.hints) } : ((c.meta && c.meta.page) || null)
      };
      await assignEpisode(c);
      const sc = st.scan;                      // part of a running "collect all episodes"?
      if (sc && sc.status === 'running' && frameId === sc.frameId && c.ep === sc.targets[sc.idx]) {
        if (SG.sameTrans({ id: c.dubId, name: c.dub }, sc.trans)) sc.got[c.ep] = 1;
        else sc.fails[c.ep] = 'dub:' + (c.dub || '?');   // reported, never replaced by another voice-over
        advance(sc);
        if (sc.status === 'finishing') setTimeout(() => finishScan(tabId), 0);
      }
      await save(tabId, st);
    });
  } else if (msg.type === 'thumb') {
    run(async () => {                          // thumbnails live in the registry (not in the size-limited session storage)
      await ready; if (!enabled) return;
      const st = await load(tabId);
      const id = st.playId && st.playId[frameId], c = id && st.streams.find(s => s.id === id);
      if (!c || !c.akey || !c.ep) return;
      const key = SG.epsKey(c.akey, c.tkey), S = await SG.getEps(key), rec = S.eps[c.ep];
      if (rec && rec.skey === c.skey && (!rec.thumb || !msg.dark)) { rec.thumb = msg.thumb; await chrome.storage.local.set({ [key]: S }); }   // a dark frame never replaces a good one
    });
  }
});

chrome.tabs.onRemoved.addListener(id => chrome.storage.session.remove([K(id), 'hide_' + id]));

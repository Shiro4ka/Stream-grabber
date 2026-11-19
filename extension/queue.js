const T = I18N.t;
const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jobs = new Map();   // id -> job (persisted in chrome.storage.local as "job:<id>")
const mem = new Map();    // id -> progress (memory only)
let root = null, busy = false, waiting = false, cur = null, S = { ...SG.DEFAULTS };

// ---------- folder ----------
async function renderRoot() {
  $('rootname').textContent = root ? root.name : T('notSelected');
  const ok = await FS.perm(root, false);
  $('grant').hidden = !root || ok;
  const queued = [...jobs.values()].some(j => j.status === 'queued');
  if (!root) $('note').textContent = T('noteNoRoot');
  else if (!ok && queued) $('note').textContent = T('noteNeedPerm');
  else $('note').textContent = '';
  document.title = (!root || (!ok && queued)) ? T('titleAction') : T('titleQueue');
}

$('pick').onclick = async () => {
  try {
    root = await FS.pick();
    if (S.bat) await FS.ensureBat(root);
    await renderRoot(); pump();
  } catch {}
};
$('grant').onclick = async () => { if (await FS.perm(root, true)) { if (S.bat) await FS.ensureBat(root); await renderRoot(); pump(); } };
$('settings').onclick = () => chrome.runtime.openOptionsPage();
$('cancelAll').onclick = () => { for (const j of [...jobs.values()]) if (j.status === 'queued' || j.status === 'running') cancel(j); };
$('clearDone').onclick = async () => {
  for (const j of [...jobs.values()]) if (j.status === 'done' || j.status === 'canceled') { jobs.delete(j.id); await chrome.storage.local.remove('job:' + j.id); }
  render();
};

// ---------- jobs ----------
const epN = e => { const n = SG.epNum(e); return isNaN(n) ? 1e9 : n; };
// order: by series (first added first), inside — by episode number; downloads run in the same order
function ordered() {
  const arr = [...jobs.values()], first = {};
  for (const j of arr) first[j.anime] = Math.min(first[j.anime] ?? Infinity, j.created);
  return arr.sort((a, b) => (first[a.anime] - first[b.anime]) || a.anime.localeCompare(b.anime) || (epN(a.ep) - epN(b.ep)) || a.created - b.created);
}
const saveJob = j => chrome.storage.local.set({ ['job:' + j.id]: j });

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.settings) {
    const old = S.lang;
    S = { ...SG.DEFAULTS, ...(ch.settings.newValue || {}) };
    if (S.lang !== old) { location.reload(); return; }
    render();
  }
  let changed = false;
  for (const [k, c] of Object.entries(ch)) {
    if (!k.startsWith('job:')) continue;
    if (!c.newValue) { if (jobs.delete(k.slice(4))) changed = true; }
    else if (!jobs.has(c.newValue.id)) { jobs.set(c.newValue.id, c.newValue); changed = true; }
  }
  if (changed) { render(); pump(); }
});

window.addEventListener('beforeunload', e => { if (cur) { e.preventDefault(); e.returnValue = ''; } });

(async () => {
  await I18N.init();
  S = await SG.getSettings();
  root = await FS.getRoot();
  const all = await chrome.storage.local.get(null);
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith('job:')) continue;
    if (v.status === 'running') { v.status = 'error'; v.error = T('errInterrupted'); saveJob(v); }
    jobs.set(v.id, v);
  }
  await renderRoot(); render(); pump();
})();

const queuedExists = () => [...jobs.values()].some(j => j.status === 'queued');

async function pump() {
  if (busy) return;
  busy = true;
  try {
    for (;;) {
      const next = ordered().find(j => j.status === 'queued');
      if (!next) break;
      if (!(await FS.perm(root, false))) { waiting = true; break; }
      waiting = false;
      cur = next; next.status = 'running'; delete next.error;
      await saveJob(next); render();
      try { await runJob(next); next.status = 'done'; }
      catch (e) {
        const m = mem.get(next.id);
        if ((m && m.canceled) || (e && e.name === 'AbortError')) next.status = 'canceled';
        else { next.status = 'error'; next.error = (e && e.message) || String(e); }
      }
      mem.delete(next.id); cur = null;
      await saveJob(next); render();
    }
  } finally {
    busy = false; cur = null;
    renderRoot();
    if (!waiting && queuedExists()) setTimeout(pump, 0);
  }
}

// Referer / Origin of requests made by this page = the player page
async function setReferer(ref) {
  let origin; try { origin = new URL(ref).origin; } catch { origin = ''; }
  const rules = !origin ? [] : [{
    id: 1, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [
      { header: 'referer', operation: 'set', value: ref },
      { header: 'origin', operation: 'set', value: origin }] },
    condition: { initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] }
  }];
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1], addRules: rules });
}

async function fetchBuf(u, sig) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(u, { signal: sig });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.arrayBuffer();
    } catch (e) {
      if (e.name === 'AbortError' || i >= S.retries) throw e;
      await sleep(800 * (i + 1));
    }
  }
}
async function getText(u, sig) {
  const r = await fetch(u, { signal: sig });
  if (!r.ok) throw new Error(`HTTP ${r.status} (${u})`);
  return r.text();
}
async function exists(dir, name) { try { await dir.getFileHandle(name); return true; } catch { return false; } }

async function runJob(job) {
  const c = new AbortController();
  const m = { done: 0, total: 1, bytes: 0, t0: Date.now(), ctrl: c, canceled: false };
  mem.set(job.id, m);
  await setReferer(job.ref);
  const sig = c.signal;
  let segs = [], map = null, ext = job.ext || 'mp4';

  if (job.kind === 'm3u8') {
    let url = job.variantUrl || job.url, txt = await getText(url, sig);
    if (txt.includes('#EXT-X-STREAM-INF')) {       // no quality chosen — take the best one (HEVC wins ties)
      const v = SG.parseMaster(txt, url);
      if (!v.length) throw new Error(T('errEmptyMaster'));
      url = v[0].url; txt = await getText(url, sig);
      job.quality = (v[0].h ? v[0].h + 'p' : (v[0].res || '')) + (v[0].hevc ? ' · HEVC' : '') + ' (' + T('auto') + ')';
    }
    const p = SG.parseMedia(txt, url);
    if (p.unsupported) throw new Error(T('errUnsup', p.unsupported));
    if (!p.segs.length) throw new Error(T('errNoSegs'));
    segs = p.segs; map = p.map; ext = map ? 'mp4' : 'ts'; m.total = segs.length;
  }

  // series folder + file name from the template
  const folder = SG.safeName(job.anime) || SG.UNTITLED;
  const dir = S.subfolder ? await root.getDirectoryHandle(folder, { create: true }) : root;
  const q = (String(job.quality || '').match(/(\d{3,4})p/) || [])[1];
  const base = SG.fileName(S.template, { anime: folder, ep: job.ep, quality: q ? q + 'p' : '', dub: job.translation || '' });
  let name = `${base}.${ext}`, n = 2;
  const taken = async nm => (await exists(dir, nm)) || (ext === 'ts' && await exists(dir, nm.replace(/\.ts$/, '.mp4')));
  while (await taken(name)) name = `${base} (${n++}).${ext}`;

  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  try {
    if (job.kind === 'm3u8') await dlHls(job, segs, map, w, sig, m);
    else await dlFile(job, w, sig, m);
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch {}
    try { await dir.removeEntry(name); } catch {}
    throw e;
  }
  job.savedAs = `${root.name}/${S.subfolder ? folder + '/' : ''}${name}`;
}

async function dlHls(job, segs, map, w, sig, m) {
  const keys = {};
  const getKey = k => keys[k.uri] ||= fetchBuf(k.uri, sig).then(raw => crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']));
  const load = async s => {
    let b = await fetchBuf(s.url, sig);
    if (s.key) b = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: SG.ivBytes(s.key, s.seq) }, await getKey(s.key), b);
    return b;
  };
  if (map) await w.write(await fetchBuf(map, sig));
  const K = Math.max(1, Math.min(32, +S.concurrency || 8)), n = segs.length, pend = new Array(n);
  const start = j => { const p = load(segs[j]); p.catch(() => {}); pend[j] = p; };
  for (let j = 0; j < Math.min(K, n); j++) start(j);
  for (let i = 0; i < n; i++) {
    if (m.canceled) throw new DOMException('canceled', 'AbortError');
    const buf = await pend[i]; pend[i] = null;
    if (i + K < n) start(i + K);
    await w.write(buf);
    m.done = i + 1; m.bytes += buf.byteLength; tick(job);
  }
}

async function dlFile(job, w, sig, m) {
  const r = await fetch(job.url, { signal: sig });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const total = +r.headers.get('content-length') || 0;
  m.total = total || 1; m.done = 0;
  const rd = r.body.getReader();
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    await w.write(value);
    m.done += value.byteLength; m.bytes = m.done; tick(job);
  }
  if (!total) m.total = m.done || 1;
}

// ---------- UI ----------
let lastTick = 0;
function tick(job) { const now = performance.now(); if (now - lastTick < 250) return; lastTick = now; paint(job); }
function paint(job) {
  const m = mem.get(job.id); if (!m) return;
  const bar = document.getElementById('bar-' + job.id), st = document.getElementById('st-' + job.id);
  if (bar) { bar.max = m.total || 1; bar.value = m.done; }
  const tl = document.getElementById('tl-' + job.id);
  if (tl) tl.style.setProperty('--p', (m.total ? m.done / m.total * 100 : 0) + '%');
  if (st) st.textContent = statusText(job);
  renderSummary();
}

function renderSummary() {
  const arr = [...jobs.values()], c = x => arr.filter(j => j.status === x).length, run = arr.find(j => j.status === 'running');
  $('sum').textContent = arr.length
    ? T('sumLine', c('queued'), c('done'), c('error')) + (run ? ' · ' + T('sumNow', run.ep || '?', statusText(run)) : '') : '';
}

function statusText(j) {
  const m = mem.get(j.id);
  switch (j.status) {
    case 'queued': return T('stQueued');
    case 'running': {
      if (!m || !m.total) return T('stStarting');
      const pct = Math.floor(m.done / m.total * 100), sec = Math.max((Date.now() - m.t0) / 1000, 1);
      const rem = m.done ? (m.total - m.done) * (sec / m.done) : 0;
      return T('stDownloading', pct) + (m.bytes ? T('speed', (m.bytes / sec / 1048576).toFixed(1)) : '') + (rem ? T('eta', SG.fmtDur(rem)) : '');
    }
    case 'done': return T('stDone', j.savedAs);
    case 'error': return T('stError', j.error);
    case 'canceled': return T('stCanceled');
  }
  return '';
}

function cancel(j) {
  const m = mem.get(j.id);
  if (j.status === 'running' && m) { m.canceled = true; m.ctrl.abort(); }
  else if (j.status === 'queued') { j.status = 'canceled'; saveJob(j); render(); }
}

const ICON = { queued: '⏳', running: '⬇️', done: '✓', error: '⚠️', canceled: '—' };
let selected = null;

function tile(j) {
  const t = el('div', {
    className: 'tile ' + j.status + (j.id === selected ? ' sel' : ''), id: 'tl-' + j.id,
    title: `${j.anime} — ${T('episodeWord')} ${j.ep || '?'}${j.translation ? ' [' + j.translation + ']' : ''}\n${statusText(j)}`,
    onclick: () => { selected = j.id; render(); }
  });
  if (j.thumb) t.append(el('img', { src: j.thumb }));
  t.append(el('span', { className: 'num', textContent: j.ep || '•' }), el('span', { className: 'ico', textContent: ICON[j.status] || '' }), el('div', { className: 'bar' }));
  const m = mem.get(j.id);
  if (m && m.total) t.style.setProperty('--p', (m.done / m.total * 100) + '%');
  if (j.status === 'done') t.style.setProperty('--p', '0%');
  return t;
}

function detail(j) {
  const img = el('img', { className: 'th' }); if (j.thumb) img.src = j.thumb;
  const ttl = el('div', { className: 't' }, j.anime + ' — ' + T('episodeWord') + ' ');
  if (['queued', 'error', 'canceled'].includes(j.status)) {
    const inp = el('input', { className: 'epedit', value: j.ep || '', title: T('epEditTitle') });
    inp.onchange = () => { j.ep = inp.value.trim(); saveJob(j); render(); };
    ttl.append(inp);
  } else ttl.append(j.ep || '—');
  if (j.translation) ttl.append(el('span', { className: 'chip', textContent: j.translation }));
  const s = el('div', { className: 's' + (j.status === 'error' ? ' err' : j.status === 'done' ? ' ok' : ''), id: 'st-' + j.id, textContent: statusText(j) });
  const sub = [j.quality, j.duration ? SG.fmtDur(j.duration) : ''].filter(Boolean).join(' · ');
  const mid = el('div', { className: 'mid' }, ttl, el('div', { className: 's', textContent: sub }), s);
  if (j.status === 'running' || j.status === 'queued') {
    const m = mem.get(j.id);
    mid.append(el('progress', { id: 'bar-' + j.id, max: m ? m.total || 1 : 1, value: m ? m.done : 0 }));
  }
  const act = el('div', { className: 'act' });
  if (j.status === 'running' || j.status === 'queued') act.append(el('button', { className: 'sec', textContent: T('cancel'), onclick: () => cancel(j) }));
  if (j.status === 'error' || j.status === 'canceled') act.append(el('button', { textContent: T('retry'), onclick: () => { j.status = 'queued'; delete j.error; saveJob(j); render(); renderRoot(); pump(); } }));
  if (j.status !== 'running') act.append(el('button', { className: 'sec', textContent: T('remove'), onclick: async () => { jobs.delete(j.id); await chrome.storage.local.remove('job:' + j.id); render(); } }));
  return el('div', { className: 'detail' }, img, mid, act);
}

// Adaptive grid: at most S.perRow episodes per row, the number of rows follows from the count.
// The tile size comes from the available width and (when there are many rows) from the available height;
// it never exceeds the width, so nothing overflows horizontally.
function layoutGrids() {
  const perRow = Math.max(1, Math.min(200, +S.perRow || 12)), gap = 8, MIN = 44, MAX = 240;
  const availH = Math.max(260, window.innerHeight - 220);
  document.querySelectorAll('.grid').forEach(g => {
    const n = +g.dataset.n, W = g.parentElement.clientWidth;
    const fit = Math.max(1, Math.floor((W + gap) / (MIN + gap)));          // how many readable tiles fit in a row at all
    const used = Math.max(1, Math.min(perRow, fit)), rows = Math.ceil(n / used);
    const byW = (W - gap * (used - 1)) / used;
    const byH = (availH - gap * (rows - 1)) / rows * (16 / 9);
    const size = Math.min(byW, Math.max(MIN, Math.min(byH, MAX)));
    g.style.gridTemplateColumns = `repeat(${used}, ${size}px)`;
    g.style.setProperty('--tile', size + 'px');
  });
}
let layoutRaf = 0;
new ResizeObserver(() => { cancelAnimationFrame(layoutRaf); layoutRaf = requestAnimationFrame(layoutGrids); }).observe(document.body);

function render() {
  const list = $('list'); list.replaceChildren();
  renderSummary();
  const arr = ordered();
  if (!arr.length) { list.append(el('div', { className: 'empty', textContent: T('emptyQueue') })); return; }
  const groups = [];
  for (const j of arr) {
    let g = groups[groups.length - 1];
    if (!g || g.anime !== j.anime) { g = { anime: j.anime, jobs: [] }; groups.push(g); }
    g.jobs.push(j);
  }
  for (const g of groups) {
    const done = g.jobs.filter(j => j.status === 'done').length;
    const box = el('section', { className: 'grp' }, el('h2', {}, g.anime, el('small', { textContent: `${done} / ${g.jobs.length}` })));
    const grid = el('div', { className: 'grid' });
    grid.dataset.n = g.jobs.length;
    for (const j of g.jobs) grid.append(tile(j));
    box.append(grid);
    const cur = g.jobs.find(j => j.id === selected) || g.jobs.find(j => j.status === 'running');
    if (cur) box.append(detail(cur));
    list.append(box);
  }
  layoutGrids();
}

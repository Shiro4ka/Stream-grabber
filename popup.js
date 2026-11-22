const T = I18N.t;
const $list = document.getElementById('list'), $all = document.getElementById('found'), $dl = document.getElementById('dlall');
const $en = document.getElementById('en'), $off = document.getElementById('off'), $fmt = document.getElementById('fmt'), $check = document.getElementById('check');
const $kp = document.getElementById('kpanel'), $kinfo = document.getElementById('kinfo'), $kprog = document.getElementById('kprog'), $kfails = document.getElementById('kfails');
const $kfrom = document.getElementById('kfrom'), $kto = document.getElementById('kto'), $kauto = document.getElementById('kauto');
const $kscan = document.getElementById('kscan'), $kstop = document.getElementById('kstop');
const $dubbar = document.getElementById('dubbar'), $dubsel = document.getElementById('dubsel');
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms, fallback) => Promise.race([p, sleep(ms).then(() => fallback)]);
let tab, st, showAll = false, page = null, store = {}, rows = [], S = SG.DEFAULTS, hidden = new Set(), dubSel = null, kInit = '';
const userOff = new Set();           // episodes the user unticked: kept across re-renders
const sibCache = new Map();          // playlist URL -> other qualities found (kept while the popup is open)

async function ask(frameId, type, extra, ms = 7000) {
  const p = chrome.tabs.sendMessage(tab.id, { type, ...extra }, { frameId }).catch(() => null);
  return withTimeout(p, ms, null);
}
// at most 3 quality probes at the same time; a stuck one can never block the others
let running = 0; const waiting = [];
function limited(fn) {
  return new Promise(res => {
    const go = async () => {
      running++;
      try { res(await fn()); } catch { res(null); }
      finally { running--; if (waiting.length) waiting.shift()(); }
    };
    running < 3 ? go() : waiting.push(go);
  });
}

const jobList = () => Object.entries(store).filter(([k]) => k.startsWith('job:')).map(([, v]) => v);
const liveJob = j => ['queued', 'running', 'done'].includes(j.status);
const epOrInf = e => { const n = SG.epNum(e); return isNaN(n) ? 1e9 : n; };

// ---------- THE list of episodes = the registry (storage.local, one record per series + voice-over + episode number) ----------
const curStream = () => st.streams.filter(s => s.akey && s.ep && s.activeAt).sort((a, b) => b.activeAt - a.activeAt)[0] || null;

function pageStates() {                                   // every (series, voice-over) state that belongs to this page
  const base = SG.pageKey(tab.url), cur = curStream(), out = [];
  for (const [k, x] of Object.entries(store)) {
    if (!k.startsWith('eps:') || !x || !x.eps || !x.akey) continue;
    const byPage = base && x.akey.startsWith(base) && /^(#s\d+)?$/.test(x.akey.slice(base.length));
    if (byPage || (cur && x.akey === cur.akey)) out.push(x);
  }
  return out;
}
function recToStream(x, r) {
  const live = st.streams.find(s => s.url === r.url);      // the same stream in this tab: its frame is alive (for the quality search)
  return { ...r, id: 'r' + r.ep + ':' + x.tkey, akey: x.akey, tkey: x.tkey, activeAt: r.t, epSrc: r.src, name: r.name || x.name,
    frameId: live ? live.frameId : r.frameId, size: 0, meta: { w: r.w, h: r.h, duration: r.duration, page: { image: r.image, url: r.pageUrl, hints: [] } } };
}
function view() {
  const states = pageStates(), cur = curStream();
  const curState = (cur && states.find(x => x.akey === cur.akey && x.tkey === cur.tkey)) || states.slice().sort((a, b) => (b.t || 0) - (a.t || 0))[0] || null;
  const same = curState ? states.filter(x => x.akey === curState.akey) : [];
  const sel = dubSel === null ? (curState ? curState.tkey : '') : dubSel;
  const dubs = same.map(x => ({ tkey: x.tkey, name: (x.dub && x.dub.name) || '—', n: Object.keys(x.eps).length }));
  const list = [];
  for (const x of same) {
    if (sel !== '*' && x.tkey !== sel) continue;
    for (const r of Object.values(x.eps)) if (!hidden.has(r.skey)) list.push(recToStream(x, r));
  }
  const extra = SG.uniqueStreams(SG.visibleStreams(st, true)).filter(s => !s.activeAt && !hidden.has(s.url));   // found, never played
  return { list, extra: showAll ? extra : [], foundN: extra.length, dubs, sel, curState };
}

function updateBadge() {
  const n = view().list.length;
  chrome.action.setBadgeText({ tabId: tab.id, text: $en.checked ? (n ? String(n) : '') : 'OFF' });
}

let renderTimer = 0;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    const a = document.activeElement;
    if (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return scheduleRender();     // never re-draw under the user's cursor
    render(); renderPanel();
  }, 700);
}

(async () => {
  await I18N.init();
  S = await SG.getSettings();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const k = 'tab_' + tab.id, hk = 'hide_' + tab.id;
  const o = await chrome.storage.session.get([k, hk]);
  st = o[k] || { streams: [] };
  hidden = new Set(o[hk] || []);
  store = await chrome.storage.local.get(null);
  page = await ask(0, 'frameInfo', {}, 2000);
  $en.checked = store.enabled !== false; $off.hidden = $en.checked;
  $en.onchange = async () => { await chrome.storage.local.set({ enabled: $en.checked }); $off.hidden = $en.checked; };
  $fmt.value = S.format || 'mp4';
  $fmt.onchange = async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(settings || {}), format: $fmt.value } });
    S.format = $fmt.value;
  };
  $all.onclick = () => { showAll = !showAll; render(); };
  $dubsel.onchange = () => { dubSel = $dubsel.value; render(); };
  document.getElementById('queue').onclick = () => openQueue(true);
  document.getElementById('gear').onclick = () => chrome.runtime.openOptionsPage();
  document.getElementById('clear').onclick = async () => {          // clears the page's detection history and the hidden marks, NOT the downloaded queue
    await chrome.storage.session.remove([k, hk]);
    hidden = new Set(); st = { streams: [] }; userOff.clear();
    updateBadge(); render();
  };
  $dl.onclick = () => downloadAll(false);
  $kscan.onclick = scanStart;
  $kstop.onclick = async () => { await chrome.runtime.sendMessage({ type: 'scanStop', tabId: tab.id }); };
  document.getElementById('kdiag').onclick = async () => {
    const d = st.kodik ? await ask(st.kodik.frameId, 'kodikDiag', {}, 3000) : null;
    await navigator.clipboard.writeText(JSON.stringify(d || { error: 'no Kodik frame' }, null, 2));
    document.getElementById('kdiag').textContent = T('kDiagCopied');
  };
  // live: episodes appear in the list while they are being collected
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'session' && ch[k]) { st = ch[k].newValue || { streams: [] }; renderPanel(); }
    if (area === 'local') {
      let touched = false;
      for (const [key, c] of Object.entries(ch)) {
        if (!key.startsWith('eps:') && !key.startsWith('job:')) continue;
        if (c.newValue === undefined) delete store[key]; else store[key] = c.newValue;
        touched = true;
      }
      if (touched) scheduleRender();
    }
  });
  renderPanel();
  render();
})();

async function openQueue(focus) {
  const url = chrome.runtime.getURL('queue.html');
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    if (focus) { await chrome.tabs.update(tabs[0].id, { active: true }); await chrome.windows.update(tabs[0].windowId, { focused: true }); }
  } else await chrome.tabs.create({ url, active: focus });
}

// ---------- Kodik: collect every episode of the selected voice-over ----------
const failText = r => r === 'timeout' ? T('kFailTimeout') : r === 'noEpisode' ? T('kFailNoEp') : r === 'noControl' ? T('kFailNoCtl')
  : String(r).startsWith('dub:') ? T('kFailDub', String(r).slice(4)) : String(r);
const fmtList = a => a.slice(0, 15).join(', ') + (a.length > 15 ? '…' : '');

function renderPanel() {
  const k = st.kodik, sc = st.scan;
  $kp.hidden = !(k && k.ctx);
  if ($kp.hidden) return;
  const ctx = k.ctx, eps = [...new Set(ctx.episodes || [])].sort((a, b) => a - b);
  const missing = [];
  if (eps.length) for (let n = eps[0]; n <= eps[eps.length - 1]; n++) if (!eps.includes(n)) missing.push(n);
  const dub = ctx.translation ? ctx.translation.name || ('#' + ctx.translation.id) : '?';
  const state = pageStates().find(x => SG.sameTrans(x.dub, ctx.translation));
  const uncollected = eps.filter(n => !(state && state.eps[n]));
  $kinfo.replaceChildren(el('b', { textContent: 'Kodik' }), ' · ' + (ctx.season ? T('kSeason', ctx.season) + ' · ' : '') + T('kDub') + ' ',
    el('b', { textContent: dub }), ' · ' + T('kEpisodes', eps.length) + (missing.length ? ' · ' + T('kMissing', fmtList(missing)) : '')
    + (uncollected.length && uncollected.length < eps.length ? ' · ' + T('kUncollected', fmtList(uncollected)) : ''));
  const sig = dub + '|' + ctx.season + '|' + eps.length;
  if (kInit !== sig && eps.length) { kInit = sig; $kfrom.value = eps[0]; $kto.value = eps[eps.length - 1]; }
  const running = sc && sc.status === 'running';
  $kscan.disabled = !!running || !eps.length; $kstop.hidden = !running;
  if (!sc) { $kprog.textContent = ''; $kfails.textContent = ''; return; }
  const got = Object.keys(sc.got).length, total = sc.targets.length;
  $kprog.textContent = sc.status === 'running' ? T('kScanning', got, total, sc.targets[sc.idx] || '')
    : sc.status === 'finishing' || sc.status === 'finalizing' ? T('kFinalizing')
    : sc.status === 'stopped' ? T('kStopped', got, total)
    : T('kDone', got, total, sc.result ? sc.result.queued : 0) + (sc.result && sc.result.skipped.length ? ' · ' + T('kSkipped', fmtList(sc.result.skipped)) : '');
  const fails = Object.entries(sc.fails || {}).map(([ep, r]) => `${ep}: ${failText(r)}`);
  if (sc.result && sc.result.firstOk === false) fails.unshift(T('kFirstMissing', sc.result.first));      // the first episode is never lost silently
  if (sc.result && sc.result.missing && sc.result.missing.length) fails.push(T('kNotCollected', fmtList(sc.result.missing)));
  $kfails.textContent = fails.join(' · ');
}

async function scanStart() {
  $kprog.textContent = '';
  const r = await chrome.runtime.sendMessage({ type: 'scanStart', tabId: tab.id, from: +$kfrom.value || 0, to: +$kto.value || 0, auto: $kauto.checked });
  if (!r || !r.ok) $kprog.textContent = T('kErr_' + ((r && r.reason) || 'noCtx'));
}

const qlabel = v => `${v.h ? v.h + 'p' : (v.res || '?')}${v.hevc ? ' · HEVC' : ''}${v.bw ? ` · ${(v.bw / 1e6).toFixed(1)} Mbit/s` : ''}`;

// per-row data
function prepare(s) {
  const m = s.meta || {}, pg = m.page || page;
  const prev = jobList().find(j => liveJob(j) && (j.url === s.url
    || (s.ep && j.akey && j.akey === s.akey && (j.tkey || '') === (s.tkey || '') && String(j.ep) === String(s.ep))
    || (s.ep && !j.akey && j.anime === s.name && String(j.ep) === String(s.ep) && (j.translation || '') === (s.dub || ''))));
  const anime = prev ? prev.anime : (s.name || SG.cleanTitle((pg && (pg.h1 || pg.og || pg.title)) || tab.title));
  const ep = prev ? String(prev.ep) : (s.ep ? String(s.ep) : '');
  return {
    s, m, pg, prev, anime, ep, src: prev ? '' : (s.epSrc || ''),
    duration: s.duration || m.duration || 0, segCount: s.segCount || 0, unsup: s.unsup || ''
  };
}

function render() {
  $list.replaceChildren(); rows = [];
  const v = view();
  const items = [...v.list, ...v.extra].map(prepare);
  // numeric order, never by text / time of arrival: the first episode is always first
  items.sort((a, b) => (epOrInf(a.ep) - epOrInf(b.ep)) || (a.s.dub || '').localeCompare(b.s.dub || ''));
  if (!items.length) $list.append(el('div', { className: 'hint', textContent: v.foundN ? T('hintPlay') : T('hintNone') }));

  $dubbar.hidden = !v.dubs.length;
  if (v.dubs.length) {
    $dubsel.replaceChildren(...v.dubs.map(d => el('option', { value: d.tkey, textContent: `${d.name} (${d.n})` })), el('option', { value: '*', textContent: T('dubAll') }));
    $dubsel.value = v.sel;
  }

  if (items.length) {
    const setAll = on => { rows.forEach(r => { if (!r.cb.disabled) { r.cb.checked = on; r.mark(); r.sync(); } }); updateDl(); };
    const bar = el('div', { className: 'selbar' }, el('a', { textContent: T('selAll'), onclick: () => setAll(true) }),
      el('a', { textContent: T('selNone'), onclick: () => setAll(false) }), el('span', { textContent: T('editHint') }));
    const grid = el('div', { className: 'grid' }); grid.dataset.n = items.length;
    const editor = el('div');
    const openEditor = i => { editor.replaceChildren(rows[i].el); rows.forEach((x, j) => x.tile.classList.toggle('cur', j === i)); rows[i].probe(); };
    items.forEach((it, i) => {
      const r = makeRow(it); rows.push(r);
      const tile = el('div', { className: 'tile', title: `${it.anime} — ${it.ep || '?'}${it.s.dub ? ' [' + it.s.dub + ']' : ''}` });
      if (r.thumb) tile.append(el('img', { src: r.thumb }));
      const ico = el('span', { className: 'ico' });
      tile.append(el('span', { className: 'num', textContent: it.ep || '•' }), ico,
        el('span', { className: 'ed', textContent: '✎', title: T('editRow'), onclick: e => { e.stopPropagation(); openEditor(i); } }));
      r.sync = () => {
        const done = r.cb.disabled || !!it.prev;
        tile.classList.toggle('on', r.cb.checked && !r.cb.disabled);
        tile.classList.toggle('q', done);
        ico.textContent = done ? '✓' : (it.unsup || r.short ? '⚠' : '');
      };
      r.sync();
      tile.onclick = () => { if (r.cb.disabled) return; r.cb.checked = !r.cb.checked; r.mark(); r.sync(); updateDl(); };
      r.tile = tile; grid.append(tile);
    });
    $list.append(bar, grid, editor);
    layoutGrid(grid);
  }
  $all.title = showAll ? T('showPlayed') : T('showAllFound', v.foundN);
  $all.classList.toggle('on', showAll);
  document.getElementById('foundn').textContent = v.foundN ? String(v.foundN) : '';
  updateDl();
}

// Adaptive grid: at most S.perRow tiles per row, rows follow from the count, tiles shrink to fit (never wider than the popup)
function layoutGrid(g) {
  const perRow = Math.max(1, Math.min(200, +S.perRow || 12)), gap = 4, MIN = 38, MAX = 160;
  const n = +g.dataset.n, W = $list.clientWidth || 600;
  const fit = Math.max(1, Math.floor((W + gap) / (MIN + gap)));
  const used = Math.max(1, Math.min(perRow, fit)), nrows = Math.ceil(n / used);
  const byW = (W - gap * (used - 1)) / used, byH = (300 - gap * (nrows - 1)) / nrows * (16 / 9);
  const size = Math.min(byW, Math.max(MIN, Math.min(byH, MAX)));
  g.style.gridTemplateColumns = `repeat(${used}, ${size}px)`;
  g.style.setProperty('--tile', size + 'px');
}

function updateDl() {
  const n = rows.filter(r => r.cb.checked && !r.cb.disabled).length;
  $dl.textContent = n ? T('downloadAllN', n) : T('downloadAll');
  $dl.disabled = !n;
}

// ---------- checks before a mass download: nothing is skipped silently ----------
function checkSelection(sel) {
  const k = st.kodik && st.kodik.ctx, v = view();
  const sameDub = k && k.translation && v.curState && SG.sameTrans(k.translation, v.curState.dub);
  const expected = sameDub && k.episodes && k.episodes.length ? k.episodes : null;
  const first = expected ? Math.min(...expected) : 0;
  const out = [];
  for (const i of SG.validateEpisodes(sel.map(r => r.epValue()), expected)) {
    if (i.code === 'first') out.push(T(v.list.some(s => +s.ep === first) ? 'chk_first' : 'chk_firstUncollected', ...i.args));
    else out.push(T('chk_' + i.code, ...i.args));
  }
  return { issues: out, info: expected && first > 1 ? T('chkNoFirstInDub', (k.translation.name || '?'), first) : '' };
}
function showCheck(res) {
  $check.replaceChildren(el('b', { textContent: T('chkTitle') }), el('ul', {}, ...res.issues.map(t => el('li', { textContent: t }))),
    ...(res.info ? [el('div', { textContent: res.info })] : []),
    el('div', { className: 'krow' }, el('button', { textContent: T('chkAnyway'), onclick: () => downloadAll(true) }),
      el('button', { className: 'sec', textContent: T('chkCancel'), onclick: () => { $check.hidden = true; } })));
  $check.hidden = false;
}

async function downloadAll(force) {
  const sel = rows.filter(r => r.cb.checked && !r.cb.disabled);
  if (!sel.length) return;
  if (!force) { const res = checkSelection(sel); if (res.issues.length) return showCheck(res); }
  $check.hidden = true;
  $dl.disabled = true; $dl.textContent = T('probing');
  await Promise.race([Promise.all(sel.map(r => r.probe())), sleep(25000)]);      // best quality for everything, but never longer than 25 s
  $dl.textContent = T('adding');
  let i = 0;
  for (const r of sel.slice().sort((a, b) => epOrInf(a.epValue()) - epOrInf(b.epValue()))) await r.enqueue(i++);   // ascending: the first episode is queued first
  rows.forEach(r => r.refresh());
  $dl.textContent = T('addedN', sel.length);
  const { rootSet } = await chrome.storage.local.get('rootSet');
  await openQueue(!rootSet);
}

// a number or a name edited by hand: the record moves to the new number (nothing is duplicated or lost)
async function rememberEp(s, newEp, name) {
  if (!s.akey) return;
  const key = SG.epsKey(s.akey, s.tkey), S0 = await SG.getEps(key), n = +newEp;
  let changed = false;
  if (name && name !== S0.name) { S0.name = name; for (const r of Object.values(S0.eps)) r.name = name; changed = true; }
  const rec = S0.eps[s.ep];
  if (n > 0 && rec && n !== +s.ep && !S0.eps[n]) {
    delete S0.eps[s.ep]; rec.ep = n; rec.src = 'user'; S0.eps[n] = rec;
    S0.map[rec.skey] = { ep: n, src: 'user', t: Date.now() }; S0.last = n; changed = true;
  }
  if (changed) { await chrome.storage.local.set({ [key]: S0 }); store[key] = S0; }
}

function makeRow(it) {
  const { s, m, pg, duration, segCount, unsup } = it;
  const short = duration && duration < S.shortSec;

  const thumb = s.thumb || (pg && pg.image) || '';
  const img = el('img', { className: 'th' }); if (thumb) img.src = thumb;
  const thbox = el('div', { className: 'thbox' }, img);
  if (duration) thbox.append(el('span', { className: 'dur', textContent: SG.fmtDur(duration) }));

  const nameInp = el('input', { type: 'text', className: 'anime', value: it.anime, placeholder: T('phAnime') });
  const epInp = el('input', { type: 'text', className: 'ep', value: it.ep, placeholder: '#' });
  const step = d => () => {
    const v = parseInt(epInp.value, 10);
    epInp.value = String(Math.max(0, (isNaN(v) ? 0 : v) + d));
    epInp.dispatchEvent(new Event('input'));
  };
  const epBox = el('div', { className: 'epbox' }, el('button', { textContent: '−', title: T('epMinus'), onclick: step(-1) }), epInp,
    el('button', { textContent: '+', title: T('epPlus'), onclick: step(1) }));

  const sel = el('select', { className: 'q' });
  const fill = list => { sel.replaceChildren(...list.map(o => el('option', { value: o.value, textContent: o.label }))); sel.selectedIndex = 0; };
  let sib = '', resolveReady; const ready = new Promise(r => resolveReady = r);
  let startProbe = null;
  if (s.kind === 'm3u8' && s.variants && s.variants.length) { fill(s.variants.map(v => ({ value: v.url, label: qlabel(v) }))); resolveReady(); }
  else if (s.kind === 'm3u8') {
    fill([{ value: '', label: m.h ? T('asPlayedH', m.h) : T('asPlayed') }]);
    const applySib = res => {
      sib = '';
      try {
        if (res && res.length > 1) {
          fill(res.map(x => ({ value: x.url, label: `${x.h}p${x.cur ? ' · ' + T('nowPlaying') : ''}` })));   // best first, and selected
          sib = T('foundQ', res.length);
        } else if (m.h && res) sib = T('noOtherQ', m.h);
      } catch (e) { console.warn(e); }
      sel.disabled = false; refresh(); resolveReady();
    };
    startProbe = () => {
      if (sibCache.has(s.url)) return applySib(sibCache.get(s.url));
      sib = T('searching'); sel.disabled = true; refresh();
      limited(() => ask(s.frameId, 'siblings', { url: s.url, segCount }, 8000)).then(res => { sibCache.set(s.url, res); applySib(res); });
    };
  } else { fill([{ value: '', label: (s.ext || 'mp4').toUpperCase() }]); resolveReady(); }

  const info = [s.kind === 'm3u8' ? 'HLS' : (s.ext || 'mp4').toUpperCase()];
  if (m.w && m.h) info.push(T('playingRes', m.w, m.h));
  const sub = el('div', { className: 'sub', textContent: info.join(' · ') });
  if (s.dub) sub.append(' · ', el('span', { className: 'chip', textContent: s.dub }));
  if (it.src) sub.append(el('span', { textContent: ' · ' + T('src_' + it.src) }));          // where the episode number came from
  if (s.sepAudio) sub.append(el('span', { className: 'warn', textContent: ' · ' + T('warnSepAudio') }));
  if (unsup) sub.append(el('span', { className: 'warn', textContent: ' · ' + T('warnUnsup', unsup) }));
  const note = el('div', { className: 'sub' });

  const key = s.skey || s.url;
  const cb = el('input', { type: 'checkbox', className: 'chk', checked: !unsup && !short && !it.prev && !userOff.has(key), disabled: !!unsup });
  const mark = () => { if (cb.checked) userOff.delete(key); else userOff.add(key); };
  cb.onchange = () => { mark(); updateDl(); api.sync(); };
  const btn = el('button', { textContent: T('download'), disabled: !!unsup });

  const dupInfo = () => {
    const nm = nameInp.value.trim(), e = epInp.value.trim();
    const live = jobList().filter(liveJob);
    if (live.some(j => (j.variantUrl || j.url) === (sel.value || s.url))) return T('dupSame');
    if (e && live.some(j => j.anime === nm && String(j.ep) === e && (j.translation || '') === (s.dub || ''))) return T('dupEp', e, nm);
    return '';
  };
  function refresh() {
    const w = dupInfo();
    note.className = 'sub' + (w || short ? ' warn' : '');
    note.textContent = w ? '⚠ ' + w : sib || (short ? T('shortWarn') : (it.src === 'seq' ? T('seqNote') : ''));
    if (!btn.disabled) btn.textContent = w ? T('again') : T('download');
  }
  nameInp.oninput = epInp.oninput = refresh;
  sel.onchange = refresh;

  async function enqueue(i = 0, wait = false) {
    if (wait) await Promise.race([probe(), sleep(9000)]);
    const job = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), created: Date.now() + i, status: 'queued',
      url: s.url, kind: s.kind, ext: s.ext, ref: s.ref, variantUrl: sel.value || '',
      anime: nameInp.value.trim() || SG.UNTITLED, ep: epInp.value.trim(), translation: s.dub || '', akey: s.akey || '', tkey: s.tkey || '',
      thumb, duration, quality: sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : ''
    };
    await rememberEp(s, job.ep, job.anime);
    const upd = { ['job:' + job.id]: job };
    await chrome.storage.local.set(upd);
    Object.assign(store, upd);
    btn.textContent = T('queuedBtn'); btn.disabled = true; cb.checked = false; cb.disabled = true;
    api.sync();
    return job;
  }
  btn.onclick = async () => {
    await enqueue(0, true); updateDl();
    const { rootSet } = await chrome.storage.local.get('rootSet');
    await openQueue(!rootSet);
  };
  const cp = el('button', { className: 'sec', textContent: 'URL', title: T('copyUrl'), onclick: () => navigator.clipboard.writeText(s.url) });
  const hide = el('button', { className: 'sec', textContent: '✕', title: T('hideRow'), onclick: async () => {
    hidden.add(key);
    await chrome.storage.session.set({ ['hide_' + tab.id]: [...hidden] });
    updateBadge(); render();
  } });

  let probed = false;
  function probe() { if (!probed) { probed = true; if (startProbe) startProbe(); } return ready; }   // quality search runs on demand, not for 64 rows at once

  refresh();
  const root = el('div', { className: 'row' }, cb, thbox,
    el('div', { className: 'meta' }, nameInp, el('div', { className: 'line' }, epBox, sel), sub, note),
    el('div', { className: 'side' }, btn, el('div', { className: 'line2' }, cp, hide)));
  const api = { el: root, cb, btn, enqueue, refresh, probe, thumb, short, mark, epValue: () => epInp.value, sync() {} };
  return api;
}

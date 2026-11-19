const T = I18N.t;
const $list = document.getElementById('list'), $all = document.getElementById('found'), $dl = document.getElementById('dlall');
const $en = document.getElementById('en'), $off = document.getElementById('off'), $dupnote = document.getElementById('dupnote');
const $kp = document.getElementById('kpanel'), $kinfo = document.getElementById('kinfo'), $kprog = document.getElementById('kprog'), $kfails = document.getElementById('kfails');
const $kfrom = document.getElementById('kfrom'), $kto = document.getElementById('kto'), $kauto = document.getElementById('kauto');
const $kscan = document.getElementById('kscan'), $kstop = document.getElementById('kstop');
const $dubbar = document.getElementById('dubbar'), $dubsel = document.getElementById('dubsel');
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms, fallback) => Promise.race([p, sleep(ms).then(() => fallback)]);
let tab, st, showAll = false, page = null, store = {}, rows = [], S = SG.DEFAULTS, hidden = new Set(), dubSel = null, kInit = '';
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
const baseList = all => SG.uniqueStreams(SG.visibleStreams(st, all)).filter(s => !hidden.has(s.url));

// what is shown: unique videos of ONE voice-over (the one selected in the player, unless another is chosen here)
function view() {
  const vis = SG.visibleStreams(st, showAll), uniq = SG.uniqueStreams(vis);
  let list = uniq.filter(s => !hidden.has(s.url));
  const dubs = [...new Set(list.map(s => s.dub).filter(Boolean))];
  const cur = dubSel === null ? SG.defaultDub(list) : (dubSel === '*' ? '' : dubSel);
  if (cur) list = list.filter(s => s.dub === cur);
  return { list, dubs, cur, hiddenDup: vis.length - uniq.length };
}

function updateBadge() {
  const n = view().list.length;
  chrome.action.setBadgeText({ tabId: tab.id, text: $en.checked ? (n ? String(n) : '') : 'OFF' });
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
  $all.onclick = () => { showAll = !showAll; render(); };
  $dubsel.onchange = () => { dubSel = $dubsel.value; render(); };
  document.getElementById('queue').onclick = () => openQueue(true);
  document.getElementById('gear').onclick = () => chrome.runtime.openOptionsPage();
  document.getElementById('clear').onclick = async () => {
    await chrome.storage.session.remove([k, hk]);
    hidden = new Set(); st = { streams: [] };
    updateBadge(); render();
  };
  $dl.onclick = downloadAll;
  $kscan.onclick = scanStart;
  $kstop.onclick = async () => { await chrome.runtime.sendMessage({ type: 'scanStop', tabId: tab.id }); };
  document.getElementById('kdiag').onclick = async () => {
    const d = st.kodik ? await ask(st.kodik.frameId, 'kodikDiag', {}, 3000) : null;
    await navigator.clipboard.writeText(JSON.stringify(d || { error: 'no Kodik frame' }, null, 2));
    document.getElementById('kdiag').textContent = T('kDiagCopied');
  };
  // live progress of "collect all episodes"; the rows are refreshed once when it finishes
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'session' || !ch[k]) return;
    const was = st.scan && st.scan.status;
    st = ch[k].newValue || { streams: [] };
    renderPanel();
    const now = st.scan && st.scan.status;
    if (was && was !== now && (now === 'done' || now === 'stopped')) { chrome.storage.local.get(null).then(v => { store = v; render(); }); }
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

function renderPanel() {
  const k = st.kodik, sc = st.scan;
  $kp.hidden = !(k && k.ctx);
  if ($kp.hidden) return;
  const ctx = k.ctx, eps = [...new Set(ctx.episodes || [])].sort((a, b) => a - b);
  const missing = [];
  if (eps.length) for (let n = eps[0]; n <= eps[eps.length - 1]; n++) if (!eps.includes(n)) missing.push(n);
  const dub = ctx.translation ? ctx.translation.name || ('#' + ctx.translation.id) : '?';
  $kinfo.replaceChildren(el('b', { textContent: 'Kodik' }), ' · ' + (ctx.season ? T('kSeason', ctx.season) + ' · ' : '') + T('kDub') + ' ',
    el('b', { textContent: dub }), ' · ' + T('kEpisodes', eps.length) + (missing.length ? ' · ' + T('kMissing', missing.slice(0, 15).join(', ') + (missing.length > 15 ? '…' : '')) : ''));
  const sig = dub + '|' + ctx.season + '|' + eps.length;
  if (kInit !== sig && eps.length) { kInit = sig; $kfrom.value = eps[0]; $kto.value = eps[eps.length - 1]; }
  const running = sc && sc.status === 'running';
  $kscan.disabled = !!running || !eps.length; $kstop.hidden = !running;
  if (!sc) { $kprog.textContent = ''; $kfails.textContent = ''; return; }
  const got = Object.keys(sc.got).length, total = sc.targets.length;
  $kprog.textContent = sc.status === 'running' ? T('kScanning', got, total, sc.targets[sc.idx] || '')
    : sc.status === 'finishing' || sc.status === 'finalizing' ? T('kFinalizing')
    : sc.status === 'stopped' ? T('kStopped', got, total)
    : T('kDone', got, total, sc.result ? sc.result.queued : 0) + (sc.result && sc.result.skipped.length ? ' · ' + T('kSkipped', sc.result.skipped.join(', ')) : '');
  const fails = Object.entries(sc.fails || {}).map(([ep, r]) => `${ep}: ${failText(r)}`);
  $kfails.textContent = fails.join(' · ');
}

async function scanStart() {
  $kprog.textContent = '';
  const r = await chrome.runtime.sendMessage({ type: 'scanStart', tabId: tab.id, from: +$kfrom.value || 0, to: +$kto.value || 0, auto: $kauto.checked });
  if (!r || !r.ok) $kprog.textContent = T('kErr_' + ((r && r.reason) || 'noCtx'));
}

const qlabel = v => `${v.h ? v.h + 'p' : (v.res || '?')}${v.hevc ? ' · HEVC' : ''}${v.bw ? ` · ${(v.bw / 1e6).toFixed(1)} Mbit/s` : ''}`;

// per-row data. The episode number was resolved once, when the video started (player > page > sequence) — it is only displayed here.
function prepare(s) {
  const m = s.meta || {}, pg = m.page || page;
  const kids = st.streams.filter(x => x.parent === s.id);
  const prev = jobList().find(j => j.url === s.url && liveJob(j));
  const anime = prev ? prev.anime : (s.name || SG.cleanTitle((pg && (pg.h1 || pg.og || pg.title)) || m.title || tab.title));
  const ep = prev ? String(prev.ep) : (s.ep ? String(s.ep) : SG.guessEp([...(pg ? pg.hints : []), ...(m.hints || [])]));
  return {
    s, m, pg, kids, prev, anime, ep, src: prev ? '' : (s.epSrc || (ep ? 'page' : '')),
    duration: s.duration || (kids.find(x => x.duration) || {}).duration || m.duration || 0,
    segCount: s.segCount || (kids.find(x => x.segCount) || {}).segCount || 0,
    unsup: s.unsup || (kids.find(x => x.unsup) || {}).unsup || ''
  };
}

function render() {
  $list.replaceChildren(); rows = [];
  const v = view(), total = baseList(true).length;
  const items = v.list.map(prepare);
  if (!items.length) $list.append(el('div', { className: 'hint', textContent: total ? T('hintPlay') : T('hintNone') }));

  // voice-over selector (only the chosen voice-over is listed / downloaded)
  $dubbar.hidden = !v.dubs.length;
  if (v.dubs.length) {
    $dubsel.replaceChildren(...v.dubs.map(d => el('option', { value: d, textContent: d })), el('option', { value: '*', textContent: T('dubAll') }));
    $dubsel.value = v.cur || '*';
  }

  // first episode on top, later ones below
  const first = {};
  for (const it of items) first[it.anime] = Math.min(first[it.anime] ?? Infinity, it.s.activeAt || it.s.t);
  items.sort((a, b) => (first[a.anime] - first[b.anime]) || a.anime.localeCompare(b.anime)
    || (epOrInf(a.ep) - epOrInf(b.ep)) || ((a.s.activeAt || 0) - (b.s.activeAt || 0)));

  for (const it of items) { const r = makeRow(it); rows.push(r); $list.append(r.el); }
  $dupnote.hidden = !v.hiddenDup;
  $dupnote.textContent = T('dupHidden', v.hiddenDup);
  $all.title = showAll ? T('showPlayed') : T('showAllFound', total);
  $all.classList.toggle('on', showAll);
  document.getElementById('foundn').textContent = total ? String(total) : '';
  updateDl();
}

function updateDl() {
  const n = rows.filter(r => r.cb.checked && !r.cb.disabled).length;
  $dl.textContent = n ? T('downloadAllN', n) : T('downloadAll');
  $dl.disabled = !n;
}

async function downloadAll() {
  const sel = rows.filter(r => r.cb.checked && !r.cb.disabled);
  if (!sel.length) return;
  $dl.disabled = true; $dl.textContent = T('adding');
  let i = 0;
  for (const r of sel) await r.enqueue(i++);
  rows.forEach(r => r.refresh());
  $dl.textContent = T('addedN', sel.length);
  const { rootSet } = await chrome.storage.local.get('rootSet');
  await openQueue(!rootSet);
}

// a number or a name edited by hand is remembered for this stream and for the series
async function rememberEp(s, ep, name) {
  if (!s.akey || !s.skey) return;
  const key = SG.epsKey(s.akey, s.tkey), S0 = await SG.getEps(key), n = +ep;
  let changed = false;
  if (name && name !== S0.name) { S0.name = name; changed = true; }
  if (n && (!S0.map[s.skey] || S0.map[s.skey].ep !== n)) { S0.map[s.skey] = { ep: n, src: 'user', t: Date.now() }; S0.last = n; changed = true; }
  if (changed) await chrome.storage.local.set({ [key]: S0 });
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
  } else { fill([{ value: '', label: s.ext.toUpperCase() }]); resolveReady(); }

  const info = [s.kind === 'm3u8' ? 'HLS' : s.ext.toUpperCase()];
  if (m.w && m.h) info.push(T('playingRes', m.w, m.h));
  if (s.size) info.push(T('mb', (s.size / 1048576).toFixed(0)));
  const sub = el('div', { className: 'sub', textContent: info.join(' · ') });
  if (s.dub) sub.append(' · ', el('span', { className: 'chip', textContent: s.dub }));
  if (it.src) sub.append(el('span', { textContent: ' · ' + T('src_' + it.src) }));          // where the episode number came from
  if (s.sepAudio) sub.append(el('span', { className: 'warn', textContent: ' · ' + T('warnSepAudio') }));
  if (unsup) sub.append(el('span', { className: 'warn', textContent: ' · ' + T('warnUnsup', unsup) }));
  const note = el('div', { className: 'sub' });

  const cb = el('input', { type: 'checkbox', className: 'chk', checked: !unsup && !short && !it.prev, disabled: !!unsup });
  cb.onchange = updateDl;
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

  async function enqueue(i = 0) {
    await Promise.race([ready, sleep(9000)]);
    const job = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), created: Date.now() + i, status: 'queued',
      url: s.url, kind: s.kind, ext: s.ext, ref: s.ref, variantUrl: sel.value || '',
      anime: nameInp.value.trim() || SG.UNTITLED, ep: epInp.value.trim(), translation: s.dub || '',
      thumb, duration, quality: sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : ''
    };
    await rememberEp(s, job.ep, job.anime);
    const upd = { ['job:' + job.id]: job };
    await chrome.storage.local.set(upd);
    Object.assign(store, upd);
    btn.textContent = T('queuedBtn'); btn.disabled = true; cb.checked = false; cb.disabled = true;
    return job;
  }
  btn.onclick = async () => {
    await enqueue(0); updateDl();
    const { rootSet } = await chrome.storage.local.get('rootSet');
    await openQueue(!rootSet);
  };
  const cp = el('button', { className: 'sec', textContent: 'URL', title: T('copyUrl'), onclick: () => navigator.clipboard.writeText(s.url) });
  const hide = el('button', { className: 'sec', textContent: '✕', title: T('hideRow'), onclick: async () => {
    hidden.add(s.url);
    await chrome.storage.session.set({ ['hide_' + tab.id]: [...hidden] });
    updateBadge(); render();
  } });

  refresh();
  const root = el('div', { className: 'row' }, cb, thbox,
    el('div', { className: 'meta' }, nameInp, el('div', { className: 'line' }, epBox, sel), sub, note),
    el('div', { className: 'side' }, btn, el('div', { className: 'line2' }, cp, hide)));
  if (startProbe) startProbe();
  return { el: root, cb, btn, enqueue, refresh };
}

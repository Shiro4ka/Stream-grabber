const T = I18N.t;
const $ = id => document.getElementById(id);
const REPO = '';   // e.g. 'https://github.com/your-name/stream-grabber' — the link is shown only when set
let S = { ...SG.DEFAULTS }, root = null, toastTimer;

function toast() { $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 1200); }
async function save(patch) { S = { ...S, ...patch }; await chrome.storage.local.set({ settings: S }); toast(); }

function preview() {
  $('preview').textContent = SG.fileName($('tpl').value || S.template, { anime: 'Fullmetal Alchemist: Brotherhood', ep: '5', quality: '720p' }) + '.ts';
}

async function renderFolder() {
  $('rootname').textContent = root ? root.name : T('notSelected');
  const ok = await FS.perm(root, false);
  $('grant').hidden = !root || ok;
  const el = $('folderState');
  el.className = 'hint ' + (!root ? 'warn' : ok ? 'ok' : 'warn');
  el.textContent = !root ? T('folderNone') : ok ? T('folderOk') : T('folderNeedPerm');
}

async function init() {
  await I18N.init();
  S = await SG.getSettings();
  const { enabled } = await chrome.storage.local.get('enabled');
  root = await FS.getRoot();

  $('lang').value = S.lang;
  $('enabled').checked = enabled !== false;
  $('subfolder').checked = S.subfolder;
  $('tpl').value = S.template;
  $('bat').checked = S.bat;
  $('conc').value = S.concurrency; $('concv').textContent = S.concurrency;
  $('retries').value = S.retries;
  $('perRow').value = S.perRow;
  $('maxHistory').value = S.maxHistory;
  $('shortSec').value = S.shortSec;
  $('ignore').value = S.ignore;
  $('ver').textContent = chrome.runtime.getManifest().version;
  if (REPO) { $('repo').href = REPO; $('repo').hidden = false; }
  document.title = 'Stream Grabber — ' + T('settings');
  preview(); renderFolder();
}

const num = (id, min, max) => Math.max(min, Math.min(max, parseInt($(id).value, 10) || min));

$('lang').onchange = async () => { await save({ lang: $('lang').value }); await init(); };
$('enabled').onchange = async () => { await chrome.storage.local.set({ enabled: $('enabled').checked }); toast(); };
$('hotkey').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
$('subfolder').onchange = () => save({ subfolder: $('subfolder').checked });
$('tpl').oninput = () => { preview(); };
$('tpl').onchange = () => save({ template: $('tpl').value.trim() || SG.DEFAULTS.template });
$('bat').onchange = async () => { await save({ bat: $('bat').checked }); if ($('bat').checked && root && await FS.perm(root, false)) FS.ensureBat(root); };
$('conc').oninput = () => { $('concv').textContent = $('conc').value; };
$('conc').onchange = () => save({ concurrency: num('conc', 1, 16) });
$('retries').onchange = () => save({ retries: num('retries', 0, 10) });
$('perRow').onchange = () => save({ perRow: num('perRow', 1, 200) });
$('maxHistory').onchange = () => save({ maxHistory: num('maxHistory', 50, 5000) });
$('shortSec').onchange = () => save({ shortSec: num('shortSec', 0, 600) });
$('ignore').onchange = () => save({ ignore: $('ignore').value });

$('pick').onclick = async () => {
  try { root = await FS.pick(); if (S.bat) await FS.ensureBat(root); renderFolder(); toast(); } catch {}
};
$('grant').onclick = async () => { if (await FS.perm(root, true)) { if (S.bat) await FS.ensureBat(root); renderFolder(); } };

$('clearJobs').onclick = async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.entries(all).filter(([k, v]) => k.startsWith('job:') && (v.status === 'done' || v.status === 'canceled' || v.status === 'error')).map(([k]) => k);
  if (keys.length) await chrome.storage.local.remove(keys);
  toast();
};
$('reset').onclick = async () => {
  if (!confirm(T('confirmReset'))) return;
  await chrome.storage.local.remove('settings');
  await init(); toast();
};

init();

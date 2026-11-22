// Download-folder handle (File System Access API) shared by the queue page and the settings page.
var FS = (() => {
  const idb = () => new Promise((res, rej) => {
    const r = indexedDB.open('sg', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const kvGet = async k => { const db = await idb(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); };
  const kvSet = async (k, v) => { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); };

  // Re-encodes downloaded videos (.mp4 / .ts) to HEVC with ffmpeg (GPU if available, CPU otherwise). Originals are kept.
  const BAT_VERSION = 'sg-bat-v2';
  const BAT = [
    '@echo off', 'chcp 65001 >nul',
    'rem ' + BAT_VERSION + ': re-encodes downloaded videos to HEVC (needs ffmpeg in PATH). Originals are kept.',
    'rem Output: "<name> [HEVC].mp4" next to the original. Run it from the download root folder.',
    'set DELETE_ORIGINAL=0', 'set CRF=24',
    'where ffmpeg >nul 2>nul || (echo ffmpeg not found in PATH & pause & exit /b 1)',
    'set GPU=',
    'ffmpeg -hide_banner -encoders 2>nul | find "hevc_nvenc" >nul && set GPU=1',
    'for /r "%~dp0" %%f in (*.mp4 *.ts) do call :conv "%%f"',
    'echo.', 'echo Done.', 'pause', 'exit /b 0',
    ':conv',
    'echo "%~n1" | find "[HEVC]" >nul && goto :eof',
    'if exist "%~dpn1 [HEVC].mp4" goto :eof',
    'echo.', 'echo === %~nx1',
    'if defined GPU ffmpeg -hide_banner -loglevel error -stats -i "%~1" -c:v hevc_nvenc -preset p5 -cq 28 -tag:v hvc1 -c:a copy -movflags +faststart "%~dpn1 [HEVC].mp4" && goto :done',
    'ffmpeg -hide_banner -loglevel error -stats -y -i "%~1" -c:v libx265 -crf %CRF% -preset medium -tag:v hvc1 -c:a copy -movflags +faststart "%~dpn1 [HEVC].mp4" || goto :eof',
    ':done',
    'if "%DELETE_ORIGINAL%"=="1" del "%~1"',
    'goto :eof'
  ].join('\r\n');

  const getRoot = async () => { try { return (await kvGet('root')) || null; } catch { return null; } };
  async function pick() {
    const h = await showDirectoryPicker({ id: 'sg-root', mode: 'readwrite', startIn: 'videos' });
    await kvSet('root', h);
    await chrome.storage.local.set({ rootSet: true });
    return h;
  }
  async function perm(root, interactive) {
    if (!root) return false;
    const o = { mode: 'readwrite' };
    try {
      if (await root.queryPermission(o) === 'granted') return true;
      if (interactive && await root.requestPermission(o) === 'granted') return true;
    } catch {}
    return false;
  }
  async function ensureBat(root) {                       // creates the script, or replaces an older version of it
    try {
      let cur = '';
      try { cur = await (await (await root.getFileHandle('Convert-to-HEVC.bat')).getFile()).text(); } catch {}
      if (cur.includes(BAT_VERSION)) return;
      const w = await (await root.getFileHandle('Convert-to-HEVC.bat', { create: true })).createWritable();
      await w.write(BAT); await w.close();
    } catch {}
  }
  return { getRoot, pick, perm, ensureBat };
})();

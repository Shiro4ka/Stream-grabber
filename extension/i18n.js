// Tiny i18n: Russian + English, language is chosen in Settings (default: browser language).
var I18N = (() => {
  const D = {
    en: {
      hideRow: 'Hide this row', dub: 'Voice-over:', dubAll: 'All voice-overs',
      src_player: '№ from the player', src_page: '№ from the page', src_seq: '№ by sequence', src_user: '№ set by you',
      seqNote: 'The number was not found on the page — counted as “previous + 1”. Please check.',
      kFrom: 'From', kTo: 'to', kAuto: 'add to the queue right away', kScan: 'Collect all episodes', kStop: 'Stop',
      kDiag: 'Diagnostics', kDiagCopied: 'Copied ✓',
      kSeason: 'season {0}', kDub: 'voice-over:', kEpisodes: 'episodes: {0}', kMissing: 'missing in this voice-over: {0}',
      kScanning: 'Collecting… {0} of {1} (now episode {2}). Keep this tab open: the player flips through the episodes, muted.',
      kFinalizing: 'Finishing — preparing the queue…', kStopped: 'Stopped: collected {0} of {1}.',
      kDone: 'Done: collected {0} of {1}, added to the queue: {2}.', kSkipped: 'already in the queue: {0}',
      kFailTimeout: 'the episode did not start', kFailNoEp: 'no such episode in the list', kFailNoCtl: 'no control to switch episodes',
      kFailDub: 'the player switched the voice-over to “{0}” — skipped, not replaced',
      kErr_noCtx: 'The Kodik player was not detected on this page yet — start playback first.',
      kErr_noDub: 'Could not detect the selected voice-over, so nothing was started (voice-overs are never guessed or replaced). Use “Diagnostics”.',
      kErr_noEpisodes: 'The episode list was not found in the player. Use “Diagnostics”.', kErr_empty: 'No episodes in this range.',
      sumLine: 'Queued: {0} · done: {1} · errors: {2}', sumNow: 'now: episode {0} — {1}',
      optPerRow: 'Episodes per row in the queue',
      optPerRowHint: '12 by default. Rows are created automatically (48 episodes with 12 per row = 4 rows). Thumbnails shrink so that everything fits; max 200.',
      optMaxHistory: 'History size per tab', optMaxHistoryHint: 'How many videos are remembered per tab (50–5000).',
      detect: 'Detection', detectHotkey: 'Turn detection on / off (hotkey: Alt+Shift+D)',
      detectOff: 'Detection is off — new videos are not captured.',
      downloadAll: 'Download all', downloadAllN: 'Download all ({0})', adding: 'Adding…', addedN: '✓ Added: {0}',
      openQueue: 'Open download queue', clearList: 'Clear this list', settings: 'Settings',
      showPlayed: 'Show only what was played', showAllFound: 'Show everything found ({0})',
      hintPlay: 'Start playing an episode — it will show up here.',
      hintNone: 'Nothing found yet. Open an episode and start playback (if you just installed the extension, reload the page).',
      dupHidden: 'duplicates hidden: {0}',
      phAnime: 'Series title (folder name)', epMinus: 'Episode −1', epPlus: 'Episode +1',
      asPlayed: 'As playing', asPlayedH: 'As playing ({0}p)', searching: 'looking for other qualities…',
      foundQ: 'qualities found: {0}', noOtherQ: 'no other qualities found, playing {0}p', nowPlaying: 'now playing',
      playingRes: 'playing {0}×{1}', mb: '{0} MB',
      warnSepAudio: '⚠ audio is a separate stream — it will be downloaded without sound',
      warnUnsup: '⚠ not supported: {0}',
      download: 'Download', again: 'Again', queuedBtn: '✓ Queued', copyUrl: 'Copy playlist URL',
      dupSame: 'This video is already in the queue',
      dupEp: 'Episode {0} of “{1}” is already queued or downloaded',
      shortWarn: '⚠ short video (ad / trailer?) — unchecked',

      saveFolder: 'Download folder:', notSelected: 'not selected', pickFolder: 'Choose folder…',
      grantAccess: 'Allow folder access', cancelAll: 'Cancel all', clearDone: 'Remove finished',
      noteNoRoot: 'Choose a folder to save to (create e.g. D:\\Anime — Chrome will not let you pick Downloads / Documents themselves).',
      noteNeedPerm: 'Folder access must be confirmed again — click “Allow folder access”.',
      titleAction: '⚠ Stream Grabber — action needed', titleQueue: 'Stream Grabber — queue',
      emptyQueue: 'The queue is empty. Open an episode, start playback and press “Download” in the extension popup.',
      stQueued: 'Queued', stStarting: 'Starting…', stDownloading: 'Downloading {0}%',
      speed: ' · {0} MB/s', eta: ' · ~{0} left', stDone: 'Done → {0}', stError: 'Error: {0}', stCanceled: 'Canceled',
      cancel: 'Cancel', retry: 'Retry', remove: 'Remove', episodeWord: 'episode',
      epEditTitle: 'Episode number (you can fix it before the download starts)',
      errInterrupted: 'Interrupted (the queue tab was closed)', errEmptyMaster: 'The master playlist is empty',
      errUnsup: 'Not supported: {0}', errNoSegs: 'The playlist has no segments', auto: 'auto',

      optLead: 'Settings are saved automatically.',
      secGeneral: 'General', optLang: 'Language', langAuto: 'Auto (browser language)',
      optDetect: 'Video detection', optHotkey: 'Change hotkey…',
      optDetectHint: 'Only streams that are really played are listed. YouTube is ignored by default (see below).',
      secFolder: 'Folder & file names', optFolder: 'Download folder',
      folderNone: 'No folder selected yet — downloads wait until you choose one.',
      folderOk: 'Access granted.', folderNeedPerm: 'Access has to be confirmed again (Chrome asks once per browser session).',
      optSubfolder: 'One folder per series',
      optTemplate: 'File name template',
      optTemplateHint: 'Variables: {anime} {ep} {quality}. Example:',
      optBat: 'Add Convert-to-HEVC.bat',
      optBatHint: 'A small script that converts downloaded .ts files to HEVC .mp4 with ffmpeg (GPU if available). Needs ffmpeg in PATH.',
      secDownload: 'Downloading', optConc: 'Parallel segments', optRetries: 'Retries per segment',
      secDetection: 'Detection', optShort: 'Short video threshold, s',
      optShortHint: 'Videos shorter than this (ads, trailers) are unchecked in “Download all”.',
      optIgnore: 'Ignored sites (one per line)', optIgnoreHint: 'Subdomains are included. Nothing is captured on these sites.',
      secData: 'Data', optClearJobs: 'Remove finished jobs from the queue', optReset: 'Reset settings',
      secAbout: 'About',
      aboutText: 'detects the video you are actually watching (HLS / MP4) and downloads it. No telemetry, nothing leaves your computer except the requests to the video servers.',
      aboutLegal: 'Use it only for content you have the right to save. DRM-protected streams are not supported and are not circumvented.',
      saved: 'Saved', confirmReset: 'Reset all settings to defaults?'
    },
    ru: {
      hideRow: 'Скрыть эту строку', dub: 'Озвучка:', dubAll: 'Все озвучки',
      src_player: '№ из плеера', src_page: '№ со страницы', src_seq: '№ по порядку', src_user: '№ задан вами',
      seqNote: 'Номер на странице не найден — посчитан как «предыдущая + 1». Проверьте.',
      kFrom: 'С', kTo: 'по', kAuto: 'сразу добавить в очередь', kScan: 'Собрать все серии', kStop: 'Стоп',
      kDiag: 'Диагностика', kDiagCopied: 'Скопировано ✓',
      kSeason: '{0} сезон', kDub: 'озвучка:', kEpisodes: 'серий: {0}', kMissing: 'нет в этой озвучке: {0}',
      kScanning: 'Собираю… {0} из {1} (сейчас серия {2}). Держите вкладку открытой: плеер сам листает серии без звука.',
      kFinalizing: 'Завершаю — готовлю очередь…', kStopped: 'Остановлено: собрано {0} из {1}.',
      kDone: 'Готово: собрано {0} из {1}, добавлено в очередь: {2}.', kSkipped: 'уже в очереди: {0}',
      kFailTimeout: 'серия не запустилась', kFailNoEp: 'такой серии нет в списке', kFailNoCtl: 'нет элемента для переключения серий',
      kFailDub: 'плеер переключил озвучку на «{0}» — серия пропущена, подмены нет',
      kErr_noCtx: 'Плеер Kodik на этой странице ещё не обнаружен — сначала запустите воспроизведение.',
      kErr_noDub: 'Не удалось определить выбранную озвучку, поэтому сбор не запущен (озвучку никогда не угадываем и не подменяем). Нажмите «Диагностика».',
      kErr_noEpisodes: 'Список серий в плеере не найден. Нажмите «Диагностика».', kErr_empty: 'В этом диапазоне нет серий.',
      sumLine: 'В очереди: {0} · готово: {1} · ошибок: {2}', sumNow: 'сейчас: серия {0} — {1}',
      optPerRow: 'Серий в ряду в очереди',
      optPerRowHint: 'По умолчанию 12. Ряды создаются сами (48 серий по 12 = 4 ряда). Превью уменьшаются, чтобы всё поместилось; максимум 200.',
      optMaxHistory: 'Размер истории на вкладку', optMaxHistoryHint: 'Сколько видео помнить на вкладку (50–5000).',
      detect: 'Обнаружение', detectHotkey: 'Включить / выключить обнаружение (горячая клавиша: Alt+Shift+D)',
      detectOff: 'Обнаружение выключено — новые видео не ловятся.',
      downloadAll: 'Скачать все', downloadAllN: 'Скачать все ({0})', adding: 'Добавляю…', addedN: '✓ Добавлено: {0}',
      openQueue: 'Открыть очередь загрузок', clearList: 'Очистить этот список', settings: 'Настройки',
      showPlayed: 'Показать только проигранное', showAllFound: 'Показать все найденное ({0})',
      hintPlay: 'Запустите воспроизведение серии — она появится здесь.',
      hintNone: 'Ничего не найдено. Откройте серию и запустите воспроизведение (если расширение только что установили — обновите страницу).',
      dupHidden: 'скрыто дубликатов: {0}',
      phAnime: 'Название аниме (имя папки)', epMinus: 'Серия −1', epPlus: 'Серия +1',
      asPlayed: 'Как играет', asPlayedH: 'Как играет ({0}p)', searching: 'ищу другие качества…',
      foundQ: 'найдено качеств: {0}', noOtherQ: 'другие качества не найдены, играет {0}p', nowPlaying: 'сейчас играет',
      playingRes: 'играет {0}×{1}', mb: '{0} МБ',
      warnSepAudio: '⚠ звук отдельным потоком — скачается без звука',
      warnUnsup: '⚠ не поддерживается: {0}',
      download: 'Скачать', again: 'Ещё раз', queuedBtn: '✓ В очереди', copyUrl: 'Копировать ссылку на плейлист',
      dupSame: 'Это видео уже добавлено в очередь',
      dupEp: 'Серия {0} «{1}» уже в очереди или скачана',
      shortWarn: '⚠ короткое видео (реклама / трейлер?) — отметка снята',

      saveFolder: 'Папка загрузок:', notSelected: 'не выбрана', pickFolder: 'Выбрать папку…',
      grantAccess: 'Разрешить доступ к папке', cancelAll: 'Отменить все', clearDone: 'Убрать завершённые',
      noteNoRoot: 'Выберите папку, куда сохранять (создайте, например, D:\\Anime — саму папку «Загрузки» / «Документы» Chrome выбрать не даёт).',
      noteNeedPerm: 'Нужно снова подтвердить доступ к папке — нажмите «Разрешить доступ к папке».',
      titleAction: '⚠ Stream Grabber — нужно действие', titleQueue: 'Stream Grabber — очередь',
      emptyQueue: 'Очередь пуста. Откройте серию, запустите воспроизведение и нажмите «Скачать» в окне расширения.',
      stQueued: 'В очереди', stStarting: 'Запуск…', stDownloading: 'Скачивание {0}%',
      speed: ' · {0} МБ/с', eta: ' · осталось ~{0}', stDone: 'Готово → {0}', stError: 'Ошибка: {0}', stCanceled: 'Отменено',
      cancel: 'Отмена', retry: 'Повторить', remove: 'Убрать', episodeWord: 'серия',
      epEditTitle: 'Номер серии (можно поправить до начала загрузки)',
      errInterrupted: 'Прервано (вкладка очереди была закрыта)', errEmptyMaster: 'Пустой мастер-плейлист',
      errUnsup: 'Не поддерживается: {0}', errNoSegs: 'В плейлисте нет сегментов', auto: 'авто',

      optLead: 'Настройки сохраняются автоматически.',
      secGeneral: 'Общие', optLang: 'Язык', langAuto: 'Авто (язык браузера)',
      optDetect: 'Обнаружение видео', optHotkey: 'Сменить горячую клавишу…',
      optDetectHint: 'В списке только то, что реально играло. YouTube по умолчанию игнорируется (см. ниже).',
      secFolder: 'Папка и имена файлов', optFolder: 'Папка загрузок',
      folderNone: 'Папка ещё не выбрана — загрузки ждут, пока вы её выберете.',
      folderOk: 'Доступ есть.', folderNeedPerm: 'Нужно снова подтвердить доступ (Chrome спрашивает раз за сессию браузера).',
      optSubfolder: 'Отдельная папка на каждое аниме',
      optTemplate: 'Шаблон имени файла',
      optTemplateHint: 'Переменные: {anime} {ep} {quality}. Пример:',
      optBat: 'Класть Convert-to-HEVC.bat',
      optBatHint: 'Маленький скрипт: конвертирует скачанные .ts в HEVC .mp4 через ffmpeg (на видеокарте, если есть). Нужен ffmpeg в PATH.',
      secDownload: 'Загрузка', optConc: 'Параллельных сегментов', optRetries: 'Повторов на сегмент',
      secDetection: 'Обнаружение', optShort: 'Порог «короткого» видео, с',
      optShortHint: 'Видео короче порога (реклама, трейлеры) не отмечаются в «Скачать все».',
      optIgnore: 'Игнорируемые сайты (по одному в строке)', optIgnoreHint: 'Поддомены включены. На этих сайтах ничего не ловится.',
      secData: 'Данные', optClearJobs: 'Убрать завершённые задания из очереди', optReset: 'Сбросить настройки',
      secAbout: 'О расширении',
      aboutText: 'находит видео, которое вы реально смотрите (HLS / MP4), и скачивает его. Без телеметрии: наружу уходят только запросы к серверам видео.',
      aboutLegal: 'Используйте только для контента, который вам разрешено сохранять. Видео с DRM не поддерживается и не обходится.',
      saved: 'Сохранено', confirmReset: 'Сбросить все настройки по умолчанию?'
    }
  };
  let lang = 'en';
  const detect = () => (navigator.language || 'en').toLowerCase().startsWith('ru') ? 'ru' : 'en';

  const t = (key, ...a) => {
    let s = (D[lang] && D[lang][key]) ?? D.en[key] ?? key;
    a.forEach((v, i) => { s = s.split('{' + i + '}').join(v); });
    return s;
  };

  function apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(e => { e.textContent = t(e.dataset.i18n); });
    root.querySelectorAll('[data-i18n-title]').forEach(e => { e.title = t(e.dataset.i18nTitle); });
    root.querySelectorAll('[data-i18n-ph]').forEach(e => { e.placeholder = t(e.dataset.i18nPh); });
  }

  async function init() {
    const { settings } = await chrome.storage.local.get('settings');
    const l = settings && settings.lang;
    lang = (l === 'ru' || l === 'en') ? l : detect();
    document.documentElement.lang = lang;
    apply();
    return lang;
  }

  return { init, t, apply, D, get lang() { return lang; } };
})();

# Privacy

Stream Grabber has **no telemetry, no analytics and no remote servers of its own**.

- Everything runs locally in your browser.
- The extension looks at network requests only to recognise video playlists (`.m3u8`) and video files (`.mp4`, `.webm`).
  Detected URLs and page titles are kept in the browser's session storage and disappear when the browser closes.
- Settings and the download queue are stored in `chrome.storage.local`; the chosen download folder handle is stored in the extension's IndexedDB.
- The only network traffic the extension creates is the download itself (requests to the video servers, sent with the Referer of the page you were watching).

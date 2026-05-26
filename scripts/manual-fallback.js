/*
 * Comix Downloader — manual fallback
 *
 * Temporary workaround for the rare scrambled-image bug that the browser
 * extension can't currently handle (see issue #2). The browser extension
 * loads the chapter in a hidden background tab, which throttles the site's
 * own canvas renderer and prevents it from drawing the unscrambled image
 * for the few pages comix.to actually scrambles. This script does the same
 * job — but from the user's *foreground* tab where rendering works.
 *
 * Usage (paste-once):
 *   1. Open the affected chapter on comix.to.
 *   2. Open DevTools (F12) → Console tab.
 *   3. Paste the bootloader from the README and press Enter.
 *   4. Don't switch tabs. Watch the green-bordered panel in the top-right.
 *   5. When it says "✓ Saved", check your Downloads folder.
 *
 * Or paste this whole file directly into the console if the bootloader is
 * blocked by the site's CSP.
 */
(async () => {
  // 1. Pull JSZip from a CDN (the page doesn't have it on its own)
  if (typeof JSZip === 'undefined') {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
      s.onload = res;
      s.onerror = () => rej(new Error('JSZip CDN load failed — site CSP may block jsdelivr'));
      document.head.appendChild(s);
    });
  }

  // 2. Floating progress UI
  document.getElementById('cdl-fb')?.remove();
  const ui = document.createElement('div');
  ui.id = 'cdl-fb';
  ui.style.cssText = 'position:fixed;top:20px;right:20px;width:360px;background:#0a0a14;color:#e8ecf0;padding:14px;border:2px solid #4ade80;border-radius:10px;z-index:2147483647;font:13px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,0.6)';
  ui.innerHTML = '<div style="font-weight:bold;font-size:14px;margin-bottom:6px">Comix Downloader — manual fallback</div>' +
    '<div id="cdl-msg" style="font-size:12px;color:#c0c8e0;min-height:36px">Starting…</div>' +
    '<div style="height:6px;background:#222;border-radius:3px;margin:8px 0;overflow:hidden">' +
    '<div id="cdl-bar" style="height:100%;background:linear-gradient(90deg,#3b82f6,#4ade80);width:0%;transition:width .3s"></div></div>' +
    '<div id="cdl-counter" style="font-size:11px;color:#7a82a0">0 / ?</div>' +
    '<button id="cdl-cancel" style="background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.4);border-radius:6px;padding:6px 14px;cursor:pointer;margin-top:8px;font-size:12px">Cancel</button>';
  document.body.appendChild(ui);

  const msg = (t) => ui.querySelector('#cdl-msg').textContent = t;
  const bar = (n, d) => {
    ui.querySelector('#cdl-bar').style.width = (d ? (n / d * 100).toFixed(1) : 0) + '%';
    ui.querySelector('#cdl-counter').textContent = n + ' / ' + (d || '?');
  };
  let cancelled = false;
  ui.querySelector('#cdl-cancel').onclick = () => { cancelled = true; msg('Cancelling…'); };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  try {
    // 3. Filename derivation
    const mangaTitle =
      document.querySelector('.rpage-header__title')?.textContent?.trim() ||
      document.title.replace(/\s*[-|].*$/, '').trim() || 'manga';
    const slug = mangaTitle.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    const chMatch = location.pathname.match(/\/\d+-chapter-([\w.-]+)/i);
    const zipName = (slug || 'manga') + '-Ch' + (chMatch ? chMatch[1] : 'unknown') + '.zip';

    // 4. Find pages
    let pages = [...document.querySelectorAll('.rpage-page')]
      .sort((a, b) => (+a.dataset.page) - (+b.dataset.page));
    if (pages.length === 0) throw new Error('No .rpage-page elements found. Make sure you are on a comix.to chapter reader page.');

    // 5. PASS 1 — scroll through all pages so the site's Mr() unscrambler draws every canvas
    msg('Pre-rendering ' + pages.length + ' pages (so scrambled ones get drawn by the site)…');
    for (let i = 0; i < pages.length; i++) {
      if (cancelled) return msg('Cancelled.');
      pages[i].scrollIntoView({ block: 'center', behavior: 'auto' });
      await sleep(220);
      bar(i + 1, pages.length);
    }

    // 6. PASS 2 — capture each page
    msg('Capturing pages…');
    const zip = new JSZip();
    pages = [...document.querySelectorAll('.rpage-page')]
      .sort((a, b) => (+a.dataset.page) - (+b.dataset.page));

    for (let i = 0; i < pages.length; i++) {
      if (cancelled) return msg('Cancelled.');
      const el = pages[i];
      const dataPage = +el.dataset.page;
      const paddedIdx = String(dataPage).padStart(3, '0');
      el.scrollIntoView({ block: 'center', behavior: 'auto' });
      await sleep(150);

      const canvas = el.querySelector('canvas');
      const img = el.querySelector('img');
      const url = img?.currentSrc || img?.src;

      try {
        if (canvas && canvas.width > 0) {
          // Scrambled — wait for Mr() to finish drawing (async fetch + render)
          let attempts = 0;
          while (attempts++ < 50) {
            const px = canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
            if (px[3] > 0) break;
            await sleep(100);
          }
          const blob = await new Promise(r => canvas.toBlob(r, 'image/webp', 0.95))
                    || await new Promise(r => canvas.toBlob(r, 'image/png'));
          if (blob) zip.file(paddedIdx + '.' + (blob.type.split('/')[1] || 'png'), blob);
          else throw new Error('canvas.toBlob returned null');
        } else if (url) {
          // Not scrambled — fetch the raw bytes from the CDN
          const res = await fetch(url);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const ext = (url.match(/\.([a-z0-9]+)$/i) || [, 'webp'])[1];
          zip.file(paddedIdx + '.' + ext, await res.arrayBuffer());
        }
      } catch (err) {
        console.warn('[ComixDL fallback] page ' + dataPage + ' failed:', err);
        zip.file(paddedIdx + '_ERROR.txt', 'Page ' + dataPage + ' could not be captured: ' + err.message + '\nURL: ' + url);
      }
      bar(i + 1, pages.length);
    }

    if (cancelled) return msg('Cancelled.');

    // 7. Pack + download
    msg('Building ZIP…');
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = zipName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);

    msg('✓ Saved as ' + zipName + ' (' + pages.length + ' pages, ' + (blob.size / 1048576).toFixed(1) + ' MB)');
    ui.querySelector('#cdl-cancel').textContent = 'Close';
    ui.querySelector('#cdl-cancel').onclick = () => ui.remove();
  } catch (err) {
    msg('✗ Failed: ' + err.message);
    console.error(err);
  }
})();

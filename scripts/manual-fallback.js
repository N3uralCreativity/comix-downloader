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

  // Helper — decode a data URL ("data:image/X;base64,...") into bytes
  const decodeDataUrl = (dataUrl) => {
    const m = dataUrl.match(/^data:([^;,]+)(?:;base64)?,(.*)$/);
    if (!m) throw new Error('Invalid data URL');
    const binary = atob(m[2]);
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
    const ext = (m[1].split('/')[1] || 'png').toLowerCase();
    return { buf, ext };
  };

  // Helper — pull canvas pixels reliably. Re-queries each attempt because
  // React re-renders blow away the canvas DOM node and reset dimensions.
  // Returns { buf, ext } or null if the canvas can't be captured (tainted,
  // unrendered, etc.) — caller falls back to fetching the raw URL.
  const captureCanvas = async (pageEl) => {
    const MAX_ATTEMPTS = 80;          // ~8s of polling
    let lastCenterAlpha = 0;
    let stableCount = 0;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const canvas = pageEl.querySelector('canvas');
      if (!canvas || canvas.width === 0 || canvas.height === 0) {
        // Likely React just cleaned it up — wait and retry
        await sleep(100);
        continue;
      }
      let alpha;
      try {
        const ctx = canvas.getContext('2d');
        alpha = ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data[3];
      } catch (_) {
        // Tainted canvas — can't read at all, bail to URL fetch
        return null;
      }
      if (alpha > 0) {
        // Require two consecutive non-empty reads so we don't grab mid-frame
        if (lastCenterAlpha > 0) stableCount++;
        if (stableCount >= 1) {
          try {
            const dataUrl = canvas.toDataURL('image/webp', 0.95);
            const final = dataUrl.startsWith('data:image/webp')
              ? dataUrl
              : canvas.toDataURL('image/png');
            return decodeDataUrl(final);
          } catch (_) {
            return null;
          }
        }
      } else {
        stableCount = 0;
      }
      lastCenterAlpha = alpha;
      await sleep(100);
    }
    return null;
  };

  // Helper — fall back to fetching the CDN URL directly (will be mosaic if scrambled)
  const fetchRaw = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ext = (url.match(/\.([a-z0-9]+)$/i) || [, 'webp'])[1];
    return { buf: new Uint8Array(await res.arrayBuffer()), ext };
  };

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
    const initialPages = [...document.querySelectorAll('.rpage-page')]
      .sort((a, b) => (+a.dataset.page) - (+b.dataset.page));
    if (initialPages.length === 0) throw new Error('No .rpage-page elements found. Make sure you are on a comix.to chapter reader page.');

    // 5. SINGLE PASS — scroll to each page in order, capture immediately while it's still in view
    //    (avoids React's cleanup wiping the canvas between scroll and capture).
    msg('Capturing ' + initialPages.length + ' pages…');
    const zip = new JSZip();
    let captured = 0;
    let mosaicFallbacks = 0;

    for (let i = 0; i < initialPages.length; i++) {
      if (cancelled) return msg('Cancelled.');

      // Re-query (React may have re-keyed the DOM nodes)
      const allNow = [...document.querySelectorAll('.rpage-page')]
        .sort((a, b) => (+a.dataset.page) - (+b.dataset.page));
      const el = allNow[i] || initialPages[i];
      const dataPage = +el.dataset.page;
      const paddedIdx = String(dataPage).padStart(3, '0');

      el.scrollIntoView({ block: 'center', behavior: 'auto' });

      // Snapshot the URL from the img early — React may unmount it later
      const initialImgSrc = (() => {
        const img = el.querySelector('img');
        return img?.currentSrc || img?.src || null;
      })();

      // Always try to capture canvas first (works for scrambled pages).
      // captureCanvas re-queries on every attempt so DOM changes are tolerated.
      let item = await captureCanvas(el);

      // If no canvas (non-scrambled page) or canvas read failed, fall back to URL fetch
      if (!item) {
        // Re-look for the URL one more time, then use the snapshot
        const img = el.querySelector('img');
        const url = (img?.currentSrc || img?.src) || initialImgSrc;
        if (url) {
          try {
            item = await fetchRaw(url);
            if (el.querySelector('canvas')) mosaicFallbacks++; // had canvas but couldn't read it → likely mosaic in output
          } catch (err) {
            console.warn('[ComixDL fallback] page ' + dataPage + ' fetch failed:', err);
            zip.file(paddedIdx + '_ERROR.txt',
              'Page ' + dataPage + ' could not be captured.\n' +
              'Error: ' + err.message + '\nURL: ' + url);
          }
        } else {
          console.warn('[ComixDL fallback] page ' + dataPage + ' has no img and no readable canvas');
          zip.file(paddedIdx + '_ERROR.txt',
            'Page ' + dataPage + ' had no image URL and no readable canvas.\n' +
            'React likely had not rendered this page yet — try scrolling slower or running again.');
        }
      }

      if (item) {
        zip.file(paddedIdx + '.' + item.ext, item.buf);
        captured++;
      }
      bar(i + 1, initialPages.length);
    }

    if (cancelled) return msg('Cancelled.');

    // 6. Pack + download
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

    const sizeMB = (blob.size / 1048576).toFixed(1);
    let summary = '✓ Saved as ' + zipName + ' (' + captured + '/' + initialPages.length + ' pages, ' + sizeMB + ' MB)';
    if (mosaicFallbacks > 0) summary += '. ⚠ ' + mosaicFallbacks + ' page(s) may still be mosaic.';
    msg(summary);
    ui.querySelector('#cdl-cancel').textContent = 'Close';
    ui.querySelector('#cdl-cancel').onclick = () => ui.remove();
  } catch (err) {
    msg('✗ Failed: ' + err.message);
    console.error(err);
  }
})();

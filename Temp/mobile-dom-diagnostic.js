// Mobile DOM diagnostic — paste into the Firefox remote debugger console
// while on a comix.to/title/* page on your phone.
(function () {
  const out = {};

  // 1. All buttons / links / role=button elements (first 40)
  out.buttons = [...document.querySelectorAll('button, a, [role="button"]')]
    .slice(0, 40)
    .map(el => ({
      tag: el.tagName,
      cls: String(el.className).slice(0, 120),
      text: el.textContent.trim().slice(0, 60),
      visible: el.getBoundingClientRect().height > 0,
    }));

  // 2. Everything whose class contains "follow" (case-insensitive)
  out.followEls = [...document.querySelectorAll('*')]
    .filter(el => typeof el.className === 'string' && /follow/i.test(el.className))
    .slice(0, 15)
    .map(el => ({
      tag: el.tagName,
      cls: el.className.slice(0, 120),
      text: el.textContent.trim().slice(0, 60),
      parentCls: String(el.parentElement?.className).slice(0, 80),
    }));

  // 3. Everything whose class contains "mpage"
  out.mpageEls = [...document.querySelectorAll('[class*="mpage"]')]
    .slice(0, 15)
    .map(el => ({
      tag: el.tagName,
      cls: el.className.slice(0, 120),
      directChildren: [...el.children].map(c => ({ tag: c.tagName, cls: String(c.className).slice(0, 80), text: c.textContent.trim().slice(0, 40) })),
    }));

  // 4. Top-level structure of <main> or <body>
  const root = document.querySelector('main') || document.body;
  out.topStructure = [...root.children].slice(0, 10).map(el => ({
    tag: el.tagName,
    cls: String(el.className).slice(0, 100),
    childCount: el.children.length,
  }));

  // 5. Any element whose visible text starts with "Follow"
  out.followTextEls = [...document.querySelectorAll('*')]
    .filter(el => /^follow/i.test(el.textContent.trim()))
    .filter(el => el.children.length < 3)   // leaf-ish nodes
    .slice(0, 10)
    .map(el => ({
      tag: el.tagName,
      cls: String(el.className).slice(0, 120),
      text: el.textContent.trim().slice(0, 60),
      parentTag: el.parentElement?.tagName,
      parentCls: String(el.parentElement?.className).slice(0, 80),
    }));

  console.log('=== COMIX MOBILE DOM DIAGNOSTIC ===');
  console.log(JSON.stringify(out, null, 2));
  return out;
})();

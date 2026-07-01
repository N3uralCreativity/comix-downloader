/**
 * content_home.js — Comix Downloader "Custom Home" (v3.0.0, Phase 1 of the redesign).
 *
 * When `home.customLayout` is on, replaces comix.to's busy logged-in Home with a clean,
 * focused layout of three horizontal carousels, all built from comix's own JSON API
 * (same-origin, cookie-auth — no token needed):
 *   - New Chapters from Followed Comics  → /api/v1/user/following-titles?sort=chapter_updated_desc&folder_ids[]=1
 *   - Reading History                    → /api/v1/user/history
 *   - Recently Followed Comics           → /api/v1/user/following-titles?sort=added_desc
 *
 * Cards are cover-with-overlay-text (title + chapter on a gradient over the art); Reading
 * History cards get a progress bar + %. The cursor-following hover popup adds type/status,
 * genres/tags and the synopsis (parsed from the title page). We hide everything else on the
 * Home (announcements, share row, global carousels, the right sidebar). Card links are
 * `/title/{hid}` (comix resolves the hid without the slug). Skeleton shimmers show instantly
 * so there's no blank flash. To match the site we use comix's theme CSS vars and keep corners
 * minimal (4px). Fully reversible: toggle off / leave Home → native Home returns untouched
 * (we only hide native nodes via a class, never delete them).
 *
 * Isolated world, loaded after content_features.js, SPA-aware via `cdl:locationchange`
 * (dispatched by the MAIN-world bridge in scripts/extract-bridge.js). Pure parsing lives in
 * cdl-home-core.js (CDLHomeCore).
 */
(function () {
  'use strict';
  if (window.top !== window) return;
  var S = (typeof CDLSettings !== 'undefined') ? CDLSettings : null;
  var Core = (typeof CDLHomeCore !== 'undefined') ? CDLHomeCore : null;
  if (!S || !Core) return;

  var STYLE_ID = 'cdl-home-style';
  var HIDE_CLASS = 'cdl-home-hide';
  var ROOT_CLASS = 'cdl-home-on';
  var ROOT_ID = 'cdl-home-root';
  var POP_ID = 'cdl-home-pop';
  var SKELETON_N = 12; // 2 rows × ~6 columns

  // The sections shown are config-driven (cdl-home-core's registry resolved against the user's
  // `home.sections` order/selection); `sections` is recomputed each apply. Personal sections come
  // from comix's user API; global sections are re-rendered from comix's already-loaded DOM cards.
  var HERO_ID = 'cdl-hero-slot';
  var GREET_ID = 'cdl-home-greet';
  var sections = []; // active, ordered registry entries for the current config

  function secDomId(s) { return 'cdl-sec-' + s.id; }
  function heroCount() { var h = cfg['home.hero']; return h === 'off' ? 0 : (h === 'one' ? 1 : 2); }
  function heroSourceId() { return cfg['home.heroSource'] || 'new-chapters'; }
  // Which active section actually feeds the hero: the chosen source if it's an enabled personal
  // (API) section, else the first enabled personal section, else none (globals/collections lack
  // the rich data a hero needs). Returns null when no hero should show.
  function heroFeedId() {
    if (heroCount() === 0) return null;
    var apiSecs = sections.filter(function (s) { return s.source === 'api'; });
    if (!apiSecs.length) return null;
    var want = heroSourceId();
    return apiSecs.some(function (s) { return s.id === want; }) ? want : apiSecs[0].id;
  }
  function itemsLimit() { var n = parseInt(cfg['home.itemsPerSection'], 10); return (n >= 6 && n <= 40) ? n : 24; }
  function apiUrl(s) { return s.api + (s.api.indexOf('?') === -1 ? '?' : '&') + 'limit=' + itemsLimit(); }

  var cfg = Object.assign({}, S.DEFAULTS);
  var applied = false, applying = false;
  var observer = null, applyDebounce = null;
  var apiMeta = Object.create(null);    // url -> { synopsis, rating, type, status, contentRating } (instant hover)
  var genreCache = Object.create(null); // url -> Promise<{genres,tags}> (lazy from title page)
  var pop = null, hoverWired = false, curHoverUrl = null;
  var loggedInState = null; // null=unknown, true, false — drives the per-section empty messages
  var userCache = null; // Promise<{loggedIn,name}> for the greeting

  function isHome() { var p = location.pathname.replace(/\/+$/, '') || '/'; return p === '/' || p === '/home'; }
  function enabled() { return !!cfg['home.customLayout']; }
  function mainCol() { return document.querySelector('.main-col'); }

  // ── tiny DOM builders ────────────────────────────────────────────────────────
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'class') n.className = props[k];
      else if (k === 'text') n.textContent = props[k];
      else n.setAttribute(k, props[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function chevron(dir) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('width', 15); s.setAttribute('height', 15); s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2.25');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    var p = document.createElementNS(ns, 'polyline');
    p.setAttribute('points', dir === 'prev' ? '15 18 9 12 15 6' : '9 18 15 12 9 6');
    s.appendChild(p); return s;
  }

  // ── styles ───────────────────────────────────────────────────────────────────
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = `
.${HIDE_CLASS}{display:none !important;}
/* box-sizing reset for our injected UI so padding never inflates fixed heights/widths
   (comix doesn't set a global border-box, so our elements would default to content-box). */
#${ROOT_ID} *, #${POP_ID} *{box-sizing:border-box;}
/* comix's content is a fixed grid (main 960px + sidebar 340px) inside a 1400px max-width
   wrapper. With the sidebar hidden we collapse that grid to one full-width column and widen
   the wrapper so the home actually fills the screen instead of leaving the sidebar gap empty. */
html.${ROOT_CLASS} .main-col{max-width:none !important;width:100% !important;}
html.${ROOT_CLASS} .cdl-home-wide{max-width:min(2040px,95vw) !important;grid-template-columns:1fr !important;gap:0 !important;}

#${ROOT_ID}{display:block;width:100%;padding-top:6px;}
#${ROOT_ID} .cdl-sec{margin:0 0 18px;animation:cdlFadeUp .45s ease both;}

/* ── featured hero: two side-by-side spotlight cards ── */
#${HERO_ID}{margin:0 0 26px;}
#${HERO_ID} .cdl-hero-row{display:grid;grid-template-columns:1fr 1fr;gap:20px;}
@media (max-width:980px){#${HERO_ID} .cdl-hero-row{grid-template-columns:1fr;}}
#${HERO_ID} .cdl-hero{position:relative;display:block;height:392px;border-radius:4px;overflow:hidden;text-decoration:none;background:var(--surface-2,#323a3e);animation:cdlFadeUp .4s ease both;}
#${HERO_ID} .cdl-hero-bg{position:absolute;inset:0;z-index:0;background-size:cover;background-position:center 25%;filter:brightness(.5) saturate(1.05);transform:scale(1.08);transition:transform .6s ease;}
/* gradient sits BELOW the text (z-index:1 < inner's 2) so it darkens the art for
   readability without covering the content. */
#${HERO_ID} .cdl-hero::after{content:'';position:absolute;inset:0;z-index:1;background:linear-gradient(105deg,rgba(8,10,12,.96) 0%,rgba(8,10,12,.82) 42%,rgba(8,10,12,.5) 72%,rgba(8,10,12,.2) 100%);}
#${HERO_ID} .cdl-hero:hover .cdl-hero-bg{transform:scale(1.12);}
#${HERO_ID} .cdl-hero-inner{position:relative;z-index:2;height:100%;display:flex;align-items:center;gap:18px;padding:20px 22px;}
#${HERO_ID} .cdl-hero-cover{width:198px;height:296px;flex:0 0 198px;object-fit:cover;border-radius:4px;box-shadow:0 10px 28px rgba(0,0,0,.55);}
#${HERO_ID} .cdl-hero-text{min-width:0;flex:1;color:#fff;display:flex;flex-direction:column;align-self:stretch;}
#${HERO_ID} .cdl-hero-eyebrow{font-size:var(--text-xs,.6875rem);font-weight:800;letter-spacing:.12em;color:var(--accent,#66e8fa);text-transform:uppercase;margin-bottom:7px;}
#${HERO_ID} .cdl-hero-title{font-size:1.6rem;font-weight:850;line-height:1.12;margin-bottom:9px;text-shadow:0 2px 8px rgba(0,0,0,.5);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
#${HERO_ID} .cdl-hero-genres{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;max-height:28px;overflow:hidden;}
#${HERO_ID} .cdl-hero-genres span{font-size:var(--text-xs,.6875rem);font-weight:700;padding:3px 9px;border-radius:3px;background:rgba(255,255,255,.16);color:#fff;}
#${HERO_ID} .cdl-hero-alts{font-size:var(--text-sm,.75rem);color:rgba(255,255,255,.6);margin-bottom:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#${HERO_ID} .cdl-hero-desc{font-size:var(--text-base,.875rem);line-height:1.5;color:rgba(255,255,255,.82);
  display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;}
#${HERO_ID} .cdl-hero-foot{display:flex;align-items:center;gap:13px;flex-wrap:wrap;margin-top:auto;padding-top:12px;}
#${HERO_ID} .cdl-hero-status{font-size:var(--text-xs,.6875rem);font-weight:700;color:#5ee08a;display:inline-flex;align-items:center;gap:5px;}
#${HERO_ID} .cdl-hero-status::before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor;}
#${HERO_ID} .cdl-hero-mini{font-size:var(--text-xs,.6875rem);color:rgba(255,255,255,.75);}
#${HERO_ID} .cdl-hero-btn{margin-left:auto;display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:4px;
  background:var(--accent,#66e8fa);color:var(--accent-ink,#082a30);font-weight:800;font-size:var(--text-base,.875rem);transition:filter .14s;}
#${HERO_ID} .cdl-hero:hover .cdl-hero-btn{filter:brightness(1.08);}
#${HERO_ID} .cdl-hero-skel{height:392px;border-radius:4px;background:var(--surface-2,#323a3e);
  background-image:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.06) 50%,transparent 70%);background-size:200% 100%;animation:cdlShimmer 1.3s linear infinite;}
@media (max-width:560px){#${HERO_ID} .cdl-hero-cover{width:108px;height:162px;flex-basis:108px;}#${HERO_ID} .cdl-hero-title{font-size:1.2rem;}#${HERO_ID} .cdl-hero-desc{-webkit-line-clamp:2;}}
#${ROOT_ID} .section__header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:16px;}
#${ROOT_ID} .cdl-head-l{min-width:0;}
#${ROOT_ID} .section__title{font-size:var(--text-3xl,1.5rem);font-weight:800;letter-spacing:-.015em;color:var(--text-emphasis,#ecf4f5);line-height:1.15;}
#${ROOT_ID} .cdl-sub{margin-top:3px;font-size:var(--text-sm,.75rem);color:var(--text-3,#6f7778);}
#${ROOT_ID} .nav-btns{display:flex;gap:8px;flex-shrink:0;}
#${ROOT_ID} .nav-btn{cursor:pointer;width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;
  border-radius:4px;background:var(--surface,#2a3134);color:var(--text-2,#9da4a5);border:0;transition:background .14s,color .14s;}
#${ROOT_ID} .nav-btn:hover{background:var(--surface-3,#3a4248);color:var(--text-emphasis,#ecf4f5);}

#${ROOT_ID} .cdl-rail{
  display:grid;grid-auto-flow:column;grid-template-rows:repeat(var(--cdl-rows,2),auto);grid-auto-columns:calc((100% - 5*20px)/6);gap:22px 20px;
  overflow-x:auto;overflow-y:hidden;scroll-snap-type:x proximity;scroll-behavior:smooth;
  /* generous top/bottom padding so the hover lift + shadow aren't clipped by the scroller */
  padding:14px 6px 34px;scrollbar-width:thin;scrollbar-color:var(--surface-3,#3a4248) transparent;
  -webkit-mask-image:linear-gradient(90deg,transparent 0,#000 16px,#000 calc(100% - 16px),transparent 100%);
  mask-image:linear-gradient(90deg,transparent 0,#000 16px,#000 calc(100% - 16px),transparent 100%);
}
@media (min-width:1800px){#${ROOT_ID} .cdl-rail{grid-auto-columns:calc((100% - 6*20px)/7);}}
@media (min-width:2200px){#${ROOT_ID} .cdl-rail{grid-auto-columns:calc((100% - 7*20px)/8);}}
@media (max-width:1200px){#${ROOT_ID} .cdl-rail{grid-auto-columns:calc((100% - 4*18px)/5);gap:18px;}}
@media (max-width:980px){#${ROOT_ID} .cdl-rail{grid-auto-columns:calc((100% - 3*16px)/4);gap:16px;}}
@media (max-width:680px){#${ROOT_ID} .cdl-rail{grid-auto-columns:calc((100% - 2*12px)/3);gap:12px;}}
#${ROOT_ID} .cdl-rail::-webkit-scrollbar{height:8px;}
#${ROOT_ID} .cdl-rail::-webkit-scrollbar-thumb{background:var(--surface-3,#3a4248);border-radius:4px;}
#${ROOT_ID} .cdl-rail > *{scroll-snap-align:start;}

/* cover-with-overlay-text card */
#${ROOT_ID} .cdl-card{position:relative;display:block;border-radius:4px;overflow:hidden;text-decoration:none;
  background:var(--surface-2,#323a3e);transition:transform .18s ease, box-shadow .18s ease;}
#${ROOT_ID} .cdl-card:hover{transform:translateY(-5px);box-shadow:0 12px 26px rgba(0,0,0,.5);z-index:2;}
#${ROOT_ID} .cdl-poster{position:relative;aspect-ratio:2/3;background:var(--surface-2,#323a3e);}
#${ROOT_ID} .cdl-poster > img{width:100%;height:100%;object-fit:cover;display:block;}
#${ROOT_ID} .cdl-grad{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.93) 0%,rgba(0,0,0,.55) 26%,rgba(0,0,0,0) 52%);}
#${ROOT_ID} .cdl-ov{position:absolute;left:0;right:0;bottom:0;padding:10px 11px 11px;}
#${ROOT_ID} .cdl-ch{font-size:var(--text-2xs,.625rem);font-weight:800;letter-spacing:.02em;color:var(--accent,#66e8fa);margin-bottom:3px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#${ROOT_ID} .cdl-ttl{font-size:var(--text-md,.8125rem);font-weight:750;color:#fff;line-height:1.22;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-shadow:0 1px 3px rgba(0,0,0,.55);}
#${ROOT_ID} .cdl-prog{position:absolute;left:0;right:0;bottom:0;height:4px;background:rgba(255,255,255,.16);}
#${ROOT_ID} .cdl-prog > i{display:block;height:100%;background:var(--accent,#66e8fa);}
#${ROOT_ID} .cdl-pct{position:absolute;top:7px;right:7px;font-size:var(--text-2xs,.625rem);font-weight:800;color:#fff;
  background:rgba(0,0,0,.74);padding:2px 6px;border-radius:3px;}
#${ROOT_ID} .cdl-empty{color:var(--text-2,#9da4a5);font-size:var(--text-base,.875rem);padding:14px 2px;}
/* per-section empty message (logged out / no history / no follows) */
#${ROOT_ID} .cdl-emptymsg{margin:2px 2px 8px;padding:26px 22px;border-radius:6px;border:1px dashed var(--surface-3,#3a4248);
  background:var(--surface,#2a3134);color:var(--text-2,#9da4a5);font-size:var(--text-base,.875rem);font-weight:600;text-align:center;}

/* classic card: cover + caption below (no overlay text) */
#${ROOT_ID} .cdl-card--classic{background:transparent;}
#${ROOT_ID} .cdl-card--classic .cdl-poster{border-radius:4px;overflow:hidden;}
#${ROOT_ID} .cdl-cap{padding:8px 2px 0;}
#${ROOT_ID} .cdl-cap-ch{font-size:var(--text-2xs,.625rem);font-weight:800;color:var(--accent,#66e8fa);margin-bottom:3px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#${ROOT_ID} .cdl-cap-ttl{font-size:var(--text-md,.8125rem);font-weight:700;color:var(--text-emphasis,#ecf4f5);line-height:1.22;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}

/* compact density: more (smaller) cards per row */
#${ROOT_ID}.cdl-compact .cdl-rail{grid-auto-columns:calc((100% - 7*16px)/8);gap:18px 16px;}
@media (min-width:1800px){#${ROOT_ID}.cdl-compact .cdl-rail{grid-auto-columns:calc((100% - 9*16px)/10);}}
@media (min-width:2200px){#${ROOT_ID}.cdl-compact .cdl-rail{grid-auto-columns:calc((100% - 11*16px)/12);}}
@media (max-width:1200px){#${ROOT_ID}.cdl-compact .cdl-rail{grid-auto-columns:calc((100% - 5*14px)/6);gap:14px;}}
@media (max-width:980px){#${ROOT_ID}.cdl-compact .cdl-rail{grid-auto-columns:calc((100% - 4*12px)/5);gap:12px;}}
@media (max-width:680px){#${ROOT_ID}.cdl-compact .cdl-rail{grid-auto-columns:calc((100% - 3*10px)/4);gap:10px;}}

/* User Collections: landscape (horizontal) cards, wider grid columns, no hover popup */
#${ROOT_ID} .cdl-rail--coll{grid-auto-columns:calc((100% - 2*20px)/3);}
@media (min-width:1800px){#${ROOT_ID} .cdl-rail--coll{grid-auto-columns:calc((100% - 3*20px)/4);}}
@media (max-width:1200px){#${ROOT_ID} .cdl-rail--coll{grid-auto-columns:calc((100% - 1*18px)/2);}}
@media (max-width:680px){#${ROOT_ID} .cdl-rail--coll{grid-auto-columns:88%;}}
#${ROOT_ID}.cdl-compact .cdl-rail--coll{grid-auto-columns:calc((100% - 3*16px)/4);}
#${ROOT_ID} .cdl-coll{display:flex;aspect-ratio:5/2;border-radius:4px;overflow:hidden;text-decoration:none;
  background:var(--surface-2,#323a3e);transition:transform .18s ease, box-shadow .18s ease;}
#${ROOT_ID} .cdl-coll:hover{transform:translateY(-4px);box-shadow:0 12px 26px rgba(0,0,0,.5);}
#${ROOT_ID} .cdl-coll-cover{flex:0 0 42%;display:flex;overflow:hidden;background:linear-gradient(135deg,var(--surface-3,#3a4248),var(--surface-2,#323a3e));}
#${ROOT_ID} .cdl-coll-thumb{flex:1 1 0;min-width:0;width:100%;height:100%;object-fit:cover;}
#${ROOT_ID} .cdl-coll-thumb + .cdl-coll-thumb{border-left:1px solid rgba(0,0,0,.35);}
#${ROOT_ID} .cdl-coll-folder{flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-3,#6f7778);}
#${ROOT_ID} .cdl-coll-body{flex:1;min-width:0;padding:11px 13px;display:flex;flex-direction:column;justify-content:center;gap:4px;}
#${ROOT_ID} .cdl-coll-name{font-size:var(--text-md,.8125rem);font-weight:800;color:var(--text-emphasis,#ecf4f5);line-height:1.2;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
#${ROOT_ID} .cdl-coll-owner{font-size:var(--text-xs,.6875rem);font-weight:700;color:var(--accent,#66e8fa);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#${ROOT_ID} .cdl-coll-meta{font-size:var(--text-2xs,.625rem);color:var(--text-3,#6f7778);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}

/* "What's New" feed — unread first, two columns to fill the wide page (1 on narrow, 3 on very wide) */
#${ROOT_ID} .cdl-feed{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 18px;align-content:start;}
@media (min-width:1700px){#${ROOT_ID} .cdl-feed{grid-template-columns:repeat(3,minmax(0,1fr));}}
@media (max-width:860px){#${ROOT_ID} .cdl-feed{grid-template-columns:1fr;}}
#${ROOT_ID}.cdl-compact .cdl-feed{grid-template-columns:repeat(3,minmax(0,1fr));}
#${ROOT_ID} .cdl-feed-row{display:flex;align-items:center;gap:13px;padding:9px 12px;border-radius:6px;text-decoration:none;
  background:var(--surface,#2a3134);border:1px solid transparent;transition:background .14s,border-color .14s,transform .12s;}
#${ROOT_ID} .cdl-feed-row:hover{background:var(--surface-3,#3a4248);transform:translateX(2px);}
#${ROOT_ID} .cdl-feed-link{flex:1;min-width:0;display:flex;align-items:center;gap:13px;text-decoration:none;color:inherit;}
#${ROOT_ID} .cdl-feed-row.is-unread{border-color:rgba(var(--accent-rgb,102 232 250)/.32);background:rgba(var(--accent-rgb,102 232 250)/.07);}
#${ROOT_ID} .cdl-feed-dot{flex:0 0 8px;width:8px;height:8px;border-radius:50%;background:transparent;}
#${ROOT_ID} .cdl-feed-row.is-unread .cdl-feed-dot{background:var(--accent,#66e8fa);box-shadow:0 0 0 3px rgba(var(--accent-rgb,102 232 250)/.18);}
#${ROOT_ID} .cdl-feed-cover{flex:0 0 44px;width:44px;height:62px;object-fit:cover;border-radius:4px;background:var(--surface-2,#323a3e);}
#${ROOT_ID} .cdl-feed-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}
#${ROOT_ID} .cdl-feed-title{font-size:var(--text-md,.8125rem);font-weight:650;color:var(--text,#cdd5d6);line-height:1.25;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#${ROOT_ID} .cdl-feed-row.is-unread .cdl-feed-title{font-weight:850;color:var(--text-emphasis,#ecf4f5);}
#${ROOT_ID} .cdl-feed-sub{font-size:var(--text-xs,.6875rem);color:var(--text-3,#6f7778);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#${ROOT_ID} .cdl-feed-ch{color:var(--accent,#66e8fa);font-weight:700;}
#${ROOT_ID} .cdl-feed-new{flex:0 0 auto;font-size:var(--text-2xs,.625rem);font-weight:800;letter-spacing:.04em;text-transform:uppercase;
  color:var(--accent-ink,#082a30);background:var(--accent,#66e8fa);border-radius:3px;padding:2px 6px;}
#${ROOT_ID} .cdl-feed-dl{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:5px;
  color:var(--text-2,#9da4a5);background:var(--surface-2,#323a3e);transition:background .14s,color .14s;}
#${ROOT_ID} .cdl-feed-dl:hover{background:var(--accent,#66e8fa);color:var(--accent-ink,#082a30);}

/* "Your Reading" local stats panel */
#${ROOT_ID} .cdl-stats{display:flex;gap:30px;align-items:stretch;flex-wrap:wrap;padding:16px 20px;border-radius:8px;
  background:var(--surface,#2a3134);border:1px solid var(--surface-3,#3a4248);}
#${ROOT_ID} .cdl-stats-bars{display:flex;gap:10px;align-items:flex-end;height:96px;}
#${ROOT_ID} .cdl-stats-bcol{display:flex;flex-direction:column;align-items:center;gap:5px;width:26px;height:100%;justify-content:flex-end;}
#${ROOT_ID} .cdl-stats-bar{width:100%;border-radius:4px 4px 2px 2px;background:rgba(var(--accent-rgb,102 232 250)/.75);}
#${ROOT_ID} .cdl-stats-bar.is-zero{background:var(--surface-2,#323a3e);}
#${ROOT_ID} .cdl-stats-blbl{font-size:var(--text-2xs,.625rem);color:var(--text-3,#6f7778);}
#${ROOT_ID} .cdl-stats-kpis{display:flex;gap:28px;align-items:center;flex-wrap:wrap;}
#${ROOT_ID} .cdl-stats-kpi{display:flex;flex-direction:column;gap:2px;min-width:88px;}
#${ROOT_ID} .cdl-stats-num{font-size:var(--text-2xl,1.25rem);font-weight:850;color:var(--text-emphasis,#ecf4f5);}
#${ROOT_ID} .cdl-stats-lbl{font-size:var(--text-xs,.6875rem);color:var(--text-3,#6f7778);}
#${ROOT_ID} .cdl-stats-top{display:flex;flex-direction:column;gap:6px;min-width:220px;flex:1;justify-content:center;}
#${ROOT_ID} .cdl-stats-toprow{display:flex;justify-content:space-between;gap:14px;font-size:var(--text-sm,.75rem);color:var(--text,#cdd5d6);}
#${ROOT_ID} .cdl-stats-toprow b{font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px;}
#${ROOT_ID} .cdl-stats-topt{color:var(--text-3,#6f7778);white-space:nowrap;}
#${ROOT_ID} .cdl-stats-hint{padding:12px 4px;font-size:var(--text-sm,.75rem);color:var(--text-3,#6f7778);}

/* welcome header */
#${GREET_ID}{margin:2px 2px 20px;}
#${GREET_ID} .cdl-greet-title{font-size:var(--text-3xl,1.5rem);font-weight:850;letter-spacing:-.02em;color:var(--text-emphasis,#ecf4f5);}
#${GREET_ID} .cdl-greet-sub{margin-top:4px;font-size:var(--text-sm,.75rem);color:var(--text-3,#6f7778);}
#${GREET_ID}.cdl-greet-guest .cdl-greet-title{color:var(--accent,#66e8fa);}

/* hero: single wide panel */
#${HERO_ID} .cdl-hero-row--one{grid-template-columns:1fr;}

/* skeletons */
#${ROOT_ID} .cdl-skel{border-radius:4px;overflow:hidden;}
#${ROOT_ID} .cdl-skel .cdl-skel-poster{aspect-ratio:2/3;border-radius:4px;background:var(--surface-2,#323a3e);
  background-image:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.06) 50%,transparent 70%);
  background-size:200% 100%;animation:cdlShimmer 1.3s linear infinite;}

@keyframes cdlFadeUp{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:none;}}
@keyframes cdlShimmer{from{background-position:200% 0;}to{background-position:-200% 0;}}

/* cursor-following detail popup — theme-matched, barely rounded (4px) */
#${POP_ID}{position:fixed;z-index:2147483647;top:0;left:0;width:340px;max-width:84vw;
  background:var(--bg-2,#262d30);color:var(--text,#cdd5d6);
  border:1px solid var(--surface-3,#3a4248);border-radius:4px;
  box-shadow:0 20px 52px rgba(0,0,0,.58);padding:14px;display:flex;gap:14px;
  pointer-events:none;opacity:0;transform:translateY(4px);transition:opacity .12s ease, transform .12s ease;}
#${POP_ID}.show{opacity:1;transform:none;}
#${POP_ID} .cdl-pop-cover{flex:0 0 94px;width:94px;height:140px;border-radius:3px;object-fit:cover;background:var(--surface-2,#323a3e);}
#${POP_ID} .cdl-pop-body{min-width:0;display:flex;flex-direction:column;}
#${POP_ID} .cdl-pop-title{font-weight:800;font-size:var(--text-xl,1rem);color:var(--text-emphasis,#ecf4f5);line-height:1.25;}
#${POP_ID} .cdl-pop-badges{display:flex;gap:6px;flex-wrap:wrap;margin:7px 0;}
#${POP_ID} .cdl-pop-badges span{font-size:var(--text-2xs,.625rem);font-weight:700;text-transform:uppercase;letter-spacing:.04em;
  padding:2px 6px;border-radius:3px;background:var(--surface-2,#323a3e);color:var(--text-2,#9da4a5);}
#${POP_ID} .cdl-pop-badges span.accent{background:rgba(var(--accent-rgb,102 232 250)/.16);color:var(--accent,#66e8fa);}
#${POP_ID} .cdl-pop-genres{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;}
#${POP_ID} .cdl-pop-genres span{font-size:var(--text-xs,.6875rem);padding:2px 8px;border-radius:3px;
  background:var(--surface,#2a3134);color:var(--text-2,#9da4a5);border:1px solid var(--surface-3,#3a4248);}
#${POP_ID} .cdl-pop-desc{font-size:var(--text-md,.8125rem);line-height:1.5;color:var(--text-2,#9da4a5);
  display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden;}
/* loading skeletons shown while genres / synopsis are fetched from the title page */
#${POP_ID} .cdl-pop-gskel{display:inline-block;height:19px;border-radius:3px;background:var(--surface,#2a3134);
  background-image:linear-gradient(100deg,transparent 28%,rgba(255,255,255,.09) 50%,transparent 72%);background-size:200% 100%;animation:cdlShimmer 1.1s linear infinite;}
#${POP_ID} .cdl-pop-dskel{height:11px;margin:6px 0;border-radius:3px;background:var(--surface,#2a3134);
  background-image:linear-gradient(100deg,transparent 28%,rgba(255,255,255,.09) 50%,transparent 72%);background-size:200% 100%;animation:cdlShimmer 1.1s linear infinite;}
`;
    var s = el('style', { id: STYLE_ID }); s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  // ── carousels ─────────────────────────────────────────────────────────────────
  function navBtn(dir) {
    var b = el('button', { type: 'button', class: 'nav-btn cdl-' + dir, 'aria-label': dir === 'prev' ? 'Previous' : 'Next' });
    b.appendChild(chevron(dir)); return b;
  }
  function skeletonCard() { return el('div', { class: 'cdl-skel' }, [el('div', { class: 'cdl-skel-poster' })]); }
  function buildShell(s) {
    var feed = s.layout === 'feed', stats = s.layout === 'stats';
    var headKids = [el('div', { class: 'cdl-head-l section__title-wrap' }, [
      el('h2', { class: 'section__title', text: s.title }),
      el('div', { class: 'cdl-sub', text: s.sub || '' })
    ])];
    // the feed and the stats panel are vertical (no horizontal scroll) → no prev/next arrows
    if (!feed && !stats) headKids.push(el('div', { class: 'section__controls' }, [el('div', { class: 'nav-btns' }, [navBtn('prev'), navBtn('next')])]));
    var header = el('div', { class: 'section__header' }, headKids);
    var body;
    if (stats) {
      body = el('div', { class: 'cdl-stats' }); // filled synchronously from local storage — no skeleton
    } else if (feed) {
      body = el('div', { class: 'cdl-feed' });
      for (var f = 0; f < 6; f++) body.appendChild(el('div', { class: 'cdl-feed-row' }, [el('span', { class: 'cdl-feed-cover cdl-skel-poster' }), el('div', { class: 'cdl-feed-main' })]));
    } else {
      body = el('div', { class: 'cdl-rail' });
      for (var i = 0; i < SKELETON_N; i++) body.appendChild(skeletonCard());
    }
    return el('section', { class: 'section cdl-sec', id: secDomId(s) }, [header, body]);
  }
  function wireArrows(sec) {
    var rail = sec.querySelector('.cdl-rail');
    var prev = sec.querySelector('.cdl-prev'), next = sec.querySelector('.cdl-next');
    var by = function () { return Math.max(260, Math.round(rail.clientWidth * 0.85)); };
    if (prev && !prev._cdl) { prev._cdl = 1; prev.addEventListener('click', function () { rail.scrollBy({ left: -by(), behavior: 'smooth' }); }); }
    if (next && !next._cdl) { next._cdl = 1; next.addEventListener('click', function () { rail.scrollBy({ left: by(), behavior: 'smooth' }); }); }
  }

  // ── "What's New" feed row ──────────────────────────────────────────────────
  function downloadGlyph() {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('width', '16'); s.setAttribute('height', '16'); s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    [['M12 3v12'], ['M7 11l5 4 5-4'], ['M5 21h14']].forEach(function (d) { var p = document.createElementNS(ns, 'path'); p.setAttribute('d', d[0]); s.appendChild(p); });
    return s;
  }
  function feedRow(t) {
    if (t.url) apiMeta[t.url] = { synopsis: t.synopsis, rating: t.rating, type: t.type, status: t.status, contentRating: t.contentRating };
    var chTxt = (t.latestChapter != null) ? ('Ch.' + t.latestChapter) : '';
    var time = (t.time && (t.time.chapterUpdated || t.time.updated)) || '';
    var prog = t.unread ? (t.lastRead != null ? ('on Ch.' + t.lastRead) : 'not started') : 'caught up';
    var tail = [time, prog].filter(Boolean).join('   ·   ');
    var sub = el('div', { class: 'cdl-feed-sub' }, [
      chTxt ? el('span', { class: 'cdl-feed-ch', text: chTxt }) : null,
      el('span', { text: (chTxt && tail ? '   ·   ' : '') + tail })
    ]);
    var link = el('a', linkProps(t.url, 'Open ' + (t.title || '')), [
      t.cover ? el('img', { class: 'cdl-feed-cover', loading: 'lazy', alt: '', src: t.cover }) : el('span', { class: 'cdl-feed-cover' }),
      el('div', { class: 'cdl-feed-main' }, [el('div', { class: 'cdl-feed-title', text: t.title || '' }), sub])
    ]);
    link.className = 'cdl-feed-link';
    var dl = el('a', linkProps(t.url, 'Open ' + (t.title || '') + ' to download'), [downloadGlyph()]);
    dl.className = 'cdl-feed-dl'; dl.title = 'Open to download';
    return el('div', { class: 'cdl-feed-row' + (t.unread ? ' is-unread' : '') }, [
      el('span', { class: 'cdl-feed-dot' }), link,
      t.unread ? el('span', { class: 'cdl-feed-new', text: 'New' }) : null, dl
    ]);
  }
  // anchor props honoring the open-in-new-tab setting
  function linkProps(url, label) {
    var p = { href: url || '#', 'aria-label': label };
    if (cfg['home.openInNewTab']) { p.target = '_blank'; p.rel = 'noopener'; }
    return p;
  }

  // Normalize an API item (parseTitlesApi) or a DOM-parsed card (parseFollowedTitles) into one
  // view model the renderer understands. DOM items carry pre-formatted chapter/time strings and
  // have no rich meta (hover fetches genres/synopsis from the title page as usual).
  function buildCardModel(t, s) {
    if (s.source === 'dom') {
      return { title: t.title || '', url: t.url || '#', hid: t.slug || t.url || t.title, cover: t.cover || '',
        chTxt: t.chapter || '', timeTxt: t.time || '', progress: null, resumeUrl: null, meta: null };
    }
    var chNum = s.progress ? (t.lastRead != null ? t.lastRead : t.latestChapter) : t.latestChapter;
    return {
      title: t.title || '', url: t.url || '#', hid: t.hid, cover: t.cover || '',
      chTxt: (chNum != null) ? ('Ch.' + chNum) : '',
      timeTxt: (t.time && (t.time[s.timeKey] || t.time.chapterUpdated || t.time.updated)) || '',
      // resume link is independent of the progress-bar toggle (history always resumes the chapter)
      resumeUrl: (s.progress && t.resumeUrl) ? t.resumeUrl : null,
      progress: (s.progress && cfg['home.showProgress'] && t.progress != null) ? t.progress : null,
      meta: { synopsis: t.synopsis, rating: t.rating, type: t.type, status: t.status, contentRating: t.contentRating }
    };
  }

  function cardEl(t, s) {
    var m = buildCardModel(t, s);
    var chLine = [m.chTxt, m.timeTxt].filter(Boolean).join('   ·   ');
    if (m.meta && m.url) apiMeta[m.url] = m.meta;
    var overlay = cfg['home.cardStyle'] !== 'classic';

    var poster = el('div', { class: 'cdl-poster' });
    if (m.cover) poster.appendChild(el('img', { loading: 'lazy', alt: m.title, src: m.cover }));
    if (overlay) {
      poster.appendChild(el('div', { class: 'cdl-grad' }));
      poster.appendChild(el('div', { class: 'cdl-ov' }, [
        chLine ? el('div', { class: 'cdl-ch', text: chLine }) : null,
        el('div', { class: 'cdl-ttl', text: m.title })
      ]));
    }
    if (m.progress != null) {
      var bar = el('div', { class: 'cdl-prog' }); var fill = el('i'); fill.style.width = m.progress + '%'; bar.appendChild(fill);
      poster.appendChild(bar);
    }
    var kids = [poster];
    if (!overlay) kids.push(el('div', { class: 'cdl-cap' }, [
      chLine ? el('div', { class: 'cdl-cap-ch', text: chLine }) : null,
      el('div', { class: 'cdl-cap-ttl', text: m.title })
    ]));
    // Continue-Reading cards resume at the exact chapter; others go to the title page.
    // data-meta-url keeps the title URL for the hover (genres/synopsis) regardless of href.
    var aProps = {
      class: 'card cdl-card' + (overlay ? '' : ' cdl-card--classic'), href: m.resumeUrl || m.url,
      'data-meta-url': m.url || '', 'data-title': m.title, 'data-ch': m.chTxt, 'data-time': m.timeTxt
    };
    if (cfg['home.openInNewTab']) { aProps.target = '_blank'; aProps.rel = 'noopener'; }
    var a = el('a', aProps, kids);
    if (m.progress != null) a.appendChild(el('span', { class: 'cdl-pct', text: m.progress + '%' }));
    return a;
  }

  function fillRail(sec, cards) {
    var rail = sec.querySelector('.cdl-rail'); rail.textContent = '';
    cards.forEach(function (c) { rail.appendChild(c); });
    wireArrows(sec);
  }

  // ── featured hero: two spotlight cards (newest new-chapters from followed) ──────
  function statusLabel(s) {
    s = (s || '').toLowerCase();
    if (s === 'releasing') return 'Ongoing';
    if (s === 'completed') return 'Completed';
    if (s === 'hiatus') return 'Hiatus';
    if (s === 'cancelled' || s === 'canceled') return 'Cancelled';
    return s ? (s.charAt(0).toUpperCase() + s.slice(1)) : 'Ongoing';
  }
  function buildHeroPanel(t) {
    if (t.url) apiMeta[t.url] = { synopsis: t.synopsis, rating: t.rating, type: t.type, status: t.status, contentRating: t.contentRating };
    var bg = el('div', { class: 'cdl-hero-bg' }); if (t.cover) bg.style.backgroundImage = 'url("' + t.cover + '")';
    var eyebrow = 'New Chapter' + (t.time && t.time.chapterUpdated ? '   ·   ' + t.time.chapterUpdated : '');
    var genres = el('div', { class: 'cdl-hero-genres' });
    var mini = [t.rating != null ? ('★ ' + t.rating) : '', t.type, t.latestChapter != null ? ('Ch.' + t.latestChapter) : ''].filter(Boolean).join('   ·   ');
    var foot = el('div', { class: 'cdl-hero-foot' }, [
      el('span', { class: 'cdl-hero-status', text: statusLabel(t.status) }),
      mini ? el('span', { class: 'cdl-hero-mini', text: mini }) : null,
      el('span', { class: 'cdl-hero-btn', text: (t.latestChapter != null ? 'Read Ch.' + t.latestChapter : 'Read') + '  →' })
    ]);
    var text = el('div', { class: 'cdl-hero-text' }, [
      el('div', { class: 'cdl-hero-eyebrow', text: eyebrow }),
      el('div', { class: 'cdl-hero-title', text: t.title || '' }),
      genres,
      (t.altTitles && t.altTitles.length) ? el('div', { class: 'cdl-hero-alts', text: t.altTitles.slice(0, 4).join('   /   ') }) : null,
      t.synopsis ? el('div', { class: 'cdl-hero-desc', text: t.synopsis }) : null,
      foot
    ]);
    var inner = el('div', { class: 'cdl-hero-inner' }, [
      t.cover ? el('img', { class: 'cdl-hero-cover', src: t.cover, alt: t.title || '' }) : null, text
    ]);
    var aProps = { class: 'cdl-hero', href: t.url || '#' };
    if (cfg['home.openInNewTab']) { aProps.target = '_blank'; aProps.rel = 'noopener'; }
    var a = el('a', aProps, [bg, inner]);
    // genres aren't in the titles API — fill them in from the title page (cached).
    if (t.url) fetchGenres(t.url).then(function (g) {
      if (!a.isConnected) return;
      genres.textContent = '';
      (g.genres || []).concat(g.tags || []).slice(0, 5).forEach(function (x) { genres.appendChild(el('span', { text: x })); });
    });
    return a;
  }
  function buildHero(items) {
    var slot = document.getElementById(HERO_ID); if (!slot) return;
    var count = heroCount();
    items = (items || []).filter(Boolean).slice(0, count);
    if (!count || !items.length) { slot.style.display = 'none'; return; }
    slot.style.display = '';
    var row = el('div', { class: 'cdl-hero-row' + (items.length === 1 ? ' cdl-hero-row--one' : '') });
    items.forEach(function (t) { row.appendChild(buildHeroPanel(t)); });
    slot.textContent = ''; slot.appendChild(row);
  }

  // Per-section empty messages (when the custom Home is on we never revert to native — each
  // empty section says why). A logged-out account overrides them all.
  var EMPTY_MSG = {
    'whats-new': 'You don’t have any comics followed.',
    'continue-reading': 'You don’t have any reading history.',
    'new-chapters': 'You don’t have any comics followed.',
    'recently-followed': 'You don’t have any comics followed.',
    'most-recent-popular': 'Nothing to show right now.',
    'most-follows-new': 'Nothing to show right now.',
    'latest-updates': 'Nothing to show right now.',
    'user-collections': 'No collections to show right now.'
  };
  function emptyMessage(id) {
    if (loggedInState === false) return 'You’re logged out — log in to comix to see this.';
    return EMPTY_MSG[id] || 'Nothing to show here yet.';
  }
  function refreshEmpties() {
    document.querySelectorAll('#' + ROOT_ID + ' .cdl-emptymsg').forEach(function (m) {
      m.textContent = emptyMessage(m.getAttribute('data-sec'));
    });
  }
  // Show a section with an empty-state message in place of its rail (never hide/revert).
  function fillEmpty(sec, s) {
    sec.style.display = '';
    var rail = sec.querySelector('.cdl-rail, .cdl-feed'); if (rail) rail.style.display = 'none';
    var msg = sec.querySelector('.cdl-emptymsg');
    if (!msg) { msg = el('div', { class: 'cdl-emptymsg' }); sec.appendChild(msg); }
    msg.setAttribute('data-sec', s.id);
    msg.textContent = emptyMessage(s.id);
    // Resolve auth once, then correct every empty message (e.g. → "logged out").
    fetchUser().then(function (u) { var v = !!(u && u.loggedIn); if (v !== loggedInState) { loggedInState = v; refreshEmpties(); } });
  }

  // Hero feeding + rail fill, shared by API and DOM sections. `s` is the registry entry.
  function fillSection(s, sec, cards) {
    // "What's New" vertical feed — unread first, no hero/rail.
    if (s.layout === 'feed') {
      if (!cards.length) { fillEmpty(sec, s); return; }
      sec.style.display = '';
      var msgF = sec.querySelector('.cdl-emptymsg'); if (msgF) msgF.remove();
      var feed = sec.querySelector('.cdl-feed');
      if (feed) { feed.style.display = ''; feed.textContent = ''; Core.sortFeed(cards).forEach(function (t) { feed.appendChild(feedRow(t)); }); }
      return;
    }
    if (s.id === heroFeedId()) {
      // Feature the freshest titles with an UNREAD latest chapter (unless that's disabled); once
      // you've read a series' newest chapter it drops out of the hero on the next visit.
      var heroPicks = cfg['home.heroSkipRead'] ? Core.selectHero(cards, heroCount()) : cards.slice(0, heroCount());
      buildHero(heroPicks);
      var picked = Object.create(null);
      heroPicks.forEach(function (t) { picked[t.hid] = true; });
      cards = cards.filter(function (t) { return !picked[t.hid]; }); // no dupe in the rail
    }
    if (!cards.length) { fillEmpty(sec, s); return; }
    sec.style.display = '';
    var rail0 = sec.querySelector('.cdl-rail'); if (rail0) rail0.style.display = '';
    var msg0 = sec.querySelector('.cdl-emptymsg'); if (msg0) msg0.remove();
    fillRail(sec, cards.map(function (t) { return cardEl(t, s); }));
  }

  // ── "Your Reading" — local stats panel (no network; data from content_features' tracker) ──
  function statsKpi(num, lbl) {
    return el('div', { class: 'cdl-stats-kpi' }, [el('div', { class: 'cdl-stats-num', text: num }), el('div', { class: 'cdl-stats-lbl', text: lbl })]);
  }
  function renderStats(box, stats, FC) {
    box.textContent = '';
    var days = (stats && stats.days) || {};
    if (!Object.keys(days).length) {
      box.appendChild(el('div', { class: 'cdl-stats-hint', text: 'Nothing tracked yet — read a chapter or two and your stats will appear here.' }));
      return;
    }
    var today = FC.statsDayKey(Date.now());
    var week = FC.summarizeWeek(days, today);
    var wkC = 0, wkS = 0, maxC = 0;
    week.forEach(function (d) { wkC += d.c; wkS += d.s; if (d.c > maxC) maxC = d.c; });

    var bars = el('div', { class: 'cdl-stats-bars' });
    week.forEach(function (d) {
      var bar = el('div', { class: 'cdl-stats-bar' + (d.c ? '' : ' is-zero') });
      bar.style.height = (d.c && maxC ? Math.max(8, Math.round((d.c / maxC) * 100)) : 4) + '%';
      var wd = 'SMTWTFS'[new Date(d.key + 'T12:00:00').getDay()] || '';
      bars.appendChild(el('div', { class: 'cdl-stats-bcol', title: d.key + ' · ' + d.c + (d.c === 1 ? ' chapter · ' : ' chapters · ') + FC.fmtDuration(d.s) },
        [bar, el('span', { class: 'cdl-stats-blbl', text: wd })]));
    });

    var streak = FC.computeStreak(days, today);
    var pace = (stats && stats.pace && stats.pace.avg > 0) ? FC.fmtDuration(stats.pace.avg) : '—';
    var kpis = el('div', { class: 'cdl-stats-kpis' }, [
      statsKpi(String(wkC), 'chapters this week'),
      statsKpi(FC.fmtDuration(wkS), 'read this week'),
      statsKpi(streak ? streak + (streak === 1 ? ' day' : ' days') : '—', 'reading streak'),
      statsKpi(pace, 'avg per chapter')
    ]);

    // most-read series over the last 30 days, by active time
    var cutoff = Date.now() - 30 * 864e5;
    var series = (stats && stats.series) || {};
    var top = Object.keys(series)
      .map(function (k) { var e = series[k]; return { slug: k, name: e.name || k, c: e.c || 0, s: e.s || 0, ts: e.ts || 0 }; })
      .filter(function (e) { return e.ts >= cutoff && e.s > 0; })
      .sort(function (a, b) { return b.s - a.s; }).slice(0, 3);

    box.appendChild(bars);
    box.appendChild(kpis);
    if (top.length) {
      var list = el('div', { class: 'cdl-stats-top' }, [el('div', { class: 'cdl-stats-lbl', text: 'Most read · last 30 days' })]);
      top.forEach(function (e) {
        list.appendChild(el('div', { class: 'cdl-stats-toprow' }, [
          el('b', { text: e.name }),
          el('span', { class: 'cdl-stats-topt', text: e.c + ' ch · ' + FC.fmtDuration(e.s) })
        ]));
      });
      box.appendChild(list);
    }
  }
  function loadStats(s, sec) {
    sec._cdlLoaded = true;
    sec.style.display = '';
    var box = sec.querySelector('.cdl-stats'); if (!box) return;
    var FC = (typeof CDLFeaturesCore !== 'undefined') ? CDLFeaturesCore : null;
    if (!FC) { sec.style.display = 'none'; return; }
    if (!cfg['features.readingStats']) {
      box.textContent = '';
      box.appendChild(el('div', { class: 'cdl-stats-hint',
        text: 'Turn on “Reading stats” in the Comix-Downloader settings to start tracking (stored on this device only, never shared).' }));
      return;
    }
    try {
      chrome.storage.local.get('cdlReadStats', function (r) {
        renderStats(box, (r && r.cdlReadStats) || null, FC);
      });
    } catch (e) { renderStats(box, null, FC); }
  }

  function loadSection(s) {
    var sec = document.getElementById(secDomId(s)); if (!sec || sec._cdlLoaded) return;
    if (s.source === 'dom') { loadDomSection(s, sec); return; }
    if (s.source === 'collections') { loadCollections(s, sec); return; }
    if (s.source === 'stats') { loadStats(s, sec); return; }
    sec._cdlLoaded = true;
    fetch(apiUrl(s), { credentials: 'include', headers: { Accept: 'application/json' } })
      .then(function (r) { return (r.ok && /json/i.test(r.headers.get('content-type') || '')) ? r.json() : null; })
      .then(function (json) {
        var sec2 = document.getElementById(secDomId(s)); if (!sec2) return;
        var cards = Core.parseTitlesApi(json, location.origin).slice(0, itemsLimit());
        fillSection(s, sec2, cards);
      })
      .catch(function () {
        var sec2 = document.getElementById(secDomId(s)); if (!sec2) return;
        if (s.id === heroFeedId()) buildHero([]);
        if (!sec2.querySelector('.cdl-card')) fillEmpty(sec2, s);
      });
  }

  // Find comix's native carousel for a global section by its heading text (skipping our own).
  function findNativeSection(s) {
    var col = mainCol(); if (!col) return null;
    var secs = col.querySelectorAll('section.section');
    for (var i = 0; i < secs.length; i++) {
      if (secs[i].closest('#' + ROOT_ID)) continue; // skip our re-rendered shells
      var h = secs[i].querySelector('.section__title, h1, h2, h3');
      if (h && Core.matchNativeSection(h.textContent) === s.id) return secs[i];
    }
    return null;
  }
  // Global sections: re-render comix's already-loaded cards in our own style; retried by the
  // observer until the native carousel has rendered its cards (it loads async).
  function loadDomSection(s, sec) {
    var native = findNativeSection(s);
    if (!native) return; // not in the DOM yet
    var items = Core.parseFollowedTitles(native.innerHTML, location.origin).slice(0, itemsLimit());
    if (!items.length) return; // cards not rendered yet
    sec._cdlLoaded = true;
    fillSection(s, sec, items);
  }

  // Logged-in identity for the greeting (comix's GET /api/v1/user, cached per apply session).
  function fetchUser() {
    if (userCache) return userCache;
    userCache = fetch('/api/v1/user', { credentials: 'include', headers: { Accept: 'application/json' } })
      .then(function (r) { return (r.ok && /json/i.test(r.headers.get('content-type') || '')) ? r.json() : null; })
      .then(function (j) { return Core.parseUser(j); })
      .catch(function () { return { loggedIn: false, name: '' }; });
    return userCache;
  }
  function updateGreeting(g) {
    var titleEl = g.querySelector('.cdl-greet-title'), subEl = g.querySelector('.cdl-greet-sub');
    fetchUser().then(function (u) {
      if (!g.isConnected || !titleEl) return;
      if (u.loggedIn) {
        titleEl.textContent = u.name ? ('Welcome back, ' + u.name) : 'Welcome back';
        subEl.textContent = 'Here’s what’s new across the comics you follow.';
        g.classList.remove('cdl-greet-guest');
      } else {
        titleEl.textContent = 'Login required';
        subEl.textContent = 'Log in to comix.to to see your followed comics, new chapters and reading history here.';
        g.classList.add('cdl-greet-guest');
      }
    });
  }
  function buildGreeting() {
    return el('div', { id: GREET_ID }, [
      el('div', { class: 'cdl-greet-title', text: 'Welcome back' }),
      el('div', { class: 'cdl-greet-sub', text: 'Here’s what’s new across the comics you follow.' })
    ]);
  }
  function heroSkelRow() {
    var skels = []; for (var i = 0; i < Math.max(1, heroCount()); i++) skels.push(el('div', { class: 'cdl-hero-skel' }));
    return el('div', { class: 'cdl-hero-row' + (heroCount() === 1 ? ' cdl-hero-row--one' : '') }, skels);
  }
  // Build (once per config) the greeting, hero slot and section shells, in the configured order.
  // User Collections: user-made lists of comics (not comics). Landscape cards, no hover popup.
  function folderIcon() {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '26'); s.setAttribute('height', '26');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.7');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z');
    s.appendChild(p); return s;
  }
  function collectionCard(c) {
    var cover = el('div', { class: 'cdl-coll-cover' });
    if (c.covers && c.covers.length) {
      c.covers.slice(0, 3).forEach(function (src) { cover.appendChild(el('img', { class: 'cdl-coll-thumb', loading: 'lazy', alt: '', src: src })); });
    } else { cover.appendChild(el('div', { class: 'cdl-coll-folder' }, [folderIcon()])); }
    var meta = [(c.itemCount || 0) + (c.itemCount === 1 ? ' comic' : ' comics'), c.likeCount ? (c.likeCount + (c.likeCount === 1 ? ' like' : ' likes')) : '', c.time].filter(Boolean).join('   ·   ');
    var body = el('div', { class: 'cdl-coll-body' }, [
      el('div', { class: 'cdl-coll-name', text: c.name || 'Untitled collection' }),
      c.owner ? el('div', { class: 'cdl-coll-owner', text: 'by ' + c.owner }) : null,
      el('div', { class: 'cdl-coll-meta', text: meta })
    ]);
    var aProps = { class: 'cdl-coll', href: c.url || '#' };
    if (cfg['home.openInNewTab']) { aProps.target = '_blank'; aProps.rel = 'noopener'; }
    return el('a', aProps, [cover, body]);
  }
  function loadCollections(s, sec) {
    sec._cdlLoaded = true;
    fetch(apiUrl(s), { credentials: 'include', headers: { Accept: 'application/json' } })
      .then(function (r) { return (r.ok && /json/i.test(r.headers.get('content-type') || '')) ? r.json() : null; })
      .then(function (json) {
        var sec2 = document.getElementById(secDomId(s)); if (!sec2) return;
        var cols = Core.parseCollectionsApi(json, location.origin).slice(0, itemsLimit());
        if (!cols.length) { fillEmpty(sec2, s); return; }
        sec2.style.display = '';
        sec2.classList.add('cdl-sec--coll');
        var rail = sec2.querySelector('.cdl-rail'); if (rail) { rail.style.display = ''; rail.classList.add('cdl-rail--coll'); }
        var msg0 = sec2.querySelector('.cdl-emptymsg'); if (msg0) msg0.remove();
        fillRail(sec2, cols.map(collectionCard));
      })
      .catch(function () {
        var sec2 = document.getElementById(secDomId(s)); if (sec2 && !sec2.querySelector('.cdl-coll')) fillEmpty(sec2, s);
      });
  }

  function ensureRoot() {
    var col = mainCol(); if (!col) return null;
    var root = document.getElementById(ROOT_ID);
    if (!root) { root = el('div', { id: ROOT_ID }); col.insertBefore(root, col.firstChild); }
    else if (root.parentElement !== col) { col.insertBefore(root, col.firstChild); }
    // greeting (top) — async-filled with the logged-in name (or a login prompt)
    var greet = document.getElementById(GREET_ID);
    if (cfg['home.greeting']) { if (!greet) { greet = buildGreeting(); root.appendChild(greet); updateGreeting(greet); } }
    else if (greet) greet.remove();
    // hero slot — only when a personal section is available to feed it
    var hero = document.getElementById(HERO_ID);
    if (heroFeedId()) { if (!hero) root.appendChild(el('div', { id: HERO_ID }, [heroSkelRow()])); }
    else if (hero) { hero.remove(); }
    // section shells, in configured order
    sections.forEach(function (s) { if (!document.getElementById(secDomId(s))) root.appendChild(buildShell(s)); });
    return root;
  }
  function hideNative() {
    var col = mainCol(); if (!col) return;
    [].forEach.call(col.children, function (ch) { if (ch.id !== ROOT_ID) ch.classList.add(HIDE_CLASS); });
    document.querySelectorAll('aside.panel--bare, aside.panel.panel--bare').forEach(function (side) {
      if (!side.closest('.main-col')) side.classList.add(HIDE_CLASS);
    });
    // Collapse comix's fixed [main 960px | sidebar 340px] grid to one full-width column.
    if (col.parentElement) col.parentElement.classList.add('cdl-home-wide');
  }
  function unhideAll() {
    document.querySelectorAll('.' + HIDE_CLASS).forEach(function (n) { n.classList.remove(HIDE_CLASS); });
    document.querySelectorAll('.cdl-home-wide').forEach(function (g) { g.classList.remove('cdl-home-wide'); });
  }

  // ── hover popup ───────────────────────────────────────────────────────────────
  function ensurePopup() {
    if (pop && pop.isConnected) return pop;
    pop = el('div', { id: POP_ID }, [
      el('img', { class: 'cdl-pop-cover', alt: '' }),
      el('div', { class: 'cdl-pop-body' }, [
        el('div', { class: 'cdl-pop-title' }), el('div', { class: 'cdl-pop-badges' }),
        el('div', { class: 'cdl-pop-genres' }), el('div', { class: 'cdl-pop-desc' })
      ])
    ]);
    (document.body || document.documentElement).appendChild(pop);
    return pop;
  }
  // Genres/tags aren't in the titles API — fetch them from the title page (cached).
  function fetchGenres(url) {
    if (genreCache[url]) return genreCache[url];
    genreCache[url] = fetch(url, { credentials: 'include', headers: { Accept: 'text/html' } })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (html) { var m = Core.parseTitleMeta(html); return { genres: m.genres || [], tags: m.tags || [], description: m.description || '' }; })
      .catch(function () { return { genres: [], tags: [], description: '' }; });
    return genreCache[url];
  }
  function showPopupFor(card) {
    var p = ensurePopup();
    var url = card.getAttribute('data-meta-url') || card.href; curHoverUrl = url;
    var meta = apiMeta[url] || {};
    var img = card.querySelector('img');
    var title = card.getAttribute('data-title') || (card.querySelector('.cdl-ttl') || {}).textContent || (img && img.alt) || '';
    var ch = card.getAttribute('data-ch'), tm = card.getAttribute('data-time');
    p.querySelector('.cdl-pop-cover').src = (img && (img.currentSrc || img.src)) || '';
    p.querySelector('.cdl-pop-title').textContent = (title || '').trim();
    // Instant badges + synopsis from the API data we already have.
    var badges = p.querySelector('.cdl-pop-badges'); badges.textContent = '';
    if (ch) badges.appendChild(el('span', { class: 'accent', text: ch }));
    if (tm) badges.appendChild(el('span', { text: tm }));
    if (meta.type) badges.appendChild(el('span', { text: meta.type }));
    if (meta.status) badges.appendChild(el('span', { text: meta.status }));
    if (meta.rating != null) badges.appendChild(el('span', { class: 'accent', text: '★ ' + meta.rating }));
    // Genres (and synopsis, if the API didn't include one) load from the title page —
    // show shimmer skeletons in the meantime.
    var gEl = p.querySelector('.cdl-pop-genres'); gEl.textContent = '';
    for (var gi = 0; gi < 4; gi++) { var gsk = el('span', { class: 'cdl-pop-gskel' }); gsk.style.width = (44 + (gi * 13) % 36) + 'px'; gEl.appendChild(gsk); }
    var descEl = p.querySelector('.cdl-pop-desc');
    if (meta.synopsis) { descEl.textContent = meta.synopsis; }
    else { descEl.textContent = ''; for (var di = 0; di < 3; di++) { var dsk = el('div', { class: 'cdl-pop-dskel' }); if (di === 2) dsk.style.width = '70%'; descEl.appendChild(dsk); } }
    p.classList.add('show');
    fetchGenres(url).then(function (g) {
      if (curHoverUrl !== url || !pop) return;
      gEl.textContent = '';
      (g.genres || []).concat(g.tags || []).slice(0, 6).forEach(function (x) { gEl.appendChild(el('span', { text: x })); });
      if (!meta.synopsis) descEl.textContent = g.description || '';
      measurePopup(); // content changed — refresh cached dims for positioning
    });
  }
  // Position uses CACHED popup dimensions (measured on show / content change) so we never
  // read layout on mousemove, and updates are rAF-throttled. mousemove is only attached
  // while a popup is actually showing — not globally — to avoid constant work.
  var popW = 340, popH = 200, moveRAF = null, lastMove = null;
  function measurePopup() { if (pop) { popW = pop.offsetWidth || popW; popH = pop.offsetHeight || popH; } }
  function positionPopup(e) {
    if (!pop || !e || !pop.classList.contains('show')) return;
    var pad = 18, x = e.clientX + pad, y = e.clientY + pad;
    if (x + popW > window.innerWidth - 8) x = e.clientX - popW - pad;
    if (y + popH > window.innerHeight - 8) y = Math.max(8, window.innerHeight - popH - 8);
    pop.style.left = x + 'px'; pop.style.top = y + 'px';
  }
  function onMove(e) {
    lastMove = e;
    if (moveRAF) return;
    moveRAF = requestAnimationFrame(function () { moveRAF = null; positionPopup(lastMove); });
  }
  function hidePopup() {
    curHoverUrl = null;
    if (pop) { pop.classList.remove('show'); var g = pop.querySelector('.cdl-pop-genres'); if (g) g.textContent = ''; }
    document.removeEventListener('mousemove', onMove, true);
    if (moveRAF) { cancelAnimationFrame(moveRAF); moveRAF = null; }
  }
  function onOver(e) {
    if (!applied || !cfg['home.hoverPreview']) return;
    var card = e.target.closest && e.target.closest('#' + ROOT_ID + ' a.cdl-card');
    if (!card || (card.getAttribute('data-meta-url') || card.href) === curHoverUrl) return;
    showPopupFor(card);
    document.addEventListener('mousemove', onMove, true); // only while a popup is shown
    measurePopup(); positionPopup(e);
  }
  function onOut(e) {
    var card = e.target.closest && e.target.closest('#' + ROOT_ID + ' a.cdl-card');
    if (!card) return;
    var to = e.relatedTarget;
    if (to && to.closest && to.closest('a.cdl-card') === card) return;
    hidePopup();
  }
  function wireHover() {
    if (hoverWired) return; hoverWired = true;
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
  }
  function unwireHover() {
    if (!hoverWired) return; hoverWired = false;
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('mouseout', onOut, true);
    hidePopup();
  }

  // ── observer / lifecycle ──────────────────────────────────────────────────────
  function ensureObserver() {
    if (observer) return;
    observer = new MutationObserver(function () {
      if (applyDebounce) return;
      applyDebounce = setTimeout(function () { applyDebounce = null; if (applied) doApply(); }, 300);
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
    if (applyDebounce) { clearTimeout(applyDebounce); applyDebounce = null; }
  }

  function doApply() {
    if (applying || !mainCol()) return;
    applying = true;
    try {
      sections = Core.resolveSections(cfg['home.sections']); // active, ordered for this config
      ensureStyle();
      document.documentElement.classList.add(ROOT_CLASS);
      var root = ensureRoot();
      if (root) {
        root.style.setProperty('--cdl-rows', String(parseInt(cfg['home.rows'], 10) || 2));
        root.classList.toggle('cdl-compact', cfg['home.density'] === 'compact');
      }
      hideNative();
      sections.forEach(loadSection);
      if (cfg['home.hoverPreview']) wireHover(); else unwireHover();
    } catch (_) {}
    applying = false;
  }
  function applyHome() { applied = true; doApply(); ensureObserver(); }
  function clearHome() {
    applied = false; userCache = null; loggedInState = null; // fresh start on the next home visit (e.g. after login)
    stopObserver(); unwireHover();
    document.documentElement.classList.remove(ROOT_CLASS);
    var root = document.getElementById(ROOT_ID); if (root) root.remove();
    var st = document.getElementById(STYLE_ID); if (st) st.remove();
    var pp = document.getElementById(POP_ID); if (pp) pp.remove();
    unhideAll();
    pop = null;
  }

  // Engage only when the custom Home is on, we're on the Home route, and at least one section is
  // enabled (all-off behaves like the feature being off → native Home).
  function sync() {
    var anyOn = enabled() && Core.resolveSections(cfg['home.sections']).length > 0;
    if (anyOn && isHome()) applyHome(); else clearHome();
  }

  function boot() {
    S.getSettings().then(function (loaded) { cfg = loaded; sync(); }).catch(function () { sync(); });
    S.onChange(function (next) { cfg = next; sync(); });
    var lastPath = location.pathname;
    var onRoute = function () { if (location.pathname === lastPath) return; lastPath = location.pathname; sync(); };
    window.addEventListener('cdl:locationchange', onRoute);
    window.addEventListener('popstate', onRoute);
    window.addEventListener('hashchange', onRoute);
    window.addEventListener('pageshow', function (e) { if (e.persisted) sync(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

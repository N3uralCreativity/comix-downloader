"use strict";
// Run after building the Chromium package. Loads the packaged extension on a
// comix-shaped not-found page at /agenda and checks the native Release Agenda.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const origin = "https://comix.to";
// A trimmed copy of comix's page shell and of the component rules the Agenda uses.
const shell = (
  title,
  body,
) => `<!doctype html><html data-theme="dark"><head><title>${title}</title><style>
:root{--bg:#181a1c;--surface:#202326;--surface-2:#282c30;--surface-3:#30343a;--accent:#8765eb;--accent-2:#6f4dd3;--accent-ink:#1a1133;--text-emphasis:#f5f5f5;--text:#d4d4d4;--text-2:#a0a0a0;--text-3:#6f7778;--text-4:#555b5c;--radius:8px;--radius-sm:6px;--container:1400px;--gutter:28px;--ctrl-sm:30px;--ctrl-lg:40px;--f-mono:ui-monospace,monospace;--text-xs:11px;--text-sm:13px;--text-base:14px;--text-md:15px;--text-2xl:24px}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--text);font:14px/1.5 Arial,sans-serif;display:flex;flex-direction:column;min-height:100vh}#__next{display:flex;flex-direction:column;min-height:100vh}a{color:inherit;text-decoration:none}
.topnav{height:64px;background:var(--surface)}.topnav__inner{max-width:var(--container);height:100%;margin:0 auto;padding:0 var(--gutter);display:flex;align-items:center;justify-content:space-between}.topnav__right{display:flex;align-items:center;gap:6px}
.icon-btn{width:var(--ctrl-lg);height:var(--ctrl-lg);color:var(--text-2);border-radius:var(--radius);background:0 0;border:0;display:inline-flex;align-items:center;justify-content:center}
.error-main{max-width:var(--container);min-height:60vh;margin:0 auto;padding:0 var(--gutter) 64px;display:flex;align-items:center;justify-content:center}
.list-main{max-width:var(--container);margin:0 auto;padding:40px var(--gutter) 0}
.section{min-width:0}.section__header{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:18px}.section__kicker{font-family:var(--f-mono);font-size:var(--text-xs);letter-spacing:.16em;color:var(--text-4);text-transform:uppercase;margin-bottom:6px}.section__title{margin:0;font-size:var(--text-2xl);font-weight:600}.section__controls{display:flex;align-items:center;gap:12px}
.btn{height:var(--ctrl-lg);border-radius:var(--radius);font:inherit;font-weight:600;border:0;display:inline-flex;align-items:center;gap:8px;padding:0 18px}.btn--sm{height:var(--ctrl-sm);font-size:var(--text-sm);padding:0 12px}.btn--primary{background:var(--accent);color:var(--accent-ink)}.btn--soft{background:var(--surface-2);color:var(--text-2)}
.panel{background:var(--surface);border-radius:var(--radius)}.grid-updates{display:grid;grid-template-columns:repeat(5,1fr);gap:26px 14px}
.card{color:var(--text);display:flex;flex-direction:column;gap:10px;min-width:0;padding-bottom:6px}.card__poster-wrap{position:relative}.card__body{text-align:center;display:flex;flex-direction:column;gap:4px;min-width:0;padding:0 2px}.card__title{margin-top:4px;font-size:var(--text-base);font-weight:600;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.card__meta{font-size:var(--text-sm);color:var(--text-3);white-space:nowrap;display:flex;justify-content:space-between;align-items:baseline;gap:14px;padding:0 2px}.card__ch{color:var(--text-2);font-weight:500}.card__time{font-family:var(--f-mono);font-size:var(--text-xs)}
.card--compact .card__body{text-align:left;padding:0}.card--compact .card__meta{gap:8px;padding:0}.poster{aspect-ratio:200/280;border-radius:var(--radius);background:var(--surface-2);overflow:hidden}.poster img{width:100%;height:100%;object-fit:cover;display:block}
.footer{padding:24px var(--gutter);background:var(--surface);color:var(--text-3)}
@media(max-width:1100px){.grid-updates{grid-template-columns:repeat(3,1fr)}}@media(max-width:700px){:root{--gutter:16px}.section__header{flex-wrap:wrap;align-items:flex-start;gap:8px}.section__controls{margin-left:auto}}
</style></head><body><div id="__next"><header class="topnav"><div class="topnav__inner"><a class="logo" href="/">comix</a><nav class="topnav__right"><div class="settings"><button type="button" class="icon-btn" title="Settings">S</button></div><div class="usermenu"><button type="button" class="icon-btn" title="Account">U</button></div></nav></div></header>
${body}<footer class="footer">comix footer</footer></div></body></html>`;
const notFound = shell(
  "404: This page could not be found",
  '<main class="error-main"><h1>404</h1><p>This page could not be found.</p></main>',
);
const settingsPage = shell(
  "My Profile",
  '<main class="user-main"><h1>Settings</h1></main>',
);

function weekDay(dayFromMonday, hour) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7) + dayFromMonday);
  date.setHours(hour);
  return date.toISOString();
}
function entry(slug, mangaName, prediction, extra = {}) {
  return {
    slug,
    mangaName,
    titleUrl: `${origin}/title/${slug}`,
    coverUrl: null,
    expectedChapterLabel: "Ch.45",
    eventCount: 9,
    cadenceDays: 7,
    confidence: 88,
    historyStatus: "ok",
    prediction: {
      uncertaintyDays: 0,
      showTime: false,
      precision: "day",
      ...prediction,
    },
    ...extra,
  };
}
const agenda = {
  generatedAt: new Date().toISOString(),
  timeZone: "Europe/Paris",
  pollIntervalMinutes: 360,
  subscriptionCount: 5,
  readyCount: 4,
  unscheduledCount: 1,
  needsBackfill: ["first-light"],
  entries: [
    entry(
      "first-light",
      "First Light",
      { level: "on-schedule", instantUtc: weekDay(1, 18), showTime: true },
      { coverUrl: "https://static.comix.to/covers/first-light.png" },
    ),
    entry("slow-tide", "Slow Tide", {
      level: "estimated",
      instantUtc: weekDay(3, 12),
      precision: "week",
      uncertaintyDays: 3,
    }),
    entry("overdue-knight", "Overdue Knight", {
      level: "late",
      instantUtc: weekDay(5, 9),
      uncertaintyDays: 1,
    }),
    entry("next-arc", "Next Arc", {
      level: "on-schedule",
      instantUtc: weekDay(8, 20),
    }),
    entry("quiet-season", "Quiet Season", {
      level: "unscheduled",
      instantUtc: null,
      reason: "irregular",
    }),
  ],
};

(async () => {
  const extension = path.resolve(__dirname, "../../dist/package-work/chrome");
  const output = path.resolve(__dirname, "../../output/playwright/agenda");
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, "profile-"));
  const cover = await fs.readFile(
    path.resolve(__dirname, "../../icons/icon128.png"),
  );
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      locale: "en-US",
      viewport: { width: 1440, height: 1000 },
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    });
    await context.route(/^https?:/, (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "static.comix.to")
        return route.fulfill({ contentType: "image/png", body: cover });
      if (url.origin !== origin) return route.abort();
      if (url.pathname === "/user")
        return route.fulfill({ contentType: "text/html", body: settingsPage });
      return route.fulfill({
        status: 404,
        contentType: "text/html",
        body: notFound,
      });
    });
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    await worker.evaluate((data) => {
      self.agendaCalls = { get: 0, refresh: 0 };
      self.agendaLocked = false;
      buildAgendaState = async () => {
        self.agendaCalls.get++;
        if (self.agendaLocked) {
          throw Object.assign(
            new Error(
              "The release agenda is available while a Plus trial or subscription is active.",
            ),
            { code: "AGENDA_PLUS_REQUIRED" },
          );
        }
        return self.agendaCalls.refresh ? { ...data, needsBackfill: [] } : data;
      };
      refreshAgendaHistory = async (options) => {
        self.agendaCalls.refresh++;
        self.lastRefreshOptions = options;
        return {
          summary: { requested: 1, analyzed: 1, covers: 1 },
          agenda: { ...data, needsBackfill: [] },
        };
      };
    }, agenda);

    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/agenda`);
    await page.locator("#cdl-agenda-main .cdl-agenda-week").waitFor();
    await page.waitForFunction(() =>
      /1 title\(s\) refreshed \/ 1 cover\(s\) recovered/.test(
        document.querySelector("#cdl-agenda-main .cdl-agenda-status")
          ?.textContent || "",
      ),
    );
    assert.deepEqual(
      await worker.evaluate(() => ({
        calls: self.agendaCalls,
        onlyMissing: self.lastRefreshOptions.onlyMissing,
      })),
      {
        calls: { get: 1, refresh: 1 },
        onlyMissing: true,
      },
    );

    // The page is comix's own shell: header and footer stay, the not-found body is hidden.
    const shellState = await page.evaluate(() => {
      const main = document.getElementById("cdl-agenda-main");
      const entry = document.getElementById("cdl-agenda-topnav-entry");
      const link = entry.querySelector("a");
      return {
        title: document.title,
        routeClass:
          document.documentElement.classList.contains("cdl-agenda-route"),
        errorHidden:
          getComputedStyle(document.querySelector(".error-main")).display ===
          "none",
        mainClass: main.className,
        placedAfterSiteMain:
          main.previousElementSibling === document.querySelector(".error-main"),
        footerAfter:
          main.nextElementSibling === document.querySelector("footer.footer"),
        entryBeforeSettings:
          entry.nextElementSibling ===
          document.querySelector(".topnav__right .settings"),
        link: {
          href: link.getAttribute("href"),
          cls: link.className,
          current: link.getAttribute("aria-current"),
        },
      };
    });
    assert.deepEqual(shellState, {
      title: "Release Agenda",
      routeClass: true,
      errorHidden: true,
      mainClass: "list-main cdl-agenda",
      placedAfterSiteMain: true,
      footerAfter: true,
      entryBeforeSettings: true,
      link: { href: "/agenda", cls: "icon-btn", current: "page" },
    });

    const readWeek = () =>
      page.evaluate(() => ({
        label: document.querySelector(".cdl-agenda-weekline strong")
          .textContent,
        today: [...document.querySelectorAll(".cdl-agenda-day")].findIndex(
          (day) => day.classList.contains("is-today"),
        ),
        days: [...document.querySelectorAll(".cdl-agenda-day")].map((day) =>
          [...day.querySelectorAll("a.card.card--compact")].map((card) => ({
            title: card.querySelector(".card__title").textContent,
            href: card.getAttribute("href"),
            time: card
              .querySelector(".card__time")
              .textContent.replace(/\s/g, " "),
            level: [...card.classList].find((name) => name.startsWith("is-")),
            poster: card.querySelector(".poster img")
              ? "image"
              : card.querySelector(".poster").textContent,
          })),
        ),
        sections: [
          ...document.querySelectorAll(
            "#cdl-agenda-main > .section .section__title",
          ),
        ].map((node) => node.textContent),
        other: [
          ...document.querySelectorAll(
            "#cdl-agenda-main .grid-updates .card__title",
          ),
        ].map((node) => node.textContent),
      }));
    const week = await readWeek();
    assert.equal(week.today, (new Date().getDay() + 6) % 7);
    assert.deepEqual(week.days, [
      [],
      [
        {
          title: "First Light",
          href: "/title/first-light",
          time: "~6:00 PM",
          level: "is-on-schedule",
          poster: "image",
        },
      ],
      [],
      [
        {
          title: "Slow Tide",
          href: "/title/slow-tide",
          time: "Broad estimate",
          level: "is-estimated",
          poster: "ST",
        },
      ],
      [],
      [
        {
          title: "Overdue Knight",
          href: "/title/overdue-knight",
          time: "+/- 1 day",
          level: "is-late",
          poster: "OK",
        },
      ],
      [],
    ]);
    assert.deepEqual(week.sections, [
      "Release Agenda",
      "Other weeks",
      "Not scheduled yet",
    ]);
    assert.deepEqual(week.other, ["Next Arc", "Quiet Season"]);
    assert.match(
      await page.locator(".cdl-agenda-weekline span").textContent(),
      /^5 followed \/ 4 placed \/ Europe\/Paris$/,
    );

    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - innerWidth,
        columns: getComputedStyle(
          document.querySelector(".cdl-agenda-week"),
        ).gridTemplateColumns.split(" ").length,
      }));
      assert.ok(
        layout.overflow <= 0,
        `no horizontal scroll at ${width}px: ${JSON.stringify(layout)}`,
      );
      assert.equal(
        layout.columns,
        width >= 1181 ? 7 : width > 760 ? 4 : 1,
        `week columns at ${width}px`,
      );
      await page.screenshot({
        path: path.join(output, `agenda-${width}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    // Week navigation moves predictions between the grid and "Other weeks".
    const thisWeekLabel = week.label;
    await page.getByRole("button", { name: "Next week", exact: true }).click();
    const nextWeek = await readWeek();
    assert.notEqual(nextWeek.label, thisWeekLabel);
    assert.deepEqual(
      nextWeek.days[1].map((card) => card.title),
      ["Next Arc"],
    );
    assert.equal(nextWeek.today, -1);
    assert.deepEqual(nextWeek.other, [
      "First Light",
      "Slow Tide",
      "Overdue Knight",
      "Quiet Season",
    ]);
    await page.getByRole("button", { name: "This week", exact: true }).click();
    assert.equal((await readWeek()).label, thisWeekLabel);

    // If comix re-renders around the page, the same agenda is re-attached without refetching.
    await page.evaluate(() =>
      document.getElementById("cdl-agenda-main").remove(),
    );
    await page.locator("#cdl-agenda-main .cdl-agenda-week").waitFor();
    assert.deepEqual(await worker.evaluate(() => self.agendaCalls), {
      get: 1,
      refresh: 1,
    });

    // Leaving through comix's client-side navigation restores the site's page.
    await page.evaluate(() => history.pushState({}, "", "/home"));
    await page.waitForFunction(
      () => !document.getElementById("cdl-agenda-main"),
    );
    assert.deepEqual(
      await page.evaluate(() => ({
        routeClass:
          document.documentElement.classList.contains("cdl-agenda-route"),
        errorShown: getComputedStyle(document.querySelector(".error-main"))
          .display,
        current: document
          .querySelector("#cdl-agenda-topnav-entry a")
          .getAttribute("aria-current"),
      })),
      { routeClass: false, errorShown: "flex", current: null },
    );
    await page.evaluate(() => history.back());
    await page.locator("#cdl-agenda-main .cdl-agenda-week").waitFor();

    // Without an active Plus trial or subscription, the page explains what to do.
    await worker.evaluate(() => {
      self.agendaLocked = true;
    });
    await page.reload();
    await page
      .getByText("Release Agenda is part of Comix Downloader Plus.", {
        exact: true,
      })
      .waitFor();
    await page.screenshot({ path: path.join(output, "agenda-locked.png") });
    // Check the URL the extension asked for: the tab can load before the route stub
    // attaches, and live comix.to then redirects a signed-out /user page to /home.
    await worker.evaluate(() => {
      self.__cdlOpenedUrls = [];
      const create = chrome.tabs.create.bind(chrome.tabs);
      chrome.tabs.create = (props, ...rest) => {
        self.__cdlOpenedUrls.push(props && props.url);
        return create(props, ...rest);
      };
    });
    const settingsTab = context.waitForEvent("page");
    await page
      .getByRole("button", { name: "Open Plus settings", exact: true })
      .click();
    const opened = await settingsTab;
    await opened.waitForLoadState("domcontentloaded");
    const requested = await worker.evaluate(() => self.__cdlOpenedUrls.splice(0));
    assert.ok(
      opened.url() === `${origin}/user?tab=settings` || requested.includes(`${origin}/user?tab=settings`),
      `opened ${opened.url()} (extension asked for ${requested.join(", ")})`,
    );
    // The tab opens first; the "open the Plus view" flag is written right after it.
    let view = null;
    for (let attempt = 0; attempt < 50 && view !== "plus"; attempt++) {
      view = await worker.evaluate(
        async () =>
          (await chrome.storage.local.get("cdlOpenExtSettingsView"))
            .cdlOpenExtSettingsView,
      );
      if (view !== "plus")
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(view, "plus");

    assert.deepEqual(errors, []);
    console.log(
      "PASS packaged Release Agenda: native comix shell, week grid, backfill, navigation, re-render, route exit, Plus gate, 1440/1024/390 layouts.",
    );
  } finally {
    if (context) await context.close();
    await fs.rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

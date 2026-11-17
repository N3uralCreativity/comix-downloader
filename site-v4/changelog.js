/* Comix Downloader changelog: paginated GitHub history with local caching. */
(function (root, factory) {
  "use strict";

  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
    return;
  }

  root.CDLChangelog = api;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", api.init);
  } else {
    api.init();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var REPOSITORY = "N3uralCreativity/comix-downloader";
  var BRANCH = "master";
  var API_URL = "https://api.github.com/repos/" + REPOSITORY + "/commits";
  var COMMIT_URL = "https://github.com/" + REPOSITORY + "/commit/";
  var HISTORY_URL = "https://github.com/" + REPOSITORY + "/commits/" + BRANCH;
  var PAGE_SIZE = 100;
  var CACHE_KEY = "cdl-changelog-cache-v1";
  var CACHE_TTL = 15 * 60 * 1000;
  var TYPE_ORDER = ["ALL", "PATCH", "ADD", "REMOVE", "DOCS", "TEST", "RELEASE", "REFACTOR", "CI", "CHORE", "CHANGE"];

  var PREFIX_TYPES = {
    fix: "PATCH",
    hotfix: "PATCH",
    bugfix: "PATCH",
    feat: "ADD",
    feature: "ADD",
    add: "ADD",
    remove: "REMOVE",
    delete: "REMOVE",
    drop: "REMOVE",
    docs: "DOCS",
    doc: "DOCS",
    test: "TEST",
    tests: "TEST",
    release: "RELEASE",
    refactor: "REFACTOR",
    perf: "REFACTOR",
    ci: "CI",
    workflow: "CI",
    chore: "CHORE",
    build: "CHORE",
    style: "CHORE"
  };

  var KEYWORD_RULES = [
    { type: "REMOVE", pattern: /\b(remove[ds]?|removing|delete[ds]?|delet(?:e|ed|ing)|drop(?:ped|s|ping)?|deprecat(?:e|ed|es|ing)|retir(?:e|ed|es|ing)|disable[ds]?|disabling)\b/i },
    { type: "PATCH", pattern: /\b(fix(?:ed|es|ing)?|patch(?:ed|es|ing)?|resolv(?:e|ed|es|ing)|repair(?:ed|s|ing)?|correct(?:ed|s|ing)?|prevent(?:ed|s|ing)?|restor(?:e|ed|es|ing)|regression|bug(?:fix)?|harden(?:ed|s|ing)?)\b/i },
    { type: "ADD", pattern: /\b(add(?:ed|s|ing)?|implement(?:ed|s|ing)?|introduc(?:e|ed|es|ing)|creat(?:e|ed|es|ing)|support(?:ed|s|ing)?|enable[ds]?|enabling|new|feature)\b/i },
    { type: "DOCS", pattern: /\b(docs?|documentation|readme|privacy|policy|website|site copy)\b/i },
    { type: "TEST", pattern: /\b(tests?|testing|specs?|validat(?:e|ed|es|ing)|lint(?:ed|s|ing)?)\b/i },
    { type: "RELEASE", pattern: /\b(release[ds]?|version(?:ed|s|ing)?|tag(?:ged|s|ging)?)\b/i },
    { type: "REFACTOR", pattern: /\b(refactor(?:ed|s|ing)?|cleanup|clean up|reorganiz(?:e|ed|es|ing)|simplif(?:y|ied|ies|ying)|optimiz(?:e|ed|es|ing)|performance)\b/i },
    { type: "CI", pattern: /\b(ci|workflow|workflows|github actions|pipeline)\b/i },
    { type: "CHORE", pattern: /\b(chore|bump(?:ed|s|ing)?|sync(?:ed|s|ing)?|merge[ds]?|merging|update[ds]?|updating|build)\b/i }
  ];

  function classifyCommit(message) {
    var text = String(message || "").trim();
    var prefix = text.match(/^(?:revert\s+)?([a-z]+)(?:\([^)]*\))?!?:/i);
    if (prefix) {
      var prefixType = PREFIX_TYPES[prefix[1].toLowerCase()];
      if (prefixType) return prefixType;
    }

    for (var i = 0; i < KEYWORD_RULES.length; i++) {
      if (KEYWORD_RULES[i].pattern.test(text)) return KEYWORD_RULES[i].type;
    }
    return "CHANGE";
  }

  function splitMessage(message) {
    var normalized = String(message || "").replace(/\r\n/g, "\n").trim();
    if (!normalized) return { title: "Untitled commit", body: "" };
    var newline = normalized.indexOf("\n");
    if (newline === -1) return { title: normalized, body: "" };
    return {
      title: normalized.slice(0, newline).trim(),
      body: normalized.slice(newline + 1).trim()
    };
  }

  function normalizeCommit(item) {
    if (!item || !item.sha || !item.commit) return null;
    var message = splitMessage(item.commit.message);
    var author = item.author && item.author.login
      ? item.author.login
      : item.commit.author && item.commit.author.name
        ? item.commit.author.name
        : "Unknown author";

    return {
      sha: String(item.sha),
      title: message.title,
      body: message.body,
      date: item.commit.author && item.commit.author.date
        ? item.commit.author.date
        : item.commit.committer && item.commit.committer.date
          ? item.commit.committer.date
          : "",
      author: author,
      type: classifyCommit(item.commit.message)
    };
  }

  function makeApiError(response) {
    var error = new Error("GitHub returned HTTP " + response.status + ".");
    error.status = response.status;
    if (response.status === 403 && response.headers && response.headers.get("x-ratelimit-remaining") === "0") {
      var resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
      if (Number.isFinite(resetSeconds)) {
        error.message = "GitHub's public API limit was reached. It resets at " +
          new Date(resetSeconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + ".";
      } else {
        error.message = "GitHub's public API limit was reached. Please try again later.";
      }
    }
    return error;
  }

  async function fetchCommitPage(fetchImpl, page, sha) {
    var url = new URL(API_URL);
    url.searchParams.set("sha", sha);
    url.searchParams.set("per_page", String(PAGE_SIZE));
    url.searchParams.set("page", String(page));

    var response = await fetchImpl(url.toString(), {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      cache: "no-store"
    });
    if (!response.ok) throw makeApiError(response);

    var data = await response.json();
    if (!Array.isArray(data)) throw new Error("GitHub returned an unexpected response.");
    return data;
  }

  async function fetchAllCommits(fetchImpl, onProgress) {
    var fetcher = fetchImpl || fetch;
    var firstPage = await fetchCommitPage(fetcher, 1, BRANCH);
    var rawCommits = firstPage.slice();
    var pinnedHead = firstPage.length ? firstPage[0].sha : BRANCH;
    var page = 1;
    if (onProgress) onProgress(rawCommits.length);

    while (rawCommits.length && rawCommits.length % PAGE_SIZE === 0) {
      page += 1;
      var nextPage = await fetchCommitPage(fetcher, page, pinnedHead);
      rawCommits = rawCommits.concat(nextPage);
      if (onProgress) onProgress(rawCommits.length);
      if (nextPage.length < PAGE_SIZE) break;
    }

    var seen = Object.create(null);
    return rawCommits.map(normalizeCommit).filter(function (commit) {
      if (!commit || seen[commit.sha]) return false;
      seen[commit.sha] = true;
      return true;
    });
  }

  function matchesCommit(commit, query, type) {
    if (type && type !== "ALL" && commit.type !== type) return false;
    if (!query) return true;
    var haystack = [commit.title, commit.body, commit.author, commit.sha, commit.type].join(" ").toLocaleLowerCase();
    return haystack.indexOf(query.toLocaleLowerCase()) !== -1;
  }

  function readCache(storage, now) {
    try {
      if (!storage) return null;
      var cached = JSON.parse(storage.getItem(CACHE_KEY));
      if (!cached || cached.version !== 1 || !Array.isArray(cached.commits) || !Number.isFinite(cached.savedAt)) return null;
      var commits = cached.commits.filter(function (commit) {
        return commit &&
          typeof commit.sha === "string" &&
          /^[0-9a-f]{7,64}$/i.test(commit.sha) &&
          typeof commit.title === "string" &&
          typeof commit.body === "string" &&
          typeof commit.date === "string" &&
          typeof commit.author === "string";
      }).map(function (commit) {
        return {
          sha: commit.sha,
          title: commit.title,
          body: commit.body,
          date: commit.date,
          author: commit.author,
          type: TYPE_ORDER.indexOf(commit.type) > 0
            ? commit.type
            : classifyCommit(commit.title + "\n" + commit.body)
        };
      });
      if (cached.commits.length && !commits.length) return null;
      return {
        commits: commits,
        savedAt: cached.savedAt,
        fresh: (now || Date.now()) - cached.savedAt < CACHE_TTL
      };
    } catch (error) {
      return null;
    }
  }

  function writeCache(storage, commits) {
    try {
      if (!storage) return;
      storage.setItem(CACHE_KEY, JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        commits: commits
      }));
    } catch (error) {
      // The live changelog still works when storage is unavailable or full.
    }
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function init() {
    var list = document.getElementById("commit-list");
    if (!list) return;

    var ui = {
      list: list,
      skeleton: document.getElementById("skeleton-list"),
      search: document.getElementById("commit-search"),
      filters: document.getElementById("category-filters"),
      refresh: document.getElementById("refresh-button"),
      results: document.getElementById("results-count"),
      status: document.getElementById("load-status"),
      sync: document.getElementById("sync-state")
    };
    var state = { commits: [], activeType: "ALL", loading: false };

    var dateFormatter = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit"
    });
    var monthFormatter = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "long"
    });
    var timeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

    function validDate(value) {
      var parsed = value ? new Date(value) : null;
      return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
    }

    function relativeSavedTime(savedAt) {
      var minutes = Math.round((savedAt - Date.now()) / 60000);
      if (Math.abs(minutes) < 1) return "just now";
      if (Math.abs(minutes) < 60) return timeFormatter.format(minutes, "minute");
      var hours = Math.round(minutes / 60);
      if (Math.abs(hours) < 24) return timeFormatter.format(hours, "hour");
      return timeFormatter.format(Math.round(hours / 24), "day");
    }

    function setLoading(loading) {
      state.loading = loading;
      ui.refresh.disabled = loading;
      ui.refresh.classList.toggle("loading", loading);
      ui.skeleton.hidden = !loading || state.commits.length > 0;
      if (loading) {
        ui.sync.className = "sync-state loading";
        ui.sync.textContent = "Synchronizing";
      }
    }

    function setStatus(kind, text) {
      ui.status.dataset.kind = kind || "";
      ui.status.textContent = text || "";
    }

    function buildFilters() {
      var counts = { ALL: state.commits.length };
      state.commits.forEach(function (commit) {
        counts[commit.type] = (counts[commit.type] || 0) + 1;
      });

      var fragment = document.createDocumentFragment();
      TYPE_ORDER.forEach(function (type) {
        if (type !== "ALL" && !counts[type]) return;
        var button = element("button", "filter-button");
        button.type = "button";
        button.dataset.type = type;
        button.setAttribute("aria-pressed", type === state.activeType ? "true" : "false");
        button.appendChild(element("span", "", type));
        button.appendChild(element("span", "filter-count", String(counts[type] || 0)));
        fragment.appendChild(button);
      });
      ui.filters.replaceChildren(fragment);
    }

    function createCommitRow(commit) {
      var row = element("article", "commit-row");
      var meta = element("div", "commit-meta");
      meta.appendChild(element("span", "commit-tag type-" + commit.type.toLowerCase(), commit.type));

      var date = validDate(commit.date);
      var time = element("time", "commit-date", date ? dateFormatter.format(date) : "Date unavailable");
      if (date) time.dateTime = date.toISOString();
      meta.appendChild(time);

      var content = element("div", "commit-content");
      var title = element("a", "commit-title", commit.title);
      title.href = COMMIT_URL + encodeURIComponent(commit.sha);
      title.target = "_blank";
      title.rel = "noopener";
      content.appendChild(title);
      if (commit.body) content.appendChild(element("p", "commit-body", commit.body));

      var foot = element("div", "commit-foot");
      foot.appendChild(element("span", "commit-sha", commit.sha.slice(0, 7)));
      foot.appendChild(element("span", "commit-separator", "/"));
      foot.appendChild(element("span", "", commit.author));
      content.appendChild(foot);

      row.appendChild(meta);
      row.appendChild(content);
      return row;
    }

    function renderEmpty() {
      var box = element("div", "empty-state");
      box.appendChild(element("h2", "", "No matching commits"));
      box.appendChild(element("p", "", "Try another search or show all change types."));
      var clear = element("button", "", "Clear filters");
      clear.type = "button";
      clear.addEventListener("click", function () {
        state.activeType = "ALL";
        ui.search.value = "";
        buildFilters();
        render();
        ui.search.focus();
      });
      box.appendChild(clear);
      ui.list.replaceChildren(box);
    }

    function render() {
      var query = ui.search.value.trim();
      var filtered = state.commits.filter(function (commit) {
        return matchesCommit(commit, query, state.activeType);
      });
      ui.results.textContent = "Showing " + filtered.length + " of " + state.commits.length + " commits";

      if (!filtered.length) {
        renderEmpty();
        return;
      }

      var groups = [];
      var byMonth = Object.create(null);
      filtered.forEach(function (commit) {
        var date = validDate(commit.date);
        var key = date ? date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") : "unknown";
        if (!byMonth[key]) {
          byMonth[key] = {
            label: date ? monthFormatter.format(date) : "Date unavailable",
            commits: []
          };
          groups.push(byMonth[key]);
        }
        byMonth[key].commits.push(commit);
      });

      var fragment = document.createDocumentFragment();
      groups.forEach(function (group) {
        var section = element("section", "change-month");
        var heading = element("header", "month-head");
        heading.appendChild(element("h2", "", group.label));
        heading.appendChild(element("span", "", group.commits.length + (group.commits.length === 1 ? " commit" : " commits")));
        section.appendChild(heading);
        group.commits.forEach(function (commit) {
          section.appendChild(createCommitRow(commit));
        });
        fragment.appendChild(section);
      });
      ui.list.replaceChildren(fragment);
    }

    function showFatalError(message) {
      var box = element("div", "error-state");
      box.appendChild(element("h2", "", "The changelog could not be loaded"));
      box.appendChild(element("p", "", message));
      var link = element("a", "", "Open the history on GitHub");
      link.href = HISTORY_URL;
      link.target = "_blank";
      link.rel = "noopener";
      box.appendChild(link);
      ui.list.replaceChildren(box);
      ui.results.textContent = "Commit history unavailable";
    }

    async function load(force) {
      if (state.loading) return;
      var storage = null;
      try { storage = window.localStorage; } catch (error) { /* storage is optional */ }
      var cached = readCache(storage);

      if (!force && cached) {
        state.commits = cached.commits;
        buildFilters();
        render();
        ui.sync.className = "sync-state";
        ui.sync.textContent = "Cached " + relativeSavedTime(cached.savedAt);
        setStatus("", cached.fresh ? "Local cache" : "Refreshing stale cache");
        if (cached.fresh) {
          setLoading(false);
          return;
        }
      }

      setLoading(true);
      setStatus("", state.commits.length ? "Refreshing..." : "Fetching page 1...");
      try {
        var commits = await fetchAllCommits(window.fetch.bind(window), function (count) {
          setStatus("", "Fetched " + count + " commits...");
        });
        state.commits = commits;
        if (!commits.length) throw new Error("The repository returned no commits.");
        writeCache(storage, commits);
        buildFilters();
        render();
        ui.sync.className = "sync-state";
        ui.sync.textContent = "Live history";
        setStatus("", "Updated just now");
      } catch (error) {
        ui.sync.className = "sync-state error";
        if (state.commits.length) {
          ui.sync.textContent = "Using cached history";
          setStatus("error", error.message || "Refresh failed.");
        } else {
          ui.sync.textContent = "GitHub unavailable";
          setStatus("error", "Load failed");
          showFatalError(error.message || "Please try again later.");
        }
      } finally {
        setLoading(false);
      }
    }

    ui.search.addEventListener("input", render);
    ui.filters.addEventListener("click", function (event) {
      var button = event.target.closest(".filter-button");
      if (!button) return;
      state.activeType = button.dataset.type;
      Array.prototype.forEach.call(ui.filters.querySelectorAll(".filter-button"), function (item) {
        item.setAttribute("aria-pressed", item === button ? "true" : "false");
      });
      render();
    });
    ui.refresh.addEventListener("click", function () { load(true); });

    load(false);
  }

  return {
    CACHE_KEY: CACHE_KEY,
    CACHE_TTL: CACHE_TTL,
    TYPE_ORDER: TYPE_ORDER,
    classifyCommit: classifyCommit,
    splitMessage: splitMessage,
    normalizeCommit: normalizeCommit,
    fetchAllCommits: fetchAllCommits,
    matchesCommit: matchesCommit,
    readCache: readCache,
    init: init
  };
});

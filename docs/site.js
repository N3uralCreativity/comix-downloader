/* Comix Downloader — shared site behaviour (progressive enhancement) */
(function () {
  "use strict";

  var burger = document.querySelector(".nav-burger");
  var links = document.querySelector(".nav-links");
  if (!burger || !links) return;

  function setOpen(open) {
    links.classList.toggle("open", open);
    burger.setAttribute("aria-expanded", open ? "true" : "false");
  }

  // Toggle on the burger itself
  burger.addEventListener("click", function (e) {
    e.stopPropagation();
    setOpen(!links.classList.contains("open"));
  });

  // Close once a destination is chosen
  links.addEventListener("click", function (e) {
    if (e.target.closest("a")) setOpen(false);
  });

  // Close on Escape, returning focus to the toggle
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && links.classList.contains("open")) {
      setOpen(false);
      burger.focus();
    }
  });

  // Close when clicking outside the menu
  document.addEventListener("click", function (e) {
    if (
      links.classList.contains("open") &&
      !links.contains(e.target) &&
      !burger.contains(e.target)
    ) {
      setOpen(false);
    }
  });
})();

/* Arriving from the welcome page (?from=welcome#target): start at the top and
   smoothly scroll down to the target section, instead of the browser's instant jump. */
(function () {
  "use strict";
  if (!/[?&]from=welcome(?:&|$)/.test(location.search) || !location.hash) return;
  var target = null;
  try { target = document.querySelector(location.hash); } catch (e) { return; }
  if (!target) return;
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  window.scrollTo(0, 0);
  window.addEventListener("load", function () {
    window.scrollTo(0, 0); // undo the browser's automatic anchor jump
    var attempts = 0;
    var glide = function () {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      // Images loading in above the target shift the layout while we glide, so
      // re-correct until the section actually sits at the top (or we give up).
      attempts++;
      setTimeout(function () {
        var top = target.getBoundingClientRect().top;
        if (Math.abs(top - 84) > 60 && attempts < 5) glide();
      }, 1300);
    };
    setTimeout(glide, 350);
  });
})();

/* Documentation — Linux browser + distro install-command selectors (icon dropdowns) */
(function () {
  "use strict";
  var pick = document.getElementById("distro-pick");
  if (!pick) return;
  var out = document.getElementById("distro-cmd");

  // command = CMDS[browser][distro]
  var CMDS = {
    firefox: {
      debian: "sudo apt update && sudo apt install firefox",
      fedora: "sudo dnf install firefox",
      arch: "sudo pacman -S firefox",
      suse: "sudo zypper install MozillaFirefox",
      flatpak: "flatpak install flathub org.mozilla.firefox",
      gentoo: "sudo emerge --ask www-client/firefox",
      void: "sudo xbps-install -Sy firefox",
      alpine: "sudo apk add firefox",
      nixos: "nix-env -iA nixpkgs.firefox   # or add pkgs.firefox to configuration.nix"
    },
    chrome: {
      debian: "wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt install ./google-chrome-stable_current_amd64.deb",
      fedora: "sudo dnf install https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm",
      arch: "yay -S google-chrome   # from the AUR (needs an AUR helper)",
      suse: "sudo zypper install https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm",
      flatpak: "flatpak install flathub com.google.Chrome",
      gentoo: "sudo emerge --ask www-client/google-chrome",
      void: "flatpak install flathub com.google.Chrome   # not in Void's repos — install via Flatpak",
      alpine: "sudo apk add chromium   # Google Chrome needs glibc; Alpine is musl, so use Chromium",
      nixos: "nix-env -iA nixpkgs.google-chrome   # unfree package: needs allowUnfree"
    }
  };
  var state = { browser: "firefox", distro: "debian" };
  function render() {
    var b = CMDS[state.browser] || {};
    if (out && b[state.distro]) out.textContent = b[state.distro];
  }

  var dropdowns = [];
  function closeAll(except) {
    for (var i = 0; i < dropdowns.length; i++) if (dropdowns[i].menu !== except) dropdowns[i].close();
  }
  function wire(triggerId, menuId, key) {
    var trigger = document.getElementById(triggerId);
    var menu = document.getElementById(menuId);
    if (!trigger || !menu) return;
    var opts = menu.querySelectorAll(".distro-opt");
    var name = trigger.querySelector(".distro-name");
    var ico = trigger.querySelector(".distro-ico");
    function setOpen(open) {
      menu.hidden = !open;
      trigger.setAttribute("aria-expanded", open ? "true" : "false");
    }
    function select(opt) {
      for (var i = 0; i < opts.length; i++) {
        var active = opts[i] === opt;
        opts[i].classList.toggle("is-active", active);
        opts[i].setAttribute("aria-selected", active ? "true" : "false");
      }
      state[key] = opt.getAttribute("data-" + key);
      if (name) name.textContent = opt.textContent.trim();
      var img = opt.querySelector("img");
      if (img && ico) ico.src = img.src;
      render();
    }
    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      var willOpen = menu.hidden;
      closeAll(menu);
      setOpen(willOpen);
    });
    menu.addEventListener("click", function (e) {
      var opt = e.target.closest(".distro-opt");
      if (opt) { select(opt); setOpen(false); trigger.focus(); }
    });
    dropdowns.push({ menu: menu, close: function () { setOpen(false); } });
  }

  wire("browser-trigger", "browser-menu", "browser");
  wire("distro-trigger", "distro-menu", "distro");
  document.addEventListener("click", function (e) { if (!pick.contains(e.target)) closeAll(null); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeAll(null); });
  render();

  // click-to-copy the current command
  var copyBtn = document.getElementById("distro-copy");
  if (copyBtn && out) {
    var resetTimer;
    function flash() {
      copyBtn.classList.add("copied");
      copyBtn.title = "Copied!";
      clearTimeout(resetTimer);
      resetTimer = setTimeout(function () {
        copyBtn.classList.remove("copied");
        copyBtn.title = "Copy command";
      }, 1600);
    }
    function legacyCopy(text) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text; ta.setAttribute("readonly", "");
        ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta);
        flash();
      } catch (e) { /* no-op */ }
    }
    copyBtn.addEventListener("click", function () {
      var text = out.textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(flash, function () { legacyCopy(text); });
      } else {
        legacyCopy(text);
      }
    });
  }
})();

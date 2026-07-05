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

/* Documentation — Linux distro install-command selector (icon dropdown) */
(function () {
  "use strict";
  var pick = document.getElementById("distro-pick");
  if (!pick) return;
  var trigger = document.getElementById("distro-trigger");
  var menu = document.getElementById("distro-menu");
  var out = document.getElementById("distro-cmd");
  var tName = document.getElementById("distro-trigger-name");
  var tIco = document.getElementById("distro-trigger-ico");
  if (!trigger || !menu) return;
  var opts = menu.querySelectorAll(".distro-opt");
  var cmds = {
    debian: "sudo apt update && sudo apt install firefox",
    fedora: "sudo dnf install firefox",
    arch: "sudo pacman -S firefox",
    suse: "sudo zypper install MozillaFirefox",
    flatpak: "flatpak install flathub org.mozilla.firefox",
    gentoo: "sudo emerge --ask www-client/firefox",
    void: "sudo xbps-install -Sy firefox",
    alpine: "sudo apk add firefox",
    nixos: "nix-env -iA nixpkgs.firefox   # or add pkgs.firefox to configuration.nix"
  };
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
    var key = opt.getAttribute("data-distro");
    if (tName) tName.textContent = opt.textContent.trim();
    var img = opt.querySelector("img");
    if (img && tIco) tIco.src = img.src;
    if (out && cmds[key]) out.textContent = cmds[key];
  }
  trigger.addEventListener("click", function (e) {
    e.stopPropagation();
    setOpen(menu.hidden);
  });
  menu.addEventListener("click", function (e) {
    var opt = e.target.closest(".distro-opt");
    if (opt) { select(opt); setOpen(false); trigger.focus(); }
  });
  document.addEventListener("click", function (e) {
    if (!pick.contains(e.target)) setOpen(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !menu.hidden) { setOpen(false); trigger.focus(); }
  });
})();

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

/* Documentation — Linux distro install-command selector */
(function () {
  "use strict";
  var pick = document.getElementById("distro-pick");
  if (!pick) return;
  var out = document.getElementById("distro-cmd");
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
  var tabs = pick.querySelectorAll(".distro-tab");
  function select(tab) {
    for (var i = 0; i < tabs.length; i++) {
      var active = tabs[i] === tab;
      tabs[i].classList.toggle("is-active", active);
      tabs[i].setAttribute("aria-selected", active ? "true" : "false");
    }
    var key = tab.getAttribute("data-distro");
    if (out && cmds[key]) out.textContent = cmds[key];
  }
  pick.addEventListener("click", function (e) {
    var tab = e.target.closest(".distro-tab");
    if (tab) select(tab);
  });
})();

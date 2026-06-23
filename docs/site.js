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

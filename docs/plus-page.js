(function () {
  'use strict';
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.product-tab'));
  var panels = Array.prototype.slice.call(document.querySelectorAll('.product-panel'));
  if (!tabs.length || !panels.length) return;

  function activate(tab, focus) {
    var panelId = tab.getAttribute('aria-controls');
    tabs.forEach(function (item) {
      var active = item === tab;
      item.setAttribute('aria-selected', active ? 'true' : 'false');
      item.tabIndex = active ? 0 : -1;
    });
    panels.forEach(function (panel) { panel.hidden = panel.id !== panelId; });
    if (focus) tab.focus();
  }

  tabs.forEach(function (tab, index) {
    tab.addEventListener('click', function () { activate(tab, false); });
    tab.addEventListener('keydown', function (event) {
      var next = index;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      activate(tabs[next], true);
    });
  });
  activate(tabs[0], false);
})();

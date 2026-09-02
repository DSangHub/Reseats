(function () {
  'use strict';

  var installPrompt;
  var installButtons = document.querySelectorAll('[data-install-app]');
  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/service-worker.js').catch(function () {
        // The receipt vault still works online if offline support cannot start.
      });
    });
  }

  if (!standalone) {
    installButtons.forEach(function (button) { button.hidden = false; });
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    installPrompt = event;
    installButtons.forEach(function (button) { button.hidden = false; });
  });

  installButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      if (installPrompt) {
        installPrompt.prompt();
        installPrompt.userChoice.finally(function () { installPrompt = null; });
        return;
      }

      var appleMobile = /iphone|ipad|ipod/i.test(navigator.userAgent);
      window.alert(appleMobile
        ? 'To install Reseats: tap Share in Safari, then choose Add to Home Screen.'
        : 'To install Reseats: open your browser menu and choose Install app or Add to Home screen.');
    });
  });

  window.addEventListener('appinstalled', function () {
    installButtons.forEach(function (button) { button.hidden = true; });
  });
})();

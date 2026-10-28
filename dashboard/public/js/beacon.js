// Reports uncaught client errors to the server access log (GET /_b?...), so embeds that
// render blank in a webview can be diagnosed. No path, token or data is sent.
(function () {
  var sent = 0;
  function report(kind, msg) {
    if (sent++ > 5) return;
    try {
      var q = 'k=' + kind + '&m=' + encodeURIComponent(String(msg).slice(0, 200)) +
        '&o=' + encodeURIComponent(String(location.origin)) +
        '&ua=' + encodeURIComponent(navigator.userAgent.slice(0, 160));
      new Image().src = '/_b?' + q;
    } catch (e) { /* nothing to do */ }
  }
  window.addEventListener('error', function (e) { report('error', (e && e.message) || 'error'); });
  window.addEventListener('unhandledrejection', function (e) { report('reject', (e && e.reason && e.reason.message) || e.reason || 'rejection'); });
  window.addEventListener('load', function () { report('load', 'ok'); });
})();

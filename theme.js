// Light/dark theme: applied before first paint (load this in <head>), remembered per browser.
// Dark (the original Resumatch look) is the default; light only when the user picks it.
(function () {
  const KEY = 'rm_theme';
  const root = document.documentElement;
  const saved = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
  root.dataset.theme = saved === 'light' ? 'light' : 'dark';

  function setTheme(t) {
    root.dataset.theme = t;
    try { localStorage.setItem(KEY, t); } catch { /* storage unavailable */ }
    const btn = document.querySelector('.theme-toggle');
    if (btn) btn.setAttribute('aria-label', t === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
  }
  window.toggleTheme = () => setTheme(root.dataset.theme === 'light' ? 'dark' : 'light');

  document.addEventListener('DOMContentLoaded', () => {
    const host = document.querySelector('nav .nav-right');
    if (!host || host.querySelector('.theme-toggle')) return;
    const btn = document.createElement('button');
    btn.className = 'theme-toggle';
    btn.type = 'button';
    btn.title = 'Toggle light / dark mode';
    btn.setAttribute('aria-label', root.dataset.theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
    btn.innerHTML = '<svg class="moon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'
      + '<svg class="sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
    btn.addEventListener('click', window.toggleTheme);
    host.prepend(btn);
  });
})();

/**
 * HomePiNAS - Theme and Language Initialization
 * Runs before main.js to prevent FOUC (Flash of Unstyled Content)
 */
(function() {
    const html = document.documentElement;
    const themeToggle = document.getElementById('theme-toggle');
    const langToggle = document.getElementById('lang-toggle');

    // Load saved theme or default to light
    const savedTheme = localStorage.getItem('homepinas-theme') || 'light';
    html.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);

    // Load saved language or default to Spanish
    const savedLang = localStorage.getItem('homepinas-lang') || 'es';
    html.setAttribute('data-lang', savedLang);
    html.setAttribute('lang', savedLang);
    updateLangIcon(savedLang);

    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            const current = html.getAttribute('data-theme');
            const next = current === 'light' ? 'dark' : 'light';
            html.setAttribute('data-theme', next);
            localStorage.setItem('homepinas-theme', next);
            updateThemeIcon(next);
        });
    }

    if (langToggle) {
        langToggle.addEventListener('click', () => {
            const current = html.getAttribute('data-lang') || 'es';
            const next = current === 'es' ? 'en' : 'es';
            html.setAttribute('data-lang', next);
            html.setAttribute('lang', next);
            localStorage.setItem('homepinas-lang', next);
            updateLangIcon(next);
            // Trigger i18n update event
            window.dispatchEvent(new CustomEvent('langchange', { detail: { lang: next } }));
        });
    }

    function updateThemeIcon(theme) {
        if (!themeToggle) return;
        themeToggle.textContent = theme === 'light' ? '\u{1F319}' : '\u{2600}\u{FE0F}';
        themeToggle.title = theme === 'light' ? 'Modo oscuro' : 'Modo claro';
    }

    function updateLangIcon(lang) {
        if (!langToggle) return;
        langToggle.textContent = lang === 'es' ? '\u{1F1EA}\u{1F1F8}' : '\u{1F1EC}\u{1F1E7}';
        langToggle.title = lang === 'es' ? 'Switch to English' : 'Cambiar a Espa\u00F1ol';
    }
})();

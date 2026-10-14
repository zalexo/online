// Keep the address out of HTML and the initial DOM. This deters simple scrapers,
// but a bot that executes JavaScript and clicks can still reveal the address.
(() => {
  const encodedAddress = 'YWxleGVpLnlhcmlsb3ZldHNAZ21haWwuY29t';

  document.querySelectorAll('[data-email-mode]').forEach(button => {
    button.addEventListener('click', () => {
      const address = atob(encodedAddress);
      const link = document.createElement('a');
      link.className = button.className;
      link.textContent = address;
      link.dir = 'ltr';

      if (button.dataset.emailMode === 'gmail') {
        const composeUrl = new URL('https://mail.google.com/mail/');
        composeUrl.search = new URLSearchParams({
          view: 'cm', fs: '1', to: address, su: button.dataset.emailSubject || ''
        });
        const signInUrl = new URL('https://accounts.google.com/AccountChooser/signinchooser');
        signInUrl.search = new URLSearchParams({ continue: composeUrl.href, service: 'mail' });
        link.href = signInUrl.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.setAttribute('aria-label', `${address} — לכתוב דרך Gmail בדפדפן`);
      } else {
        link.href = `mailto:${address}`;
      }

      button.replaceWith(link);
      link.focus();
    }, { once: true });
    button.hidden = false;
  });
})();

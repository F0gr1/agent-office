try {
  if (localStorage.getItem('agent-office-theme') === 'dark') {
    document.documentElement.dataset.theme = 'dark';
    document.querySelector('meta[name="theme-color"]').content = '#171e1a';
  }
} catch {
  /* Private storage may be unavailable. */
}

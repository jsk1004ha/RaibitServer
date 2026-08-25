const githubUrl = 'https://github.com/jsk1004ha/RaibitServer';

export function PublicFooter() {
  return (
    <footer className="landing-footer">
      <nav className="landing-footer-links" aria-label="푸터 탐색">
        <a href="/support">Support</a>
        <a href="/status">System Status</a>
        <a href={githubUrl} target="_blank" rel="noreferrer">GitHub</a>
        <a href="/contributors">Contributors</a>
        <a href="/privacy">Privacy Policy</a>
      </nav>
      <span className="landing-footer-copyright">© 2026 Raibit, ISHS.</span>
    </footer>
  );
}

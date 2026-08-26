export default function Loading() {
  return (
    <main className="landing-page">
      <section
        className="page"
        aria-live="polite"
        aria-busy="true"
      >
        <article className="card">
          <p className="eyebrow">RAIBIT SERVER</p>
          <h1 className="page-title">불러오는 중입니다</h1>
          <p className="muted" style={{ marginTop: 8 }}>
            잠시만 기다려 주세요.
          </p>
        </article>
      </section>
    </main>
  );
}

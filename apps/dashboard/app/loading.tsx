export default function Loading() {
  return (
    <main id="main-content" aria-busy="true" className="grid min-h-[100dvh] place-items-center bg-background px-raibit-lg py-raibit-xxl text-foreground">
      <section
        aria-live="polite"
        className="w-full max-w-lg rounded-lg border border-border bg-card p-raibit-xxl shadow-sm"
      >
        <p className="font-mono text-micro uppercase tracking-[0.08em] text-muted-foreground">RAIBIT SERVER</p>
        <h1 className="mt-raibit-sm text-display-md font-medium tracking-tight">불러오는 중입니다</h1>
        <p className="mt-raibit-sm text-body-md text-muted-foreground">잠시만 기다려 주세요.</p>
      </section>
    </main>
  );
}

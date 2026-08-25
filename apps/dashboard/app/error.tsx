'use client';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
	return (
		<main className="auth-page">
			<section className="auth-panel danger-zone" role="alert" aria-live="assertive">
				<header><p className="eyebrow">RAIBIT SERVER</p><h1>콘솔을 불러오지 못했습니다</h1><p>잠시 후 다시 시도하세요.</p></header>
				<button type="button" className="btn btn-primary" onClick={reset}>다시 시도</button>
				<footer><a href="/">메인으로 돌아가기</a><a href="/support">지원</a></footer>
			</section>
		</main>
	);
}

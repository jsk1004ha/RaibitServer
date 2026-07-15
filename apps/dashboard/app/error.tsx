'use client';

import { ConsoleShell } from '../components/console-ui';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
	return (
		<ConsoleShell crumbs="RAIBITSERVER / 오류">
			<section className="page">
				<article className="card danger-zone" role="alert" aria-live="assertive">
					<h1 className="page-title">콘솔을 불러오지 못했습니다</h1>
					<p className="muted" style={{ marginTop: 8 }}>잠시 후 다시 시도하세요. 계속 실패하면 API 상태와 세션 만료 여부를 확인하세요.</p>
					<button type="button" className="btn btn-primary" onClick={reset} style={{ marginTop: 12 }}>다시 시도</button>
				</article>
			</section>
		</ConsoleShell>
	);
}

import { ConsoleShell } from '../components/console-ui';

export default function Loading() {
	return (
		<ConsoleShell crumbs="RAIBITSERVER / 불러오는 중">
			<section className="page" aria-live="polite" aria-busy="true">
				<article className="card">
					<h1 className="page-title">콘솔을 불러오는 중입니다</h1>
					<p className="muted" style={{ marginTop: 8 }}>제어 평면의 최신 상태를 확인하고 있습니다.</p>
				</article>
			</section>
		</ConsoleShell>
	);
}

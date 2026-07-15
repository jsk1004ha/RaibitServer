import { ConsoleShell } from '../components/console-ui';

export default function NotFound() {
	return (
		<ConsoleShell crumbs="RAIBITSERVER / 찾을 수 없음">
			<section className="page">
				<article className="card" role="status">
					<h1 className="page-title">요청한 화면을 찾을 수 없습니다</h1>
					<p className="muted" style={{ marginTop: 8 }}>리소스가 삭제되었거나 접근 권한이 변경되었을 수 있습니다.</p>
					<a className="btn btn-primary" href="/" style={{ marginTop: 12 }}>운영 현황으로 돌아가기</a>
				</article>
			</section>
		</ConsoleShell>
	);
}

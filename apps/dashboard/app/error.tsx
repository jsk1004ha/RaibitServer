'use client';

import { ErrorScreen } from '../components/error-screen';
import { errorPageModel, normalizePublicIdentifier } from '../lib/error-page-model';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
	return (
		<ErrorScreen
			model={errorPageModel(500)}
			identifier={normalizePublicIdentifier(error.digest)}
			role="alert"
			actions={<><button type="button" className="btn btn-primary" onClick={reset}>다시 시도하기</button><a className="btn btn-ghost" href="/support">지원 보기</a></>}
		/>
	);
}

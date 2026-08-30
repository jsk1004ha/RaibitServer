'use client';

import { ErrorScreen } from '../components/error-screen';
import { errorPageModel, normalizePublicIdentifier } from '../lib/error-page-model';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
	return (
		<ErrorScreen
			model={errorPageModel(500)}
			identifier={normalizePublicIdentifier(error.digest)}
			role="alert"
			actions={<><button type="button" className="inline-flex min-h-11 items-center rounded-sm bg-primary px-raibit-md text-button-md text-primary-foreground" onClick={reset}>다시 시도하기</button><a className="inline-flex min-h-11 items-center rounded-sm border border-input px-raibit-md text-button-md" href="/support">지원 보기</a></>}
		/>
	);
}

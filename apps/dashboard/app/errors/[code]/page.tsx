import { notFound } from 'next/navigation';
import { ErrorScreen } from '../../../components/error-screen';
import {
  ERROR_STATUS_CODES,
  errorPageModel,
  errorStatusCode,
  isRetryableErrorStatusCode,
} from '../../../lib/error-page-model';

export function generateStaticParams() {
  return ERROR_STATUS_CODES.map((code) => ({ code: String(code) }));
}

export default async function ErrorPreview({ params }: { params: Promise<{ code: string }> }) {
  const { code: rawCode } = await params;
  const code = errorStatusCode(rawCode, 404);
  if (String(code) !== rawCode) notFound();
  const model = errorPageModel(code);
  const primaryHref = code === 401
    ? '/login'
    : code === 503 ? '/status'
      : isRetryableErrorStatusCode(code) ? `/errors/${code}` : '/';
  return (
    <ErrorScreen
      model={model}
      identifier={`preview-${code}`}
      actions={<><a className="btn btn-primary" href={primaryHref}>{model.actionLabel}</a><a className="btn btn-ghost" href="/errors">다른 오류 보기</a></>}
    />
  );
}

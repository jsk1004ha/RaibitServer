import { ErrorScreen } from '../components/error-screen';
import { errorPageModel } from '../lib/error-page-model';

export default function NotFound() {
	return <ErrorScreen model={{ ...errorPageModel(404), title: '요청한 화면을 찾을 수 없습니다' }} actions={<a className="inline-flex min-h-11 items-center rounded-sm bg-primary px-raibit-md text-button-md text-primary-foreground" href="/">메인으로 돌아가기</a>} />;
}

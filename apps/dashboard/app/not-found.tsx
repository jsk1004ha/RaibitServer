import { ErrorScreen } from '../components/error-screen';
import { errorPageModel } from '../lib/error-page-model';

export default function NotFound() {
	return <ErrorScreen model={{ ...errorPageModel(404), title: '요청한 화면을 찾을 수 없습니다' }} actions={<a className="btn btn-primary" href="/">메인으로 돌아가기</a>} />;
}

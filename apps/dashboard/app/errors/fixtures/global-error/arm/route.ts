import { NextResponse } from 'next/server';
import { assertE2eFixturesEnabled } from '../../fixture-access';

const globalErrorFixturePath = '/errors/fixtures/global-error';

export function GET(request: Request): NextResponse {
  assertE2eFixturesEnabled();
  const response = NextResponse.redirect(new URL(globalErrorFixturePath, request.url));
  response.cookies.set('T6_E2E_GLOBAL_ERROR', '1', {
    httpOnly: true,
    maxAge: 60,
    path: globalErrorFixturePath,
    sameSite: 'strict',
    secure: new URL(request.url).protocol === 'https:',
  });
  return response;
}

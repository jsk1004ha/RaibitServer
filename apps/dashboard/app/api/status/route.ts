import { loadSystemStatus } from '../../../lib/system-status';

export const dynamic = 'force-dynamic';

export async function GET() {
  const snapshot = await loadSystemStatus();
  return Response.json(snapshot, {
    headers: {
      'cache-control': 'no-store, max-age=0',
    },
  });
}

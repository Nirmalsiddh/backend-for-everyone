import { cookieSettings, backendOrigin, dashboardOrigin } from '@/lib/server/auth-config';
import { publicRuntimeOrigin } from '@/lib/server/runtime-origin';
export const dynamic = 'force-dynamic';
export function GET() {
  try { cookieSettings(); backendOrigin(); dashboardOrigin(); publicRuntimeOrigin(); return Response.json({ status: 'ready' }, { headers: { 'cache-control': 'no-store' } }); }
  catch { return Response.json({ status: 'unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } }); }
}

import { authHandler } from '@/lib/server/auth-handler';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  return authHandler(request, (await context.params).action);
}

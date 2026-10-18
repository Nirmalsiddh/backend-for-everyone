import { adapter } from '@/lib/server/adapter';
export const dynamic = 'force-dynamic';
async function handle(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return adapter(request, (await context.params).path, true);
}
export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };

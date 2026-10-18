import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cookieSettings, backendOrigin } from './auth-config';
export async function currentUser() {
  const token = (await cookies()).get(cookieSettings().name)?.value;
  if (!token || !/^ps_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const response = await fetch(`${backendOrigin()}/internal/auth/me`, {
    headers: { authorization: `Bearer ${token}` }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error('Authentication service unavailable');
  const user = await response.json();
  if (typeof user.id !== 'string' || typeof user.email !== 'string') throw new Error('Invalid authentication response');
  return { id: user.id as string, email: user.email as string };
}
export async function requireUser() {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}

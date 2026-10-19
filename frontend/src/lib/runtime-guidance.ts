export function errorGuidance(
  status: number,
  context: 'dashboard' | 'key' | 'session' | 'public' = 'dashboard',
) {
  if (status === 401)
    return context === 'dashboard'
      ? 'Your dashboard session has expired. Sign in again.'
      : context === 'key'
        ? 'Check the required project API key.'
        : context === 'session'
          ? 'Check the required application session token.'
          : 'Check the required runtime credential.';
  return (
    {
      400: 'Check request input.',
      403: 'Check API-key scope or authorization.',
      404: 'The record may not exist or may not be accessible to this user.',
      409: 'The request conflicts with existing data.',
      429: 'Wait and try again later.',
      503: 'The API is temporarily unavailable or setup needs attention.',
      504: 'The operation timed out; inspect state before retrying writes.',
    } as Record<number, string>
  )[status];
}

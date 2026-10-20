'use client';
import { clearRuntimeSuccesses } from '@/lib/project-visit';
import { useState, type FormEvent } from 'react';
export function AuthForm({ signup = false }: { signup?: boolean }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`/api/auth/${signup ? 'signup' : 'login'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: fields.get('email'),
          password: fields.get('password'),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        const retry = Number(response.headers.get('retry-after'));
        setMessage(
          (data.message ?? 'Authentication failed') +
            (signup && response.status >= 500
              ? ' The signup result could not be confirmed. Try signing in with the same account before signing up again.'
              : '') +
            (retry > 0
              ? ` Try again in approximately ${Math.ceil(retry)} seconds.`
              : ''),
        );
        return;
      }
      form.reset();
      if (signup) setMessage(data.message);
      else window.location.assign('/projects');
    } catch {
      setMessage(
        signup
          ? 'Response could not be confirmed. Try signing in with the same account before signing up again.'
          : 'Authentication service unavailable. Please retry.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <h1>{signup ? 'Create platform account' : 'Sign in'}</h1>
      <form onSubmit={submit}>
        <fieldset
          className="mutation-boundary"
          disabled={busy}
          aria-busy={busy}
        >
          <label>
            Email
            <input
              name="email"
              type="email"
              autoComplete="username"
              required
              maxLength={254}
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete={signup ? 'new-password' : 'current-password'}
              required
              minLength={signup ? 15 : 1}
              maxLength={256}
            />
          </label>
          {signup && <p>Use at least 15 characters.</p>}
          <button disabled={busy}>
            {busy ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}
          </button>
        </fieldset>
      </form>
      {message && <p role="status">{message}</p>}
      <a href={signup ? '/login' : '/signup'}>
        {signup ? 'Continue to sign in' : 'Create an account'}
      </a>
    </main>
  );
}
export function LogoutButton() {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) {
        setMessage('Logout could not be confirmed. Please retry.');
        return;
      }
      clearRuntimeSuccesses();
      window.location.assign('/login');
    } catch {
      setMessage('Logout could not be confirmed. Please retry.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <span>
      <button onClick={logout} disabled={busy}>
        Log out
      </button>
      {message && <span role="alert">{message}</span>}
    </span>
  );
}

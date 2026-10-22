'use client';
import { useId, useState } from 'react';
import { LogoutButton } from './platform-auth';

export function AccountControl({ email }: { email: string }) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const parts = email.split('@')[0].split(/[._+-]+/).filter(Boolean);
  const initials = (parts.length > 1
    ? Array.from(parts[0])[0] + Array.from(parts[1])[0]
    : Array.from(parts[0] ?? '?').slice(0, 2).join('')).toUpperCase();

  return (
    <div className="app-account">
      <button
        type="button"
        className="account-trigger"
        aria-label={`Account for ${email}`}
        aria-expanded={open}
        aria-controls={menuId}
        popoverTarget={menuId}
      >
        <span className="account-avatar" aria-hidden="true">{initials}</span>
        <span className="account-chevron" aria-hidden="true">⌄</span>
      </button>
      <div
        id={menuId}
        className="account-menu"
        popover="auto"
        role="group"
        aria-label="Account"
        onToggle={(event) => setOpen(event.currentTarget.matches(':popover-open'))}
      >
        <p className="account-menu-label">Signed in as</p>
        <p className="account-menu-email">{email}</p>
        <div className="account-menu-actions"><LogoutButton /></div>
      </div>
    </div>
  );
}

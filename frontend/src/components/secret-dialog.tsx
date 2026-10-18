'use client';
import { useEffect, useRef, useState } from 'react';
export function SecretDialog({
  secret,
  onClose,
}: {
  secret: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="secret-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id="secret-title">Copy your key now</h2>
      <p>
        This secret is shown once. Copied secrets may remain in your clipboard
        or screenshots after closing.
      </p>
      <pre data-testid="new-key">{secret}</pre>
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(secret);
            setCopied(true);
            setError('');
          } catch {
            setError(
              'Clipboard unavailable. Select and copy the key manually before closing.',
            );
          }
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      {error && <p role="alert">{error}</p>}
      <button onClick={onClose}>Close and clear secret</button>
    </dialog>
  );
}

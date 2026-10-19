'use client';
import { useState } from 'react';
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [message, setMessage] = useState('');
  return (
    <>
      <button
        type="button"
        aria-label={label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setMessage('Copied');
          } catch {
            setMessage('Could not copy. Select and copy the text manually.');
          }
        }}
      >
        Copy
      </button>
      <span role="status" aria-live="polite">
        {message}
      </span>
    </>
  );
}

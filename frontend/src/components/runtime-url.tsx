'use client';
import { useEffect, useState } from 'react';
import { CopyButton } from './copy-button';
export function RuntimeUrl({ slug }: { slug: string }) {
  const [origin, setOrigin] = useState('');
  useEffect(() => {
    setOrigin(
      document
        .querySelector('meta[name="runtime-origin"]')
        ?.getAttribute('content') ?? '',
    );
  }, []);
  const url = `${origin}/api/${slug}`;
  return (
    <section>
      <p>
        Public runtime base URL: <code>{url}</code>
      </p>
      {origin && <CopyButton text={url} label="Copy public runtime base URL" />}
      <p>This is the base URL your application calls.</p>
    </section>
  );
}

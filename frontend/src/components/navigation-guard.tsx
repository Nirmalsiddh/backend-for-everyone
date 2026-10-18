'use client';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter, usePathname } from 'next/navigation';
type Guard = {
  dirty: boolean;
  save?: () => Promise<boolean>;
  discard?: () => void;
};
const Context = createContext<Map<string, Guard> | null>(null);
export function NavigationProtection({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<string, Guard>()).current;
  const router = useRouter();
  const path = usePathname();
  const current = useRef('');
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    current.current = window.location.href;
  }, [path]);
  useEffect(() => {
    const dirty = () => [...entries.values()].some((g) => g.dirty);
    const click = (event: MouseEvent) => {
      const a = (event.target as Element).closest?.('a');
      if (
        !a ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey ||
        a.target === '_blank' ||
        a.hasAttribute('download')
      )
        return;
      const target = new URL(a.href);
      if (
        target.origin !== location.origin ||
        target.href === location.href ||
        !dirty()
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setMessage('');
      setPending(target.href);
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty()) event.preventDefault();
    };
    const back = () => {
      if (!dirty()) {
        current.current = location.href;
        return;
      }
      const target = location.href;
      history.pushState(null, '', current.current);
      setPending(target);
    };
    document.addEventListener('click', click, true);
    window.addEventListener('beforeunload', unload);
    window.addEventListener('popstate', back);
    return () => {
      document.removeEventListener('click', click, true);
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener('popstate', back);
    };
  }, [entries]);
  useEffect(() => {
    if (pending) dialog.current?.showModal();
    else dialog.current?.close();
  }, [pending]);
  function leave() {
    const destination = pending;
    setPending('');
    router.push(destination);
  }
  const dirty = [...entries.values()].filter((g) => g.dirty);
  return (
    <Context.Provider value={entries}>
      {children}
      <dialog
        ref={dialog}
        aria-labelledby="dirty-title"
        onCancel={(e) => {
          e.preventDefault();
          if (!busy) setPending('');
        }}
      >
        <h2 id="dirty-title">Unsaved changes</h2>
        <p>
          Save your changes before leaving, discard them, or stay on this page.
        </p>
        {message && <p role="alert">{message}</p>}
        <button
          disabled={busy || dirty.some((g) => !g.save)}
          onClick={async () => {
            setBusy(true);
            try {
              for (const guard of dirty)
                if (!(await guard.save?.())) {
                  setMessage(
                    'Changes could not be saved. Review validation or conflict errors.',
                  );
                  return;
                }
              leave();
            } finally {
              setBusy(false);
            }
          }}
        >
          Save and leave
        </button>
        <button
          disabled={busy}
          onClick={() => {
            dirty.forEach((g) => g.discard?.());
            leave();
          }}
        >
          Discard and leave
        </button>
        <button disabled={busy} onClick={() => setPending('')}>
          Stay
        </button>
      </dialog>
    </Context.Provider>
  );
}
export function DirtyGuard({
  dirty,
  save,
  discard,
}: {
  dirty: boolean;
  save?: () => Promise<boolean>;
  discard?: () => void;
}) {
  const entries = useContext(Context);
  const id = useId();
  useEffect(() => {
    entries?.set(id, { dirty, save, discard });
    return () => {
      entries?.delete(id);
    };
  }, [entries, id, dirty, save, discard]);
  return null;
}

'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NavigationProtection } from './navigation-guard';
import { useState, type ReactNode } from 'react';
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            staleTime: 10000,
            refetchOnWindowFocus: false,
          },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <NavigationProtection>{children}</NavigationProtection>
    </QueryClientProvider>
  );
}

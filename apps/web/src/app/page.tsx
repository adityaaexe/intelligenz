'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { defaultScopeHref, readSession, sessionExpired } from '../lib/session';

/**
 * `/` has no scope, and every route in this product needs one
 * (INFORMATION-ARCHITECTURE §3.2 rule 1). So the entry point resolves the
 * operator's first workspace and forwards, or sends them to sign in.
 */
export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    const session = readSession();
    if (session === null || sessionExpired(session)) {
      router.replace('/login');
      return;
    }
    router.replace(defaultScopeHref(session));
  }, [router]);

  return (
    <main className="flex min-h-dvh items-center justify-center p-24" aria-busy="true">
      <p className="text-ink-3 text-sm">Resolving workspace…</p>
    </main>
  );
}

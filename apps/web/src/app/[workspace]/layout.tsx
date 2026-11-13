import type { ReactNode } from 'react';

import { AppShell } from '../../components/shell/app-shell';

/**
 * The workspace segment is always present (INFORMATION-ARCHITECTURE §3.2 rule 1),
 * so a shared link is never ambiguous about scope. `params` is a promise in
 * Next 15; only a server component can await it, and only a client component can
 * read the session — so they are split here.
 */
export default async function WorkspaceLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly workspace: string }>;
}) {
  const { workspace } = await params;
  return <AppShell workspace={workspace}>{children}</AppShell>;
}

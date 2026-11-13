import type { Metadata } from 'next';

import { OverviewScreen } from '../../../components/overview/overview-screen';

export const metadata: Metadata = {
  title: 'Overview',
};

export default async function OverviewPage({
  params,
}: {
  readonly params: Promise<{ readonly workspace: string }>;
}) {
  const { workspace } = await params;
  return <OverviewScreen workspace={workspace} />;
}

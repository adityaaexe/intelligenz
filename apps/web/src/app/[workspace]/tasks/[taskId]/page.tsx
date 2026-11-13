import type { Metadata } from 'next';

import { ExecutionDetailScreen } from '../../../../components/executions/execution-detail-screen';

export const metadata: Metadata = {
  title: 'Execution detail',
};

/**
 * `/[workspace]/tasks/[taskId]` — what actually happened on a task.
 *
 * The segment order keeps the workspace explicit (INFORMATION-ARCHITECTURE §3.2
 * rule 1), so a link is never ambiguous about tenant scope. `params` is a
 * promise in Next 15: the server component awaits it and hands the client
 * component plain strings.
 */
export default async function ExecutionDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly workspace: string; readonly taskId: string }>;
}) {
  const { workspace, taskId } = await params;
  return <ExecutionDetailScreen workspace={workspace} taskId={taskId} />;
}

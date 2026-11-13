/**
 * Response shapes the tests assert on.
 *
 * Deliberately minimal: each test declares the part it reads, so a change to an
 * unrelated field does not break it, and a silently missing field does.
 */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, string[]>;
  };
  correlationId: string;
}

export interface DataBody<T> {
  data: T;
}

export interface PageBody<T> {
  data: T[];
  meta: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
}

export interface TaskBody {
  id: string;
  orgId: string;
  projectId: string;
  workspaceId: string;
  title: string;
  status: string;
  riskClass: string;
  priority: string;
  idempotencyKey: string;
  acceptanceCriteria: string[];
}

export interface RunBody {
  taskId: string;
  workflowRunId: string;
  workflowId: string;
  temporalRunId: string;
  status: string;
}

export interface ApprovalBody {
  id: string;
  taskId: string;
  status: string;
  riskClass: string;
  decidedById?: string | null;
}

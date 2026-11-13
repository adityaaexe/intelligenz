import type { IconName } from '@intelligenz/design-system';

/**
 * The 16 primary destinations (docs/design/INFORMATION-ARCHITECTURE.md §2.3).
 *
 * `implemented` is the honest bit: Phase 2 delivers Overview only. Every other
 * destination routes to a placeholder that names the module, states that it is
 * not implemented, and names the API surface that does or does not exist. Ten
 * nav items that silently 404, or that render an empty shell pretending to load,
 * are worse than ten items that say "not built".
 */
export type NavGroupId = 'pinned' | 'engineering' | 'intelligence' | 'assurance' | 'platform';

export interface ModuleEntry {
  readonly slug: string;
  readonly label: string;
  readonly icon: IconName;
  readonly group: NavGroupId;
  /** One line from the module register, used verbatim on the placeholder. */
  readonly purpose: string;
  /** The route that backs this module today, or `none`. */
  readonly api: string;
  readonly implemented: boolean;
}

export const MODULES: readonly ModuleEntry[] = [
  {
    slug: 'overview',
    label: 'Overview',
    icon: 'overview',
    group: 'pinned',
    purpose: 'Real-time posture: what is running, what needs a human, what it costs.',
    api: 'GET /health/ready · GET /v1/orgs/:orgId/approvals · project and task reads',
    implemented: true,
  },
  {
    slug: 'approvals',
    label: 'Approvals',
    icon: 'approvals',
    group: 'pinned',
    purpose: 'Risk-ranked governance queue; approve, reject, or request changes with evidence.',
    api: 'GET /v1/orgs/:orgId/approvals · POST /v1/orgs/:orgId/approvals/:approvalId/decision',
    implemented: false,
  },
  {
    slug: 'agents',
    label: 'Agent Command Centre',
    icon: 'agents',
    group: 'pinned',
    purpose: 'Agent registry and live execution surface: assignments, handoffs, logs, recovery.',
    api: 'none',
    implemented: false,
  },
  {
    slug: 'projects',
    label: 'Projects',
    icon: 'projects',
    group: 'pinned',
    purpose: 'Object navigator: goals, plans, repositories, runs and artifacts per project.',
    api: 'GET /v1/orgs/:orgId/workspaces/:workspaceId/projects',
    implemented: false,
  },
  {
    slug: 'code',
    label: 'Code Intelligence',
    icon: 'code',
    group: 'engineering',
    purpose: 'Repository understanding, refactor proposals, test and security findings.',
    api: 'none',
    implemented: false,
  },
  {
    slug: 'design',
    label: 'Design Intelligence',
    icon: 'design',
    group: 'engineering',
    purpose: 'UI audits, design-system drift and accessibility findings against live surfaces.',
    api: 'none',
    implemented: false,
  },
  {
    slug: 'creative',
    label: 'Creative Studio',
    icon: 'creative',
    group: 'engineering',
    purpose: 'Brand assets, campaign variants and generated media with licence provenance.',
    api: 'none',
    implemented: false,
  },
  {
    slug: 'workflows',
    label: 'Workflow Studio',
    icon: 'workflows',
    group: 'engineering',
    purpose: 'Author and version the graphs that agents execute, including guardrails.',
    api: 'none',
    implemented: false,
  },
  {
    slug: 'schedules',
    label: 'Schedules',
    icon: 'schedules',
    group: 'engineering',
    purpose: 'Cron and event triggers; upcoming fire times; missed and skipped runs.',
    api: 'none',
    implemented: false,
  },
  {
    slug: 'research',
    label: 'Research Lab',
    icon: 'research',
    group: 'intelligence',
    purpose: 'Campaigns, source provenance, findings with confidence and coverage gaps.',
    api: 'none',
    implemented: false,
  },
  {
    slug: 'models',
    label: 'Model Intelligence',
    icon: 'models',
    group: 'intelligence',
    purpose: 'Routing policy per role, cost and quality history.',
    api: 'none',
    implemented: false,
  },
  {
    slug: 'knowledge',
    label: 'Knowledge Base',
    icon: 'knowledge',
    group: 'intelligence',
    purpose: 'Durable project memory: decisions, conventions, evaluated skills.',
    api: 'none',
    implemented: false,
  },
  {
    slug: 'security',
    label: 'Security',
    icon: 'security',
    group: 'assurance',
    purpose: 'Policies, permission grants, sandbox isolation and audit log export.',
    api: 'none',
    implemented: false,
  },
  {
    slug: 'reports',
    label: 'Reports',
    icon: 'reports',
    group: 'assurance',
    purpose: 'Generated delivery and cost reports, per client or per period.',
    api: 'none',
    implemented: false,
  },
  {
    slug: 'integrations',
    label: 'Integrations',
    icon: 'integrations',
    group: 'platform',
    purpose: 'Connected providers: VCS, CI, Figma, issue trackers, model providers.',
    api: 'none',
    implemented: false,
  },
  {
    slug: 'marketplace',
    label: 'Marketplace',
    icon: 'marketplace',
    group: 'platform',
    purpose: 'Installable agents, skills and workflow templates with trust signals.',
    api: 'none',
    implemented: false,
  },
];

export interface NavGroup {
  readonly id: NavGroupId;
  /** `null` for the pinned block, which has no group header. */
  readonly label: string | null;
  readonly modules: readonly ModuleEntry[];
}

const GROUP_LABELS: Readonly<Record<NavGroupId, string | null>> = {
  pinned: null,
  engineering: 'Engineering',
  intelligence: 'Intelligence',
  assurance: 'Assurance',
  platform: 'Platform',
};

export const NAV_GROUPS: readonly NavGroup[] = (
  ['pinned', 'engineering', 'intelligence', 'assurance', 'platform'] as const
).map((id) => ({
  id,
  label: GROUP_LABELS[id],
  modules: MODULES.filter((module) => module.group === id),
}));

export function findModule(slug: string): ModuleEntry | undefined {
  return MODULES.find((module) => module.slug === slug);
}

export function moduleHref(workspaceSlug: string, moduleSlug: string): string {
  return `/${workspaceSlug}/${moduleSlug}`;
}

'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Chip, Icon } from '@intelligenz/design-system';
import type { IconName } from '@intelligenz/design-system';

import { NAV_GROUPS, moduleHref } from '../../lib/nav';
import type { NavGroupId } from '../../lib/nav';
import { clearSession, readSession, resolveScope, roleLabel, sessionExpired } from '../../lib/session';
import type { ResolvedScope, Session } from '../../lib/session';

/**
 * The shell: topbar 56px, sidebar 264px (64px rail below 1280, drawer below 768),
 * scope bar 40px (DESIGN.md §7.1, §7.3).
 *
 * This is a client component because the access token lives in this tab
 * (`lib/session.ts`) — there is no server-readable session, so the chrome cannot
 * be rendered by the server. Everything it renders before that check is a
 * structural skeleton with no data in it, so server and client markup agree and
 * there is no hydration mismatch.
 */

type ShellState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly session: Session;
      readonly scope: ResolvedScope;
    }
  | { readonly status: 'invalid' };

const COLLAPSED_KEY = 'intelligenz.nav.collapsed.v1';

export function AppShell({ workspace, children }: { readonly workspace: string; readonly children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const [state, setState] = useState<ShellState>({ status: 'loading' });
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<NavGroupId>>(new Set<NavGroupId>());
  const navToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const session = readSession();
    if (session === null || sessionExpired(session)) {
      clearSession();
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      setState({ status: 'invalid' });
      return;
    }
    const scope = resolveScope(session, workspace);
    if (scope === null) {
      setState({ status: 'invalid' });
      return;
    }
    setState({ status: 'ready', session, scope });
  }, [pathname, router, workspace]);

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(COLLAPSED_KEY);
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setCollapsed(new Set(parsed.filter((item): item is NavGroupId => typeof item === 'string') as NavGroupId[]));
        }
      }
    } catch {
      // A blocked or corrupt preference is not worth a broken shell.
    }
  }, []);

  // Escape closes the mobile drawer and returns focus to the control that opened it.
  useEffect(() => {
    if (!navOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNavOpen(false);
        navToggleRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [navOpen]);

  useEffect(() => {
    if (navOpen) {
      sidebarRef.current?.querySelector<HTMLAnchorElement>('a')?.focus();
    }
  }, [navOpen]);

  const toggleGroup = useCallback((id: NavGroupId) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      try {
        window.sessionStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // Preference only.
      }
      return next;
    });
  }, []);

  const signOut = useCallback(() => {
    clearSession();
    router.replace('/login');
  }, [router]);

  const orgName = state.status === 'ready' ? state.scope.membership.orgName : null;
  const workspaceName = state.status === 'ready' ? state.scope.workspace.name : null;
  const role = state.status === 'ready' ? state.scope.membership.role : null;

  return (
    <>
      <a className="app-skip-link" href="#main">
        Skip to main content
      </a>
      <div className="app-shell">
        <aside
          className="app-sidebar iz-on-chrome"
          id="primary-navigation"
          ref={sidebarRef}
          data-open={navOpen ? 'true' : 'false'}
          aria-label="Primary"
        >
          <SidebarBody
            state={state}
            workspace={workspace}
            pathname={pathname}
            collapsed={collapsed}
            onToggleGroup={toggleGroup}
            onSignOut={signOut}
            onNavigate={() => setNavOpen(false)}
          />
        </aside>
        <button
          className="app-scrim"
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          data-visible={navOpen ? 'true' : 'false'}
          onClick={() => setNavOpen(false)}
        />

        <div className="app-column">
          <header className="app-topbar iz-on-chrome">
            <div className="app-topbar__start">
              <button
                className="app-icon-btn app-nav-toggle"
                type="button"
                ref={navToggleRef}
                aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
                aria-expanded={navOpen}
                aria-controls="primary-navigation"
                onClick={() => setNavOpen((open) => !open)}
              >
                <Icon name={navOpen ? 'x' : 'rail'} size={16} />
              </button>
              <Link className="app-brand" href={moduleHref(workspace, 'overview')}>
                <span className="app-brand__mark" aria-hidden="true" />
                INTELLIGENZ
              </Link>
              <span className="app-topbar__divider" aria-hidden="true" />
              <div className="app-topbar__org">
                <span className="app-topbar__org-name">{orgName ?? '—'}</span>
                <span className="app-topbar__org-meta">Control centre</span>
              </div>
            </div>
            <div className="app-topbar__end">
              {state.status === 'ready' ? (
                <>
                  <span className="app-topbar__user">{state.session.user.name}</span>
                  <Chip tone="derived">{roleLabel(state.scope.membership.role)}</Chip>
                </>
              ) : null}
            </div>
          </header>

          <main className="app-content" id="main" tabIndex={-1}>
            {/*
             * The scope bar lives inside `main`, not between the banner and it.
             * It is page content (the scope the numbers below are scoped to), and
             * content outside every landmark is a `region` violation — the one
             * axe reported on this screen. Moving it here keeps the pixels
             * identical (sticky under the 56px topbar) and makes the landmark
             * tree true: banner, complementary, navigation, main.
             */}
            <ScopeBar
              workspaceSlug={workspace}
              workspaceName={workspaceName}
              role={role}
            />
            <div className="app-content__inner">{children}</div>
          </main>
        </div>
      </div>
    </>
  );
}

interface SidebarBodyProps {
  readonly state: ShellState;
  readonly workspace: string;
  readonly pathname: string;
  readonly collapsed: ReadonlySet<NavGroupId>;
  readonly onToggleGroup: (id: NavGroupId) => void;
  readonly onSignOut: () => void;
  readonly onNavigate: () => void;
}

function SidebarBody({
  state,
  workspace,
  pathname,
  collapsed,
  onToggleGroup,
  onSignOut,
  onNavigate,
}: SidebarBodyProps) {
  const memberships = state.status === 'ready' ? state.session.memberships : [];
  const workspaces = memberships.flatMap((membership) =>
    membership.workspaces.map((entry) => ({ ...entry, orgName: membership.orgName })),
  );

  return (
    <>
      <div className="app-sidebar__workspace">
        <span className="app-sidebar__workspace-label">Workspace</span>
        <div className="app-workspace-switch">
          {workspaces.length === 0 ? (
            <span className="app-sidebar__user-name">—</span>
          ) : (
            workspaces.map((entry) => (
              <Link
                className="app-workspace-switch__item"
                key={entry.id}
                href={moduleHref(entry.slug, 'overview')}
                aria-current={entry.slug === workspace ? 'true' : undefined}
                title={entry.name}
                onClick={onNavigate}
              >
                <Icon name="projects" size={12} />
                <span>{entry.name}</span>
              </Link>
            ))
          )}
        </div>
      </div>

      <nav className="app-nav" aria-label="Primary">
        {NAV_GROUPS.map((group) => {
          const isCollapsed = collapsed.has(group.id);
          const listId = `nav-group-${group.id}`;
          return (
            <div className="app-nav__group" key={group.id}>
              {group.label !== null ? (
                <button
                  className="app-nav__group-toggle"
                  type="button"
                  aria-expanded={!isCollapsed}
                  aria-controls={listId}
                  onClick={() => onToggleGroup(group.id)}
                  title={group.label}
                >
                  <span>{group.label}</span>
                  <Icon name="chevron-down" size={12} />
                </button>
              ) : null}
              <ul className="app-nav__list" id={listId} hidden={isCollapsed}>
                {group.modules.map((module) => {
                  const href = moduleHref(workspace, module.slug);
                  const active = pathname === href;
                  return (
                    <li key={module.slug}>
                      <Link
                        className="app-nav__item"
                        href={href}
                        aria-current={active ? 'page' : undefined}
                        title={module.label}
                        onClick={onNavigate}
                      >
                        <Icon className="app-nav__icon" name={module.icon as IconName} size={16} />
                        <span className="app-nav__label">{module.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="app-sidebar__footer">
        <div className="app-sidebar__user">
          <span className="app-sidebar__user-name">
            {state.status === 'ready' ? state.session.user.email : '—'}
          </span>
          <span className="app-sidebar__user-role">
            {state.status === 'ready' ? roleLabel(state.scope.membership.role) : ''}
          </span>
        </div>
        <button className="app-signout" type="button" onClick={onSignOut} aria-label="Sign out">
          <Icon name="signout" size={12} />
          <span>Sign out</span>
        </button>
      </div>
    </>
  );
}

function ScopeBar({
  workspaceSlug,
  workspaceName,
  role,
}: {
  readonly workspaceSlug: string;
  readonly workspaceName: string | null;
  readonly role: string | null;
}) {
  return (
    /*
     * `tabIndex={0}` because the bar is a horizontal scroll container below
     * 768px (DESIGN.md §9 "two chips + overflow"). A scroll container nobody can
     * reach with a keyboard hides its own content (WCAG 2.1.1), and axe reports
     * it as `scrollable-region-focusable` — only at the widths where it actually
     * overflows, which is why a desktop-only run never saw it.
     */
    <div className="app-scopebar" role="group" aria-label="Scope" tabIndex={0}>
      <div className="app-scopebar__chips">
        <span className="app-scope-chip" data-emphasis="true">
          <span className="app-scope-chip__key">Workspace</span>
          {workspaceName ?? workspaceSlug}
        </span>
        <span className="app-scope-chip">
          <span className="app-scope-chip__key">Project</span>
          All projects
        </span>
        <span className="app-scope-chip">
          <span className="app-scope-chip__key">Environment</span>
          All
        </span>
      </div>
      <div className="app-scopebar__meta">
        {role !== null ? <Chip tone="derived">{roleLabel(role)}</Chip> : null}
      </div>
    </div>
  );
}

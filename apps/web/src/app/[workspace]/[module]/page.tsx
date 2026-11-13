import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { Banner, Chip, NotInstrumented, Panel } from '@intelligenz/design-system';

import { findModule, moduleHref } from '../../../lib/nav';

/**
 * Every one of the 15 destinations that Phase 2 does not implement.
 *
 * The page exists so the nav does not lie in either direction: the link goes
 * somewhere, and that somewhere says the module is not built, what it is for, and
 * whether an API for it already exists. A 404 would hide the roadmap; an empty
 * shell pretending to load would be worse.
 */
export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ readonly module: string }>;
}): Promise<Metadata> {
  const { module } = await params;
  const entry = findModule(module);
  return { title: entry?.label ?? 'Not found' };
}

export default async function ModulePage({
  params,
}: {
  readonly params: Promise<{ readonly workspace: string; readonly module: string }>;
}) {
  const { workspace, module } = await params;
  const entry = findModule(module);

  if (entry === undefined) {
    notFound();
  }
  if (entry.slug === 'overview') {
    redirect(moduleHref(workspace, 'overview'));
  }

  const hasApi = entry.api !== 'none';

  return (
    <>
      <header className="app-page-header">
        <div className="app-page-header__text">
          <h1 className="app-page-title">{entry.label}</h1>
          <p className="app-page-subtitle">{entry.purpose}</p>
        </div>
        <div className="app-page-actions">
          <Chip tone="neutral">Not implemented</Chip>
          <Link className="iz-btn" href={moduleHref(workspace, 'overview')} data-variant="secondary" data-size="sm">
            <span className="iz-btn__label">Back to Overview</span>
          </Link>
        </div>
      </header>

      <div className="placeholder">
        <Banner variant="info" title={`${entry.label} is not implemented in Phase 2.`}>
          The web unit delivers the Overview screen only. This route exists so the navigation is
          honest about where it leads, and so the destination has a URL when the screen is built.
        </Banner>

        <Panel title="What exists today">
          <dl className="placeholder__facts">
            <div className="placeholder__fact">
              <dt>Module</dt>
              <dd>{entry.label}</dd>
            </div>
            <div className="placeholder__fact">
              <dt>Purpose</dt>
              <dd>{entry.purpose}</dd>
            </div>
            <div className="placeholder__fact">
              <dt>Screen</dt>
              <dd>Not implemented — no components, no data binding.</dd>
            </div>
            <div className="placeholder__fact">
              <dt>API surface</dt>
              <dd>
                {hasApi ? (
                  <>
                    Implemented: <span className="iz-mono">{entry.api}</span>
                  </>
                ) : (
                  'None. No route for this module exists in apps/api.'
                )}
              </dd>
            </div>
            <div className="placeholder__fact">
              <dt>Specification</dt>
              <dd className="iz-mono">docs/design/INFORMATION-ARCHITECTURE.md §2.3</dd>
            </div>
          </dl>
        </Panel>

        {hasApi ? (
          <Panel title="Why the screen is not here yet">
            <p className="iz-empty__body">
              The API for {entry.label} is implemented and covered by its own tests, but this phase
              scopes the web application to Overview. Building a screen against it now would mean
              shipping an untested surface without the design review the other screens received.
            </p>
          </Panel>
        ) : (
          <Panel title="Why the screen is not here yet">
            <NotInstrumented
              reason={`${entry.label} has neither an API route nor a screen. Building the screen first would mean inventing the data contract it is supposed to read.`}
              source={`module ${entry.slug} — no controller in apps/api, no route in apps/web`}
              unblockedBy="The API contract for this module comes first (contract §14: contracts before implementations)."
            />
          </Panel>
        )}
      </div>
    </>
  );
}

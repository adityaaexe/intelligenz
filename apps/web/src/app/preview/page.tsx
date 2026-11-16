import type { Metadata } from 'next';

import { Banner, Panel } from '@intelligenz/design-system';

import { BoardSection, BlockersSection, NextEligibleSection, SummarySection } from '../../components/preview/programme';
import { HealthSection } from '../../components/preview/health';
import {
  blockedTasks,
  blockerFacts,
  formatUtc,
  loadPreviewData,
  nextEligible,
  parseFilter,
  shortCommit,
  summarise,
} from '../../lib/preview-data';

import './preview.css';

/**
 * `/preview` — the operator's read-only view through a tunnel.
 *
 * A Server Component with `force-dynamic`: every request reads the ledger from
 * disk and probes `GET /health/ready` on the loopback address, then ships
 * finished HTML. No browser code fetches the API, so the page works on a phone
 * that can reach only port 3100. Filters are anchors with a query string, so
 * they work without JavaScript and the server does the filtering.
 *
 * Two things are deliberately absent: a live indicator and any client polling.
 * A number here is a value read once per request, and it says so.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'INTELLIGENZ preview',
};

export default async function PreviewPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const filter = parseFilter(params['status']);
  const { ledger, health, snapshotAt } = await loadPreviewData();

  return (
    <main className="pv">
      <header className="pv-head">
        <p className="pv-eyebrow">INTELLIGENZ · operator preview</p>
        <h1 className="pv-title">Programme preview</h1>
        <p className="pv-lede">
          Read-only. The web server reads the programme ledger and the API readiness probe on every
          request and renders the result as static HTML — no browser code asks the API for anything.
        </p>
      </header>

      <Banner variant="info" title="TEMPORARY PREVIEW — read-only">
        <p className="pv-banner-copy">
          This is not production and nothing here is editable. Two sources are read server-side at
          request time: the programme ledger file, and one API readiness probe.
        </p>
        {ledger.ok ? (
          <>
            <dl className="pv-meta">
              <div className="pv-meta__pair">
                <dt>Ledger file</dt>
                <dd>
                  <code>docs/engineering/programme/EXECUTION-STATE.json</code>
                </dd>
              </div>
              <div className="pv-meta__pair">
                <dt>Branch</dt>
                <dd>
                  <code>{ledger.ledger.branch || 'not recorded'}</code>
                </dd>
              </div>
              <div className="pv-meta__pair">
                <dt>Commit</dt>
                <dd>
                  <code title={ledger.ledger.head || undefined}>
                    {shortCommit(ledger.ledger.head) || 'not recorded'}
                  </code>
                </dd>
              </div>
              <div className="pv-meta__pair">
                <dt>Ledger updated at</dt>
                <dd>
                  <time dateTime={ledger.ledger.updatedAt || undefined}>
                    {formatUtc(ledger.ledger.updatedAt)}
                  </time>
                </dd>
              </div>
            </dl>
            <p className="pv-caveat">
              Branch and commit are the values <em>recorded in the ledger file</em>, not a live{' '}
              <code>git</code> query. This page runs no subprocess and does not claim the checked-out
              HEAD matches them.
            </p>
          </>
        ) : null}
      </Banner>

      {ledger.ok ? (
        <>
          <SummarySection
            summary={summarise(ledger.ledger)}
            phase={ledger.ledger.phase}
            head={shortCommit(ledger.ledger.head)}
            dropped={ledger.ledger.droppedTasks}
          />
          <BoardSection
            tasks={ledger.ledger.tasks}
            filter={filter}
            summary={summarise(ledger.ledger)}
          />
          <BlockersSection
            tasks={blockedTasks(ledger.ledger)}
            facts={blockerFacts(ledger.ledger)}
          />
          <NextEligibleSection task={nextEligible(ledger.ledger)} />
        </>
      ) : (
        <Panel title="Programme ledger" note="The preview cannot show programme data without it.">
          <Banner variant="error" title="The programme ledger could not be read">
            <p>{ledger.error}</p>
            <p className="pv-caveat">
              The health section below is independent of the ledger and is still real: a live
              readiness probe, or an explicit <code>UNAVAILABLE</code> when the probe fails.
            </p>
          </Banner>
        </Panel>
      )}

      <HealthSection health={health} snapshotAt={snapshotAt} />

      <footer className="pv-footer">
        <p>
          No test result is shown as current. The last measured verification is recorded in{' '}
          <code>docs/engineering/phase8.8-operations/PHASE88-EXECUTION-REPORT.md</code> at commit{' '}
          <code>d7a817d</code>.
        </p>
        <p className="pv-footer__meta">
          Rendered server-side per request. No animation, no polling, no live indicator — a number on
          this page is a value read once, not a value watched.
        </p>
      </footer>
    </main>
  );
}

'use client';

import { useState } from 'react';

import { Button, Icon } from '@intelligenz/design-system';

import { ApiError } from '../../lib/api';
import type { ArtifactDownload } from '../../lib/api';
import { artifactFilename, formatBytes, integrityDescriptor, splitArtifactUri } from '../../lib/execution-state';
import type { ExecutionArtifact } from '../../lib/types';
import { IntegrityBadge } from './execution-badges';

/**
 * Artifacts: the evidence, with its integrity state computed by the API on this
 * request (never a stored flag — `api-contract.md` §Artifacts re-hashes the bytes
 * before answering).
 *
 * ## Why the download is a `fetch`, not an `<a href>`
 *
 * The content route is authenticated with a bearer token held in this tab
 * (`lib/session.ts`), so a plain link would arrive unauthenticated. The bytes are
 * fetched, wrapped in an object URL, and handed to a synthetic anchor.
 *
 * ## Why an integrity failure is inline
 *
 * A `409 ARTIFACT_INTEGRITY_FAILED` is not a transient glitch: it means the file
 * on disk is no longer the file the ledger recorded. A toast would remove the
 * only evidence the operator has that something changed underneath them, so the
 * failure is rendered in the region, names the artifact, and stays until the
 * operator retries or dismisses it.
 */
export function ArtifactTable({
  artifacts,
  download,
}: {
  readonly artifacts: readonly ExecutionArtifact[];
  readonly download: (artifactId: string) => Promise<ArtifactDownload>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    readonly artifact: ExecutionArtifact;
    readonly error: ApiError;
  } | null>(null);

  async function attemptDownload(artifact: ExecutionArtifact): Promise<void> {
    setBusyId(artifact.id);
    setFailure(null);
    try {
      const result = await download(artifact.id);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = artifactFilename(artifact.uri, artifact.kind);
      anchor.rel = 'noopener';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // Revoked on the next task, so Safari has begun the download by then.
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      const error =
        cause instanceof ApiError
          ? cause
          : new ApiError('UNKNOWN', 0, cause instanceof Error ? cause.message : String(cause));
      setFailure({ artifact, error });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div
        className="iz-table-scroll"
        role="region"
        tabIndex={0}
        aria-label="Artifacts, scrollable"
      >
        <table className="iz-table ex-artifacts" data-density="compact">
          <caption className="iz-sr-only">
            Artifacts attributed to this attempt, with integrity checked against the recorded
            SHA-256.
          </caption>
          <thead>
            <tr>
              <th scope="col">Artifact</th>
              <th scope="col" className="iz-col-sm">
                Kind
              </th>
              <th scope="col" data-align="right" className="iz-col-sm">
                Size
              </th>
              <th scope="col">Integrity</th>
              <th scope="col" data-align="right">
                <span className="iz-sr-only">Download</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {artifacts.map((artifact) => {
              const descriptor = integrityDescriptor(artifact.integrity);
              const parts = splitArtifactUri(artifact.uri);
              return (
                <tr key={artifact.id} data-integrity={artifact.integrity}>
                  <td>
                    <span className="iz-mono ex-artifact-uri" title={artifact.uri}>
                      <span className="iz-sr-only">{artifact.uri}</span>
                      <span className="ex-artifact-uri__dir" aria-hidden="true">
                        {parts.dir}
                      </span>
                      <span className="ex-artifact-uri__name" aria-hidden="true">
                        {parts.name}
                      </span>
                    </span>
                    {descriptor.loud ? (
                      <span className="ex-artifacts__alarm">
                        <strong>Integrity failed.</strong> {descriptor.detail}
                      </span>
                    ) : null}
                  </td>
                  <td className="iz-col-sm">
                    <span className="iz-mono">{artifact.kind}</span>
                  </td>
                  <td data-align="right" className="iz-col-sm">
                    <span className="iz-num">{formatBytes(artifact.sizeBytes)}</span>
                  </td>
                  <td>
                    <IntegrityBadge integrity={artifact.integrity} />
                  </td>
                  <td data-align="right">
                    <Button
                      size="sm"
                      className="ex-download"
                      aria-label={`Download ${parts.name}`}
                      loading={busyId === artifact.id}
                      onClick={() => {
                        void attemptDownload(artifact);
                      }}
                    >
                      <span className="ex-download__label">Download</span>
                      <Icon className="ex-download__icon" name="download" size={16} />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {failure !== null ? (
        <ArtifactFailure
          artifact={failure.artifact}
          error={failure.error}
          busy={busyId === failure.artifact.id}
          onRetry={() => {
            void attemptDownload(failure.artifact);
          }}
          onDismiss={() => setFailure(null)}
        />
      ) : null}
    </>
  );
}

/** What each documented content failure means, in the operator's words. */
function failureCopy(error: ApiError): { readonly title: string; readonly body: string } {
  switch (error.code) {
    case 'ARTIFACT_INTEGRITY_FAILED':
      return {
        title: 'Integrity check failed — nothing was downloaded.',
        body:
          'The bytes on disk no longer match the recorded SHA-256, so the API refused to serve ' +
          'them. This is not a transient error: the file changed after it was recorded. Re-run ' +
          'the task to regenerate the artifact, or inspect the host before trusting any earlier copy.',
      };
    case 'ARTIFACT_GONE':
      return {
        title: 'The file is no longer on this host.',
        body:
          'The artifact row still exists, but its bytes are gone. The metadata above is the record ' +
          'that survives; the content cannot be recovered from this API.',
      };
    case 'NOT_FOUND':
      return {
        title: 'The artifact is not available in this organisation.',
        body:
          'Either the artifact does not exist, or it belongs to another organisation. The API ' +
          'answers 404 for both so the difference cannot be probed.',
      };
    case 'FORBIDDEN':
      return {
        title: 'Your role does not permit this read.',
        body: 'Ask an owner of this organisation to raise your role, then retry.',
      };
    case 'NETWORK_ERROR':
      return {
        title: 'The API could not be reached.',
        body: 'The download did not start. Nothing was served from a cache; retry when the API is up.',
      };
    case 'UNAUTHORIZED':
      return {
        title: 'Your session expired.',
        body: 'Sign in again and retry the download.',
      };
    default:
      return {
        title: 'The download failed.',
        body: error.message,
      };
  }
}

function ArtifactFailure({
  artifact,
  error,
  busy,
  onRetry,
  onDismiss,
}: {
  readonly artifact: ExecutionArtifact;
  readonly error: ApiError;
  readonly busy: boolean;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}) {
  const copy = failureCopy(error);
  const integrity = integrityDescriptor(artifact.integrity);
  return (
    <div className="ex-artifact-failure" role="alert" data-code={error.code}>
      <div className="ex-artifact-failure__text">
        <p className="ex-artifact-failure__title">
          <Icon name="status-failed" size={16} /> {copy.title}
        </p>
        <p className="ex-artifact-failure__body">
          <span className="iz-mono">{artifact.uri}</span> — {copy.body}
        </p>
        <p className="ex-artifact-failure__meta">
          Code <span className="iz-mono">{error.code}</span> · HTTP {error.status}
          {error.correlationId !== null ? (
            <>
              {' '}
              · <span className="iz-mono">Correlation {error.correlationId}</span>
            </>
          ) : null}
          {error.code === 'ARTIFACT_INTEGRITY_FAILED' ? (
            <>
              {' '}
              · Integrity still reads{' '}
              <span className="iz-mono">{integrity.label.toLowerCase()}</span> for this row.
            </>
          ) : null}
        </p>
      </div>
      <div className="ex-artifact-failure__actions">
        <Button size="sm" onClick={onRetry} loading={busy}>
          Retry download
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/**
 * `@intelligenz/egress-broker` — terminate provider authentication outside the sandbox.
 *
 * The package exists because of one measured fact: an agent that authenticates by
 * reading a file must be able to read that file, so a credential inside the sandbox is
 * a credential the agent can exfiltrate. Phase 3 tried to narrow the mount and could
 * not: the credential lives in `opencode.db` together with 696 sessions of operator
 * history, and opencode needs the database to authenticate.
 *
 * The broker removes the requirement instead of narrowing it. The sandbox gets a canary
 * that authenticates nothing; the host injects the real credential per request.
 *
 * See `broker.ts` for the traffic path and the policy, and `credential.ts` for why the
 * store is SQLite and why no error message can contain the value.
 */

export {
  BROKER_SOCKET_NAME,
  DEFAULT_ALLOWED_METHODS,
  DEFAULT_ALLOWED_PATHS,
  HEALTH_PATH,
  STRIPPED_REQUEST_HEADERS,
  credentialReadLatencyMs,
  resolveUpstreamUrl,
  startEgressBroker,
  tokensMatch,
  type BrokerDenial,
  type BrokerRequestLog,
  type EgressBroker,
  type EgressBrokerOptions,
} from './broker';

export {
  DEFAULT_CREDENTIAL_TTL_MS,
  CredentialExpiredError,
  CredentialUnavailableError,
  readCredential,
  readEnvCredential,
  readOpencodeCredential,
  type CredentialSource,
  type ResolvedCredential,
} from './credential';

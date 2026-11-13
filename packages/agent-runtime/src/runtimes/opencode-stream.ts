import type { ExecutionEvent, ExecutionUsage, ToolInvocationRecord } from '../types';
import { redactAndTruncate, summarizeToolPayload } from '../redact';

/**
 * The `opencode run --format json` reader.
 *
 * It lives apart from the adapter because it is the one part that can be tested
 * without a provider: give it a stream, read what it found. The format is not a public
 * contract, so every field is probed rather than assumed — an event shape that changes
 * becomes a missing tool call or an unknown cost, never a crash and never an invented
 * number.
 */

const MAX_EVENTS = 200;
const TOOL_SUMMARY_LIMIT = 500;

/** What one stream produced. Every field is optional in practice; none is guessed. */
export interface ParsedStream {
  readonly events: ExecutionEvent[];
  readonly invocations: ToolInvocationRecord[];
  readonly usage: ExecutionUsage;
  readonly sessionId: string | null;
  readonly finalText: string;
  readonly stepCount: number;
  readonly model: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Read one stream. Never throws: a malformed line is skipped, not fatal. */
export function parseOpencodeStream(stdout: string): ParsedStream {
  const events: ExecutionEvent[] = [];
  const invocations: ToolInvocationRecord[] = [];
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;
  let usd: number | undefined;
  let sessionId: string | null = null;
  let finalText = '';
  let stepCount = 0;
  let model: string | null = null;
  let seq = 0;

  const emit = (type: ExecutionEvent['type'], message: string, at: string): void => {
    if (events.length >= MAX_EVENTS) return;
    seq += 1;
    events.push({ seq, type, at, message: redactAndTruncate(message, 400) });
  };

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    let parsed: Record<string, unknown>;
    try {
      const record = asRecord(JSON.parse(line));
      if (record === undefined) continue;
      parsed = record;
    } catch {
      continue;
    }

    const type = asString(parsed.type) ?? 'unknown';
    const at = new Date().toISOString();
    const session = asString(parsed.sessionID);
    if (session !== undefined && sessionId === null) sessionId = session;

    const part = asRecord(parsed.part) ?? {};

    if (type === 'step_start' || type === 'step-start') {
      stepCount += 1;
      const partModel = asRecord(part.model);
      const candidate =
        asString(partModel?.modelID) ?? asString(part.modelID) ?? asString(parsed.model);
      if (candidate !== undefined && model === null) model = candidate;
      emit('progress', `step ${stepCount} started`, at);
      continue;
    }

    if (type === 'text') {
      const text = asString(part.text) ?? asString(parsed.text);
      if (text !== undefined) {
        finalText = redactAndTruncate(text, 4000);
        emit('progress', text, at);
      }
      continue;
    }

    if (type === 'tool' || type === 'tool_use' || type === 'tool_use_start') {
      const tool = asString(part.tool) ?? asString(parsed.tool) ?? 'tool';
      const state = asRecord(part.state) ?? {};
      const input = state.input ?? part.input ?? parsed.input;
      const output = state.output ?? part.output;
      const summaryText = summarizeToolPayload(
        typeof output === 'string' && output.length > 0 ? output : (input ?? tool),
        TOOL_SUMMARY_LIMIT,
      );

      invocations.push({
        sequence: invocations.length + 1,
        tool: redactAndTruncate(tool, 64),
        summary: summaryText,
        occurredAt: at,
      });

      emit('progress', `${tool}: ${summaryText}`, at);
      continue;
    }

    if (type === 'step_finish' || type === 'step-finish') {
      const cost = asNumber(part.cost) ?? asNumber(parsed.cost);
      if (cost !== undefined) usd = (usd ?? 0) + cost;

      const tokens = asRecord(part.tokens) ?? asRecord(parsed.tokens) ?? {};
      const input = asNumber(tokens.input);
      const output = asNumber(tokens.output);
      if (input !== undefined) tokensIn = (tokensIn ?? 0) + input;
      if (output !== undefined) tokensOut = (tokensOut ?? 0) + output;

      emit(
        'progress',
        `step finished (cost ${cost === undefined ? 'unknown' : cost.toFixed(6)})`,
        at,
      );
      continue;
    }

    if (type === 'error') {
      emit('log', `provider error: ${summarizeToolPayload(parsed.error ?? parsed, 300)}`, at);
      continue;
    }

    if (type === 'retry') {
      emit('log', `transport retry ${String(parsed.attempt ?? '?')}`, at);
    }
  }

  return {
    events,
    invocations,
    usage: { tokensIn, tokensOut, usd },
    sessionId,
    finalText,
    stepCount,
    model,
  };
}


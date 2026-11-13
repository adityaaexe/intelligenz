import type { LogLevel } from './config';

/**
 * Structured JSON logging without a dependency.
 *
 * `pino` is the contract's logger (§2) and the API uses it, but adding it to this
 * package would mean editing the shared lockfile, which this unit may not do. A
 * thirty-line writer that emits one JSON object per line is the honest alternative:
 * the shape is pino-compatible (`level`, `time`, `msg`, plus fields), so swapping the
 * implementation later is a one-file change and no log consumer has to be rewritten.
 *
 * `no-console` is an ESLint rule here for a reason — a stray `console.log` in a worker
 * is a line an operator cannot filter. Everything goes through this module.
 */

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface WorkerLogger {
  child(fields: Record<string, unknown>): WorkerLogger;
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export function createLogger(
  level: LogLevel,
  base: Record<string, unknown> = {},
  sink: NodeJS.WritableStream = process.stdout,
): WorkerLogger {
  const threshold = LEVEL_WEIGHT[level];

  const write = (
    entryLevel: LogLevel,
    fields: Record<string, unknown>,
    message: string,
  ): void => {
    if (LEVEL_WEIGHT[entryLevel] < threshold) return;

    const record = {
      level: entryLevel,
      time: new Date().toISOString(),
      ...base,
      ...fields,
      msg: message,
    };

    let line: string;

    try {
      line = JSON.stringify(record, jsonReplacer);
    } catch {
      // A logger that throws takes the worker down with it. Degrade, never crash.
      line = JSON.stringify({
        level: entryLevel,
        time: new Date().toISOString(),
        msg: message,
        logError: 'record was not serialisable',
      });
    }

    sink.write(`${line}\n`);
  };

  return {
    child: (fields) => createLogger(level, { ...base, ...fields }, sink),
    debug: (fields, message) => write('debug', fields, message),
    info: (fields, message) => write('info', fields, message),
    warn: (fields, message) => write('warn', fields, message),
    error: (fields, message) => write('error', fields, message),
  };
}

/** Normalises what JSON.stringify would otherwise flatten into `{}`. */
export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;

    return {
      name: error.name,
      message: error.message,
      ...(typeof code === 'string' ? { code } : {}),
      ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
    };
  }

  return { message: String(error) };
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return serializeError(value);

  return value;
}

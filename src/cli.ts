#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

import { createAnchor, readAnchor, verifyAnchor } from './anchor.js';
import { parseJournal, verifyJournal } from './journal.js';
import { replay } from './replay.js';
import { VERSION } from './version.js';

const USAGE = `run-journal ${VERSION}

Deterministic, tamper-evident run journals for multi-agent systems.

Usage:
  run-journal verify <journal> [--anchor <file>]
                                     Recompute the chain; exit 1 if broken
                                     or if it disagrees with the anchor
  run-journal anchor <journal> [--out <file>]
                                     Print (or write) a publishable head anchor
  run-journal head <journal> [n]     Print the first n entries (default 10)
  run-journal tail <journal> [n]     Print the last n entries (default 10)
  run-journal replay <journal>       Re-drive a journal and print a summary
  run-journal --version
  run-journal --help

Exit codes:
  0  success
  1  journal or anchor verification failed
  2  usage error
`;

interface ParsedArgs {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        index += 1;
      } else {
        flags.set(key, 'true');
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

function fail(message: string): number {
  console.error(`error: ${message}`);
  return 2;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const parsed = parseArgs(rest);
  const target = parsed.positional[0];

  switch (command) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE);
      return 0;

    case '-v':
    case '--version':
      console.log(VERSION);
      return 0;

    case 'verify': {
      if (target === undefined) return fail('verify requires a journal path');

      const anchorPath = parsed.flags.get('anchor');
      if (anchorPath === undefined) {
        const result = verifyJournal(target);
        if (!result.ok) {
          console.error(`BROKEN at seq ${result.brokenAt}: ${result.error} (${result.count} entries)`);
          return 1;
        }
        console.log(`OK ${result.count} entries, chain intact`);
        return 0;
      }

      const result = verifyAnchor(target, readAnchor(anchorPath));
      if (!result.ok) {
        console.error(`ANCHOR MISMATCH: ${result.error}`);
        return 1;
      }
      console.log(
        `OK ${result.total} entries, chain intact, anchored prefix of ${result.anchored} intact` +
          (result.appended > 0 ? `, ${result.appended} appended since anchor` : ''),
      );
      return 0;
    }

    case 'anchor': {
      if (target === undefined) return fail('anchor requires a journal path');

      const anchor = createAnchor(target);
      const out = parsed.flags.get('out');
      const encoded = `${JSON.stringify(anchor, null, 2)}\n`;

      if (out === undefined) {
        process.stdout.write(encoded);
        return 0;
      }

      writeFileSync(out, encoded, 'utf8');
      console.error(`anchor written to ${out} (head ${anchor.head.slice(0, 12)}…, ${anchor.entries} entries)`);
      return 0;
    }

    case 'head':
    case 'tail': {
      if (target === undefined) return fail(`${command} requires a journal path`);

      const requested = parsed.positional[1] === undefined ? 10 : Number.parseInt(parsed.positional[1], 10);
      if (!Number.isInteger(requested) || requested < 0) {
        return fail('count must be a non-negative integer');
      }

      const entries = parseJournal(readFileSync(target, 'utf8'));
      const slice = command === 'head' ? entries.slice(0, requested) : entries.slice(-requested);

      for (const entry of slice) {
        const seq = String(entry.seq).padStart(4);
        console.log(`${seq}  ${entry.ts}  ${entry.type.padEnd(13)}  ${JSON.stringify(entry.payload)}`);
      }
      return 0;
    }

    case 'replay': {
      if (target === undefined) return fail('replay requires a journal path');

      const summary = await replay(target, {
        '*': (entry) => {
          console.log(`${String(entry.seq).padStart(4)}  ${entry.type}`);
        },
      });
      console.log(`\nreplayed ${summary.events} events in ${summary.durationMs}ms`);
      return 0;
    }

    default:
      return fail(`unknown command: ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });

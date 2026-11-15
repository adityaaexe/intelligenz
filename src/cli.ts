#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { parseJournal, verifyJournal } from './journal.js';
import { replay } from './replay.js';
import { VERSION } from './version.js';

const USAGE = `intelligenz ${VERSION}

Deterministic, tamper-evident run journals for multi-agent systems.

Usage:
  intelligenz verify <journal>       Recompute the hash chain; exit 1 if broken
  intelligenz head <journal> [n]     Print the first n entries (default 10)
  intelligenz tail <journal> [n]     Print the last n entries (default 10)
  intelligenz replay <journal>       Re-drive a journal and print a summary
  intelligenz --version
  intelligenz --help
`;

function fail(message: string): number {
  console.error(`error: ${message}`);
  return 2;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

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
      const path = rest[0];
      if (path === undefined) return fail('verify requires a journal path');

      const result = verifyJournal(path);
      if (!result.ok) {
        console.error(`BROKEN at seq ${result.brokenAt}: ${result.error} (${result.count} entries)`);
        return 1;
      }
      console.log(`OK ${result.count} entries, chain intact`);
      return 0;
    }

    case 'head':
    case 'tail': {
      const path = rest[0];
      if (path === undefined) return fail(`${command} requires a journal path`);

      const requested = rest[1] === undefined ? 10 : Number.parseInt(rest[1], 10);
      if (!Number.isInteger(requested) || requested < 0) {
        return fail('count must be a non-negative integer');
      }

      const entries = parseJournal(readFileSync(path, 'utf8'));
      const slice = command === 'head' ? entries.slice(0, requested) : entries.slice(-requested);

      for (const entry of slice) {
        const seq = String(entry.seq).padStart(4);
        console.log(`${seq}  ${entry.ts}  ${entry.type.padEnd(13)}  ${JSON.stringify(entry.payload)}`);
      }
      return 0;
    }

    case 'replay': {
      const path = rest[0];
      if (path === undefined) return fail('replay requires a journal path');

      const summary = await replay(path, {
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

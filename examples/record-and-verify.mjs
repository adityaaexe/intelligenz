// Run with: npm run example
import { Journal, replay, verifyJournal } from '../dist/src/index.js';

const path = new URL('./demo.journal.jsonl', import.meta.url).pathname;

const journal = Journal.create(path, { force: true });

journal.append('run.start', { goal: 'summarise three papers' });
journal.append('agent.spawn', { agent: 'researcher', model: 'none' });
journal.append('tool.call', { tool: 'search', query: 'retrieval augmented generation' });
journal.append('tool.result', { tool: 'search', hits: 3 });
journal.append('decision', { chosen: 'summarise', rejected: ['re-rank'] });
journal.append('run.end', { reason: 'completed' });

console.log('entries:', journal.entries().length);
console.log('verify:', verifyJournal(path));

let toolCalls = 0;
await replay(path, {
  'tool.call': () => {
    toolCalls += 1;
  },
});
console.log('tool calls during replay:', toolCalls);

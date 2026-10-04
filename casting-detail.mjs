#!/usr/bin/env node
/**
 * casting-detail.mjs — read ONE Alternativa Teatral casting page and print what
 * the poster wrote: description, contact email, deadline, remuneration.
 *
 *   node casting-detail.mjs <https://www.alternativateatral.com/casting{id}-slug> [--json]
 *
 * One request per run, through the shared HTTP client (identifies as
 * career-ops, refuses redirects). The board asks Crawl-delay 600 — callers
 * (a person, or an agent such as Hermes) read only the few postings they
 * actually mean to answer, never the whole list. Read-only: it never sends
 * anything; drafting the reply is the agent's job, and the user sends it.
 */
import { makeHttpCtx } from './providers/_http.mjs';
import { fetchCastingDetail } from './providers/alternativateatral.mjs';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
const asJson = args.includes('--json');

if (!url || args.includes('--help')) {
  console.log('Usage: node casting-detail.mjs <casting URL> [--json]');
  process.exit(url ? 0 : 1);
}

try {
  const d = await fetchCastingDetail(url, makeHttpCtx());
  if (asJson) {
    console.log(JSON.stringify({ url, ...d }, null, 2));
  } else {
    console.log(`${d.title}\n${url}\n`);
    console.log(d.description || '(sin descripción)');
    console.log(`\nContacto: ${d.contact || d.emails.join(', ') || '(no indicado)'}`);
    console.log(`Vencimiento: ${d.deadline || '?'} · Remuneración: ${d.remuneration || '?'} · Rubros: ${d.categories.join(', ') || '?'}`);
  }
} catch (err) {
  console.error(`casting-detail: ${err.message}`);
  process.exit(1);
}

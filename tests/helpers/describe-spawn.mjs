// tests/helpers/describe-spawn.mjs — why a child process failed, in a message
// that always names a cause.
//
// A SEPARATE module from tests/helpers.mjs, which is not free to import: it
// sets process.env.CAREER_OPS_TRACKER, calls pinSandboxDataRoot() and registers
// an 'exit' hook at load. 51 of the test files that need this helper do not
// import helpers.mjs today, and making them do so just to reach one pure
// function would hand them that environment as well. helpers.mjs re-exports it
// for the files that already depend on it.

/**
 * Why a spawnSync/execFileSync result failed, in a message that always names a
 * cause.
 *
 * The common shape is `assert.equal(r.status, 0, r.stderr)`, or
 * `${r.stdout}${r.stderr}`. That reads well for a child that ran and printed a
 * complaint, and says NOTHING for a child that never got to print:
 *
 *   spawnSync(node, [...], { timeout: 20_000 })
 *   -> status null, signal SIGTERM, error ETIMEDOUT, stdout "", stderr ""
 *
 * so the assertion message is the empty string and the failure reads
 * "AssertionError: --status Applied:" with no reason at all. That is a real
 * CI failure on windows-latest, not a hypothetical: a slow runner killed the
 * child at the 20s timeout and the report could not say so, which is why it
 * looked like a logic failure in the thing under test.
 *
 * `status` can be null, `signal` says a kill, and `error` carries ETIMEDOUT or
 * ENOENT. All three are in the result and all three were being thrown away.
 * Empty streams are printed as "(empty)" rather than as nothing, so a reader
 * can tell silence from a truncated message.
 *
 * @param {import('child_process').SpawnSyncReturns<string>} result
 * @param {string} [label] - What was being run, for the first line.
 * @returns {string}
 */
export function describeSpawn(result, label = '') {
  const parts = [];
  if (label) parts.push(label);
  if (result?.error) {
    const code = result.error.code ? `${result.error.code}: ` : '';
    parts.push(`spawn error — ${code}${result.error.message}`);
  }
  if (result?.signal) parts.push(`killed by signal ${result.signal}`);
  const status = result?.status;
  parts.push(status === null || status === undefined
    ? `exit status ${status === null ? 'null' : 'undefined'} (the process did not exit on its own)`
    : `exit status ${status}`);
  const stream = (name, value) => {
    const t = String(value ?? '').trim();
    return t ? `${name}:\n${t}` : `${name}: (empty)`;
  };
  parts.push(stream('stdout', result?.stdout));
  parts.push(stream('stderr', result?.stderr));
  return parts.join('\n  ');
}

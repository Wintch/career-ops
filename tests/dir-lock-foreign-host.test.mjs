// tests/dir-lock-foreign-host.test.mjs — a lock held from another host or
// container is judged by age, never by a pid that means nothing here.
//
// The lock directory can sit on a filesystem several machines or containers
// share (a jobfinder data/ dir over NFS, with the night scan on one host and
// the person's bot on another). owner.json used to record only the pid, and
// lockRecoveryVerdict condemned the lock as soon as process.kill(pid, 0)
// failed. A pid from another pid namespace is almost never alive here, so each
// side deleted the other's LIVE lock at once and both entered the critical
// section. The stamp now carries host, boot_id and pid_ns; the pid is checked
// only when all three match, and a foreign holder ages out instead.
//
// The last test reproduces the real failure without NFS: a child in its own
// pid namespace (unshare, unprivileged) judges a lock this process holds. It
// is skipped where user namespaces are unavailable.
//
// Run: node --test tests/dir-lock-foreign-host.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireDirLock, tryAcquireDirLockSync, lockRecoveryVerdict, ownerPidIsJudgeable, processIdentity,
  RECOVER_LIVE, RECOVER_STALE,
} from '../lib/dir-lock.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'dir-lock-foreign-'));
after(() => rmSync(work, { recursive: true, force: true }));

let seq = 0;
const freshLockDir = () => join(work, `l${++seq}.lock`);

// A pid that is certainly not running here: a child that has already exited.
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

function writeStamp(lockDir, owner) {
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ token: 'other', started_at: new Date().toISOString(), ...owner }));
}

function backdate(lockDir, ms) {
  const t = (Date.now() - ms) / 1000;
  utimesSync(lockDir, t, t);
}

const me = processIdentity();
const foreignHost = { host: `${me.host}-elsewhere`, boot_id: 'other-boot', pid_ns: 'pid:[1]' };

test('a new lock stamps the identity of the pid namespace its pid belongs to', () => {
  const lockDir = freshLockDir();
  const lock = tryAcquireDirLockSync(lockDir, { staleMs: 60_000, owner: { tool: 't', host: 'spoofed' } });
  assert.ok(lock);
  const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.tool, 't');
  assert.equal(owner.host, me.host, 'an extra owner field cannot overwrite the identity');
  assert.equal(owner.boot_id, me.boot_id);
  assert.equal(owner.pid_ns, me.pid_ns);
  if (process.platform === 'linux') {
    assert.ok(owner.boot_id && owner.pid_ns, 'Linux records boot_id and pid_ns');
  }
  lock.release();
});

test('ownerPidIsJudgeable: same namespace or a legacy stamp only', () => {
  assert.equal(ownerPidIsJudgeable({ pid: 1 }), true, 'legacy stamp without host keeps the pid rule');
  assert.equal(ownerPidIsJudgeable({ pid: 1, ...me }), true);
  assert.equal(ownerPidIsJudgeable({ pid: 1, ...me, host: 'other' }), false);
  assert.equal(ownerPidIsJudgeable({ pid: 1, ...me, boot_id: 'other' }), false, 'same name, other machine or reboot');
  assert.equal(ownerPidIsJudgeable({ pid: 1, ...me, pid_ns: 'pid:[2]' }), false, 'same machine, other container');
  const noLinux = { host: 'h' };
  assert.equal(ownerPidIsJudgeable({ pid: 1, host: 'h' }, noLinux), true, 'absent ids on both sides still match');
  assert.equal(ownerPidIsJudgeable({ pid: 1, host: 'h', pid_ns: 'pid:[3]' }, noLinux), false, 'present on one side only does not');
});

test('same-namespace stamp with a dead pid is still reclaimed at once', () => {
  const lockDir = freshLockDir();
  writeStamp(lockDir, { pid: deadPid(), ...me });
  assert.equal(lockRecoveryVerdict(lockDir, 60_000), RECOVER_STALE);
});

test('legacy stamp (no identity) with a dead pid is still reclaimed at once', () => {
  const lockDir = freshLockDir();
  writeStamp(lockDir, { pid: deadPid() });
  assert.equal(lockRecoveryVerdict(lockDir, 60_000), RECOVER_STALE);
});

test('foreign stamp with a pid dead here is LIVE until it ages out', () => {
  const lockDir = freshLockDir();
  writeStamp(lockDir, { pid: deadPid(), ...foreignHost });
  assert.equal(lockRecoveryVerdict(lockDir, 60_000), RECOVER_LIVE, 'the bug: this used to be STALE');
  backdate(lockDir, 61_000);
  assert.equal(lockRecoveryVerdict(lockDir, 60_000), RECOVER_STALE, 'a crashed foreign holder still ages out');
});

test('foreign stamp whose pid happens to be alive here still ages out', () => {
  const lockDir = freshLockDir();
  writeStamp(lockDir, { pid: process.pid, ...foreignHost });
  assert.equal(lockRecoveryVerdict(lockDir, 60_000), RECOVER_LIVE);
  backdate(lockDir, 61_000);
  assert.equal(lockRecoveryVerdict(lockDir, 60_000), RECOVER_STALE, 'an unrelated live pid here must not pin it for ever');
});

test('foreignStaleMs widens the age rule for foreign holders only', () => {
  const foreign = freshLockDir();
  writeStamp(foreign, { pid: deadPid(), ...foreignHost });
  backdate(foreign, 5 * 60_000);
  assert.equal(lockRecoveryVerdict(foreign, 60_000, 3 * 60 * 60_000), RECOVER_LIVE, 'a ten-minute run on another host is not condemned');
  backdate(foreign, 3 * 60 * 60_000 + 1_000);
  assert.equal(lockRecoveryVerdict(foreign, 60_000, 3 * 60 * 60_000), RECOVER_STALE);

  const local = freshLockDir();
  writeStamp(local, { pid: deadPid(), ...me });
  assert.equal(lockRecoveryVerdict(local, 60_000, 3 * 60 * 60_000), RECOVER_STALE, 'a local crash is not made to wait');

  const ownerless = freshLockDir();
  mkdirSync(ownerless);
  backdate(ownerless, 61_000);
  assert.equal(lockRecoveryVerdict(ownerless, 60_000, 3 * 60 * 60_000), RECOVER_STALE, 'an ownerless dir keeps staleMs');
});

test('acquire: a fresh foreign holder blocks, an aged-out one is reclaimed', async () => {
  const lockDir = freshLockDir();
  writeStamp(lockDir, { pid: deadPid(), ...foreignHost });

  assert.equal(tryAcquireDirLockSync(lockDir, { staleMs: 60_000 }), null, 'sync acquire answers busy');
  await assert.rejects(acquireDirLock(lockDir, { timeoutMs: 150, retryMs: 10, staleMs: 60_000 }), /lock|timed out|Timeout/i);
  assert.equal(JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')).token, 'other', 'the foreign stamp is untouched');

  backdate(lockDir, 61_000);
  const lock = await acquireDirLock(lockDir, { timeoutMs: 1_000, retryMs: 10, staleMs: 60_000 });
  assert.equal(lock.staleRecovered, true);
  assert.equal(JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')).token, lock.token);
  lock.release();
  assert.equal(existsSync(lockDir), false);
});

// The real failure, end to end: a process in another pid namespace cannot see
// this process, so process.kill(ourPid, 0) fails there with ESRCH.
const unshareOk = process.platform === 'linux'
  && spawnSync('unshare', ['-Urp', '--fork', '--mount-proc', 'true']).status === 0;

test('a process in another pid namespace does not steal a live lock', { skip: !unshareOk && 'unshare -Urp unavailable' }, () => {
  const lockDir = freshLockDir();
  const lock = tryAcquireDirLockSync(lockDir, { staleMs: 60_000 });
  assert.ok(lock);

  const childSrc = `
    import { tryAcquireDirLockSync, processIdentity } from ${JSON.stringify(join(ROOT, 'lib', 'dir-lock.mjs'))};
    let seen;
    try { process.kill(${process.pid}, 0); seen = 'visible'; } catch (e) { seen = e.code; }
    const got = tryAcquireDirLockSync(${JSON.stringify(lockDir)}, { staleMs: 60_000 });
    process.stdout.write(JSON.stringify({ seen, acquired: Boolean(got), pid_ns: processIdentity().pid_ns }));
    got?.release();
  `;
  const r = spawnSync('unshare', ['-Urp', '--fork', '--mount-proc', process.execPath, '--input-type=module', '-e', childSrc], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const child = JSON.parse(r.stdout);
  assert.equal(child.seen, 'ESRCH', 'the parent pid is invisible from the child namespace (the old code read this as dead)');
  assert.notEqual(child.pid_ns, me.pid_ns);
  assert.equal(child.acquired, false, 'the child must answer busy, not reclaim');
  assert.equal(JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')).token, lock.token, 'our stamp survives');

  lock.release();
});

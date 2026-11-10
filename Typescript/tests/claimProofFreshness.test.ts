// F1 regression: only the timestamp inside the verified message may decide
// freshness. Outer proof metadata is attacker-controlled. Real Ed25519 proofs,
// temporary kernel/claim storage, and the real HTTP handlers; no live services.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeProofMessage } from 'this.me';
import { claimNamespace, getClaim, openNamespace, resetOpenNonceStoreForTests } from '../src/claim/records';
import { resetKernelStateForTests } from '../src/kernel/manager';
import { createClaimsRouter } from '../src/http/claims';
import type { NamespaceClaimProof } from '../src/claim/types';

const ROOT = 'cleaker.me';
const previousStateDir = process.env.ME_STATE_DIR;
const previousClaimDir = process.env.MONAD_CLAIM_DIR;
let clock: number;
let directory: string;
let keypair: CryptoKeyPair;
let namespace: string;
let identityHash: string;
let server: Server | null = null;

async function proofAt(timestamp: number, challenge: string | null = null): Promise<NamespaceClaimProof> {
  const message = normalizeProofMessage({ identityHash, expression: namespace.split('.')[0], namespace, rootNamespace: ROOT, challenge, timestamp });
  const signature = await crypto.webcrypto.subtle.sign('Ed25519', keypair.privateKey, new TextEncoder().encode(message));
  const publicKey = await crypto.webcrypto.subtle.exportKey('raw', keypair.publicKey);
  return { message, signature: Buffer.from(signature).toString('base64url'), publicKey: Buffer.from(publicKey).toString('base64url'), timestamp };
}

async function claim() {
  expect((await claimNamespace({ namespace, proof: await proofAt(clock) })).ok).toBe(true);
}

async function serve() {
  const app = express();
  app.use(express.json());
  app.use(createClaimsRouter());
  server = await new Promise<Server>(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monad-proof-freshness-'));
  process.env.ME_STATE_DIR = path.join(directory, 'state');
  process.env.MONAD_CLAIM_DIR = path.join(directory, 'claims');
  resetKernelStateForTests();
  resetOpenNonceStoreForTests();
  namespace = `freshness-${crypto.randomBytes(6).toString('hex')}.${ROOT}`;
  identityHash = crypto.randomBytes(32).toString('hex');
  keypair = await crypto.webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = null;
  }
  resetOpenNonceStoreForTests();
  resetKernelStateForTests();
  if (previousStateDir === undefined) delete process.env.ME_STATE_DIR; else process.env.ME_STATE_DIR = previousStateDir;
  if (previousClaimDir === undefined) delete process.env.MONAD_CLAIM_DIR; else process.env.MONAD_CLAIM_DIR = previousClaimDir;
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('claim proof freshness uses signed time only (F1)', () => {
  it.each([-1, 1])('rejects an out-of-window claim (%s) despite fresh outer metadata', async direction => {
    const proof = await proofAt(clock + direction * (5 * 60_000 + 1));
    proof.timestamp = clock;
    expect(await claimNamespace({ namespace, proof })).toEqual({ ok: false, error: 'PROOF_TIMESTAMP_INVALID' });
    expect(getClaim(namespace)).toBeUndefined();
  });

  it('accepts current signed claim/open times even with stale or absent outer metadata', async () => {
    const proof = await proofAt(clock);
    proof.timestamp = 1;
    expect((await claimNamespace({ namespace, proof })).ok).toBe(true);
    const open = await proofAt(clock, 'open:' + crypto.randomUUID());
    delete open.timestamp;
    expect((await openNamespace({ namespace, proof: open })).ok).toBe(true);
    const another = await proofAt(clock, 'open:' + crypto.randomUUID());
    another.timestamp = 1;
    expect((await openNamespace({ namespace, proof: another })).ok).toBe(true);
  });

  it('cannot rejuvenate an already-used open proof after its nonce window expires', async () => {
    await claim();
    const proof = await proofAt(clock, 'open:' + crypto.randomUUID());
    expect((await openNamespace({ namespace, proof })).ok).toBe(true);
    clock += 60_001;
    proof.timestamp = clock;
    expect(await openNamespace({ namespace, proof })).toEqual({ ok: false, error: 'PROOF_TIMESTAMP_INVALID' });
  });

  it('rejects an out-of-window future open even when outer metadata says now', async () => {
    await claim();
    const proof = await proofAt(clock + 60_001, 'open:' + crypto.randomUUID());
    proof.timestamp = clock;
    expect(await openNamespace({ namespace, proof })).toEqual({ ok: false, error: 'PROOF_TIMESTAMP_INVALID' });
  });

  it('does not replace a missing or invalid signed timestamp with outer metadata', async () => {
    for (const timestamp of [undefined, 0, -1]) {
      const proof = await proofAt(clock);
      const payload = JSON.parse(proof.message);
      if (timestamp === undefined) delete payload.timestamp; else payload.timestamp = timestamp;
      proof.message = normalizeProofMessage(payload);
      proof.signature = Buffer.from(await crypto.webcrypto.subtle.sign('Ed25519', keypair.privateKey, new TextEncoder().encode(proof.message))).toString('base64url');
      expect(await claimNamespace({ namespace, proof })).toEqual({ ok: false, error: 'PROOF_MESSAGE_INVALID' });
    }
  });

  it('still rejects an expired signed proof after the process-local nonce store is cleared', async () => {
    await claim();
    const proof = await proofAt(clock, 'open:' + crypto.randomUUID());
    expect((await openNamespace({ namespace, proof })).ok).toBe(true);
    resetOpenNonceStoreForTests(); // replay state lost, as after a restart
    clock += 60_001;
    proof.timestamp = clock;
    expect(await openNamespace({ namespace, proof })).toEqual({ ok: false, error: 'PROOF_TIMESTAMP_INVALID' });
  });

  it('rejects editing the signed time without a new valid signature', async () => {
    await claim();
    const proof = await proofAt(clock - 60_001, 'open:' + crypto.randomUUID());
    const payload = JSON.parse(proof.message);
    payload.timestamp = clock;
    proof.message = normalizeProofMessage(payload);
    proof.timestamp = clock;
    expect(await openNamespace({ namespace, proof })).toEqual({ ok: false, error: 'CLAIM_VERIFICATION_FAILED' });
  });

  it('POST /claims rejects expired signed time despite current outer metadata', async () => {
    const base = await serve();
    const proof = await proofAt(clock - 5 * 60_000 - 1);
    proof.timestamp = clock;
    const response = await fetch(base + '/claims', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ namespace, proof, username: namespace.split('.')[0], name: 'Freshness test', email: 'freshness@example.test', phone: '5551234567' }) });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('PROOF_TIMESTAMP_INVALID');
    expect(getClaim(namespace)).toBeUndefined();
  });

  it.each(['/claims/open', '/claims/signIn'])('%s returns no memories for a captured proof with refreshed outer time', async endpoint => {
    await claim();
    const base = await serve();
    const proof = await proofAt(clock, 'open:' + crypto.randomUUID());
    const first = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ namespace, proof }) });
    expect(first.status).toBe(200);
    clock += 60_001;
    proof.timestamp = clock;
    const replay = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ namespace, proof }) });
    expect(replay.status).toBe(400);
    const body = await replay.json();
    expect(JSON.stringify(body)).toContain('PROOF_TIMESTAMP_INVALID');
    expect(JSON.stringify(body)).not.toMatch(/"memories"|"verified":true/);
  });
});

/**
 * commitsync.test.ts — The Memory Ledger and State Replay
 *
 * WHAT IS COMMITSYNC?
 * monad.ai stores user state as a sequential log of "memories" — semantic facts
 * with a timestamp and a hash linking each entry to the next. Think of it as a
 * blockchain for personal data: every change is committed, hashed, and chained.
 *
 * Each memory entry has:
 *   namespace:  which user this belongs to ("user.cleaker.me")
 *   path:       what semantic key is being set ("profile.name")
 *   operator:   how the value is applied ("=", "+", etc.)
 *   data:       the value being stored ("Abella")
 *   timestamp:  when this change happened
 *   hash:       fingerprint of this entry (links to the chain)
 *
 * MEMORY REPLAY:
 * `ME` (from this.me) can rebuild state from a memory log. Given a list of memory
 * entries, it replays them in order to reconstruct the current state:
 *   replayMemories([...]) → applies each entry to the in-memory kernel
 *   me("settings.theme") → reads the reconstructed value
 *
 * WHAT WE TEST (2 groups):
 *   1. CommitSync: Memory Ledger — appendSemanticMemory and listSemanticMemoriesByNamespace
 *   2. SessionOrchestrator: Memory Replay — ME.replayMemories rebuilds state from a log
 */

// CommitSync protocol integration tests for Monad.ai
import ME from 'this.me';
import { appendSemanticMemory, listSemanticMemoriesByNamespace } from '../src/claim/memoryStore';

describe('CommitSync: Memory Ledger', () => {
  const testNamespace = 'user.cleaker.me';

  // The first memory entry we'll commit to the ledger.
  // This sets "profile.name" = "Abella" for the test namespace.
  const initialMemory = {
    namespace: testNamespace,
    path: 'profile.name',
    operator: '=',     // "=" means: set this value (replace any previous value)
    data: 'Abella',
    timestamp: Date.now(),
  };

  it('should commit a new memory to the ledger', async () => {
    // WHAT: Call appendSemanticMemory to add one entry to the ledger.
    //       Verify the returned entry has:
    //         - the correct path ("profile.name")
    //         - a hash value (non-empty string — the content fingerprint)
    //
    // WHY: The hash is the key to the "sync" in CommitSync. Each entry's hash
    //      is computed from its content. When another node receives this entry,
    //      it can verify the hash to confirm the data wasn't tampered with.
    //
    //      If the hash is missing or empty, the chain is broken and sync is unreliable.
    const memory = appendSemanticMemory(initialMemory);
    expect(memory.path).toBe('profile.name');
    expect(memory.hash).toBeTruthy(); // exists and is non-empty
  });

  it('should sync memories incrementally', async () => {
    // WHAT: Read back memories for the test namespace with a limit of 50 entries.
    //       The results should be an array containing our previously committed entry.
    //
    // HOW: listSemanticMemoriesByNamespace returns entries in chronological order.
    //      We use .some() to find our entry by path — there might be other entries
    //      in the list if previous tests ran in the same process.
    //
    // WHY: "Incremental sync" means a client that has already seen entries up to
    //      timestamp T can request only entries after T. This test verifies that
    //      the committed entry IS visible through the list API — a prerequisite
    //      for any sync protocol to work.
    const memories = listSemanticMemoriesByNamespace(testNamespace, { limit: 50 });
    expect(Array.isArray(memories)).toBe(true);
    expect(memories.some((memory) => memory.path === 'profile.name')).toBe(true);
  });
});

describe('SessionOrchestrator: Memory Replay', () => {
  it('should rebuild state by learning from the memory log', async () => {
    // WHAT: Create a ME instance (personal semantic kernel), then replay a pre-built
    //       memory log to reconstruct state.
    //
    // HOW:
    //   1. new ME("test-seed") creates an empty kernel with a specific seed
    //   2. replayMemories([...]) processes each entry in timestamp order:
    //        - settings.theme = "dark"   (timestamp 1, earlier)
    //        - settings.font  = "mono"   (timestamp 2, later)
    //   3. me("settings.theme") should return "dark"
    //   4. me("settings.font") should return "mono"
    //
    // WHY: Replay is how monad.ai reconstructs state after restart.
    //      The kernel is ephemeral (in-memory), but the memory log is persistent.
    //      On startup, the daemon replays the log to rebuild the current state
    //      without requiring any external database. Think of it like
    //      event sourcing / CQRS — the log IS the source of truth.
    //
    //      If replay doesn't work, the daemon loses all user state on every restart.
    const me = new ME('test-seed-commitsync');

    // A minimal memory log — two sequential writes in timestamp order
    const memoryLog = [
      {
        path: 'settings.theme',
        expression: 'dark',
        value: 'dark',
        operator: '=',    // "=" means set (not append or increment)
        hash: 'h1',       // in production this would be a real content hash
        timestamp: 1,     // earlier timestamp → replayed first
      },
      {
        path: 'settings.font',
        expression: 'mono',
        value: 'mono',
        operator: '=',
        hash: 'h2',
        timestamp: 2,     // later timestamp → replayed second
      },
    ];

    // Replay the log — rebuilds kernel state from the entries
    me.replayMemories(memoryLog);

    // Verify reconstructed state matches what was in the log
    expect((me as any)('settings.theme')).toBe('dark');
    expect((me as any)('settings.font')).toBe('mono');
  });
});

import assert from "node:assert";
import { randomBytes } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
import { HeliusUnavailableError } from "../src/lib/helius";

process.env.HELIUS_API_KEY = "test";

const RUN = `${process.pid}-${Date.now()}`;
const MINT = getBase58Decoder().decode(randomBytes(32));
const realFetch = globalThis.fetch;
let snapshotSlot = 100;
let snapshotAmount = 0n;
let onSnapshot: (() => Promise<void>) | null = null;
let malformedSnapshot = false;
let splitSnapshotSlots: { spl: number[]; token2022: number[] } | null = null;
let observedMinSlots: { spl: number[]; token2022: number[] } = { spl: [], token2022: [] };

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("mainnet.helius-rpc.com")) throw new Error(`unexpected fetch ${url}`);
  const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; params?: unknown[] };
  if (body.method !== "getTokenAccountsByOwner") throw new Error(`unexpected RPC ${body.method}`);
  if (onSnapshot) {
    const callback = onSnapshot;
    onSnapshot = null;
    await callback();
  }
  const filter = body.params?.[1] as { programId?: string } | undefined;
  const token2022 = filter?.programId === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const options = body.params?.[2] as { minContextSlot?: number } | undefined;
  const program = token2022 ? "token2022" : "spl";
  observedMinSlots[program].push(options?.minContextSlot ?? 0);
  const slot = splitSnapshotSlots?.[program].shift() ?? snapshotSlot;
  const value = malformedSnapshot
    ? [{ account: { data: { parsed: { info: { mint: MINT, tokenAmount: { amount: "not-a-number" } } } } } }]
    : token2022 && snapshotAmount > 0n
    ? [{ account: { data: { parsed: { info: { mint: MINT, tokenAmount: { amount: String(snapshotAmount) } } } } } }]
    : [];
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot }, value } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { getWalletTokensSnapshot } = await import("../src/lib/helius");
  const { refreshWalletHoldings } = await import("../src/lib/stocks-real");
  const {
    bumpWalletGeneration,
    captureWalletSnapshotFence,
    claimWalletRefreshLease,
    releaseWalletRefreshLease,
  } = await import("../src/lib/wallet-sync");
  const { refreshStaleStockWallets } = await import("../src/lib/stock-wallet-sweep");

  const userIds: string[] = [];
  let assetId: string | null = null;
  try {
    splitSnapshotSlots = { spl: [100, 112], token2022: [110] };
    observedMinSlots = { spl: [], token2022: [] };
    const split = await getWalletTokensSnapshot(`payer-split-${RUN}`, 0n);
    assert.strictEqual(split.slot, 110, "the accepted floor reaches the newer half of a split snapshot");
    assert.deepStrictEqual(observedMinSlots.spl, [0, 110], "the older SPL half is re-read at the newer slot");
    assert.deepStrictEqual(observedMinSlots.token2022, [0]);
    splitSnapshotSlots = null;

    const user = await prisma.user.create({
      data: { privyId: `did:privy:wallet-race-${RUN}`, authProvider: "EMAIL", referralCode: `wr-${RUN}` },
    });
    userIds.push(user.id);
    const asset = await prisma.stockAsset.create({
      data: {
        mint: MINT,
        symbol: `WR${process.pid}x`,
        name: "Wallet Race xStock",
        underlying: "WR",
        decimals: 0,
        priceCents: 100,
        pricedAt: new Date(),
      },
    });
    assetId = asset.id;

    // Barrier: an RPC snapshot starts, then a SELL confirm closes the lot and bumps the generation.
    // The first snapshot must be rejected; the bounded retry observes the post-sale empty wallet and
    // must not resurrect a phantom imported lot.
    const payer = `payer-race-${RUN}`;
    const lot = await prisma.stockPosition.create({
      data: { userId: user.id, assetId: asset.id, mode: "REAL", source: "DECK", qtyBase: 100n, costCents: 100, entryPriceCents: 100, payer },
    });
    await prisma.stockWalletState.create({ data: { userId: user.id, payer } });
    snapshotSlot = 100;
    snapshotAmount = 0n;
    onSnapshot = async () => {
      await prisma.$transaction(async (db) => {
        await bumpWalletGeneration(db, user.id, payer, 100n);
        await db.stockPosition.update({ where: { id: lot.id }, data: { closedAt: new Date(), closeReason: "sold" } });
      });
    };
    const barrier = await refreshWalletHoldings(user.id, payer);
    assert.strictEqual(barrier.accepted, true, "generation race retries and accepts a new snapshot");
    assert.strictEqual(barrier.adopted, 0, "post-sale snapshot does not import a phantom lot");
    assert.strictEqual(
      await prisma.stockPosition.count({ where: { userId: user.id, payer, closedAt: null } }),
      0,
      "no open lot is resurrected",
    );

    // A replica behind the latest confirmed receipt is never accepted as fresh.
    const stalePayer = `payer-stale-${RUN}`;
    await prisma.stockWalletState.create({
      data: { userId: user.id, payer: stalePayer, latestConfirmedReceiptSlot: 500n },
    });
    snapshotSlot = 499;
    await assert.rejects(
      refreshWalletHoldings(user.id, stalePayer),
      HeliusUnavailableError,
      "minContextSlot/context.slot fence rejects a lagging replica",
    );

    malformedSnapshot = true;
    snapshotSlot = 500;
    await assert.rejects(
      refreshWalletHoldings(user.id, stalePayer),
      HeliusUnavailableError,
      "a malformed token account cannot close lots or stamp wallet freshness",
    );
    malformedSnapshot = false;

    // A quarantined legacy receipt may already have moved this mint. Wallet refresh can accept the
    // rest of the snapshot, but it must not import that ambiguous balance as a second WALLET lot.
    const manualPayer = `payer-manual-${RUN}`;
    await prisma.stockWalletState.create({ data: { userId: user.id, payer: manualPayer } });
    const manualAttempt = await prisma.stockBuyAttempt.create({
      data: {
        userId: user.id,
        assetId: asset.id,
        payer: manualPayer,
        stakeCents: 100,
        inAmountMicro: 100n,
        minOutBase: 100n,
        msgHash: `legacy-${RUN}`,
        lastValidBlockHeight: 1n,
        manualReviewReason: "legacy_landed_wire_provenance_unverified",
      },
    });
    snapshotSlot = 550;
    snapshotAmount = 100n;
    const quarantined = await refreshWalletHoldings(user.id, manualPayer);
    assert.strictEqual(quarantined.accepted, true);
    assert.strictEqual(quarantined.adopted, 0, "manual-review mint is not imported as a second lot");
    assert.strictEqual(
      await prisma.stockPosition.count({ where: { userId: user.id, payer: manualPayer, assetId: asset.id } }),
      0,
    );
    await prisma.stockBuyAttempt.delete({ where: { id: manualAttempt.id } });

    // A payer-wide confirmed slot survives a later account linking the same wallet. The new owner
    // must inherit that floor before its first RPC snapshot.
    const sharedPayer = `payer-shared-${RUN}`;
    await prisma.$transaction((db) => bumpWalletGeneration(db, user.id, sharedPayer, 500n));
    const laterOwner = await prisma.user.create({
      data: { privyId: `did:privy:shared-${RUN}`, authProvider: "EMAIL", referralCode: `shared-${RUN}` },
    });
    userIds.push(laterOwner.id);
    await prisma.hedgeWallet.create({ data: { userId: laterOwner.id, address: sharedPayer, verifiedAt: new Date() } });
    const inheritedFence = await captureWalletSnapshotFence(prisma, laterOwner.id, sharedPayer);
    assert.strictEqual(inheritedFence.requiredSlot, 500n, "a later owner inherits the payer-wide receipt slot floor");

    // Lease release is ownership-checked. If A runs past expiry and B acquires a new lease, A's late
    // finally block cannot clear B's lease and admit a third overlapping refresh.
    const leasePayer = `payer-lease-${RUN}`;
    const leaseA = await claimWalletRefreshLease(prisma, user.id, leasePayer, new Date(1_000), 1_000);
    assert.ok(leaseA);
    const leaseB = await claimWalletRefreshLease(prisma, user.id, leasePayer, new Date(3_000), 1_000);
    assert.ok(leaseB);
    await releaseWalletRefreshLease(prisma, user.id, leasePayer, leaseA!);
    assert.strictEqual(
      (await prisma.stockWalletState.findUniqueOrThrow({ where: { userId_payer: { userId: user.id, payer: leasePayer } } })).leaseUntil?.getTime(),
      leaseB!.getTime(),
      "an expired worker cannot release the current worker's lease",
    );
    await releaseWalletRefreshLease(prisma, user.id, leasePayer, leaseB!);

    // Two reconcilers can read the same external holding, but generation validation and a locked
    // re-read produce one imported lot, never duplicates.
    const concurrentPayer = `payer-concurrent-${RUN}`;
    await prisma.stockWalletState.create({ data: { userId: user.id, payer: concurrentPayer } });
    snapshotSlot = 600;
    snapshotAmount = 100n;
    await Promise.all([
      refreshWalletHoldings(user.id, concurrentPayer),
      refreshWalletHoldings(user.id, concurrentPayer),
    ]);
    const imported = await prisma.stockPosition.findMany({
      where: { userId: user.id, payer: concurrentPayer, source: "WALLET", closedAt: null },
    });
    assert.strictEqual(imported.length, 1, "concurrent refresh creates one imported lot");
    assert.strictEqual(imported[0]!.qtyBase, 100n);

    // Background refresh is bounded and cursor-fair: 12 inactive open-wallet states are covered as
    // 10 then 2, and the injected refresh avoids network calls while exercising leases/cursors.
    const backgroundPairs: { userId: string; payer: string }[] = [];
    for (let i = 0; i < 12; i++) {
      const bg = await prisma.user.create({
        data: { privyId: `did:privy:bg-${RUN}-${i}`, authProvider: "EMAIL", referralCode: `bg-${RUN}-${i}` },
      });
      userIds.push(bg.id);
      const bgPayer = `payer-bg-${RUN}-${String(i).padStart(2, "0")}`;
      backgroundPairs.push({ userId: bg.id, payer: bgPayer });
      await prisma.stockWalletState.create({
        data: { userId: bg.id, payer: bgPayer, lastCheckedAt: new Date(Date.now() - 7 * 3_600_000) },
      });
      await prisma.stockPosition.create({
        data: { userId: bg.id, assetId: asset.id, mode: "REAL", qtyBase: 1n, costCents: 1, entryPriceCents: 100, payer: bgPayer },
      });
    }
    const visited: string[] = [];
    const fakeRefresh = async (userId: string, bgPayer: string) => {
      visited.push(`${userId}|${bgPayer}`);
      return { adopted: 0, closed: 0, accepted: true };
    };
    const first = await refreshStaleStockWallets(prisma, new Date(), fakeRefresh);
    const second = await refreshStaleStockWallets(prisma, new Date(), fakeRefresh);
    assert.strictEqual(first.scanned, 10, "first background batch is capped at 10 wallets");
    assert.strictEqual(second.scanned, 2, "second batch advances past the first ten");
    assert.strictEqual(new Set(visited).size, 12, "every inactive wallet is reached without starvation");

    console.log("test-stock-wallet-races: OK");
  } finally {
    globalThis.fetch = realFetch;
    await prisma.sweepCursor.deleteMany({ where: { name: { in: ["stock-wallet-refresh"] } } });
    await prisma.stockBuyAttempt.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.stockPosition.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.stockWalletState.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.hedgeWallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (assetId) await prisma.stockAsset.deleteMany({ where: { id: assetId } });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  globalThis.fetch = realFetch;
  console.error("FAIL:", error);
  process.exitCode = 1;
});

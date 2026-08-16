// The run-scoped convergence probe, shared by every money verb: the relayer's own view of THIS
// run's transaction. A wallet-wide balance delta cannot tell one flow from another (K3 S6/S7
// MEDIUM-1) — a concurrent fill, wrap or withdrawal satisfies or masks all of them at once.
// Verdict semantics are lifted from the SDK's own TransactionHandle.wait.
import type { PrismaClient, WalletOpKind } from "@prisma/client";
import type { TxVerdict } from "./workflow";
import { fetchTransaction } from "@polymarket/client/actions";
import type { serverSecureClient } from "./polymarket-server";

export async function relayerVerdict(
  prisma: PrismaClient,
  userId: string,
  kind: WalletOpKind,
  client: NonNullable<Awaited<ReturnType<typeof serverSecureClient>>>,
): Promise<TxVerdict> {
  const row = await prisma.walletWorkflow.findUnique({
    where: { userId_kind: { userId, kind } },
    select: { txHash: true },
  });
  if (!row?.txHash) return "unknown"; // nothing handed off to the relayer yet
  try {
    const tx = await fetchTransaction(client, { transactionId: row.txHash });
    const state = String(tx.state);
    if (state === "STATE_CONFIRMED") return "landed";
    if (state === "STATE_FAILED" || state === "STATE_INVALID") return "failed";
    return "pending"; // STATE_NEW / STATE_EXECUTED / STATE_MINED
  } catch {
    return "unknown"; // probe unreachable — the balance predicates stay in charge
  }
}

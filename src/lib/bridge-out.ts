// The BRIDGE_OUT run: one pUSD transfer from the deposit wallet to a single-purpose bridge address.
// The spec lives here because TWO routes drive the same run — /api/real/withdraw starts it (it is
// the only place allowed to mint the bridge address) and /api/real/workflow answers it — and the
// two must build byte-identical calls or the engine would restart the run on every device answer.
import type { WorkflowGen, WorkflowSpec, StepRequest } from "./workflow";
import type { serverSecureClient } from "./polymarket-server";
import { buildPusdTransferCall } from "./wallet-ops";
import { erc20BalanceOf, PUSD_ADDRESS } from "./polygon";
import { prepareGaslessTransaction } from "@polymarket/client/actions";

export type BridgeOutInputs = {
  bridgeAddress: string;
  recipient: string;
  chainId: string;
  tokenAddress: string;
  amountMicro: string;
  wallet: string;
  pusdBaseline: string;
};

export function bridgeOutSpec(
  userId: string,
  signerAddress: string,
  client: NonNullable<Awaited<ReturnType<typeof serverSecureClient>>>,
  inputs: BridgeOutInputs,
): WorkflowSpec {
  const amount = BigInt(inputs.amountMicro);
  const baseline = BigInt(inputs.pusdBaseline);
  return {
    userId,
    kind: "BRIDGE_OUT",
    inputs,
    factory: () =>
      prepareGaslessTransaction(client, {
        calls: [buildPusdTransferCall(inputs.bridgeAddress, amount)].map((c) => ({
          to: c.to,
          data: c.data as `0x${string}`,
        })),
        metadata: "HedgeFun bridge withdrawal",
      }) as Promise<WorkflowGen>,
    autoAnswer: (r: StepRequest) => (r.kind === "requestAddress" ? signerAddress : null),
    // The only thing this run owns is pUSD leaving the wallet, so a DROP from the run's own
    // baseline is the signal — and it is still wrapped in runScoped by the caller, because a
    // concurrent fill lowers pUSD too and would otherwise read as "the withdrawal landed".
    verify: async () => (await erc20BalanceOf(PUSD_ADDRESS, inputs.wallet)) <= baseline - amount,
    // Still at the baseline = nothing moved, so the run is safe to reset.
    definitelyNotDone: async () => (await erc20BalanceOf(PUSD_ADDRESS, inputs.wallet)) >= baseline,
  };
}

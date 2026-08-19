// What did the bridge actually charge? Its API publishes no fee anywhere, so the only source of a
// real number is the status row of a withdrawal that already happened. This prints it raw.
//
//   npx tsx scripts/bridge-status.ts 0x<bridge-address>
//
// The bridge address is the one the withdrawal card shows truncated; GET /api/real/withdraw returns
// it in full. Once a field carrying the DELIVERED amount is identified here, RealWithdrawCard can
// show the exact fee instead of the measured sentence it currently carries.
import { fetchWithdrawalStatus } from "../src/lib/bridge";

const address = process.argv[2];
if (!address) {
  console.error("usage: tsx scripts/bridge-status.ts 0x<bridge-address>");
  process.exit(1);
}

const { status, txHash, raw } = await fetchWithdrawalStatus(address);
console.log("status:", status, "\ntxHash:", txHash);
console.log("raw:", JSON.stringify(raw, null, 2));

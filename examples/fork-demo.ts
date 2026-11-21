// Create, check and simulate a buy end to end, on a local anvil fork of Robinhood Chain (npm run example; needs Foundry).
import { parseEther } from 'viem';
import { checkDeal, createDeal, decodeDealLink, encodeDealLink, prepareBuy, sellerApproval, simulateBuy } from 'flash-deals-sdk';
import { startFork } from '../test/fork/anvil.js';
import { USDG, WETH, giveUsdg, wrapEth } from '../test/fork/fund.js';

const fork = await startFork(4663);
const [seller, buyer] = fork.accounts as [`0x${string}`, `0x${string}`];
await wrapEth(fork, seller, parseEther('1'));
await giveUsdg(fork, buyer, 3_000_000_000n);
const send = async (from: `0x${string}`, tx: { to: `0x${string}`; data: `0x${string}` }) =>
  fork.client.waitForTransactionReceipt({ hash: await fork.wallet(from).sendTransaction({ account: from, chain: fork.client.chain, ...tx }) });

// 1. The seller creates the deal: 1 WETH for 3,000 USDG, 25% vesting linearly over 90 days
const deal = createDeal({ chainId: 4663, seller, sell: { token: WETH, amount: parseEther('1') }, price: { token: USDG, amount: 3_000_000_000n }, buyers: { wallet: buyer }, vesting: { percent: 25, shape: 'linear', duration: 90 * 86_400 } });
const sellerSig = await fork.wallet(seller).signTypedData({ account: seller, ...deal.typedData });
await send(seller, sellerApproval(4663, deal.terms));
const link = encodeDealLink({ chainId: 4663, terms: deal.terms, sellerSig, whitelist: deal.whitelist });
console.log('link:', link.slice(0, 80) + '…');

// 2. The buyer opens the link and runs the checks
const opened = decodeDealLink(link);
const check = await checkDeal(fork.client, opened, { buyer });
console.log('state:', check.state, '| ok:', check.ok, '| price per WETH:', check.price.unitPrice, 'USDG | fee:', check.price.fee, '|', check.vesting?.description);
for (const c of check.checks) console.log(c.ok ? '  ✓' : '  ✗', c.message);

// 3. The buyer signs, approves the price and simulates the settle
const buy = await prepareBuy(fork.client, opened, buyer);
const buyerSig = await fork.wallet(buyer).signTypedData({ account: buyer, ...buy.typedData });
if (buy.approval) await send(buyer, buy.approval);
console.log('simulated settle consumes digest', await simulateBuy(fork.client, buy, buyerSig), '=', deal.digest);
fork.stop();

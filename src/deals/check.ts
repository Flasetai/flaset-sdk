// Deal state and pre-buy checks (tokens, signature, seller balance/allowance, fee, vesting).
import { erc20Abi, formatUnits, getAddress, type Address, type Hash, type PublicClient } from 'viem';
import { flasetDealsAbi } from './abi.js';
import { deploymentOf } from './deployments.js';
import type { SignedDeal } from './link.js';
import { searchBackwards, type LogSearch } from './logs.js';
import { BPS, BUYER_MODE, SHAPE_NAMES, appStartOk, dealTypedData, feeOf, sellerDigest, termsProblems, type DealTerms, type ShapeName } from './terms.js';
import { checkToken, type TokenCheck } from './tokens.js';
import { whitelistTree } from './whitelist.js';

export type DealState = 'open' | 'filled' | 'cancelled' | 'expired';

export interface DealStatus {
  state: DealState;
  digest: Hash;
  /** filled: the settlement */
  settled?: { tx: Hash; block: bigint; buyer: Address; streamId: bigint };
  /** cancelled: who cancelled, and the transaction */
  cancelled?: { tx: Hash; block: bigint; by: Address };
}

/** open | expired | filled | cancelled. Used deals are found by digest in DealSettled/DealCancelled, newest first. */
export async function dealState(client: PublicClient, chainId: number, terms: DealTerms, opts: { now?: number; logs?: LogSearch } = {}): Promise<DealStatus> {
  const { FlasetDeals } = deploymentOf(chainId);
  const digest = sellerDigest(chainId, terms);
  const consumed = await client.readContract({ address: FlasetDeals.address, abi: flasetDealsAbi, functionName: 'consumed', args: [digest] });
  const now = BigInt(opts.now ?? Math.floor(Date.now() / 1000));
  if (!consumed) return { state: terms.deadline < now ? 'expired' : 'open', digest };
  const range = { fromBlock: opts.logs?.fromBlock ?? FlasetDeals.deployBlock, toBlock: opts.logs?.toBlock, window: opts.logs?.window };
  const logs = await searchBackwards(
    client,
    chainId,
    range,
    async (fromBlock, toBlock) => {
      const [s, c] = await Promise.all([
        client.getContractEvents({ address: FlasetDeals.address, abi: flasetDealsAbi, eventName: 'DealSettled', args: { digest }, fromBlock, toBlock, strict: true }),
        client.getContractEvents({ address: FlasetDeals.address, abi: flasetDealsAbi, eventName: 'DealCancelled', args: { digest }, fromBlock, toBlock, strict: true }),
      ]);
      return [...s, ...c];
    },
    (items) => items.length > 0,
  );
  const log = logs[0];
  if (log?.eventName === 'DealSettled') {
    return { state: 'filled', digest, settled: { tx: log.transactionHash, block: log.blockNumber, buyer: log.args.buyer, streamId: log.args.streamId } };
  }
  if (log?.eventName === 'DealCancelled') {
    return { state: 'cancelled', digest, cancelled: { tx: log.transactionHash, block: log.blockNumber, by: log.args.by } };
  }
  throw new Error(`Deal ${digest} is used on chain, but no DealSettled or DealCancelled log was found from block ${range.fromBlock}.`);
}

export interface Check {
  id: string;
  ok: boolean;
  /** an error stops the buy; a warning is for the buyer to read */
  level: 'error' | 'warning';
  message: string;
}

export interface VestingSummary {
  /** the share that goes into a stream, in percent */
  percent: number;
  shape: ShapeName;
  /** seconds; 0 where the shape takes none */
  cliff: bigint;
  duration: bigint;
  steps: number;
  /** 0 = at settlement */
  start: bigint;
  transferable: boolean;
  description: string;
}

export interface PriceSummary {
  feeBps: number;
  payAmount: bigint;
  fee: bigint;
  /** what the seller gets: the price minus the fee */
  sellerReceives: bigint;
  /** what the buyer gets at settlement */
  buyerReceivesNow: bigint;
  /** what goes into the buyer's stream */
  vestedAmount: bigint;
  /** the price of one whole token sold, in the price token, when both tokens' decimals are known */
  unitPrice: string | null;
}

export interface DealCheck extends DealStatus {
  /** true when the deal is open and no check with level error failed */
  ok: boolean;
  checks: Check[];
  tokens: { asset: TokenCheck; pay: TokenCheck };
  price: PriceSummary;
  vesting: VestingSummary | null;
  /** with `buyer`: the approval the buyer still needs to send, in the price token's base units; 0n when none */
  buyerApprovalNeeded?: bigint;
}

const days = (s: bigint) => {
  const d = Number(s) / 86_400;
  return Number.isInteger(d) ? `${d} ${d === 1 ? 'day' : 'days'}` : `${Number(s).toLocaleString('en-US')} seconds`;
};

/** Human-readable vesting summary */
export function describeVesting(t: DealTerms): VestingSummary | null {
  if (t.vestingBps === 0) return null;
  const shape = SHAPE_NAMES[t.vestingShape] ?? 'linear';
  const pct = t.vestingBps / 100;
  const from = t.vestingStart === 0n ? 'from the settlement' : `from ${new Date(Number(t.vestingStart) * 1000).toISOString().replace('.000Z', 'Z')}`;
  const words: Record<ShapeName, string> = {
    linear: `${pct}% vests evenly over ${days(t.vestingDuration)} ${from}`,
    cliff: `${pct}% vests over ${days(t.vestingDuration)} ${from}, with a cliff at ${days(t.vestingCliff)}`,
    steps: `${pct}% unlocks in ${t.vestingSteps} equal steps over ${days(t.vestingDuration)} ${from}`,
    monthly: `${pct}% unlocks in ${t.vestingSteps} monthly parts, the first one month ${from.replace('from ', 'after ')}`,
    allAtOnce: `${pct}% unlocks all at once after ${days(t.vestingDuration)} ${from}`,
  };
  const transfer = t.vestingTransferable ? 'The stream can move to another wallet.' : 'The stream stays with the buyer.';
  return {
    percent: pct,
    shape,
    cliff: t.vestingCliff,
    duration: t.vestingDuration,
    steps: t.vestingSteps,
    start: t.vestingStart,
    transferable: t.vestingTransferable,
    description: `${words[shape]}, as a Sablier stream that nobody can cancel. ${transfer}`,
  };
}

const decimalsOf = (t: TokenCheck) => ('decimals' in t ? t.decimals : null);
const labelOf = (t: TokenCheck) => ('symbol' in t && t.symbol ? t.symbol : t.address);

function tokenCheck(id: string, role: string, t: TokenCheck): Check {
  switch (t.kind) {
    case 'known':
      return { id, ok: true, level: 'error', message: `The ${role} is ${t.symbol}, at its listed address.` };
    case 'unverified':
      return { id, ok: false, level: 'warning', message: `The ${role} calls itself ${t.symbol} and is on no standard list. Check its address yourself.` };
    case 'lookalike':
      return { id, ok: false, level: 'error', message: `The ${role} calls itself ${t.symbol} but is not the real ${t.imitates.symbol}.` };
    case 'delegated':
      return { id, ok: false, level: 'error', message: `The ${role} address is a wallet with an EIP-7702 delegation, not a token contract.` };
    case 'invalid':
      return {
        id,
        ok: false,
        level: 'error',
        message: t.why === 'blocked' ? `Flaset blocked the ${role} on Flash Deals.` : t.why === 'no-code' ? `There is no token contract at the ${role} address.` : `The ${role} does not answer as an ERC-20 does.`,
      };
  }
}

/** State plus all pre-buy checks. With `buyer`, also checks eligibility, balance and the missing approval. */
export async function checkDeal(client: PublicClient, deal: SignedDeal, opts: { buyer?: Address; now?: number; logs?: LogSearch } = {}): Promise<DealCheck> {
  const { chainId, terms, sellerSig, whitelist } = deal;
  const { FlasetDeals } = deploymentOf(chainId);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const deals = FlasetDeals.address;

  const [status, paused, feeBps, sigOk, asset, pay, sellerBalance, sellerAllowance] = await Promise.all([
    dealState(client, chainId, terms, { now, logs: opts.logs }),
    client.readContract({ address: deals, abi: flasetDealsAbi, functionName: 'paused' }),
    client.readContract({ address: deals, abi: flasetDealsAbi, functionName: 'feeBps' }),
    client.verifyTypedData({ address: terms.seller, ...dealTypedData(chainId, terms), signature: sellerSig }).catch(() => false),
    checkToken(client, chainId, terms.asset),
    checkToken(client, chainId, terms.payToken),
    client.readContract({ address: terms.asset, abi: erc20Abi, functionName: 'balanceOf', args: [terms.seller] }).catch(() => 0n),
    client.readContract({ address: terms.asset, abi: erc20Abi, functionName: 'allowance', args: [terms.seller, deals] }).catch(() => 0n),
  ]);

  const problems = termsProblems(terms);
  const fee = feeOf(terms.payAmount, feeBps);
  const vestedAmount = (terms.assetAmount * BigInt(terms.vestingBps)) / BigInt(BPS);
  const aDec = decimalsOf(asset);
  const pDec = decimalsOf(pay);
  const checks: Check[] = [
    { id: 'terms', ok: problems.length === 0, level: 'error', message: problems.length ? problems.join(' ') : 'The terms are ones FlasetDeals takes.' },
    {
      id: 'vesting-start',
      ok: appStartOk(terms, now),
      level: 'error',
      message: appStartOk(terms, now) ? 'The vesting starts as the Flaset app signs it.' : 'The vesting sets a start of its own, which the Flaset app does not open.',
    },
    { id: 'paused', ok: !paused, level: 'error', message: paused ? 'Flash Deals are paused right now. Nothing settles until they resume.' : 'Flash Deals are live.' },
    { id: 'deadline', ok: terms.deadline >= BigInt(now), level: 'error', message: terms.deadline >= BigInt(now) ? 'The deal is within its deadline.' : 'The deal is past its deadline.' },
    { id: 'state', ok: status.state === 'open', level: 'error', message: status.state === 'open' ? 'The deal is open.' : `The deal is ${status.state}.` },
    {
      id: 'signature',
      ok: sigOk,
      level: 'error',
      message: sigOk ? 'The seller’s signature matches these exact terms.' : 'The seller’s signature does not match these terms.',
    },
    tokenCheck('asset-token', 'token sold', asset),
    tokenCheck('pay-token', 'price token', pay),
    {
      id: 'seller-balance',
      ok: sellerBalance >= terms.assetAmount,
      level: 'error',
      message: sellerBalance >= terms.assetAmount ? `The seller holds the ${labelOf(asset)}.` : `The seller holds only ${aDec === null ? sellerBalance : formatUnits(sellerBalance, aDec)} ${labelOf(asset)}.`,
    },
    {
      id: 'seller-allowance',
      ok: sellerAllowance >= terms.assetAmount,
      level: 'error',
      message: sellerAllowance >= terms.assetAmount ? `The seller approved the ${labelOf(asset)} for FlasetDeals.` : 'The seller has not approved the tokens for FlasetDeals yet, so a settle reverts.',
    },
    {
      id: 'fee',
      ok: fee <= terms.maxFee,
      level: 'error',
      message: fee <= terms.maxFee ? `The fee is ${feeBps / 100}% of the price, within the signed maxFee.` : `The fee (${feeBps / 100}%) is above the maxFee the seller signed, so a settle reverts.`,
    },
  ];
  if (terms.buyerMode === BUYER_MODE.whitelist) {
    const same = !!whitelist && whitelistTree(whitelist).root.toLowerCase() === terms.buyersRoot.toLowerCase();
    checks.push({ id: 'whitelist', ok: same, level: 'error', message: same ? 'The whitelist is the one the seller signed.' : 'The whitelist is not the one the seller signed.' });
  }

  let buyerApprovalNeeded: bigint | undefined;
  if (opts.buyer) {
    const buyer = getAddress(opts.buyer);
    const mode = terms.buyerMode;
    const allowed =
      buyer.toLowerCase() !== terms.seller.toLowerCase() &&
      (mode === BUYER_MODE.oneWallet ? buyer.toLowerCase() === terms.buyer.toLowerCase() : mode === BUYER_MODE.whitelist ? !!whitelist && whitelistTree(whitelist).has(buyer) : true);
    checks.push({ id: 'buyer', ok: allowed, level: 'error', message: allowed ? 'This wallet may take the deal.' : 'This wallet may not take the deal.' });
    const [bal, allowance] = await Promise.all([
      client.readContract({ address: terms.payToken, abi: erc20Abi, functionName: 'balanceOf', args: [buyer] }).catch(() => 0n),
      client.readContract({ address: terms.payToken, abi: erc20Abi, functionName: 'allowance', args: [buyer, deals] }).catch(() => 0n),
    ]);
    checks.push({
      id: 'buyer-balance',
      ok: bal >= terms.payAmount,
      level: 'error',
      message: bal >= terms.payAmount ? `This wallet holds the ${labelOf(pay)} to pay.` : `This wallet holds only ${pDec === null ? bal : formatUnits(bal, pDec)} ${labelOf(pay)}.`,
    });
    buyerApprovalNeeded = allowance >= terms.payAmount ? 0n : terms.payAmount;
  }

  const unitPrice = aDec !== null && pDec !== null ? formatUnits((terms.payAmount * 10n ** BigInt(aDec)) / terms.assetAmount, pDec) : null;
  return {
    ...status,
    ok: status.state === 'open' && checks.every((c) => c.ok || c.level === 'warning'),
    checks,
    tokens: { asset, pay },
    price: { feeBps, payAmount: terms.payAmount, fee, sellerReceives: terms.payAmount - fee, buyerReceivesNow: terms.assetAmount - vestedAmount, vestedAmount, unitPrice },
    vesting: describeVesting(terms),
    ...(buyerApprovalNeeded === undefined ? {} : { buyerApprovalNeeded }),
  };
}

/** FlasetDeals.feeBps, live: 20 (0.20%) today, changeable by a governance vote */
export async function readFeeBps(client: PublicClient, chainId: number): Promise<number> {
  return client.readContract({ address: deploymentOf(chainId).FlasetDeals.address, abi: flasetDealsAbi, functionName: 'feeBps' });
}

// Create: the seller's side. Build the terms from plain inputs, then the typed data the seller signs, then (after the
// signature) the link the buyer opens and the one transaction the seller sends: the approval of the tokens sold.
import { encodeFunctionData, erc20Abi, getAddress, type Address, type Hex } from 'viem';
import { deploymentOf } from './deployments.js';
import { FlasetError } from '../errors.js';
import {
  BUYER_MODE,
  DEFAULT_FEE_BPS,
  NO_DEADLINE,
  SHAPE,
  ZERO_ADDRESS,
  ZERO_ROOT,
  assertTerms,
  dealTypedData,
  feeOf,
  randomNonce,
  sellerDigest,
  type DealTerms,
} from './terms.js';
import { MAX_LIST, whitelistTree } from './whitelist.js';

/** Who may buy: one wallet, the wallets on a list (the first to settle), or anyone (the first to settle) */
export type Buyers = { wallet: Address } | { whitelist: readonly Address[] } | 'anyone';

/** The vested share and how it unlocks. Durations in seconds. */
export type Vesting =
  | { percent: number; shape: 'linear'; duration: number; transferable?: boolean }
  | { percent: number; shape: 'cliff'; cliff: number; duration: number; transferable?: boolean }
  | { percent: number; shape: 'steps'; steps: number; duration: number; transferable?: boolean }
  | { percent: number; shape: 'monthly'; months: number; start: bigint; transferable?: boolean }
  | { percent: number; shape: 'allAtOnce'; duration: number; transferable?: boolean };

export interface CreateDealInput {
  chainId: number;
  seller: Address;
  /** the token sold and its amount in base units */
  sell: { token: Address; amount: bigint };
  /** the price token and the price in base units */
  price: { token: Address; amount: bigint };
  buyers: Buyers;
  vesting?: Vesting;
  /** seconds from now until the deal expires; null for no expiry. Default: 24 hours */
  expiresIn?: number | null;
  /** the fee the seller accepts, in basis points (default the live 0.20%); signed as maxFee */
  feeBps?: number;
  nonce?: bigint;
  /** seconds since the epoch; default now */
  now?: number;
}

export interface CreatedDeal {
  chainId: number;
  /** the offer the seller signs */
  terms: DealTerms;
  /** a whitelist's wallets, which travel with the link */
  whitelist: Address[] | null;
  /** pass to the seller's signTypedData */
  typedData: ReturnType<typeof dealTypedData>;
  /** the digest the seller signs and the contract marks once the deal settles or is cancelled */
  digest: Hex;
}

function vestingFields(v: Vesting | undefined): Pick<DealTerms, 'vestingBps' | 'vestingShape' | 'vestingStart' | 'vestingCliff' | 'vestingDuration' | 'vestingSteps' | 'vestingTransferable'> {
  if (!v || v.percent === 0) return { vestingBps: 0, vestingShape: 0, vestingStart: 0n, vestingCliff: 0n, vestingDuration: 0n, vestingSteps: 0, vestingTransferable: false };
  const bps = Math.round(v.percent * 100);
  if (!(bps > 0 && bps <= 10_000) || Math.abs(bps - v.percent * 100) > 1e-9) throw new FlasetError('INVALID_TERMS', 'vesting.percent is from 0.01 to 100, in steps of 0.01.');
  const base = { vestingBps: bps, vestingShape: SHAPE[v.shape], vestingStart: 0n, vestingCliff: 0n, vestingDuration: 0n, vestingSteps: 0, vestingTransferable: v.transferable ?? false };
  switch (v.shape) {
    case 'linear':
    case 'allAtOnce':
      return { ...base, vestingDuration: BigInt(v.duration) };
    case 'cliff':
      return { ...base, vestingCliff: BigInt(v.cliff), vestingDuration: BigInt(v.duration) };
    case 'steps':
      return { ...base, vestingSteps: v.steps, vestingDuration: BigInt(v.duration) };
    case 'monthly':
      return { ...base, vestingSteps: v.months, vestingStart: v.start };
  }
}

/** Build a deal's terms and the typed data the seller signs. Throws a FlasetError for terms FlasetDeals refuses. */
export function createDeal(input: CreateDealInput): CreatedDeal {
  const { chainId } = input;
  deploymentOf(chainId);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  let buyer: Address = ZERO_ADDRESS;
  let buyerMode: DealTerms['buyerMode'] = BUYER_MODE.anyone;
  let buyersRoot: Hex = ZERO_ROOT;
  let whitelist: Address[] | null = null;
  if (input.buyers !== 'anyone' && 'wallet' in input.buyers) {
    buyer = getAddress(input.buyers.wallet);
    buyerMode = BUYER_MODE.oneWallet;
  } else if (input.buyers !== 'anyone') {
    const tree = whitelistTree(input.buyers.whitelist);
    if (tree.wallets.length > MAX_LIST) throw new FlasetError('INVALID_TERMS', `A whitelist holds at most ${MAX_LIST} wallets.`);
    if (tree.has(input.seller)) throw new FlasetError('INVALID_TERMS', 'The seller cannot be on the whitelist.');
    buyerMode = BUYER_MODE.whitelist;
    buyersRoot = tree.root;
    whitelist = tree.wallets;
  }
  const expiresIn = input.expiresIn === undefined ? 24 * 3600 : input.expiresIn;
  const terms = assertTerms({
    seller: getAddress(input.seller),
    buyer,
    buyerMode,
    buyersRoot,
    asset: getAddress(input.sell.token),
    assetAmount: input.sell.amount,
    payToken: getAddress(input.price.token),
    payAmount: input.price.amount,
    ...vestingFields(input.vesting),
    maxFee: feeOf(input.price.amount, input.feeBps ?? DEFAULT_FEE_BPS),
    deadline: expiresIn === null ? NO_DEADLINE : BigInt(now + Math.round(expiresIn)),
    nonce: input.nonce ?? randomNonce(),
  });
  return { chainId, terms, whitelist, typedData: dealTypedData(chainId, terms), digest: sellerDigest(chainId, terms) };
}

/**
 * The seller's one transaction: approve FlasetDeals for exactly the amount sold. Send it with any wallet client
 * (`walletClient.sendTransaction({ to, data })`).
 */
export function sellerApproval(chainId: number, terms: DealTerms): { to: Address; data: Hex } {
  return {
    to: terms.asset,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [deploymentOf(chainId).FlasetDeals.address, terms.assetAmount] }),
  };
}

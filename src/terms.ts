// The Deal both sides sign, its EIP-712 typed data and its digests, as FlasetDeals defines them. The field order and
// types match FlasetDeals.DEAL_TYPEHASH; the domain is "FLASET Deals", version "3", on FlasetDeals' own address, so a
// signature counts only on that contract on its own chain.
import { getAddress, hashTypedData, isAddress, type Address, type Hex } from 'viem';
import { deploymentOf } from './deployments.js';
import { FlashDealsError } from './errors.js';

export const BUYER_MODE = { oneWallet: 0, whitelist: 1, anyone: 2 } as const;
export type BuyerMode = (typeof BUYER_MODE)[keyof typeof BUYER_MODE];

/** FlasetDeals.Shape: each one Sablier stream for the buyer */
export const SHAPE = { linear: 0, cliff: 1, steps: 2, monthly: 3, allAtOnce: 4 } as const;
export type ShapeName = keyof typeof SHAPE;
export const SHAPE_NAMES = Object.keys(SHAPE) as ShapeName[];

/** FlasetDeals.MAX_STEPS: at most 48 unlocks */
export const MAX_STEPS = 48;
/** FlasetDeals.BPS */
export const BPS = 10_000;
/** The fee FlasetDeals charges today, 0.20% of the price, from the seller's side. A governance vote can change it: read it live with `readFeeBps`. */
export const DEFAULT_FEE_BPS = 20;
/** The deadline of a deal without an expiry, as the Flaset app signs it */
export const NO_DEADLINE = BigInt(Number.MAX_SAFE_INTEGER);

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
export const ZERO_ROOT = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;
export const EIP712_NAME = 'FLASET Deals';
export const EIP712_VERSION = '3';

/** FlasetDeals.Deal, with every integer as a bigint, as viem passes it */
export type DealTerms = {
  seller: Address;
  /** who takes the deal; the zero address in the seller's signature for a whitelist or anyone */
  buyer: Address;
  buyerMode: BuyerMode;
  /** whitelist only: the Merkle root of the wallets that may buy; zero otherwise */
  buyersRoot: Hex;
  asset: Address;
  assetAmount: bigint;
  payToken: Address;
  payAmount: bigint;
  /** the share of assetAmount that goes into a stream, 0 to 10,000 */
  vestingBps: number;
  vestingShape: number;
  /** 0 = the settlement's timestamp */
  vestingStart: bigint;
  vestingCliff: bigint;
  vestingDuration: bigint;
  vestingSteps: number;
  vestingTransferable: boolean;
  /** the highest fee, in payToken, the seller accepts */
  maxFee: bigint;
  deadline: bigint;
  nonce: bigint;
};

export const DEAL_TYPES = {
  Deal: [
    { name: 'seller', type: 'address' },
    { name: 'buyer', type: 'address' },
    { name: 'buyerMode', type: 'uint8' },
    { name: 'buyersRoot', type: 'bytes32' },
    { name: 'asset', type: 'address' },
    { name: 'assetAmount', type: 'uint256' },
    { name: 'payToken', type: 'address' },
    { name: 'payAmount', type: 'uint256' },
    { name: 'vestingBps', type: 'uint16' },
    { name: 'vestingShape', type: 'uint8' },
    { name: 'vestingStart', type: 'uint64' },
    { name: 'vestingCliff', type: 'uint64' },
    { name: 'vestingDuration', type: 'uint64' },
    { name: 'vestingSteps', type: 'uint16' },
    { name: 'vestingTransferable', type: 'bool' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export function dealDomain(chainId: number) {
  return { name: EIP712_NAME, version: EIP712_VERSION, chainId, verifyingContract: deploymentOf(chainId).FlasetDeals.address } as const;
}

/** The EIP-712 typed data for these terms: pass it to a wallet's signTypedData. */
export function dealTypedData(chainId: number, terms: DealTerms) {
  return { domain: dealDomain(chainId), types: DEAL_TYPES, primaryType: 'Deal', message: terms } as const;
}

/** FlasetDeals.hashDeal: the digest the buyer signs (the deal with the buyer's own address). */
export const hashDeal = (chainId: number, terms: DealTerms): Hex => hashTypedData(dealTypedData(chainId, terms));

/** The offer the seller signs: buyer zero, except for a one-wallet deal. */
export const offerOf = (terms: DealTerms): DealTerms => (terms.buyerMode === BUYER_MODE.oneWallet ? terms : { ...terms, buyer: ZERO_ADDRESS });

/** FlasetDeals._sellerDigest: what the seller signs, what `consumed` keys, and what both events carry as `digest`. */
export const sellerDigest = (chainId: number, terms: DealTerms): Hex => hashDeal(chainId, offerOf(terms));

/** The deal a buyer signs and settles: the seller's offer with the buyer's own address (a one-wallet deal as it is). */
export const buyerTerms = (offer: DealTerms, buyer: Address): DealTerms =>
  offer.buyerMode === BUYER_MODE.oneWallet ? offer : { ...offer, buyer: getAddress(buyer) };

/** FlasetDeals.quoteFee */
export const feeOf = (payAmount: bigint, feeBps: number = DEFAULT_FEE_BPS): bigint => (payAmount * BigInt(feeBps)) / BigInt(BPS);

const isZeroAddress = (a: string) => /^0x0{40}$/i.test(a);
const isZeroRoot = (h: string) => /^0x0{64}$/i.test(h);
const UINT64_MAX = 2n ** 64n - 1n;
const UINT256_MAX = 2n ** 256n - 1n;

/** FlasetDeals._validSchedule: each shape takes exactly the fields it needs, and its other vesting fields are 0. */
export function validSchedule(t: Pick<DealTerms, 'vestingShape' | 'vestingCliff' | 'vestingDuration' | 'vestingSteps'>): boolean {
  const steps = t.vestingSteps >= 2 && t.vestingSteps <= MAX_STEPS;
  if (t.vestingShape === SHAPE.monthly) return t.vestingDuration === 0n && t.vestingCliff === 0n && steps;
  if (t.vestingDuration === 0n) return false;
  if (t.vestingShape === SHAPE.linear || t.vestingShape === SHAPE.allAtOnce) return t.vestingCliff === 0n && t.vestingSteps === 0;
  if (t.vestingShape === SHAPE.cliff) return t.vestingCliff > 0n && t.vestingCliff < t.vestingDuration && t.vestingSteps === 0;
  if (t.vestingShape === SHAPE.steps) return t.vestingCliff === 0n && steps && t.vestingDuration % BigInt(t.vestingSteps) === 0n;
  return false;
}

/**
 * Why FlasetDeals would refuse these terms, before any chain read (FlasetDeals._validate without the token reads), as a
 * list of sentences; empty when they are valid. Pass the offer (buyer zero for a whitelist or anyone) or the buyer's terms.
 */
export function termsProblems(t: DealTerms): string[] {
  const out: string[] = [];
  for (const k of ['seller', 'buyer', 'asset', 'payToken'] as const) if (!isAddress(t[k], { strict: false })) out.push(`${k} is not an address.`);
  if (out.length) return out;
  if (isZeroAddress(t.seller)) out.push('The seller is the zero address.');
  if (t.seller.toLowerCase() === t.buyer.toLowerCase()) out.push('The seller and the buyer are the same wallet.');
  if (![0, 1, 2].includes(t.buyerMode)) out.push('buyerMode is 0 (one wallet), 1 (whitelist) or 2 (anyone).');
  if ((t.buyerMode === BUYER_MODE.whitelist) === isZeroRoot(t.buyersRoot)) out.push('Only a whitelist deal carries a buyersRoot, and it always does.');
  if (t.buyerMode === BUYER_MODE.oneWallet && isZeroAddress(t.buyer)) out.push('A one-wallet deal names its buyer.');
  if (t.assetAmount <= 0n || t.payAmount <= 0n) out.push('Both amounts are above zero.');
  if (t.assetAmount > UINT256_MAX || t.payAmount > UINT256_MAX || t.maxFee < 0n || t.maxFee > UINT256_MAX || t.nonce < 0n || t.nonce > UINT256_MAX) out.push('An amount is outside uint256.');
  if (t.asset.toLowerCase() === t.payToken.toLowerCase()) out.push('The token sold and the price token are different tokens.');
  if (!Number.isInteger(t.vestingBps) || t.vestingBps < 0 || t.vestingBps > BPS) out.push('vestingBps is a whole number from 0 to 10,000.');
  for (const k of ['vestingStart', 'vestingCliff', 'vestingDuration', 'deadline'] as const) if (t[k] < 0n || t[k] > UINT64_MAX) out.push(`${k} is outside uint64.`);
  if (t.vestingBps > 0 && !validSchedule(t)) out.push('The vesting fields do not fit the vesting shape.');
  if (t.vestingBps > 0 && (t.assetAmount * BigInt(t.vestingBps)) / BigInt(BPS) >= 2n ** 128n) out.push('The vested amount is above uint128.');
  return out;
}

export function assertTerms(t: DealTerms): DealTerms {
  const p = termsProblems(t);
  if (p.length) throw new FlashDealsError('INVALID_TERMS', p.join(' '));
  return t;
}

/**
 * The Flaset app counts vesting from the settlement (vestingStart 0), except Monthly, which starts at 12:00 UTC on a day
 * from 7 days before now to 91 days after. A link with another start does not open in the app.
 */
export function appStartOk(t: Pick<DealTerms, 'vestingStart' | 'vestingShape' | 'vestingBps'>, now: number): boolean {
  if (t.vestingStart === 0n) return true;
  const s = Number(t.vestingStart);
  return t.vestingShape === SHAPE.monthly && t.vestingBps > 0 && s % 86_400 === 12 * 3_600 && s >= now - 7 * 86_400 && s <= now + 91 * 86_400;
}

/** 12:00 UTC on a calendar day, in seconds: the start of a Monthly vesting, as the Flaset app picks it */
export function monthlyStart(date: Date | string): bigint {
  const d = typeof date === 'string' ? new Date(`${date}T00:00:00Z`) : date;
  if (Number.isNaN(d.getTime())) throw new FlashDealsError('INVALID_TERMS', 'monthlyStart takes a Date or a YYYY-MM-DD day.');
  return BigInt(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12) / 1000);
}

/** A random 256-bit nonce */
export function randomNonce(): bigint {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return BigInt(`0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`);
}

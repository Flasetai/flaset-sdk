// Deal links: `<origin><appPath>/deal/open#d=<deal>&l=<list>`, same format as the app.
// d = base64url JSON { v: 3, chainId, contract, terms, sellerSig } (uint256 as decimal strings, uint64 as numbers).
// l = concatenated 20-byte addresses, base64url. Data lives in the fragment, so it is never sent to a server.
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { chainOf, isChainId } from '../chains.js';
import { deploymentOf } from './deployments.js';
import { FlasetError } from '../errors.js';
import { BUYER_MODE, appStartOk, termsProblems, type DealTerms } from './terms.js';
import { MAX_LIST, whitelistTree } from './whitelist.js';

export const DEFAULT_ORIGIN = 'https://flaset.ai';
/** the longest link the app reads */
export const MAX_LINK_LENGTH = 8_000;

/** A signed deal: everything a buyer needs to check and settle it */
export interface SignedDeal {
  chainId: number;
  /** the seller's offer */
  terms: DealTerms;
  sellerSig: Hex;
  /** a whitelist's wallets; null for one wallet or anyone */
  whitelist: Address[] | null;
}

const toB64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fromB64url(s: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('not base64url');
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return atob(b + '='.repeat((4 - (b.length % 4)) % 4));
}

/** Each wallet's 20 bytes in order, base64url without padding */
export function packList(list: readonly Address[]): string {
  let bin = '';
  for (const a of list) {
    const h = getAddress(a).slice(2);
    for (let j = 0; j < 40; j += 2) bin += String.fromCharCode(parseInt(h.slice(j, j + 2), 16));
  }
  return toB64url(bin);
}

/** 1 to MAX_LIST whole wallets, checksummed; null otherwise */
export function unpackList(s: string | null | undefined): Address[] | null {
  if (!s) return null;
  let bin: string;
  try {
    bin = fromB64url(s);
  } catch {
    return null;
  }
  if (bin.length === 0 || bin.length % 20 !== 0 || bin.length / 20 > MAX_LIST) return null;
  const out: Address[] = [];
  for (let i = 0; i < bin.length; i += 20) {
    let h = '0x';
    for (let j = 0; j < 20; j++) h += bin.charCodeAt(i + j).toString(16).padStart(2, '0');
    out.push(getAddress(h));
  }
  return out;
}

/** the terms as the app's link JSON holds them, in the app's key order */
function termsJson(t: DealTerms) {
  const n = (v: bigint) => {
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new FlasetError('INVALID_LINK', 'A time field is past the largest number a link holds.');
    return Number(v);
  };
  return {
    seller: t.seller,
    buyer: t.buyer,
    buyerMode: t.buyerMode,
    buyersRoot: t.buyersRoot,
    asset: t.asset,
    assetAmount: t.assetAmount.toString(),
    payToken: t.payToken,
    payAmount: t.payAmount.toString(),
    vestingBps: t.vestingBps,
    vestingShape: t.vestingShape,
    vestingStart: n(t.vestingStart),
    vestingCliff: n(t.vestingCliff),
    vestingDuration: n(t.vestingDuration),
    vestingSteps: t.vestingSteps,
    vestingTransferable: t.vestingTransferable,
    maxFee: t.maxFee.toString(),
    deadline: n(t.deadline),
    nonce: t.nonce.toString(),
  };
}

const KEYS = Object.keys(termsJson({ seller: '0x', buyer: '0x', buyerMode: 0, buyersRoot: '0x', asset: '0x', assetAmount: 0n, payToken: '0x', payAmount: 0n, vestingBps: 0, vestingShape: 0, vestingStart: 0n, vestingCliff: 0n, vestingDuration: 0n, vestingSteps: 0, vestingTransferable: false, maxFee: 0n, deadline: 0n, nonce: 0n }));

const bad = (why: string): never => {
  throw new FlasetError('INVALID_LINK', why);
};

function termsFromJson(raw: unknown): DealTerms {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('The deal terms in this link are broken.');
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).length !== KEYS.length || !KEYS.every((k) => k in o)) return bad('The deal terms in this link are broken.');
  const addr = (k: string) => (typeof o[k] === 'string' && isAddress(o[k] as string, { strict: false }) ? getAddress(o[k] as string) : bad('The deal terms in this link are broken.'));
  const uint = (k: string) => (typeof o[k] === 'string' && /^(0|[1-9][0-9]*)$/.test(o[k] as string) ? BigInt(o[k] as string) : bad('The deal terms in this link are broken.'));
  const int = (k: string, max: number) => (typeof o[k] === 'number' && Number.isInteger(o[k]) && (o[k] as number) >= 0 && (o[k] as number) <= max ? (o[k] as number) : bad('The deal terms in this link are broken.'));
  if (typeof o.buyersRoot !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(o.buyersRoot)) bad('The deal terms in this link are broken.');
  if (typeof o.vestingTransferable !== 'boolean') bad('The deal terms in this link are broken.');
  return {
    seller: addr('seller'),
    buyer: addr('buyer'),
    buyerMode: int('buyerMode', 2) as DealTerms['buyerMode'],
    buyersRoot: o.buyersRoot as Hex,
    asset: addr('asset'),
    assetAmount: uint('assetAmount'),
    payToken: addr('payToken'),
    payAmount: uint('payAmount'),
    vestingBps: int('vestingBps', 10_000),
    vestingShape: int('vestingShape', 4),
    vestingStart: BigInt(int('vestingStart', Number.MAX_SAFE_INTEGER)),
    vestingCliff: BigInt(int('vestingCliff', Number.MAX_SAFE_INTEGER)),
    vestingDuration: BigInt(int('vestingDuration', Number.MAX_SAFE_INTEGER)),
    vestingSteps: int('vestingSteps', 65_535),
    vestingTransferable: o.vestingTransferable as boolean,
    maxFee: uint('maxFee'),
    deadline: BigInt(int('deadline', Number.MAX_SAFE_INTEGER)),
    nonce: uint('nonce'),
  };
}

/** The link the buyer opens in the Flaset app, or reads with `decodeDealLink`. */
export function encodeDealLink(deal: SignedDeal, opts: { origin?: string } = {}): string {
  const { chainId, terms, sellerSig, whitelist } = deal;
  const contract = deploymentOf(chainId).FlasetDeals.address;
  if (!/^0x[0-9a-fA-F]{130}$/.test(sellerSig)) throw new FlasetError('INVALID_LINK', 'sellerSig is a 65-byte signature.');
  if (terms.buyerMode === BUYER_MODE.whitelist && !whitelist) throw new FlasetError('INVALID_LINK', 'A whitelist deal travels with its wallets.');
  const payload = { v: 3, chainId, contract, terms: termsJson(terms), sellerSig };
  const origin = (opts.origin ?? DEFAULT_ORIGIN).replace(/\/+$/, '');
  const list = terms.buyerMode === BUYER_MODE.whitelist && whitelist ? `&l=${packList(whitelist)}` : '';
  return `${origin}${chainOf(chainId).appPath}/deal/open#d=${toB64url(JSON.stringify(payload))}${list}`;
}

/** Parses a full link, a fragment, or a bare `d` value. Throws INVALID_LINK when the app would reject it. */
export function decodeDealLink(link: string, opts: { now?: number } = {}): SignedDeal {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const text = link.trim();
  if (text.length > MAX_LINK_LENGTH) bad('This link is too long to be a Flash Deal link.');
  const hash = text.includes('#') ? text.slice(text.indexOf('#') + 1) : /^https?:\/\//i.test(text) ? '' : text.includes('=') ? text : `d=${text}`;
  const frag = new URLSearchParams(hash);
  const d = frag.get('d');
  if (!d) bad('This link has no deal in it.');
  let p: { v?: unknown; chainId?: unknown; contract?: unknown; terms?: unknown; sellerSig?: unknown };
  try {
    p = JSON.parse(fromB64url(d!)) as typeof p;
  } catch {
    return bad('The deal in this link is broken.');
  }
  if (!p || typeof p !== 'object') bad('The deal in this link is broken.');
  if (p.v !== 3) bad('This link is for an earlier Flash Deals contract. Ask the seller for a new link.');
  if (!isChainId(p.chainId)) bad(`This deal is for a network Flash Deals does not run on (chain ${String(p.chainId).slice(0, 12)}).`);
  const chainId = p.chainId as number;
  if (typeof p.contract !== 'string' || p.contract.toLowerCase() !== deploymentOf(chainId).FlasetDeals.address.toLowerCase()) {
    bad('This link names a Flash Deals contract that is not FlasetDeals on its chain. Ask the seller for a new link.');
  }
  const terms = termsFromJson(p.terms);
  if (termsProblems(terms).length) bad('The deal terms in this link are broken.');
  if (typeof p.sellerSig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(p.sellerSig)) bad('The seller’s signature in this link is broken.');
  if (!appStartOk(terms, now)) bad('This link sets a vesting start of its own. The app counts vesting from the settlement only, so it does not open this link.');
  if (terms.buyerMode !== BUYER_MODE.oneWallet && !/^0x0{40}$/i.test(terms.buyer)) bad('This link names a buyer for an open deal. Ask the seller for a new link.');
  let whitelist: Address[] | null = null;
  if (terms.buyerMode === BUYER_MODE.whitelist) {
    whitelist = unpackList(frag.get('l'));
    if (!whitelist) bad('The whitelist in this link is broken.');
    if (whitelistTree(whitelist!).root.toLowerCase() !== terms.buyersRoot.toLowerCase()) bad('The whitelist in this link is not the one the seller signed.');
  }
  return { chainId, terms, sellerSig: p.sellerSig as Hex, whitelist };
}

// Token classification by address, never by symbol. Each chain has a standard list (wrapped native, stablecoins and on
// Robinhood Chain the Stock Tokens). An unlisted token reusing a listed symbol or name is flagged as a lookalike.
import { erc20Abi, getAddress, hexToString, type Address, type Hex, type PublicClient } from 'viem';
import { flasetRegistryAbi } from './abi.js';
import { deploymentOf } from './deployments.js';
import robinhood from './token-lists/4663.json' with { type: 'json' };
import base from './token-lists/8453.json' with { type: 'json' };
import bnb from './token-lists/56.json' with { type: 'json' };
import ethereum from './token-lists/1.json' with { type: 'json' };

export interface ListToken {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  kind: 'wrapped' | 'stable' | 'stock';
}
export interface NativeCoin {
  symbol: string;
  name: string;
  decimals: number;
  /** the wrapped form Flash Deals takes */
  wrapped: Address;
}
export interface TokenList {
  chainId: number;
  native: NativeCoin | null;
  tokens: ListToken[];
}

const LISTS: Record<number, TokenList> = Object.fromEntries(([robinhood, base, bnb, ethereum] as TokenList[]).map((l) => [l.chainId, l]));

/** The chain's standard token list, or null for a chain without one */
export const standardList = (chainId: number): TokenList | null => LISTS[chainId] ?? null;

/** The list's token at exactly this address, or null */
export function listedToken(chainId: number, address: string): ListToken | null {
  return standardList(chainId)?.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase()) ?? null;
}

/** normalize for comparison: "U S D G", "usdg" and "USDG." all match */
const plain = (s: string) => s.normalize('NFKC').toUpperCase().replace(/[^0-9A-Z]/g, '');

/** What a token at `address` imitates: the listed token (or the chain's coin) whose symbol or name it takes at another address */
export function lookalikeOf(chainId: number, address: string, symbol: string | null, name: string | null): ListToken | NativeCoin | null {
  const list = standardList(chainId);
  if (!list || listedToken(chainId, address)) return null;
  const s = symbol ? plain(symbol) : '';
  const n = name ? plain(name) : '';
  const hits = (x: { symbol: string; name: string }) =>
    (s !== '' && (plain(x.symbol) === s || plain(x.name) === s)) || (n !== '' && (plain(x.name) === n || plain(x.symbol) === n));
  return list.tokens.find(hits) ?? (list.native && hits(list.native) ? list.native : null);
}

/** Robinhood Chain's ArbOS precompiles: one byte of code, then a revert at the first token call */
const PRECOMPILES = new Set([...Array.from({ length: 6 }, (_, i) => 0x64 + i), ...Array.from({ length: 10 }, (_, i) => 0x6b + i), 0xff, 0xa4b05].map(BigInt));

export type CodeKind = { kind: 'none' } | { kind: 'delegated'; delegate: Address } | { kind: 'contract' };

/** none (no code, 1 byte, or precompile) | delegated (EIP-7702, 0xef0100 + address) | contract */
export function codeKind(address: string, code: string | null | undefined): CodeKind {
  if (PRECOMPILES.has(BigInt(address))) return { kind: 'none' };
  const c = (code ?? '0x').toLowerCase();
  if (c === '0x' || c.length <= 4) return { kind: 'none' };
  if (c.startsWith('0xef0100') && c.length === 2 + 46) return { kind: 'delegated', delegate: getAddress(`0x${c.slice(8)}`) };
  return { kind: 'contract' };
}

export type TokenCheck =
  /** cannot settle: nothing at the address, no ERC-20 there, or blocked on FlasetRegistry */
  | { kind: 'invalid'; address: Address; why: 'no-code' | 'not-a-token' | 'blocked'; symbol: string | null }
  /** a wallet with an EIP-7702 delegation, not a token */
  | { kind: 'delegated'; address: Address; delegate: Address }
  /** on the chain's standard list at exactly this address */
  | { kind: 'known'; address: Address; symbol: string; name: string; decimals: number }
  /** another address that takes a listed token's symbol or name; `imitates` is the real one */
  | { kind: 'lookalike'; address: Address; symbol: string; name: string | null; decimals: number; imitates: ListToken | NativeCoin }
  /** an ERC-20 on no list: settles, but nobody checked it */
  | { kind: 'unverified'; address: Address; symbol: string; name: string | null; decimals: number };

const SYMBOL = /^[\x21-\x7E]{1,16}$/;
const BYTES32_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
] as const;

const bytes32Text = (word: Hex): string | null => {
  const s = hexToString(word).replace(/\0+$/, '');
  return /^[\x20-\x7E]+$/.test(s) ? s.trim() : null;
};

/** Classifies a token: code, registry block, then symbol (string or bytes32), name, decimals. Throws on RPC errors. */
export async function checkToken(client: PublicClient, chainId: number, address: Address): Promise<TokenCheck> {
  const registry = deploymentOf(chainId).FlasetRegistry.address;
  const [code, blocked] = await Promise.all([
    client.getCode({ address }),
    client.readContract({ address: registry, abi: flasetRegistryAbi, functionName: 'isBlocked', args: [address] }),
  ]);
  const kind = codeKind(address, code);
  if (kind.kind === 'none') return { kind: 'invalid', address, why: 'no-code', symbol: null };
  if (kind.kind === 'delegated') return { kind: 'delegated', address, delegate: kind.delegate };
  const read = <T>(p: Promise<T>) => p.then((v) => v as T | undefined, () => undefined);
  const [s, n, d] = await Promise.all([
    read(client.readContract({ address, abi: erc20Abi, functionName: 'symbol' })),
    read(client.readContract({ address, abi: erc20Abi, functionName: 'name' })),
    read(client.readContract({ address, abi: erc20Abi, functionName: 'decimals' })),
  ]);
  const word = (fn: 'symbol' | 'name') => read(client.readContract({ address, abi: BYTES32_ABI, functionName: fn })).then((w) => (w ? bytes32Text(w) : undefined));
  const [s2, n2] = await Promise.all([typeof s === 'string' ? s : word('symbol'), typeof n === 'string' ? n : word('name')]);
  const symbol = typeof s2 === 'string' && SYMBOL.test(s2) ? s2 : null;
  const name = typeof n2 === 'string' && n2.length <= 64 && n2.trim() !== '' ? n2.trim() : null;
  const decimals = typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 36 ? d : null;
  if (blocked) return { kind: 'invalid', address, why: 'blocked', symbol };
  const known = listedToken(chainId, address);
  if (known) return { kind: 'known', address: known.address, symbol: known.symbol, name: known.name, decimals: known.decimals };
  if (!symbol || decimals === null) return { kind: 'invalid', address, why: 'not-a-token', symbol };
  const imitates = lookalikeOf(chainId, address, symbol, name);
  if (imitates) return { kind: 'lookalike', address, symbol, name, decimals, imitates };
  return { kind: 'unverified', address, symbol, name, decimals };
}

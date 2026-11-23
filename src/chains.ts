// Supported chains with their default public RPCs and explorers.
import { createPublicClient, fallback, http, type Chain, type PublicClient } from 'viem';
import { base, bsc, mainnet, robinhood } from 'viem/chains';
import { FlasetError } from './errors.js';

export interface FlashDealsChain {
  id: number;
  name: string;
  /** viem chain with `rpcUrls` as defaults */
  chain: Chain;
  /** public RPCs, used as fallbacks in order */
  rpcUrls: readonly string[];
  explorer: string;
  /** app path for this chain's deal links */
  appPath: string;
  /** max block range per eth_getLogs call */
  logWindow: bigint;
}

const withRpcs = (chain: Chain, rpcUrls: readonly string[], explorer: { name: string; url: string }): Chain => ({
  ...chain,
  rpcUrls: { default: { http: rpcUrls } },
  blockExplorers: { default: explorer },
});

const ROBINHOOD_RPCS = ['https://rpc.mainnet.chain.robinhood.com'] as const;
const BASE_RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'] as const;
const BSC_RPCS = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'] as const;
const ETHEREUM_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://rpc.mevblocker.io', 'https://cloudflare-eth.com'] as const;

export const CHAINS = {
  4663: {
    id: 4663,
    name: 'Robinhood Chain',
    chain: withRpcs(robinhood, ROBINHOOD_RPCS, { name: 'RobinScan', url: 'https://robin.etherscan.io' }),
    rpcUrls: ROBINHOOD_RPCS,
    explorer: 'https://robin.etherscan.io',
    appPath: '/app',
    logWindow: 5_000_000n,
  },
  8453: {
    id: 8453,
    name: 'Base',
    chain: withRpcs(base, BASE_RPCS, { name: 'Basescan', url: 'https://basescan.org' }),
    rpcUrls: BASE_RPCS,
    explorer: 'https://basescan.org',
    appPath: '/app-base',
    logWindow: 10_000n,
  },
  56: {
    id: 56,
    name: 'BNB Chain',
    chain: withRpcs(bsc, BSC_RPCS, { name: 'BscScan', url: 'https://bscscan.com' }),
    rpcUrls: BSC_RPCS,
    explorer: 'https://bscscan.com',
    appPath: '/app-bnb',
    logWindow: 5_000n,
  },
  1: {
    id: 1,
    name: 'Ethereum',
    chain: withRpcs(mainnet, ETHEREUM_RPCS, { name: 'Etherscan', url: 'https://etherscan.io' }),
    rpcUrls: ETHEREUM_RPCS,
    explorer: 'https://etherscan.io',
    appPath: '/app-ethereum',
    logWindow: 2_000n,
  },
} as const satisfies Record<number, FlashDealsChain>;

export type ChainId = keyof typeof CHAINS;

/** Each chain's id by name: `chains.robinhood`, `chains.base`, `chains.bnbChain`, `chains.ethereum` */
export const chains = { robinhood: 4663, base: 8453, bnbChain: 56, ethereum: 1 } as const satisfies Record<string, ChainId>;
export const CHAIN_IDS = Object.keys(CHAINS).map(Number) as ChainId[];

export const isChainId = (id: unknown): id is ChainId => typeof id === 'number' && id in CHAINS;

export function chainOf(id: number): FlashDealsChain {
  if (!isChainId(id)) throw new FlasetError('UNKNOWN_CHAIN', `The Flaset SDK runs on ${CHAIN_IDS.join(', ')}; chain ${id} is none of them.`);
  return CHAINS[id];
}

/** PublicClient for a supported chain. Uses `rpcUrl` if given, else the public RPCs with fallback. */
export function flashDealsClient(chainId: number, opts: { rpcUrl?: string } = {}): PublicClient {
  const c = chainOf(chainId);
  const transport = opts.rpcUrl ? http(opts.rpcUrl) : fallback(c.rpcUrls.map((u) => http(u)));
  return createPublicClient({ chain: c.chain, transport }) as PublicClient;
}

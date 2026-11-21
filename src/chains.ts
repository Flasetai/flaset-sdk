// The four chains FlasetDeals runs on, with the public RPCs and explorers the Flaset app uses. Pass your own RPC URL to
// `flashDealsClient` (or build any viem PublicClient) to read through another provider.
import { createPublicClient, fallback, http, type Chain, type PublicClient } from 'viem';
import { base, bsc, mainnet, robinhood } from 'viem/chains';
import { FlashDealsError } from './errors.js';

export interface FlashDealsChain {
  id: number;
  name: string;
  /** the viem chain, with the RPCs below as its defaults */
  chain: Chain;
  /** public RPCs, read in turn when one fails or rate-limits */
  rpcUrls: readonly string[];
  explorer: string;
  /** the path the Flaset app serves this chain's deals under, on https://flaset.ai */
  appPath: string;
  /** blocks per eth_getLogs call the public RPCs accept */
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
export const CHAIN_IDS = Object.keys(CHAINS).map(Number) as ChainId[];

export const isChainId = (id: unknown): id is ChainId => typeof id === 'number' && id in CHAINS;

export function chainOf(id: number): FlashDealsChain {
  if (!isChainId(id)) throw new FlashDealsError('UNKNOWN_CHAIN', `Flash Deals runs on ${CHAIN_IDS.join(', ')}; chain ${id} is none of them.`);
  return CHAINS[id];
}

/**
 * A viem PublicClient for a Flash Deals chain: through `rpcUrl` when given, else through the chain's public RPCs in turn.
 */
export function flashDealsClient(chainId: number, opts: { rpcUrl?: string } = {}): PublicClient {
  const c = chainOf(chainId);
  const transport = opts.rpcUrl ? http(opts.rpcUrl) : fallback(c.rpcUrls.map((u) => http(u)));
  return createPublicClient({ chain: c.chain, transport }) as PublicClient;
}

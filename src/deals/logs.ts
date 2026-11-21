// eth_getLogs in windows the public RPCs accept, newest first, so a recent event is found in the first calls.
import type { PublicClient } from 'viem';
import { chainOf } from '../chains.js';

export interface LogSearch {
  /** the first block to search; default the FlasetDeals deployment */
  fromBlock?: bigint;
  /** the last block to search; default the latest */
  toBlock?: bigint;
  /** blocks per call; default what the chain's public RPCs accept */
  window?: bigint;
}

/** Calls `get` over [from, to] in windows from the newest down, and stops at the first window that `found` accepts. */
export async function searchBackwards<T>(
  client: PublicClient,
  chainId: number,
  range: { fromBlock: bigint; toBlock?: bigint; window?: bigint },
  get: (from: bigint, to: bigint) => Promise<T[]>,
  found: (items: T[]) => boolean = () => false,
): Promise<T[]> {
  const to = range.toBlock ?? (await client.getBlockNumber());
  const step = range.window ?? chainOf(chainId).logWindow;
  const out: T[] = [];
  for (let hi = to; hi >= range.fromBlock; hi -= step) {
    const lo = hi - step + 1n > range.fromBlock ? hi - step + 1n : range.fromBlock;
    const items = await get(lo, hi);
    out.push(...items);
    if (found(items)) break;
  }
  return out;
}

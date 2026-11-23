// Windowed eth_getLogs, newest block range first.
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

/** Scans [from, to] backwards in windows; stops at the first window `found` accepts. */
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

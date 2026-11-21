// Vesting: the vested share of a deal is one Sablier Lockup stream, minted to the buyer as an NFT, that nobody can
// cancel. A buyer's streams are found through FlasetDeals' DealSettled events (the buyer is indexed); each is then read
// on the Lockup itself.
import { parseEventLogs, type Address, type Hash, type PublicClient, type TransactionReceipt } from 'viem';
import { flasetDealsAbi, sablierLockupAbi } from './abi.js';
import { deploymentOf } from './deployments.js';
import { searchBackwards, type LogSearch } from './logs.js';

/** Sablier Lockup.Status */
export const STREAM_STATUS = ['pending', 'streaming', 'settled', 'canceled', 'depleted'] as const;
export type StreamStatus = (typeof STREAM_STATUS)[number];

export interface Stream {
  id: bigint;
  lockup: Address;
  token: Address;
  /** whoever holds the stream's NFT: the buyer, unless a transferable stream moved */
  recipient: Address;
  /** FlasetDeals for every deal's stream */
  sender: Address;
  deposited: bigint;
  withdrawn: bigint;
  /** what the holder can claim now */
  withdrawable: bigint;
  /** what has unlocked so far */
  streamed: bigint;
  start: number;
  end: number;
  status: StreamStatus;
  transferable: boolean;
  cancelable: boolean;
  /** true when FlasetDeals created it */
  fromFlashDeals: boolean;
}

/** One stream on the chain's Lockup, read now */
export async function readStream(client: PublicClient, chainId: number, streamId: bigint): Promise<Stream> {
  const { SablierLockup, FlasetDeals } = deploymentOf(chainId);
  const address = SablierLockup.address;
  const r = <F extends (typeof sablierLockupAbi)[number]['name']>(functionName: F) =>
    client.readContract({ address, abi: sablierLockupAbi, functionName, args: [streamId] } as never) as Promise<unknown>;
  const [recipient, sender, token, deposited, withdrawn, withdrawable, streamed, start, end, status, transferable, cancelable] = await Promise.all([
    r('getRecipient'),
    r('getSender'),
    r('getUnderlyingToken'),
    r('getDepositedAmount'),
    r('getWithdrawnAmount'),
    r('withdrawableAmountOf'),
    r('streamedAmountOf'),
    r('getStartTime'),
    r('getEndTime'),
    r('statusOf'),
    r('isTransferable'),
    r('isCancelable'),
  ]);
  return {
    id: streamId,
    lockup: address,
    token: token as Address,
    recipient: recipient as Address,
    sender: sender as Address,
    deposited: deposited as bigint,
    withdrawn: withdrawn as bigint,
    withdrawable: withdrawable as bigint,
    streamed: streamed as bigint,
    start: Number(start),
    end: Number(end),
    status: STREAM_STATUS[Number(status)] ?? 'pending',
    transferable: transferable as boolean,
    cancelable: cancelable as boolean,
    fromFlashDeals: (sender as string).toLowerCase() === FlasetDeals.address.toLowerCase(),
  };
}

export interface BuyerStream extends Stream {
  /** the deal's settlement */
  tx: Hash;
  seller: Address;
  digest: Hash;
}

/** Every stream a buyer got from Flash Deals on a chain, read now. Pass `logs.fromBlock` to search fewer blocks. */
export async function streamsOf(client: PublicClient, chainId: number, buyer: Address, opts: { logs?: LogSearch } = {}): Promise<BuyerStream[]> {
  const { FlasetDeals } = deploymentOf(chainId);
  const logs = await searchBackwards(client, chainId, { fromBlock: opts.logs?.fromBlock ?? FlasetDeals.deployBlock, toBlock: opts.logs?.toBlock, window: opts.logs?.window }, (fromBlock, toBlock) =>
    client.getContractEvents({ address: FlasetDeals.address, abi: flasetDealsAbi, eventName: 'DealSettled', args: { buyer }, fromBlock, toBlock, strict: true }),
  );
  const withStream = logs.filter((l) => l.args.streamId > 0n);
  return Promise.all(
    withStream.map(async (l) => ({ ...(await readStream(client, chainId, l.args.streamId)), tx: l.transactionHash, seller: l.args.seller, digest: l.args.digest })),
  );
}

/** The stream a settle created, from its receipt; null for a deal without vesting */
export function streamIdFromReceipt(chainId: number, receipt: TransactionReceipt): bigint | null {
  const deals = deploymentOf(chainId).FlasetDeals.address.toLowerCase();
  const [log] = parseEventLogs({ abi: flasetDealsAbi, eventName: 'DealSettled', logs: receipt.logs.filter((l) => l.address.toLowerCase() === deals) });
  return log && log.args.streamId > 0n ? log.args.streamId : null;
}

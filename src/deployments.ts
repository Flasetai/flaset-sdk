// Every Flash Deals contract per chain. The JSON files under deployments/ hold the same addresses with their ABIs; each
// address is an exact match on Sourcify.
import type { Address, Hex } from 'viem';
import { ADDRESSES } from './addresses.js';
import { chainOf, type ChainId } from './chains.js';

export interface DeployedContract {
  address: Address;
  deployBlock: bigint;
  deployTx: Hex;
}

export interface Deployment {
  chainId: ChainId;
  name: string;
  FlasetDeals: DeployedContract;
  FlasetRegistry: DeployedContract;
  /** Sablier's Lockup, which holds each deal's vested share as a stream */
  SablierLockup: { address: Address };
}

const contract = (c: { address: string; deployBlock: number; deployTx: string }): DeployedContract => ({
  address: c.address as Address,
  deployBlock: BigInt(c.deployBlock),
  deployTx: c.deployTx as Hex,
});

const toDeployment = (raw: (typeof ADDRESSES)[keyof typeof ADDRESSES]): Deployment => ({
  chainId: raw.chainId,
  name: raw.name,
  FlasetDeals: contract(raw.FlasetDeals),
  FlasetRegistry: contract(raw.FlasetRegistry),
  SablierLockup: { address: raw.SablierLockup.address },
});

export const DEPLOYMENTS: Record<ChainId, Deployment> = {
  4663: toDeployment(ADDRESSES[4663]),
  8453: toDeployment(ADDRESSES[8453]),
  56: toDeployment(ADDRESSES[56]),
  1: toDeployment(ADDRESSES[1]),
};

/** The Flash Deals contracts on a chain; throws for a chain Flash Deals does not run on. */
export function deploymentOf(chainId: number): Deployment {
  return DEPLOYMENTS[chainOf(chainId).id as ChainId];
}

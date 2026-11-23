// Fork funding: WETH via deposit(), USDG via an impersonated holder.
import { erc20Abi, parseEther, type Address } from 'viem';
import type { Fork } from './anvil.js';

export const WETH: Address = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
export const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
/** Uniswap v4's PoolManager on Robinhood Chain, which holds USDG */
const USDG_HOLDER: Address = '0x8366a39CC670B4001A1121B8F6A443A643e40951';

export async function wrapEth(fork: Fork, who: Address, amount: bigint) {
  const hash = await fork.wallet(who).sendTransaction({ account: who, chain: fork.client.chain, to: WETH, value: amount, data: '0xd0e30db0' });
  await fork.client.waitForTransactionReceipt({ hash });
}

export async function giveUsdg(fork: Fork, to: Address, amount: bigint) {
  await fork.test.impersonateAccount({ address: USDG_HOLDER });
  await fork.test.setBalance({ address: USDG_HOLDER, value: parseEther('1') });
  const hash = await fork.wallet(USDG_HOLDER).writeContract({ account: USDG_HOLDER, chain: fork.client.chain, address: USDG, abi: erc20Abi, functionName: 'transfer', args: [to, amount] });
  await fork.client.waitForTransactionReceipt({ hash });
  await fork.test.stopImpersonatingAccount({ address: USDG_HOLDER });
}

import { keccak256, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** A test wallet whose key comes from a label, so no key is written down anywhere */
export const testAccount = (label: string) => privateKeyToAccount(keccak256(toHex(`flash-deals-sdk test ${label}`)) as Hex);

export const WETH_4663: Address = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
export const USDG_4663: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

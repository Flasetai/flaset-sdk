import { encodeAbiParameters, hashTypedData, keccak256, recoverTypedDataAddress, toHex, zeroAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  BUYER_MODE,
  DEFAULT_FEE_BPS,
  NO_DEADLINE,
  SHAPE,
  createDeal,
  dealDomain,
  dealTypedData,
  feeOf,
  hashDeal,
  monthlyStart,
  sellerApproval,
  sellerDigest,
  termsProblems,
  validSchedule,
  buyerTerms,
  DEPLOYMENTS,
  FlashDealsError,
} from '../../src/index.js';
import { USDG_4663, WETH_4663, testAccount } from '../helpers.js';

const seller = testAccount('seller');
const buyer = testAccount('buyer');
const NOW = 1_800_000_000;

const base = { chainId: 4663, seller: seller.address, sell: { token: WETH_4663, amount: 10n ** 18n }, price: { token: USDG_4663, amount: 3_000_000_000n }, now: NOW } as const;

describe('the Deal type', () => {
  it('is the type string FlasetDeals hashes (DEAL_TYPEHASH)', () => {
    // FlasetDeals.DEAL_TYPEHASH, copied from the verified source
    const solidity =
      'Deal(address seller,address buyer,uint8 buyerMode,bytes32 buyersRoot,address asset,uint256 assetAmount,' +
      'address payToken,uint256 payAmount,uint16 vestingBps,uint8 vestingShape,uint64 vestingStart,' +
      'uint64 vestingCliff,uint64 vestingDuration,uint16 vestingSteps,bool vestingTransferable,uint256 maxFee,' +
      'uint64 deadline,uint256 nonce)';
    const { terms } = createDeal({ ...base, buyers: { wallet: buyer.address } });
    const typed = dealTypedData(4663, terms);
    const fields = typed.types.Deal.map((f) => `${f.type} ${f.name}`).join(',');
    expect(`Deal(${fields})`).toBe(solidity);
    // the digest by hand, as FlasetDeals builds it: keccak256(0x1901, domainSeparator, keccak256(abi.encode(TYPEHASH, d)))
    const structHash = keccak256(
      encodeAbiParameters([{ type: 'bytes32' }, ...typed.types.Deal], [keccak256(toHex(solidity)), ...typed.types.Deal.map((f) => terms[f.name])] as never),
    );
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
        [keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')), keccak256(toHex('FLASET Deals')), keccak256(toHex('3')), 4663n, DEPLOYMENTS[4663].FlasetDeals.address],
      ),
    );
    expect(hashDeal(4663, terms)).toBe(keccak256(`0x1901${domainSeparator.slice(2)}${structHash.slice(2)}`));
    expect(hashTypedData(typed)).toBe(hashDeal(4663, terms));
  });

  it('signs on FlasetDeals of its own chain, version 3', () => {
    expect(dealDomain(8453)).toEqual({ name: 'FLASET Deals', version: '3', chainId: 8453, verifyingContract: DEPLOYMENTS[8453].FlasetDeals.address });
    const { terms } = createDeal({ ...base, buyers: 'anyone' });
    expect(hashDeal(4663, terms)).not.toBe(hashDeal(1, terms));
  });

  it('has the seller sign the offer with buyer zero, unless one wallet', () => {
    const open = createDeal({ ...base, buyers: 'anyone' });
    const taker = buyerTerms(open.terms, buyer.address);
    expect(taker.buyer).toBe(buyer.address);
    expect(sellerDigest(4663, taker)).toBe(open.digest);
    expect(hashDeal(4663, taker)).not.toBe(open.digest);
    const one = createDeal({ ...base, buyers: { wallet: buyer.address } });
    expect(buyerTerms(one.terms, buyer.address)).toBe(one.terms);
    expect(one.digest).toBe(hashDeal(4663, one.terms));
  });

  it('round-trips a wallet signature', async () => {
    const d = createDeal({ ...base, buyers: { wallet: buyer.address } });
    const sig = await seller.signTypedData(d.typedData);
    expect(await recoverTypedDataAddress({ ...d.typedData, signature: sig })).toBe(seller.address);
  });
});

describe('createDeal', () => {
  it('signs the live 0.20% as maxFee, a 24-hour deadline and a random nonce', () => {
    const a = createDeal({ ...base, buyers: 'anyone' });
    const b = createDeal({ ...base, buyers: 'anyone' });
    expect(DEFAULT_FEE_BPS).toBe(20);
    expect(a.terms.maxFee).toBe(6_000_000n);
    expect(a.terms.maxFee).toBe(feeOf(3_000_000_000n));
    expect(a.terms.deadline).toBe(BigInt(NOW + 86_400));
    expect(a.terms.nonce).not.toBe(b.terms.nonce);
    expect(createDeal({ ...base, buyers: 'anyone', expiresIn: null }).terms.deadline).toBe(NO_DEADLINE);
  });

  it('builds each buyer mode', () => {
    expect(createDeal({ ...base, buyers: { wallet: buyer.address } }).terms).toMatchObject({ buyerMode: BUYER_MODE.oneWallet, buyer: buyer.address });
    const list = createDeal({ ...base, buyers: { whitelist: [buyer.address, testAccount('b2').address] } });
    expect(list.terms).toMatchObject({ buyerMode: BUYER_MODE.whitelist, buyer: zeroAddress });
    expect(list.terms.buyersRoot).not.toMatch(/^0x0{64}$/);
    expect(list.whitelist).toHaveLength(2);
    expect(createDeal({ ...base, buyers: 'anyone' }).terms).toMatchObject({ buyerMode: BUYER_MODE.anyone, buyer: zeroAddress });
  });

  it('builds each vesting shape as FlasetDeals takes it', () => {
    const v = (vesting: Parameters<typeof createDeal>[0]['vesting']) => createDeal({ ...base, buyers: 'anyone', vesting }).terms;
    expect(v({ percent: 30, shape: 'linear', duration: 90 * 86_400 })).toMatchObject({ vestingBps: 3000, vestingShape: SHAPE.linear, vestingDuration: 7_776_000n });
    expect(v({ percent: 50, shape: 'cliff', cliff: 30 * 86_400, duration: 180 * 86_400 })).toMatchObject({ vestingShape: SHAPE.cliff, vestingCliff: 2_592_000n });
    expect(v({ percent: 10, shape: 'steps', steps: 6, duration: 180 * 86_400 })).toMatchObject({ vestingShape: SHAPE.steps, vestingSteps: 6 });
    expect(v({ percent: 25, shape: 'monthly', months: 12, start: monthlyStart('2027-01-15') })).toMatchObject({ vestingShape: SHAPE.monthly, vestingSteps: 12, vestingStart: BigInt(Date.UTC(2027, 0, 15, 12) / 1000) });
    expect(v({ percent: 100, shape: 'allAtOnce', duration: 365 * 86_400, transferable: true })).toMatchObject({ vestingBps: 10_000, vestingShape: SHAPE.allAtOnce, vestingTransferable: true });
    expect(v(undefined)).toMatchObject({ vestingBps: 0, vestingShape: 0, vestingDuration: 0n });
  });

  it('refuses what FlasetDeals refuses', () => {
    const bad = (extra: Partial<Parameters<typeof createDeal>[0]>) => () => createDeal({ ...base, buyers: 'anyone', ...extra } as Parameters<typeof createDeal>[0]);
    expect(bad({ buyers: { wallet: seller.address } })).toThrow(FlashDealsError);
    expect(bad({ price: { token: WETH_4663, amount: 1n } })).toThrow(/different tokens/);
    expect(bad({ sell: { token: WETH_4663, amount: 0n } })).toThrow(/above zero/);
    expect(bad({ vesting: { percent: 30, shape: 'steps', steps: 7, duration: 100 } })).toThrow(/vesting fields/);
    expect(bad({ vesting: { percent: 30, shape: 'cliff', cliff: 100, duration: 100 } })).toThrow(/vesting fields/);
    expect(bad({ vesting: { percent: 30, shape: 'monthly', months: 49, start: 0n } })).toThrow(/vesting fields/);
    expect(bad({ vesting: { percent: 0.001, shape: 'linear', duration: 100 } })).toThrow(/percent/);
    expect(bad({ buyers: { whitelist: [seller.address] } })).toThrow(/whitelist/);
    expect(bad({ chainId: 137 })).toThrow(/chain 137/);
  });

  it('gives the seller one approval: exactly the amount sold, to FlasetDeals', () => {
    const { terms } = createDeal({ ...base, buyers: 'anyone' });
    const tx = sellerApproval(4663, terms);
    expect(tx.to).toBe(WETH_4663);
    expect(tx.data.slice(0, 10)).toBe('0x095ea7b3');
    expect(tx.data).toContain(DEPLOYMENTS[4663].FlasetDeals.address.slice(2).toLowerCase());
    expect(BigInt(`0x${tx.data.slice(-64)}`)).toBe(terms.assetAmount);
  });
});

describe('validSchedule and termsProblems', () => {
  const t = createDeal({ ...base, buyers: 'anyone' }).terms;
  it('matches FlasetDeals._validSchedule', () => {
    const s = (vestingShape: number, vestingCliff: bigint, vestingDuration: bigint, vestingSteps: number) => validSchedule({ vestingShape, vestingCliff, vestingDuration, vestingSteps });
    expect(s(SHAPE.linear, 0n, 10n, 0)).toBe(true);
    expect(s(SHAPE.linear, 0n, 0n, 0)).toBe(false);
    expect(s(SHAPE.linear, 1n, 10n, 0)).toBe(false);
    expect(s(SHAPE.cliff, 5n, 10n, 0)).toBe(true);
    expect(s(SHAPE.cliff, 0n, 10n, 0)).toBe(false);
    expect(s(SHAPE.steps, 0n, 12n, 4)).toBe(true);
    expect(s(SHAPE.steps, 0n, 10n, 4)).toBe(false);
    expect(s(SHAPE.steps, 0n, 10n, 1)).toBe(false);
    expect(s(SHAPE.monthly, 0n, 0n, 48)).toBe(true);
    expect(s(SHAPE.monthly, 0n, 1n, 2)).toBe(false);
    expect(s(SHAPE.allAtOnce, 0n, 1n, 0)).toBe(true);
    expect(s(5, 0n, 1n, 0)).toBe(false);
  });
  it('lists every problem in words', () => {
    expect(termsProblems(t)).toEqual([]);
    expect(termsProblems({ ...t, buyerMode: BUYER_MODE.whitelist })).toEqual(['Only a whitelist deal carries a buyersRoot, and it always does.']);
    expect(termsProblems({ ...t, buyerMode: BUYER_MODE.oneWallet })).toContain('A one-wallet deal names its buyer.');
    expect(termsProblems({ ...t, deadline: 2n ** 64n })).toContain('deadline is outside uint64.');
  });
});

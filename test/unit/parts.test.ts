import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress, zeroAddress, type Hex, type TransactionReceipt } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  CHAINS,
  DEPLOYMENTS,
  buyerSide,
  cancelRequest,
  chainOf,
  codeKind,
  createDeal,
  describeVesting,
  flasetDealsAbi,
  listedToken,
  lookalikeOf,
  settleCall,
  standardList,
  streamIdFromReceipt,
  whitelistTree,
  whitelistVerify,
} from '../../src/index.js';
import deployments4663 from '../../deployments/4663.json' with { type: 'json' };
import { USDG_4663, WETH_4663, testAccount } from '../helpers.js';

const seller = testAccount('seller');
const buyer = testAccount('buyer');
const wallets = Array.from({ length: 7 }, (_, i) => testAccount(`w${i}`).address);

describe('the whitelist', () => {
  it('has the root and proofs of OpenZeppelin’s StandardMerkleTree', () => {
    const ours = whitelistTree(wallets);
    const oz = StandardMerkleTree.of(wallets.map((a) => [a]), ['address']);
    expect(ours.root).toBe(oz.root);
    for (const a of wallets) {
      expect(ours.proof(a)).toEqual(oz.getProof([a]));
      expect(whitelistVerify(ours.proof(a)!, ours.root, a)).toBe(true);
    }
    expect(ours.has(seller.address)).toBe(false);
    expect(ours.proof(seller.address)).toBeNull();
    expect(whitelistTree([buyer.address]).root).toBe(StandardMerkleTree.of([[buyer.address]], ['address']).root);
  });
});

describe('deployments', () => {
  it('has FlasetDeals, FlasetRegistry and the Lockup on each chain', () => {
    expect(Object.keys(DEPLOYMENTS).map(Number).sort((a, b) => a - b)).toEqual([1, 56, 4663, 8453]);
    expect(DEPLOYMENTS[4663].FlasetDeals.address).toBe('0x2c5224c5e456B9E1CeE0E6F1ffF8106Cd383e449');
    expect(DEPLOYMENTS[4663].FlasetRegistry.address).toBe('0xb41a45AEE32806061DDe1341249170BE3559FB8c');
    for (const id of [8453, 56, 1] as const) {
      expect(DEPLOYMENTS[id].FlasetDeals.address).toBe('0x0Aed92C2AAc63e8dd1f325a0Ca3EbE78cceb0F58');
      expect(DEPLOYMENTS[id].FlasetRegistry.address).toBe('0x8fbB95d5c5f4612B4E8376133508F47BB875Af2A');
    }
    for (const d of Object.values(DEPLOYMENTS)) {
      for (const a of [d.FlasetDeals.address, d.FlasetRegistry.address, d.SablierLockup.address]) expect(getAddress(a)).toBe(a);
      expect(d.FlasetDeals.deployBlock).toBeGreaterThan(d.FlasetRegistry.deployBlock);
    }
  });
  it('matches the JSON files, ABIs included', () => {
    expect(deployments4663.contracts.FlasetDeals.address).toBe(DEPLOYMENTS[4663].FlasetDeals.address);
    expect(JSON.stringify(deployments4663.contracts.FlasetDeals.abi)).toBe(JSON.stringify(flasetDealsAbi));
  });
  it('names the chains as the app does', () => {
    expect(Object.values(CHAINS).map((c) => [c.id, c.name, c.appPath])).toEqual([
      [1, 'Ethereum', '/app-ethereum'],
      [56, 'BNB Chain', '/app-bnb'],
      [4663, 'Robinhood Chain', '/app'],
      [8453, 'Base', '/app-base'],
    ]);
    expect(() => chainOf(10)).toThrow(/chain 10/);
  });
});

describe('tokens', () => {
  it('knows each chain’s standard list', () => {
    expect(listedToken(4663, USDG_4663.toLowerCase())?.symbol).toBe('USDG');
    expect(listedToken(4663, WETH_4663)?.decimals).toBe(18);
    expect(listedToken(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')?.symbol).toBe('USDC');
    expect(standardList(4663)!.tokens.filter((t) => t.kind === 'stock').length).toBeGreaterThan(100);
  });
  it('finds a lookalike by symbol or name, never the real token', () => {
    const fake = '0x000000000000000000000000000000000000dEaD';
    expect(lookalikeOf(4663, fake, 'USDG', 'Something')?.symbol).toBe('USDG');
    expect(lookalikeOf(4663, fake, 'u.s.d.g', null)?.symbol).toBe('USDG');
    expect(lookalikeOf(4663, fake, 'XYZ', 'Global Dollar')?.symbol).toBe('USDG');
    expect(lookalikeOf(4663, fake, 'ETH', null)?.symbol).toBe('ETH');
    expect((lookalikeOf(4663, fake, 'AAPL', null) as { address?: string } | null)?.address).toBe(listedToken(4663, '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9')?.address);
    expect(lookalikeOf(4663, USDG_4663, 'USDG', 'Global Dollar')).toBeNull();
    expect(lookalikeOf(4663, fake, 'MYTOKEN', 'My Token')).toBeNull();
  });
  it('tells an EIP-7702 delegated wallet and a precompile from a contract', () => {
    const delegate = '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B';
    expect(codeKind(buyer.address, `0xef0100${delegate.slice(2)}`)).toEqual({ kind: 'delegated', delegate: getAddress(delegate) });
    expect(codeKind('0x0000000000000000000000000000000000000064', '0xfe')).toEqual({ kind: 'none' });
    expect(codeKind(buyer.address, '0x')).toEqual({ kind: 'none' });
    expect(codeKind(WETH_4663, '0x6080604052')).toEqual({ kind: 'contract' });
  });
});

describe('buy', () => {
  const create = (buyers: Parameters<typeof createDeal>[0]['buyers']) =>
    createDeal({ chainId: 4663, seller: seller.address, sell: { token: WETH_4663, amount: 10n ** 18n }, price: { token: USDG_4663, amount: 10n ** 9n }, buyers });

  it('gives the buyer its terms and proof, and refuses a wallet that may not buy', () => {
    const one = create({ wallet: buyer.address });
    const deal = (d: ReturnType<typeof create>) => ({ chainId: 4663, terms: d.terms, sellerSig: '0x' as Hex, whitelist: d.whitelist });
    expect(buyerSide(deal(one), buyer.address)).toEqual({ terms: one.terms, proof: [] });
    expect(() => buyerSide(deal(one), testAccount('other').address)).toThrow(/another wallet/);
    const list = create({ whitelist: wallets });
    const side = buyerSide(deal(list), wallets[3]!);
    expect(side.terms.buyer).toBe(wallets[3]);
    expect(whitelistVerify(side.proof, list.terms.buyersRoot, wallets[3]!)).toBe(true);
    expect(() => buyerSide(deal(list), buyer.address)).toThrow(/not on the seller’s whitelist/);
    expect(() => buyerSide(deal(create('anyone')), seller.address)).toThrow(/its own deal/);
  });

  it('encodes settle and cancel for FlasetDeals', () => {
    const d = create('anyone');
    const call = settleCall(4663, { ...d.terms, buyer: buyer.address }, `0x${'11'.repeat(65)}`, `0x${'22'.repeat(65)}`);
    expect(call.address).toBe(DEPLOYMENTS[4663].FlasetDeals.address);
    const c = cancelRequest(4663, d.terms);
    const decoded = decodeFunctionData({ abi: flasetDealsAbi, data: c.data });
    expect(decoded.functionName).toBe('cancel');
    expect((decoded.args as unknown as [{ nonce: bigint }])[0].nonce).toBe(d.terms.nonce);
  });

  it('reads the stream id from a settle receipt', () => {
    const digest = `0x${'ab'.repeat(32)}` as Hex;
    const topics = encodeEventTopics({ abi: flasetDealsAbi, eventName: 'DealSettled', args: { digest, seller: seller.address, buyer: buyer.address } });
    const data = encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
      [WETH_4663, 10n, 3n, 77n, USDG_4663, 5n, 0n],
    );
    const receipt = { logs: [{ address: DEPLOYMENTS[4663].FlasetDeals.address.toLowerCase(), topics, data }] } as unknown as TransactionReceipt;
    expect(streamIdFromReceipt(4663, receipt)).toBe(77n);
    expect(streamIdFromReceipt(4663, { logs: [] } as unknown as TransactionReceipt)).toBeNull();
    expect(streamIdFromReceipt(8453, receipt)).toBeNull();
  });
});

describe('describeVesting', () => {
  const t = createDeal({ chainId: 4663, seller: seller.address, sell: { token: WETH_4663, amount: 1n }, price: { token: USDG_4663, amount: 1n }, buyers: 'anyone' }).terms;
  it('says each shape in words, from the signed fields', () => {
    expect(describeVesting(t)).toBeNull();
    expect(describeVesting({ ...t, vestingBps: 3000, vestingShape: 0, vestingDuration: 90n * 86_400n })?.description).toBe(
      '30% vests evenly over 90 days from the settlement, as a Sablier stream that nobody can cancel. The stream stays with the buyer.',
    );
    expect(describeVesting({ ...t, vestingBps: 5000, vestingShape: 1, vestingCliff: 30n * 86_400n, vestingDuration: 180n * 86_400n })?.description).toContain('with a cliff at 30 days');
    expect(describeVesting({ ...t, vestingBps: 1000, vestingShape: 2, vestingSteps: 6, vestingDuration: 180n * 86_400n, vestingTransferable: true })?.description).toContain('6 equal steps over 180 days');
    expect(describeVesting({ ...t, vestingBps: 2500, vestingShape: 4, vestingDuration: 86_400n })?.shape).toBe('allAtOnce');
    expect(describeVesting({ ...t, buyer: zeroAddress, vestingBps: 2500, vestingShape: 3, vestingSteps: 12, vestingStart: 1_800_000_000n })?.description).toContain('12 monthly parts');
  });
});

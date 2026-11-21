// End to end on a fork of Robinhood Chain: FlasetDeals as deployed, the real WETH and USDG, Sablier's real Lockup. It
// first reads the live contract (domain, digest, fee, wiring) and then creates, checks, settles, cancels and lets
// expire deals inside anvil. Run with `npm run test:fork` (needs Foundry's anvil).
import { erc20Abi, getAddress, keccak256, parseEther, toHex, type Address, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEPLOYMENTS,
  checkDeal,
  checkToken,
  cancelRequest,
  createDeal,
  dealDomain,
  dealState,
  decodeDealLink,
  encodeDealLink,
  flasetDealsAbi,
  hashDeal,
  prepareBuy,
  readFeeBps,
  readStream,
  sellerApproval,
  sellerDigest,
  simulateBuy,
  streamIdFromReceipt,
  streamsOf,
  type SignedDeal,
} from '../../src/index.js';
import { mockErc20Abi, mockErc20Bytecode } from '../fixtures/mock-erc20.js';
import { startFork, type Fork } from './anvil.js';
import { USDG, WETH, giveUsdg, wrapEth } from './fund.js';

const CHAIN = 4663;
const D = DEPLOYMENTS[CHAIN];
let fork: Fork;
let seller: Address, buyer: Address, buyer2: Address;
let startBlock: bigint;

const send = async (from: Address, tx: { to: Address; data: Hex }) => {
  const hash = await fork.wallet(from).sendTransaction({ account: from, chain: fork.client.chain, ...tx });
  const r = await fork.client.waitForTransactionReceipt({ hash });
  expect(r.status).toBe('success');
  return r;
};

async function sellerSigned(input: Omit<Parameters<typeof createDeal>[0], 'chainId' | 'seller'>): Promise<SignedDeal> {
  const d = createDeal({ chainId: CHAIN, seller, ...input });
  const sellerSig = await fork.wallet(seller).signTypedData({ account: seller, ...d.typedData });
  await send(seller, sellerApproval(CHAIN, d.terms));
  return { chainId: CHAIN, terms: d.terms, sellerSig, whitelist: d.whitelist };
}

beforeAll(async () => {
  fork = await startFork(CHAIN);
  [seller, buyer, buyer2] = fork.accounts as [Address, Address, Address];
  startBlock = await fork.client.getBlockNumber();
  await wrapEth(fork, seller, parseEther('20'));
  await giveUsdg(fork, buyer, 50_000_000_000n);
  await giveUsdg(fork, buyer2, 50_000_000_000n);
});

afterAll(() => fork?.stop());

describe('the live FlasetDeals on Robinhood Chain', () => {
  it('signs in the domain and digest this SDK computes', async () => {
    const d = createDeal({ chainId: CHAIN, seller, sell: { token: WETH, amount: 1n }, price: { token: USDG, amount: 1n }, buyers: { wallet: buyer } });
    const onChain = await fork.client.readContract({ address: D.FlasetDeals.address, abi: flasetDealsAbi, functionName: 'hashDeal', args: [d.terms] });
    expect(onChain).toBe(hashDeal(CHAIN, d.terms));
    const [, name, version, chainId, verifyingContract] = await fork.client.readContract({ address: D.FlasetDeals.address, abi: flasetDealsAbi, functionName: 'eip712Domain' });
    expect({ name, version, chainId: Number(chainId), verifyingContract }).toEqual(dealDomain(CHAIN));
  });

  it('charges 0.20% and is wired to the registry and Lockup in the deployments', async () => {
    expect(await readFeeBps(fork.client, CHAIN)).toBe(20);
    const r = (functionName: 'registry' | 'lockup' | 'paused') => fork.client.readContract({ address: D.FlasetDeals.address, abi: flasetDealsAbi, functionName });
    expect(await r('registry')).toBe(D.FlasetRegistry.address);
    expect(getAddress(await r('lockup') as Address)).toBe(D.SablierLockup.address);
    expect(await r('paused')).toBe(false);
  });

  it('knows WETH and USDG, and tells a lookalike and a delegated wallet', async () => {
    expect(await checkToken(fork.client, CHAIN, WETH)).toMatchObject({ kind: 'known', symbol: 'WETH' });
    expect(await checkToken(fork.client, CHAIN, USDG)).toMatchObject({ kind: 'known', symbol: 'USDG', decimals: 6 });
    const hash = await fork.wallet(seller).deployContract({ account: seller, chain: fork.client.chain, abi: mockErc20Abi, bytecode: mockErc20Bytecode, args: ['Global Dollar', 'USDG', 6] });
    const fake = (await fork.client.waitForTransactionReceipt({ hash })).contractAddress!;
    expect(await checkToken(fork.client, CHAIN, fake)).toMatchObject({ kind: 'lookalike', symbol: 'USDG', imitates: { address: USDG } });
    const wallet = getAddress(keccak256(toHex('a 7702 wallet')).slice(0, 42));
    await fork.test.setCode({ address: wallet, bytecode: `0xef0100${D.FlasetDeals.address.slice(2).toLowerCase()}` });
    expect(await checkToken(fork.client, CHAIN, wallet)).toMatchObject({ kind: 'delegated', delegate: D.FlasetDeals.address });
    const empty = getAddress(keccak256(toHex('an address without code')).slice(0, 42));
    expect(await checkToken(fork.client, CHAIN, empty)).toMatchObject({ kind: 'invalid', why: 'no-code' });
  });
});

describe('a deal from create to its stream', () => {
  it('creates, checks, settles and reads the buyer’s stream', async () => {
    const deal = await sellerSigned({ sell: { token: WETH, amount: parseEther('2') }, price: { token: USDG, amount: 6_000_000_000n }, buyers: { wallet: buyer }, vesting: { percent: 30, shape: 'linear', duration: 30 * 86_400 } });
    const link = encodeDealLink(deal);
    const opened = decodeDealLink(link);
    expect(opened).toEqual(deal);

    const before = await checkDeal(fork.client, opened, { buyer });
    expect(before.checks.filter((c) => !c.ok)).toEqual([]);
    expect(before).toMatchObject({ ok: true, state: 'open', buyerApprovalNeeded: 6_000_000_000n });
    expect(before.price).toMatchObject({ feeBps: 20, fee: 12_000_000n, sellerReceives: 5_988_000_000n, buyerReceivesNow: parseEther('1.4'), vestedAmount: parseEther('0.6'), unitPrice: '3000' });
    expect(before.tokens.asset.kind).toBe('known');

    const buy = await prepareBuy(fork.client, opened, buyer);
    expect(buy.approval).not.toBeNull();
    const buyerSig = await fork.wallet(buyer).signTypedData({ account: buyer, ...buy.typedData });
    await expect(simulateBuy(fork.client, buy, buyerSig)).rejects.toThrow();
    await send(buyer, buy.approval!);
    expect(await simulateBuy(fork.client, buy, buyerSig)).toBe(sellerDigest(CHAIN, deal.terms));

    const usdgBefore = await fork.client.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [seller] });
    const receipt = await send(buyer, buy.settle(buyerSig));
    const usdgAfter = await fork.client.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [seller] });
    expect(usdgAfter - usdgBefore).toBe(5_988_000_000n);
    expect(await fork.client.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [buyer] })).toBe(parseEther('1.4'));

    const streamId = streamIdFromReceipt(CHAIN, receipt)!;
    expect(streamId).toBeGreaterThan(0n);
    const after = await checkDeal(fork.client, opened, { logs: { fromBlock: startBlock } });
    expect(after).toMatchObject({ ok: false, state: 'filled', settled: { buyer, streamId, tx: receipt.transactionHash } });

    const stream = await readStream(fork.client, CHAIN, streamId);
    expect(stream).toMatchObject({ recipient: buyer, token: WETH, deposited: parseEther('0.6'), withdrawn: 0n, cancelable: false, transferable: false, fromFlashDeals: true, status: 'streaming' });
    expect(stream.end - stream.start).toBe(30 * 86_400);
    const mine = await streamsOf(fork.client, CHAIN, buyer, { logs: { fromBlock: startBlock } });
    expect(mine.map((s) => s.id)).toEqual([streamId]);
  });

  it('settles a whitelist deal for a wallet on the list, with its proof', async () => {
    const deal = await sellerSigned({ sell: { token: WETH, amount: parseEther('1') }, price: { token: USDG, amount: 3_100_000_000n }, buyers: { whitelist: [buyer, buyer2] }, vesting: { percent: 50, shape: 'steps', steps: 4, duration: 120 * 86_400 } });
    const opened = decodeDealLink(encodeDealLink(deal));
    expect((await checkDeal(fork.client, opened, { buyer: buyer2 })).ok).toBe(true);
    const buy = await prepareBuy(fork.client, opened, buyer2);
    expect(buy.proof.length).toBe(1);
    await send(buyer2, buy.approval!);
    const sig = await fork.wallet(buyer2).signTypedData({ account: buyer2, ...buy.typedData });
    expect(await simulateBuy(fork.client, buy, sig)).toBe(sellerDigest(CHAIN, deal.terms));
    const r = await send(buyer2, buy.settle(sig));
    expect((await readStream(fork.client, CHAIN, streamIdFromReceipt(CHAIN, r)!)).deposited).toBe(parseEther('0.5'));
  });

  it('reads a cancelled deal and an expired one', async () => {
    const open = await sellerSigned({ sell: { token: WETH, amount: parseEther('1') }, price: { token: USDG, amount: 1_000_000n }, buyers: 'anyone' });
    expect((await dealState(fork.client, CHAIN, open.terms)).state).toBe('open');
    const c = await send(seller, cancelRequest(CHAIN, open.terms));
    expect(await dealState(fork.client, CHAIN, open.terms, { logs: { fromBlock: startBlock } })).toMatchObject({ state: 'cancelled', cancelled: { by: seller, tx: c.transactionHash } });

    const now = Number((await fork.client.getBlock()).timestamp);
    const old = await sellerSigned({ sell: { token: WETH, amount: 1n }, price: { token: USDG, amount: 1n }, buyers: 'anyone', now: now - 7_200, expiresIn: 3_600 });
    const check = await checkDeal(fork.client, old, { buyer });
    expect(check).toMatchObject({ state: 'expired', ok: false });
    expect(check.checks.find((x) => x.id === 'deadline')?.ok).toBe(false);
  });

  it('fails the checks of a deal the seller cannot fill, or whose token is a lookalike', async () => {
    const big = await sellerSigned({ sell: { token: WETH, amount: parseEther('1000') }, price: { token: USDG, amount: 1_000_000n }, buyers: { wallet: buyer } });
    const c = await checkDeal(fork.client, big, { buyer });
    expect(c.ok).toBe(false);
    expect(c.checks.find((x) => x.id === 'seller-balance')?.ok).toBe(false);

    const hash = await fork.wallet(buyer).deployContract({ account: buyer, chain: fork.client.chain, abi: mockErc20Abi, bytecode: mockErc20Bytecode, args: ['Wrapped Ether', 'WETH', 18] });
    const fakeWeth = (await fork.client.waitForTransactionReceipt({ hash })).contractAddress!;
    const d = createDeal({ chainId: CHAIN, seller, sell: { token: fakeWeth, amount: 1n }, price: { token: USDG, amount: 1n }, buyers: 'anyone' });
    const sig = await fork.wallet(seller).signTypedData({ account: seller, ...d.typedData });
    const f = await checkDeal(fork.client, { chainId: CHAIN, terms: d.terms, sellerSig: sig, whitelist: null });
    expect(f.checks.find((x) => x.id === 'asset-token')).toMatchObject({ ok: false, message: 'The token sold calls itself WETH but is not the real WETH.' });

    const forged = await checkDeal(fork.client, { ...big, sellerSig: sig });
    expect(forged.checks.find((x) => x.id === 'signature')?.ok).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { DEPLOYMENTS, createDeal, decodeDealLink, encodeDealLink, monthlyStart, packList, unpackList, type SignedDeal } from '../../src/index.js';
import { USDG_4663, WETH_4663, testAccount } from '../helpers.js';

const seller = testAccount('seller');
const buyer = testAccount('buyer');
const now = Math.floor(Date.now() / 1000);
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const payloadOf = (link: string) => JSON.parse(atob(new URLSearchParams(link.split('#')[1]).get('d')!.replace(/-/g, '+').replace(/_/g, '/')));

async function signed(buyers: Parameters<typeof createDeal>[0]['buyers'], extra: Partial<Parameters<typeof createDeal>[0]> = {}): Promise<SignedDeal> {
  const d = createDeal({ chainId: 4663, seller: seller.address, sell: { token: WETH_4663, amount: 2n * 10n ** 18n }, price: { token: USDG_4663, amount: 7_500_000_000n }, buyers, ...extra });
  return { chainId: d.chainId, terms: d.terms, sellerSig: await seller.signTypedData(d.typedData), whitelist: d.whitelist };
}

describe('the deal link', () => {
  it('is the link the Flaset app builds, on each chain’s path', async () => {
    const deal = await signed({ wallet: buyer.address });
    const link = encodeDealLink(deal);
    expect(link.startsWith('https://flaset.ai/app/deal/open#d=')).toBe(true);
    expect(encodeDealLink({ ...deal, chainId: 8453 }).startsWith('https://flaset.ai/app-base/deal/open#d=')).toBe(true);
    expect(encodeDealLink(deal, { origin: 'https://example.org/' }).startsWith('https://example.org/app/deal/open#d=')).toBe(true);
    const p = payloadOf(link);
    // the app's link payload: { v: 3, chainId, contract, terms, sellerSig }, uint256 as strings and uint64 as numbers
    expect(Object.keys(p)).toEqual(['v', 'chainId', 'contract', 'terms', 'sellerSig']);
    expect(p).toMatchObject({ v: 3, chainId: 4663, contract: DEPLOYMENTS[4663].FlasetDeals.address, sellerSig: deal.sellerSig });
    expect(Object.keys(p.terms)).toEqual([
      'seller', 'buyer', 'buyerMode', 'buyersRoot', 'asset', 'assetAmount', 'payToken', 'payAmount', 'vestingBps', 'vestingShape',
      'vestingStart', 'vestingCliff', 'vestingDuration', 'vestingSteps', 'vestingTransferable', 'maxFee', 'deadline', 'nonce',
    ]);
    expect(typeof p.terms.assetAmount).toBe('string');
    expect(typeof p.terms.nonce).toBe('string');
    expect(typeof p.terms.deadline).toBe('number');
  });

  it('decodes to the same signed deal: whole link, fragment or d value', async () => {
    for (const buyers of [{ wallet: buyer.address }, 'anyone', { whitelist: [buyer.address, testAccount('b2').address, testAccount('b3').address] }] as const) {
      const deal = await signed(buyers, { vesting: { percent: 20, shape: 'linear', duration: 30 * 86_400 } });
      const link = encodeDealLink(deal);
      expect(decodeDealLink(link)).toEqual(deal);
      expect(decodeDealLink(link.split('#')[1]!)).toEqual(deal);
      if (!deal.whitelist) expect(decodeDealLink(new URLSearchParams(link.split('#')[1]).get('d')!)).toEqual(deal);
    }
  });

  it('reads a link built the way the app builds it', async () => {
    const deal = await signed('anyone');
    const t = deal.terms;
    // the app builds `${origin}/app/deal/open#d=` + base64url(JSON.stringify(payload))
    const appTerms = {
      seller: t.seller, buyer: t.buyer, buyerMode: t.buyerMode, buyersRoot: t.buyersRoot, asset: t.asset, assetAmount: t.assetAmount.toString(),
      payToken: t.payToken, payAmount: t.payAmount.toString(), vestingBps: 0, vestingShape: 0, vestingStart: 0, vestingCliff: 0, vestingDuration: 0,
      vestingSteps: 0, vestingTransferable: false, maxFee: t.maxFee.toString(), deadline: Number(t.deadline), nonce: t.nonce.toString(),
    };
    const link = `https://flaset.ai/app/deal/open#d=${b64({ v: 3, chainId: 4663, contract: DEPLOYMENTS[4663].FlasetDeals.address, terms: appTerms, sellerSig: deal.sellerSig })}`;
    expect(link).toBe(encodeDealLink(deal));
    expect(decodeDealLink(link)).toEqual(deal);
  });

  it('refuses a link the app does not open, with the app’s reason', async () => {
    const deal = await signed('anyone');
    const p = payloadOf(encodeDealLink(deal));
    const with_ = (o: object) => `#d=${b64({ ...p, ...o })}`;
    expect(() => decodeDealLink('https://flaset.ai/app/deal/open')).toThrow('This link has no deal in it.');
    expect(() => decodeDealLink('#d=***')).toThrow('The deal in this link is broken.');
    expect(() => decodeDealLink(with_({ v: 2 }))).toThrow(/earlier Flash Deals contract/);
    expect(() => decodeDealLink(with_({ chainId: 137 }))).toThrow(/chain 137/);
    expect(() => decodeDealLink(with_({ contract: DEPLOYMENTS[4663].FlasetRegistry.address }))).toThrow(/not FlasetDeals/);
    expect(() => decodeDealLink(with_({ chainId: 8453 }))).toThrow(/not FlasetDeals/);
    expect(() => decodeDealLink(with_({ sellerSig: '0x1234' }))).toThrow(/signature in this link is broken/);
    expect(() => decodeDealLink(with_({ terms: { ...p.terms, extra: 1 } }))).toThrow(/terms in this link are broken/);
    expect(() => decodeDealLink(with_({ terms: { ...p.terms, assetAmount: 5 } }))).toThrow(/terms in this link are broken/);
    expect(() => decodeDealLink(with_({ terms: { ...p.terms, buyer: buyer.address } }))).toThrow(/names a buyer for an open deal/);
    expect(() => decodeDealLink(with_({ terms: { ...p.terms, vestingBps: 1000, vestingDuration: 100, vestingStart: now + 50 } }))).toThrow(/vesting start of its own/);
    expect(() => decodeDealLink(`#d=${'A'.repeat(8_001)}`)).toThrow(/too long/);
  });

  it('takes a Monthly start at 12:00 UTC within the app’s window', async () => {
    const start = monthlyStart(new Date((now + 10 * 86_400) * 1000));
    const deal = await signed('anyone', { vesting: { percent: 40, shape: 'monthly', months: 6, start } });
    expect(decodeDealLink(encodeDealLink(deal)).terms.vestingStart).toBe(start);
    const late = await signed('anyone', { vesting: { percent: 40, shape: 'monthly', months: 6, start: start + 120n * 86_400n } });
    expect(() => decodeDealLink(encodeDealLink(late))).toThrow(/vesting start of its own/);
  });

  it('carries the whitelist the seller signed, and only that one', async () => {
    const deal = await signed({ whitelist: [buyer.address, testAccount('b2').address] });
    const link = encodeDealLink(deal);
    expect(link).toContain('&l=');
    const other = link.replace(/&l=.*$/, `&l=${packList([buyer.address])}`);
    expect(() => decodeDealLink(other)).toThrow('The whitelist in this link is not the one the seller signed.');
    expect(() => decodeDealLink(link.replace(/&l=.*$/, '&l=AAAA'))).toThrow('The whitelist in this link is broken.');
  });

  it('packs a list as each wallet’s 20 bytes', () => {
    const list = [buyer.address, seller.address];
    expect(unpackList(packList(list))).toEqual(list);
    expect(packList(list)).toHaveLength(54);
    expect(unpackList('')).toBeNull();
    expect(unpackList('AAAA')).toBeNull();
  });
});

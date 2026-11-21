// Buy: the buyer's side. The buyer signs the same deal with its own address, approves exactly the price to FlasetDeals,
// and sends `settle`. Anyone may send the settle and pay its gas; the two signatures fix every term.
import { encodeFunctionData, erc20Abi, getAddress, type Address, type Hex, type PublicClient } from 'viem';
import { flasetDealsAbi } from './abi.js';
import { deploymentOf } from './deployments.js';
import { FlasetError } from '../errors.js';
import type { SignedDeal } from './link.js';
import { BUYER_MODE, buyerTerms, dealTypedData, type DealTerms } from './terms.js';
import { whitelistTree } from './whitelist.js';

export interface TxRequest {
  to: Address;
  data: Hex;
}

export interface PreparedBuy {
  chainId: number;
  buyer: Address;
  /** the deal the buyer signs and settles: the offer with the buyer's address */
  terms: DealTerms;
  /** pass to the buyer's signTypedData */
  typedData: ReturnType<typeof dealTypedData>;
  /** the whitelist proof; empty for one wallet or anyone */
  proof: Hex[];
  /** approve exactly the price to FlasetDeals; null when the allowance already covers it */
  approval: TxRequest | null;
  /** the settle transaction, once the buyer has signed `typedData` */
  settle: (buyerSig: Hex) => TxRequest;
  /** the same call as viem's contract parameters, for simulateContract or writeContract */
  settleCall: (buyerSig: Hex) => SettleCall;
}

export interface SettleCall {
  address: Address;
  abi: typeof flasetDealsAbi;
  functionName: 'settle';
  args: readonly [DealTerms, Hex, Hex, readonly Hex[]];
}

/** The buyer's terms and whitelist proof for a signed deal, without any chain read. */
export function buyerSide(deal: SignedDeal, buyer: Address): { terms: DealTerms; proof: Hex[] } {
  const who = getAddress(buyer);
  const { terms: offer, whitelist } = deal;
  if (who.toLowerCase() === offer.seller.toLowerCase()) throw new FlasetError('NOT_A_BUYER', 'The seller cannot take its own deal.');
  if (offer.buyerMode === BUYER_MODE.oneWallet && who.toLowerCase() !== offer.buyer.toLowerCase()) throw new FlasetError('NOT_A_BUYER', 'This deal is for another wallet.');
  let proof: Hex[] = [];
  if (offer.buyerMode === BUYER_MODE.whitelist) {
    const p = whitelist ? whitelistTree(whitelist).proof(who) : null;
    if (!p) throw new FlasetError('NOT_A_BUYER', 'This wallet is not on the seller’s whitelist.');
    proof = p;
  }
  return { terms: buyerTerms(offer, who), proof };
}

/** The settle call: the buyer's terms, both signatures and the whitelist proof. */
export function settleCall(chainId: number, terms: DealTerms, sellerSig: Hex, buyerSig: Hex, proof: readonly Hex[] = []): SettleCall {
  return { address: deploymentOf(chainId).FlasetDeals.address, abi: flasetDealsAbi, functionName: 'settle', args: [terms, sellerSig, buyerSig, proof] as const };
}

/** Everything a buyer needs to take a deal: the typed data to sign, the approval if one is missing, and the settle. */
export async function prepareBuy(client: PublicClient, deal: SignedDeal, buyer: Address): Promise<PreparedBuy> {
  const { chainId, sellerSig } = deal;
  const deals = deploymentOf(chainId).FlasetDeals.address;
  const { terms, proof } = buyerSide(deal, buyer);
  const allowance = await client.readContract({ address: terms.payToken, abi: erc20Abi, functionName: 'allowance', args: [terms.buyer, deals] });
  const approval =
    allowance >= terms.payAmount ? null : { to: terms.payToken, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [deals, terms.payAmount] }) };
  const call = (buyerSig: Hex) => settleCall(chainId, terms, sellerSig, buyerSig, proof);
  return {
    chainId,
    buyer: terms.buyer,
    terms,
    typedData: dealTypedData(chainId, terms),
    proof,
    approval,
    settleCall: call,
    settle: (buyerSig) => ({ to: deals, data: encodeFunctionData(call(buyerSig)) }),
  };
}

/**
 * Runs the settle as an eth_call from the buyer, without sending anything: the deal's digest when it would settle, or
 * the contract's revert (Expired, BadSignature, FeeAboveMax, an ERC-20 allowance error and so on) as a thrown error.
 */
export async function simulateBuy(client: PublicClient, prepared: PreparedBuy, buyerSig: Hex): Promise<Hex> {
  const { result } = await client.simulateContract({ account: prepared.buyer, ...prepared.settleCall(buyerSig) });
  return result;
}

/** Cancel a deal before it settles: the seller always; the buyer of a one-wallet deal too. */
export function cancelRequest(chainId: number, offer: DealTerms): TxRequest {
  return { to: deploymentOf(chainId).FlasetDeals.address, data: encodeFunctionData({ abi: flasetDealsAbi, functionName: 'cancel', args: [offer] }) };
}

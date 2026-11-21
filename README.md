# Flaset SDK

**Create, check and buy Flash Deals from TypeScript: a token for a payment in one atomic transaction**

## Install

```sh
npm install github:Flasetai/flaset-sdk viem
```

## Example

```ts
import { chains, checkDeal, createDeal, decodeDealLink, encodeDealLink, flashDealsClient, prepareBuy, sellerApproval } from 'flaset-sdk/deals';

// Seller: 1 WETH for 3,000 USDG, open to anyone, 25% vesting over 90 days
const deal = createDeal({
  chainId: chains.robinhood, seller, buyers: 'anyone',
  sell: { token: WETH, amount: parseEther('1') }, price: { token: USDG, amount: 3_000_000_000n },
  vesting: { percent: 25, shape: 'linear', duration: 90 * 86_400 },
});
const sellerSig = await sellerWallet.signTypedData({ account: seller, ...deal.typedData });
await sellerWallet.sendTransaction({ account: seller, ...sellerApproval(chains.robinhood, deal.terms) });
const link = encodeDealLink({ chainId: chains.robinhood, terms: deal.terms, sellerSig, whitelist: null });

// Buyer: check the link, then buy
const opened = decodeDealLink(link);
const client = flashDealsClient(opened.chainId);
const check = await checkDeal(client, opened, { buyer }); // state, ok, checks, price, vesting
const buy = await prepareBuy(client, opened, buyer);
const buyerSig = await buyerWallet.signTypedData({ account: buyer, ...buy.typedData });
if (buy.approval) await client.waitForTransactionReceipt({ hash: await buyerWallet.sendTransaction({ account: buyer, ...buy.approval }) });
await buyerWallet.sendTransaction({ account: buyer, ...buy.settle(buyerSig) });
```

## Chains

| Chain | `FlasetDeals` |
|---|---|
| Robinhood Chain | `0x2c5224c5e456B9E1CeE0E6F1ffF8106Cd383e449` |
| Base | `0x0Aed92C2AAc63e8dd1f325a0Ca3EbE78cceb0F58` |
| BNB Chain | `0x0Aed92C2AAc63e8dd1f325a0Ca3EbE78cceb0F58` |
| Ethereum | `0x0Aed92C2AAc63e8dd1f325a0Ca3EbE78cceb0F58` |

## Links

[Full reference](docs/README.md) · [Contracts](https://github.com/Flasetai/flash-deals) · [Website](https://flaset.ai) · [MIT](LICENSE)

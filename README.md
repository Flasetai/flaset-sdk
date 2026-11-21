# Flash Deals SDK

**Create, check and buy Flash Deals from TypeScript.**

A Flash Deal sells a token for a payment in one atomic transaction. The seller and the buyer sign the same terms, and
one `settle` call moves the price, the fee and the tokens. The vested share goes into a Sablier stream for the buyer.

This SDK builds the terms, the signatures and the deal link, reads and checks a deal the way the Flaset app does, and
builds the buy. It runs on [viem](https://viem.sh), in Node and in the browser. The contracts are in
[Flasetai/flash-deals](https://github.com/Flasetai/flash-deals).

## Install

```sh
npm install flash-deals-sdk viem
```

## Create a deal

The seller signs the terms for free, then approves the tokens sold. The link carries the deal to the buyer.

```ts
import { createDeal, encodeDealLink, sellerApproval } from 'flash-deals-sdk';

const deal = createDeal({
  chainId: 4663,
  seller: account.address,
  sell: { token: WETH, amount: parseEther('1') },
  price: { token: USDG, amount: 3_000_000_000n }, // 3,000 USDG
  buyers: { wallet: buyer }, // or { whitelist: [a, b, c] } or 'anyone'
  vesting: { percent: 25, shape: 'linear', duration: 90 * 86_400 },
});
const sellerSig = await walletClient.signTypedData({ account, ...deal.typedData });
await walletClient.sendTransaction({ account, ...sellerApproval(4663, deal.terms) });
const link = encodeDealLink({ chainId: 4663, terms: deal.terms, sellerSig, whitelist: deal.whitelist });
```

The link opens in the Flaset app, and `decodeDealLink` reads it back.

## Read and check a deal

```ts
import { checkDeal, decodeDealLink, flashDealsClient } from 'flash-deals-sdk';

const deal = decodeDealLink(link);
const client = flashDealsClient(deal.chainId); // or any viem PublicClient
const check = await checkDeal(client, deal, { buyer: account.address });

check.state; // 'open' | 'filled' | 'cancelled' | 'expired'
check.ok; // open, and every check passed
check.price; // fee, what the seller gets, what the buyer gets now and vested, price per token
check.vesting?.description; // "25% vests evenly over 90 days from the settlement, ..."
```

`checkDeal` runs the checks the app runs before a buyer pays:

| Check | Passes when |
|---|---|
| `signature` | The seller's signature matches these exact terms |
| `asset-token`, `pay-token` | Each token is at its listed address. A lookalike, an EIP-7702 delegated wallet, an address without a token or a blocked token fails. A token on no list passes with a warning |
| `seller-balance`, `seller-allowance` | The seller holds the tokens sold and approved them for `FlasetDeals` |
| `fee` | The live fee fits within the `maxFee` the seller signed |
| `state`, `deadline`, `paused` | The deal is open, within its deadline, and Flash Deals are live |
| `terms`, `vesting-start`, `whitelist` | The terms are ones the contract and the app take, and the list is the one the seller signed |
| `buyer`, `buyer-balance` | With `buyer`: that wallet may take the deal and holds the price |

A filled deal carries its settlement and stream id, and a cancelled one carries who cancelled it.

## Buy

The buyer signs the same deal with its own address, approves exactly the price, and settles.

```ts
import { prepareBuy, simulateBuy } from 'flash-deals-sdk';

const buy = await prepareBuy(client, deal, account.address);
const buyerSig = await walletClient.signTypedData({ account, ...buy.typedData });
if (buy.approval) {
  await client.waitForTransactionReceipt({ hash: await walletClient.sendTransaction({ account, ...buy.approval }) });
}
await simulateBuy(client, buy, buyerSig); // the contract's revert, as an error, if it would revert
const hash = await walletClient.sendTransaction({ account, ...buy.settle(buyerSig) });
```

For a whitelist deal, `prepareBuy` adds the buyer's Merkle proof.

## Vesting

```ts
import { readStream, streamIdFromReceipt, streamsOf } from 'flash-deals-sdk';

const receipt = await client.waitForTransactionReceipt({ hash });
const stream = await readStream(client, 4663, streamIdFromReceipt(4663, receipt)!);
stream.deposited; // the vested share
stream.streamed; // unlocked so far
stream.withdrawable; // claimable now, in Sablier's app or on the Lockup
stream.end; // fully unlocked at this time

const all = await streamsOf(client, 4663, account.address); // every stream this wallet got from Flash Deals
```

## Terms

| Who may buy | `buyers` | Who can cancel |
|---|---|---|
| One wallet | `{ wallet }` | The seller or that wallet |
| Whitelist | `{ whitelist: [...] }`, up to 100 wallets, the first to settle | The seller |
| Anyone | `'anyone'`, the first to settle | The seller |

| Vesting `shape` | Fields | Unlocks |
|---|---|---|
| `linear` | `duration` | Evenly from the settlement to the end |
| `cliff` | `cliff`, `duration` | At the cliff what accrued so far, then evenly |
| `steps` | `steps`, `duration` | In equal steps; `duration` divides by `steps` |
| `monthly` | `months`, `start` | One part each calendar month after `start` (`monthlyStart('2027-01-15')`) |
| `allAtOnce` | `duration` | Everything at the end |

Durations are in seconds, and `percent` is the vested share. `expiresIn` sets the deadline (24 hours by default,
`null` for none). `cancelRequest(chainId, terms)` builds the cancel.

## Fee

The fee is 0.2% of the price, taken from the seller's side in the price token. A governance vote can change it.
`createDeal` signs the current fee as `maxFee`, and `readFeeBps` reads it live.

## Chains and addresses

| Chain | Chain id | `FlasetDeals` | `FlasetRegistry` |
|---|---|---|---|
| Robinhood Chain | 4663 | [`0x2c5224c5e456B9E1CeE0E6F1ffF8106Cd383e449`](https://robin.etherscan.io/address/0x2c5224c5e456B9E1CeE0E6F1ffF8106Cd383e449#code) | [`0xb41a45AEE32806061DDe1341249170BE3559FB8c`](https://robin.etherscan.io/address/0xb41a45AEE32806061DDe1341249170BE3559FB8c#code) |
| Base | 8453 | [`0x0Aed92C2AAc63e8dd1f325a0Ca3EbE78cceb0F58`](https://basescan.org/address/0x0Aed92C2AAc63e8dd1f325a0Ca3EbE78cceb0F58) | [`0x8fbB95d5c5f4612B4E8376133508F47BB875Af2A`](https://basescan.org/address/0x8fbB95d5c5f4612B4E8376133508F47BB875Af2A#code) |
| BNB Chain | 56 | [`0x0Aed92C2AAc63e8dd1f325a0Ca3EbE78cceb0F58`](https://bscscan.com/address/0x0Aed92C2AAc63e8dd1f325a0Ca3EbE78cceb0F58) | [`0x8fbB95d5c5f4612B4E8376133508F47BB875Af2A`](https://bscscan.com/address/0x8fbB95d5c5f4612B4E8376133508F47BB875Af2A#code) |
| Ethereum | 1 | [`0x0Aed92C2AAc63e8dd1f325a0Ca3EbE78cceb0F58`](https://etherscan.io/address/0x0Aed92C2AAc63e8dd1f325a0Ca3EbE78cceb0F58) | [`0x8fbB95d5c5f4612B4E8376133508F47BB875Af2A`](https://etherscan.io/address/0x8fbB95d5c5f4612B4E8376133508F47BB875Af2A#code) |

The vested share goes to Sablier's Lockup on each chain:

| Chain | Sablier Lockup |
|---|---|
| Robinhood Chain | [`0x548129a58bC230549DF7F9e33f27E77F6779ff0f`](https://robin.etherscan.io/address/0x548129a58bC230549DF7F9e33f27E77F6779ff0f) |
| Base | [`0xc19a09A66887017F603E5dF420ed3Cb9a5c07C0A`](https://basescan.org/address/0xc19a09A66887017F603E5dF420ed3Cb9a5c07C0A) |
| BNB Chain | [`0x6cd06Aaf06506bC3fF382d83023354E2B80EeD22`](https://bscscan.com/address/0x6cd06Aaf06506bC3fF382d83023354E2B80EeD22) |
| Ethereum | [`0x93b37Bd5B6b278373217333Ac30D7E74c85fBDCB`](https://etherscan.io/address/0x93b37Bd5B6b278373217333Ac30D7E74c85fBDCB) |

Every `FlasetDeals` and `FlasetRegistry` address is an exact match on [Sourcify](https://sourcify.dev).
`deployments/<chainId>.json` holds the addresses with their ABIs:

```ts
import { DEPLOYMENTS, flasetDealsAbi } from 'flash-deals-sdk';
import robinhood from 'flash-deals-sdk/deployments/4663.json' with { type: 'json' };
```

The SDK reads through each chain's public RPCs. Pass your own with `flashDealsClient(chainId, { rpcUrl })`, or hand
any viem `PublicClient` to every function.

## Development

```sh
npm install
npm test           # unit tests
npm run test:fork  # end to end on an anvil fork of Robinhood Chain (needs Foundry)
npm run example    # examples/fork-demo.ts: create, check and simulate a buy on the fork
```

## License

[MIT](LICENSE)

# Flaset SDK reference

Every function of the `deals` part, with its options. Import from `flaset-sdk/deals`, or use `deals` from `flaset-sdk`.

- [Chains and clients](#chains-and-clients)
- [Create a deal](#create-a-deal)
- [Read and check a deal](#read-and-check-a-deal)
- [Buy](#buy)
- [Cancel](#cancel)
- [Vesting streams](#vesting-streams)
- [Terms](#terms)
- [Fee](#fee)
- [Contracts and ABIs](#contracts-and-abis)
- [Errors](#errors)
- [Development](#development)

## Chains and clients

`chains` names each chain: `chains.robinhood`, `chains.base`, `chains.bnbChain` and `chains.ethereum`. Pass one
wherever a function takes `chainId`.

```ts
import { chains, flashDealsClient } from 'flaset-sdk/deals';

const client = flashDealsClient(chains.base); // the chain's public RPCs, in turn
const mine = flashDealsClient(chains.base, { rpcUrl: 'https://…' }); // your own RPC
```

Every function takes any viem `PublicClient`, so a client you already have works too. `CHAINS` holds each chain's
viem chain, public RPCs, explorer and the path the Flaset app opens its deal links under.

## Create a deal

```ts
import { chains, createDeal, encodeDealLink, sellerApproval } from 'flaset-sdk/deals';

const deal = createDeal({
  chainId: chains.robinhood,
  seller: account.address,
  sell: { token: WETH, amount: parseEther('1') },
  price: { token: USDG, amount: 3_000_000_000n }, // 3,000 USDG
  buyers: { wallet: buyer }, // or { whitelist: [a, b, c] } or 'anyone'
  vesting: { percent: 25, shape: 'linear', duration: 90 * 86_400 },
  expiresIn: 24 * 3600, // seconds; null for no expiry; 24 hours by default
});
const sellerSig = await walletClient.signTypedData({ account, ...deal.typedData });
await walletClient.sendTransaction({ account, ...sellerApproval(chains.robinhood, deal.terms) });
const link = encodeDealLink({ chainId: chains.robinhood, terms: deal.terms, sellerSig, whitelist: deal.whitelist });
```

- `createDeal` returns `terms` (the offer the seller signs), `typedData` (for `signTypedData`), `digest` (what the
  contract marks once the deal settles or is cancelled) and `whitelist`.
- It throws a `FlasetError` (code `INVALID_TERMS`) for terms FlasetDeals refuses.
- Also available: `feeBps` (the fee the seller accepts; default the current fee) and `nonce` (random by default).
- `sellerApproval` approves exactly the amount sold to `FlasetDeals`. It is the seller's only transaction.
- `encodeDealLink` builds the link the Flaset app opens. Pass `{ origin }` to point it at another host.

## Read and check a deal

```ts
import { checkDeal, decodeDealLink, dealState, flashDealsClient } from 'flaset-sdk/deals';

const deal = decodeDealLink(link); // a whole link, its fragment, or the d value
const client = flashDealsClient(deal.chainId);
const check = await checkDeal(client, deal, { buyer: account.address });
```

`decodeDealLink` reads a link as the app's buyer page does. When the app would refuse a link, it throws a
`FlasetError` (code `INVALID_LINK`) with the app's reason.

`checkDeal` returns:

| Field | What it holds |
|---|---|
| `state` | `'open'`, `'filled'`, `'cancelled'` or `'expired'` |
| `ok` | The deal is open and every check passed |
| `checks` | Each check: `id`, `ok`, `level` (`'error'` or `'warning'`) and `message` |
| `tokens` | `asset` and `pay`, each `'known'`, `'unverified'`, `'lookalike'`, `'delegated'` or `'invalid'` |
| `price` | `feeBps`, `fee`, `sellerReceives`, `buyerReceivesNow`, `vestedAmount`, `unitPrice` |
| `vesting` | The shape, its fields and a `description` in words |
| `settled` / `cancelled` | A filled deal's tx, buyer and `streamId`, or who cancelled it and the tx |
| `buyerApprovalNeeded` | With `buyer`: the approval that wallet still needs |

The checks are the ones the Flaset app runs before a buyer pays:

| Check | Passes when |
|---|---|
| `signature` | The seller's signature matches these exact terms (ERC-1271 wallets included) |
| `asset-token`, `pay-token` | Each token is at its listed address. A lookalike, an EIP-7702 delegated wallet, an address without a token or a blocked token fails. A token on no list passes with a warning |
| `seller-balance`, `seller-allowance` | The seller holds the tokens sold and approved them for `FlasetDeals` |
| `fee` | The current fee fits within the `maxFee` the seller signed |
| `state`, `deadline`, `paused` | The deal is open, within its deadline, and Flash Deals are live |
| `terms`, `vesting-start`, `whitelist` | The terms are ones the contract and the app take, and the list is the one the seller signed |
| `buyer`, `buyer-balance` | With `buyer`: that wallet may take the deal and holds the price |

- `dealState(client, chainId, terms)` returns the state alone. It finds a used deal by its digest in `DealSettled` and
  `DealCancelled`, from the newest block down. Pass `logs: { fromBlock }` to search fewer blocks.
- `checkToken(client, chainId, address)` tells what one token address is.
- `standardList(chainId)` returns the chain's token list, from official sources.

## Buy

```ts
import { prepareBuy, simulateBuy } from 'flaset-sdk/deals';

const buy = await prepareBuy(client, deal, account.address);
const buyerSig = await walletClient.signTypedData({ account, ...buy.typedData });
if (buy.approval) {
  await client.waitForTransactionReceipt({ hash: await walletClient.sendTransaction({ account, ...buy.approval }) });
}
await simulateBuy(client, buy, buyerSig); // the contract's revert, as an error, if it would revert
const hash = await walletClient.sendTransaction({ account, ...buy.settle(buyerSig) });
```

- `prepareBuy` returns the buyer's `terms` (the offer with the buyer's address), `typedData`, the whitelist `proof`,
  the `approval` (exactly the price, or `null` when the allowance covers it), `settle(sig)` as `{ to, data }` and
  `settleCall(sig)` for viem's `simulateContract` or `writeContract`.
- Anyone can send the settle and pay its gas, because both signatures fix every term.
- `buyerSide(deal, buyer)` gives the terms and proof without a chain read, and throws a `FlasetError`
  (`NOT_A_BUYER`) for a wallet that may not take the deal.

## Cancel

```ts
import { cancelRequest } from 'flaset-sdk/deals';

await walletClient.sendTransaction({ account, ...cancelRequest(chains.robinhood, deal.terms) });
```

The seller can cancel any deal before it settles, and the buyer of a one-wallet deal can too. A cancelled deal never
settles.

## Vesting streams

The vested share becomes one Sablier Lockup stream, minted to the buyer as an NFT. Nobody can cancel it.

```ts
import { readStream, streamIdFromReceipt, streamsOf } from 'flaset-sdk/deals';

const receipt = await client.waitForTransactionReceipt({ hash });
const stream = await readStream(client, chains.robinhood, streamIdFromReceipt(chains.robinhood, receipt)!);
const all = await streamsOf(client, chains.robinhood, account.address); // every stream this wallet got from Flash Deals
```

A stream holds `recipient`, `token`, `deposited`, `withdrawn`, `withdrawable`, `streamed`, `start`, `end`, `status`,
`transferable`, `cancelable` and `fromFlashDeals`. `streamsOf` adds the settlement `tx`, the `seller` and the deal's
`digest`. The holder claims in Sablier's app or on the Lockup.

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

Durations are in seconds, `percent` is the vested share, and `transferable: true` lets the stream move to another
wallet.

For the raw terms there are `termsProblems(terms)` (FlasetDeals' own rules, in words), `dealTypedData`, `hashDeal`,
`sellerDigest`, `buyerTerms`, `whitelistTree` and `whitelistVerify`.

## Fee

The fee is 0.2% of the price, taken from the seller's side in the price token. A governance vote can change it.
`createDeal` signs the current fee as `maxFee`, and `readFeeBps(client, chainId)` reads it live.

## Contracts and ABIs

| Chain | `FlasetDeals` | `FlasetRegistry` | Sablier Lockup |
|---|---|---|---|
| Robinhood Chain | `0x2c5224c5e456B9E1CeE0E6F1ffF8106Cd383e449` | `0xb41a45AEE32806061DDe1341249170BE3559FB8c` | `0x548129a58bC230549DF7F9e33f27E77F6779ff0f` |
| Base | `0x0Aed92C2AAc63e8dd1f325a0Ca3EbE78cceb0F58` | `0x8fbB95d5c5f4612B4E8376133508F47BB875Af2A` | `0xc19a09A66887017F603E5dF420ed3Cb9a5c07C0A` |
| BNB Chain | `0x0Aed92C2AAc63e8dd1f325a0Ca3EbE78cceb0F58` | `0x8fbB95d5c5f4612B4E8376133508F47BB875Af2A` | `0x6cd06Aaf06506bC3fF382d83023354E2B80EeD22` |
| Ethereum | `0x0Aed92C2AAc63e8dd1f325a0Ca3EbE78cceb0F58` | `0x8fbB95d5c5f4612B4E8376133508F47BB875Af2A` | `0x93b37Bd5B6b278373217333Ac30D7E74c85fBDCB` |

- Every `FlasetDeals` and `FlasetRegistry` address is an exact match on [Sourcify](https://sourcify.dev).
- `DEPLOYMENTS` holds them in code.
- `flasetDealsAbi`, `flasetRegistryAbi` and `sablierLockupAbi` are typed for viem.
- `deployments/` in this repo has one JSON file per chain, with each address, its deploy block and its ABI. Import it
  as `flaset-sdk/deployments/<file>.json`.

## Errors

Every error the SDK throws on purpose is a `FlasetError`, with a `code` and a `message` in words:

| Code | When |
|---|---|
| `UNKNOWN_CHAIN` | A chain the SDK has no contracts on |
| `INVALID_TERMS` | Terms FlasetDeals refuses, from `createDeal` or `assertTerms` |
| `INVALID_LINK` | A link the Flaset app does not open, from `decodeDealLink` or `encodeDealLink` |
| `NOT_A_BUYER` | A wallet that may not take the deal, from `prepareBuy` or `buyerSide` |

A revert from the chain itself, from `simulateBuy` for example, comes as viem's own error with the contract's error
name.

## Development

```sh
npm install
npm test           # unit tests
npm run test:fork  # end to end on an anvil fork of Robinhood Chain (needs Foundry)
npm run example    # examples/fork-demo.ts: create, check and simulate a buy on the fork
```

// The whitelist: the seller signs the Merkle root of the wallets that may buy, and the buyer settles with its proof.
// FlasetDeals checks MerkleProof.verifyCalldata(proof, buyersRoot, leaf(buyer)) with OpenZeppelin's StandardMerkleTree
// leaf over ["address"]: keccak256(bytes.concat(keccak256(abi.encode(a)))). The tree is built as @openzeppelin/merkle-tree
// builds it (leaves sorted, the tree in one array, pairs hashed in sorted order), so a root made here is the root that
// library makes for the same list.
import { concat, encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from 'viem';

/** The longest whitelist a deal link carries */
export const MAX_LIST = 100;

/** A StandardMerkleTree leaf of ["address"] */
export const whitelistLeaf = (a: Address): Hex => keccak256(keccak256(encodeAbiParameters([{ type: 'address' }], [getAddress(a)])));

const cmp = (a: Hex, b: Hex) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
const hashPair = (a: Hex, b: Hex): Hex => keccak256(cmp(a, b) <= 0 ? concat([a, b]) : concat([b, a]));

export interface Whitelist {
  /** what the seller signs as buyersRoot */
  root: Hex;
  /** the wallets, checksummed, each once */
  wallets: Address[];
  has: (a: Address) => boolean;
  /** the proof `settle` takes for that wallet; null when it is not on the list */
  proof: (a: Address) => Hex[] | null;
}

/** The tree of a list of wallets (at least one) */
export function whitelistTree(list: readonly Address[]): Whitelist {
  if (list.length === 0) throw new Error('A whitelist needs at least one wallet.');
  const wallets = [...new Set(list.map((a) => getAddress(a)))];
  const leaves = wallets.map(whitelistLeaf).sort(cmp);
  const tree: Hex[] = new Array<Hex>(2 * leaves.length - 1);
  leaves.forEach((leaf, i) => {
    tree[tree.length - 1 - i] = leaf;
  });
  for (let i = tree.length - 1 - leaves.length; i >= 0; i--) tree[i] = hashPair(tree[2 * i + 1]!, tree[2 * i + 2]!);
  const at = (a: Address) => {
    const i = tree.lastIndexOf(whitelistLeaf(a));
    return i >= tree.length - leaves.length ? i : -1;
  };
  return {
    root: tree[0]!,
    wallets,
    has: (a) => at(a) >= 0,
    proof: (a) => {
      let i = at(a);
      if (i < 0) return null;
      const proof: Hex[] = [];
      while (i > 0) {
        proof.push(tree[i % 2 === 0 ? i - 1 : i + 1]!);
        i = Math.floor((i - 1) / 2);
      }
      return proof;
    },
  };
}

/** MerkleProof.verify, as FlasetDeals runs it */
export function whitelistVerify(proof: readonly Hex[], root: Hex, a: Address): boolean {
  return proof.reduce<Hex>((h, p) => hashPair(h, p), whitelistLeaf(a)) === root;
}

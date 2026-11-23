// Starts a local anvil fork. Env: FORK_URL (upstream RPC, default the chain's public RPC), ANVIL (binary path).
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createPublicClient, createTestClient, createWalletClient, getAddress, http, type Address, type PublicClient } from 'viem';
import { chainOf } from '../../src/index.js';

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

export interface Fork {
  url: string;
  chainId: number;
  client: PublicClient;
  test: ReturnType<typeof createTestClient>;
  wallet: (account: Address) => ReturnType<typeof createWalletClient>;
  accounts: Address[];
  stop: () => void;
}

export async function startFork(chainId: number): Promise<Fork> {
  const c = chainOf(chainId);
  const upstream = process.env.FORK_URL ?? c.rpcUrls[0]!;
  const port = await freePort();
  const proc: ChildProcess = spawn(process.env.ANVIL ?? 'anvil', ['--fork-url', upstream, '--port', String(port), '--silent', '--retries', '20', '--fork-retry-backoff', '2000'], {
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  const transport = http(url, { retryCount: 0 });
  const client = createPublicClient({ chain: c.chain, transport }) as PublicClient;
  for (let i = 0; ; i++) {
    try {
      if ((await client.getChainId()) === chainId) break;
    } catch {
      if (i > 120) {
        proc.kill();
        throw new Error(`anvil did not answer on ${url}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const accounts = ((await client.request({ method: 'eth_accounts' } as never)) as Address[]).map((a) => getAddress(a));
  return {
    url,
    chainId,
    client,
    test: createTestClient({ chain: c.chain, mode: 'anvil', transport }),
    wallet: (account) => createWalletClient({ chain: c.chain, account, transport }),
    accounts,
    stop: () => proc.kill(),
  };
}

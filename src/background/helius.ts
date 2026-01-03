import { LAMPORTS_PER_SOL } from '../shared/types';

export class HeliusClient {
  private apiKey: string;
  private rpcUrl: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  }

  // 获取SOL余额
  async getBalance(address: string): Promise<number> {
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBalance',
        params: [address],
      }),
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    return data.result.value / LAMPORTS_PER_SOL;
  }

  // 获取Token余额
  async getTokenBalance(address: string, mint: string): Promise<number> {
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountsByOwner',
        params: [
          address,
          { mint },
          { encoding: 'jsonParsed' },
        ],
      }),
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const accounts = data.result.value;
    if (accounts.length === 0) return 0;

    return accounts[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
  }

  // 获取优先费建议
  async getPriorityFee(): Promise<number> {
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getRecentPrioritizationFees',
        params: [],
      }),
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const fees = data.result;
    if (fees.length === 0) return 100000;

    // 取最近的中位数
    const sorted = fees.map((f: any) => f.prioritizationFee).sort((a: number, b: number) => a - b);
    return sorted[Math.floor(sorted.length * 0.75)] || 100000;
  }

  // 获取最新区块哈希
  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getLatestBlockhash',
        params: [{ commitment: 'finalized' }],
      }),
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    return data.result.value;
  }

  // 发送交易 (skipPreflight 加速)
  async sendTransaction(signedTx: string): Promise<string> {
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [
          signedTx,
          {
            skipPreflight: true,
            preflightCommitment: 'processed',
            maxRetries: 3,
          },
        ],
      }),
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    return data.result;
  }

  // 确认交易
  async confirmTransaction(signature: string, timeout = 30000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignatureStatuses',
          params: [[signature]],
        }),
      });

      const data = await response.json();
      const status = data.result?.value?.[0];

      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        return !status.err;
      }

      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }
}

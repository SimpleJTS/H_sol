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
    const startTime = performance.now();
    try {
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
      const totalTime = performance.now() - startTime;
      
      if (data.error) {
        console.error('[Helius] getBalance 失败 (耗时:', totalTime.toFixed(2), 'ms):', data.error);
        throw new Error(data.error.message);
      }
      
      const balance = data.result.value / LAMPORTS_PER_SOL;
      console.log('[Helius] ✓ SOL余额获取成功，耗时:', totalTime.toFixed(2), 'ms, 余额:', balance, 'SOL');
      return balance;
    } catch (error: any) {
      const totalTime = performance.now() - startTime;
      console.error('[Helius] getBalance 异常 (耗时:', totalTime.toFixed(2), 'ms):', error);
      throw error;
    }
  }

  // 获取Token余额（UI 数量）
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

  // 获取Token原始余额（最小单位，用于精确计算）
  async getRawTokenBalance(address: string, mint: string): Promise<number> {
    const startTime = performance.now();
    try {
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
      const fetchTime = performance.now() - startTime;
      
      if (data.error) {
        console.error('[Helius] getRawTokenBalance 失败 (耗时:', fetchTime.toFixed(2), 'ms):', data.error.message);
        throw new Error(data.error.message);
      }

      const accounts = data.result.value;
      if (accounts.length === 0) {
        console.log('[Helius] ✓ 原始余额获取成功 (耗时:', fetchTime.toFixed(2), 'ms): 0');
        return 0;
      }

      const amount = accounts[0].account.data.parsed.info.tokenAmount.amount;
      const rawBalance = parseInt(amount || '0', 10);
      const totalTime = performance.now() - startTime;
      console.log('[Helius] ✓ 原始余额获取成功，耗时:', totalTime.toFixed(2), 'ms, 余额:', rawBalance.toString());
      return rawBalance;
    } catch (error: any) {
      const totalTime = performance.now() - startTime;
      console.error('[Helius] getRawTokenBalance 异常 (耗时:', totalTime.toFixed(2), 'ms):', error);
      throw error;
    }
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
  // signedTx 应该是 base58 编码的字符串
  async sendTransaction(signedTx: string): Promise<string> {
    const startTime = performance.now();
    try {
      console.log('[Helius] → 发送交易到链上，交易长度:', signedTx.length, '字符');
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendTransaction',
          params: [
            signedTx, // base58 编码的交易
            {
              skipPreflight: true,
              preflightCommitment: 'processed',
              maxRetries: 3,
              encoding: 'base58', // 明确指定编码格式
            },
          ],
        }),
      });

      const fetchTime = performance.now() - startTime;
      const data = await response.json();
      
      if (data.error) {
        console.error('[Helius] sendTransaction 失败 (耗时:', fetchTime.toFixed(2), 'ms):', data.error);
        throw new Error(data.error.message);
      }
      
      const totalTime = performance.now() - startTime;
      console.log('[Helius] ✓ 交易发送成功，耗时:', totalTime.toFixed(2), 'ms');
      console.log('[Helius]   交易签名:', data.result);
      return data.result;
    } catch (error: any) {
      const totalTime = performance.now() - startTime;
      console.error('[Helius] sendTransaction 异常 (耗时:', totalTime.toFixed(2), 'ms):', error);
      throw error;
    }
  }

  // 确认交易 - 返回详细状态
  async confirmTransaction(
    signature: string,
    timeout = 30000
  ): Promise<{ confirmed: boolean; error?: string }> {
    const start = Date.now();
    let lastStatus: any = null;
    let checkCount = 0;

    console.log('[Helius] → 等待交易确认，签名:', signature.slice(0, 16) + '...');

    while (Date.now() - start < timeout) {
      try {
        checkCount++;
        const response = await fetch(this.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getSignatureStatuses',
            params: [[signature], { searchTransactionHistory: true }],
          }),
        });

        const data = await response.json();
        const status = data.result?.value?.[0];
        lastStatus = status;

        if (status) {
          if (status.err) {
            // 交易失败，返回错误
            const errMsg = typeof status.err === 'object'
              ? JSON.stringify(status.err)
              : String(status.err);
            console.error('[Helius] ✗ 交易链上执行失败:', errMsg);
            return { confirmed: false, error: `链上执行失败: ${errMsg}` };
          }

          if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
            const elapsed = Date.now() - start;
            console.log('[Helius] ✓ 交易确认成功，耗时:', elapsed, 'ms, 状态:', status.confirmationStatus);
            return { confirmed: true };
          }
        }
      } catch (e: any) {
        console.warn('[Helius] 确认查询失败 (尝试 ' + checkCount + '):', e.message);
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    // 超时
    const elapsed = Date.now() - start;
    console.warn('[Helius] ⚠ 交易确认超时 (' + elapsed + 'ms, 检查 ' + checkCount + ' 次)');

    if (lastStatus && !lastStatus.err) {
      return { confirmed: false, error: '交易确认超时，请稍后查看钱包' };
    }
    return { confirmed: false, error: '交易可能已过期或被丢弃' };
  }

  // 发送并确认交易
  async sendAndConfirmTransaction(
    signedTx: string,
    confirmTimeout = 25000
  ): Promise<{ signature: string; confirmed: boolean; error?: string }> {
    try {
      // 发送交易
      const signature = await this.sendTransaction(signedTx);

      // 等待确认
      const result = await this.confirmTransaction(signature, confirmTimeout);

      if (result.confirmed) {
        return { signature, confirmed: true };
      }

      return { signature, confirmed: false, error: result.error };
    } catch (e: any) {
      console.error('[Helius] sendAndConfirmTransaction 失败:', e.message);
      return { signature: '', confirmed: false, error: e.message };
    }
  }
}

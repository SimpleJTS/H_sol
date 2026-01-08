import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { LAMPORTS_PER_SOL } from '../shared/types';

// Raydium Trade API 端点
const RAYDIUM_API_BASE = 'https://api-v3.raydium.io';

// SOL 的 mint 地址
const SOL_MINT = 'So11111111111111111111111111111111111111112';

export class RaydiumClient {
  private connection: Connection;
  private priorityFee: number;
  private slippage: number; // bps, 100 = 1%

  constructor(rpcUrl: string, priorityFee: number = 100000, slippage: number = 500) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.priorityFee = priorityFee;
    this.slippage = slippage;
  }

  updateSettings(priorityFee: number, slippage?: number) {
    this.priorityFee = priorityFee;
    if (slippage !== undefined) {
      this.slippage = slippage;
    }
  }

  // 获取 Token 精度
  async getTokenDecimals(mint: string): Promise<number> {
    try {
      const mintPubkey = new PublicKey(mint);
      const mintInfo = await this.connection.getParsedAccountInfo(mintPubkey);
      if (mintInfo.value && 'parsed' in mintInfo.value.data) {
        return (mintInfo.value.data as any).parsed.info.decimals;
      }
      return 9;
    } catch (error) {
      console.warn('[Raydium] 获取精度失败，使用默认值 9:', error);
      return 9;
    }
  }

  // 获取优先费建议
  private async getPriorityFee(): Promise<number> {
    try {
      const response = await fetch(`${RAYDIUM_API_BASE}/main/auto-fee`);
      if (response.ok) {
        const data = await response.json();
        // 使用 high 级别的优先费
        return data.data?.h || this.priorityFee;
      }
    } catch (error) {
      console.warn('[Raydium] 获取优先费失败，使用默认值:', error);
    }
    return this.priorityFee;
  }

  // 获取 swap 报价
  private async getSwapQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    isInputAmount: boolean = true
  ): Promise<any> {
    const endpoint = isInputAmount ? 'swap-base-in' : 'swap-base-out';
    const url = `${RAYDIUM_API_BASE}/compute/${endpoint}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${this.slippage}&txVersion=V0`;

    console.log('[Raydium] 获取报价:', url);

    const response = await fetch(url);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Raydium API 错误: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    if (!data.success) {
      throw new Error(`Raydium 报价失败: ${data.msg || JSON.stringify(data)}`);
    }

    console.log('[Raydium] 报价结果:', {
      inputAmount: data.data.inputAmount,
      outputAmount: data.data.outputAmount,
      priceImpact: data.data.priceImpactPct,
    });

    return data.data;
  }

  // 获取 swap 交易
  private async getSwapTransaction(
    quoteData: any,
    userPublicKey: string,
    wrapSol: boolean = true,
    unwrapSol: boolean = true
  ): Promise<VersionedTransaction | Transaction> {
    const priorityFee = await this.getPriorityFee();

    const requestBody = {
      computeUnitPriceMicroLamports: String(priorityFee),
      swapResponse: quoteData,
      txVersion: 'V0',
      wallet: userPublicKey,
      wrapSol,
      unwrapSol,
    };

    console.log('[Raydium] 获取交易...');

    const response = await fetch(`${RAYDIUM_API_BASE}/transaction/swap-base-in`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Raydium 交易构建失败: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    if (!data.success || !data.data || data.data.length === 0) {
      throw new Error(`Raydium 交易构建失败: ${data.msg || '无交易数据'}`);
    }

    // 解析交易（通常只有一个交易）
    const txData = data.data[0].transaction;
    const txBuffer = Buffer.from(txData, 'base64');

    // 尝试解析为 VersionedTransaction
    try {
      const versionedTx = VersionedTransaction.deserialize(txBuffer);
      console.log('[Raydium] ✓ 获取 VersionedTransaction 成功');
      return versionedTx;
    } catch {
      // 如果不是 VersionedTransaction，尝试解析为 Legacy Transaction
      const legacyTx = Transaction.from(txBuffer);
      console.log('[Raydium] ✓ 获取 Legacy Transaction 成功');
      return legacyTx;
    }
  }

  // 构建买入交易 (SOL -> Token)
  async buildBuyTransaction(
    tokenMint: string,
    solAmount: number,
    userPublicKey: string
  ): Promise<Transaction | VersionedTransaction> {
    const startTime = performance.now();
    try {
      console.log('[Raydium] 构建买入交易:', { tokenMint, solAmount, userPublicKey });

      // SOL 金额转换为 lamports
      const amountLamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

      // 获取报价
      const quoteData = await this.getSwapQuote(SOL_MINT, tokenMint, amountLamports, true);

      // 获取交易
      const transaction = await this.getSwapTransaction(quoteData, userPublicKey, true, false);

      const totalTime = performance.now() - startTime;
      console.log('[Raydium] ✓ 买入交易构建成功，耗时:', totalTime.toFixed(2), 'ms');

      return transaction;
    } catch (error: any) {
      const totalTime = performance.now() - startTime;
      console.error('[Raydium] 构建买入交易失败 (耗时:', totalTime.toFixed(2), 'ms):', error);
      throw error;
    }
  }

  // 构建卖出交易 (Token -> SOL)
  async buildSellTransaction(
    tokenMint: string,
    tokenAmount: number,
    decimals: number,
    userPublicKey: string
  ): Promise<Transaction | VersionedTransaction> {
    const startTime = performance.now();
    try {
      console.log('[Raydium] 构建卖出交易:', { tokenMint, tokenAmount, decimals, userPublicKey });

      // Token 金额转换为最小单位
      const amountRaw = Math.floor(tokenAmount * Math.pow(10, decimals));

      // 获取报价
      const quoteData = await this.getSwapQuote(tokenMint, SOL_MINT, amountRaw, true);

      // 获取交易
      const transaction = await this.getSwapTransaction(quoteData, userPublicKey, false, true);

      const totalTime = performance.now() - startTime;
      console.log('[Raydium] ✓ 卖出交易构建成功，耗时:', totalTime.toFixed(2), 'ms');

      return transaction;
    } catch (error: any) {
      const totalTime = performance.now() - startTime;
      console.error('[Raydium] 构建卖出交易失败 (耗时:', totalTime.toFixed(2), 'ms):', error);
      throw error;
    }
  }
}

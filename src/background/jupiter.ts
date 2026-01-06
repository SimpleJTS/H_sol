import { JupiterQuote, JupiterSwapResponse, SOL_MINT, LAMPORTS_PER_SOL } from '../shared/types';

const JUPITER_QUOTE_API = 'https://api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_API = 'https://api.jup.ag/swap/v1/swap';

export class JupiterClient {
  private slippageBps: number;
  private priorityFee: number;
  private apiKey: string;

  constructor(apiKey: string = '', slippageBps: number = 100, priorityFee: number = 100000) {
    this.apiKey = apiKey;
    this.slippageBps = slippageBps;
    this.priorityFee = priorityFee;
  }

  updateSettings(apiKey: string, slippageBps: number, priorityFee: number) {
    this.apiKey = apiKey;
    this.slippageBps = slippageBps;
    this.priorityFee = priorityFee;
  }

  // 获取买入报价 (SOL -> Token)
  async getBuyQuote(tokenMint: string, solAmount: number): Promise<JupiterQuote> {
    const startTime = performance.now();
    try {
      const inputAmount = Math.floor(solAmount * LAMPORTS_PER_SOL);
      const url = new URL(JUPITER_QUOTE_API);
      url.searchParams.set('inputMint', SOL_MINT);
      url.searchParams.set('outputMint', tokenMint);
      url.searchParams.set('amount', inputAmount.toString());
      url.searchParams.set('slippageBps', this.slippageBps.toString());

      const headers: HeadersInit = {};
      if (this.apiKey && this.apiKey.trim()) {
        headers['x-api-key'] = this.apiKey.trim();
      }

      console.log('[Jupiter] 请求买入报价:', {
        tokenMint: tokenMint.slice(0, 8) + '...',
        solAmount,
        inputAmount: inputAmount.toString(),
        slippageBps: this.slippageBps,
        hasApiKey: !!this.apiKey
      });

      const response = await fetch(url.toString(), { headers });
      const fetchTime = performance.now() - startTime;
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        const errorMsg = `Jupiter quote failed: ${response.status} ${errorText || response.statusText}`;
        console.error('[Jupiter] getBuyQuote 失败 (耗时:', fetchTime.toFixed(2), 'ms):', errorMsg, 'API Key:', this.apiKey ? 'present' : 'missing');
        throw new Error(errorMsg);
      }
      
      const quote = await response.json();
      const totalTime = performance.now() - startTime;
      console.log('[Jupiter] ✓ 买入报价获取成功，耗时:', totalTime.toFixed(2), 'ms');
      if (quote.outAmount) {
        console.log('[Jupiter]   预计获得Token数量:', quote.outAmount);
      }
      return quote;
    } catch (error: any) {
      const totalTime = performance.now() - startTime;
      console.error('[Jupiter] getBuyQuote 异常 (耗时:', totalTime.toFixed(2), 'ms):', error);
      throw error;
    }
  }

  // 获取卖出报价 (Token -> SOL)
  // tokenAmount 是 UI 数量（已经除以 decimals），需要转换为原始数量
  async getSellQuote(tokenMint: string, tokenAmount: number, decimals: number): Promise<JupiterQuote> {
    const startTime = performance.now();
    try {
      // 将 UI 数量转换为原始数量（最小单位）
      // 使用更精确的计算，避免精度丢失
      const inputAmount = Math.floor(tokenAmount * Math.pow(10, decimals));
      
      // 验证数量
      if (inputAmount <= 0) {
        throw new Error(`无效的卖出数量: ${tokenAmount} (decimals: ${decimals})`);
      }
      
      console.log('[Jupiter] 请求卖出报价:', {
        tokenMint: tokenMint.slice(0, 8) + '...',
        tokenAmount,
        decimals,
        inputAmount: inputAmount.toString(),
        slippageBps: this.slippageBps,
        hasApiKey: !!this.apiKey
      });
      
      const url = new URL(JUPITER_QUOTE_API);
      url.searchParams.set('inputMint', tokenMint);
      url.searchParams.set('outputMint', SOL_MINT);
      url.searchParams.set('amount', inputAmount.toString());
      url.searchParams.set('slippageBps', this.slippageBps.toString());

      const headers: HeadersInit = {};
      if (this.apiKey && this.apiKey.trim()) {
        headers['x-api-key'] = this.apiKey.trim();
      }

      const response = await fetch(url.toString(), { headers });
      const fetchTime = performance.now() - startTime;
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        const errorMsg = `Jupiter quote failed: ${response.status} ${errorText || response.statusText}`;
        console.error('[Jupiter] getSellQuote 失败 (耗时:', fetchTime.toFixed(2), 'ms):', errorMsg, 'API Key:', this.apiKey ? 'present' : 'missing');
        throw new Error(errorMsg);
      }
      
      const quote = await response.json();
      const totalTime = performance.now() - startTime;
      console.log('[Jupiter] ✓ 卖出报价获取成功，耗时:', totalTime.toFixed(2), 'ms');
      if (quote.outAmount) {
        console.log('[Jupiter]   预计获得SOL数量:', quote.outAmount);
      }
      return quote;
    } catch (error: any) {
      const totalTime = performance.now() - startTime;
      console.error('[Jupiter] getSellQuote 异常 (耗时:', totalTime.toFixed(2), 'ms):', error);
      throw error;
    }
  }

  // 获取Swap交易
  async getSwapTransaction(
    quote: JupiterQuote,
    userPublicKey: string
  ): Promise<JupiterSwapResponse> {
    const startTime = performance.now();
    try {
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (this.apiKey && this.apiKey.trim()) {
        headers['x-api-key'] = this.apiKey.trim();
      }

      console.log('[Jupiter] 构建Swap交易:', {
        userPublicKey: userPublicKey.slice(0, 8) + '...',
        priorityFee: this.priorityFee,
        hasApiKey: !!this.apiKey
      });

      const response = await fetch(JUPITER_SWAP_API, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: this.priorityFee,
        }),
      });

      const fetchTime = performance.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        const errorMsg = `Jupiter swap failed: ${response.status} ${errorText || response.statusText}`;
        console.error('[Jupiter] getSwapTransaction 失败 (耗时:', fetchTime.toFixed(2), 'ms):', errorMsg, 'API Key:', this.apiKey ? 'present' : 'missing');
        throw new Error(errorMsg);
      }
      
      const swapResponse = await response.json();
      const totalTime = performance.now() - startTime;
      console.log('[Jupiter] ✓ Swap交易构建成功，耗时:', totalTime.toFixed(2), 'ms');
      if (swapResponse.swapTransaction) {
        console.log('[Jupiter]   交易数据长度:', swapResponse.swapTransaction.length, '字符');
      }
      return swapResponse;
    } catch (error: any) {
      const totalTime = performance.now() - startTime;
      console.error('[Jupiter] getSwapTransaction 异常 (耗时:', totalTime.toFixed(2), 'ms):', error);
      throw error;
    }
  }

  // 预加载买入交易 (返回多个金额的交易)
  async preloadBuyTrades(
    tokenMint: string,
    amounts: number[],
    userPublicKey: string
  ): Promise<Map<number, { quote: JupiterQuote; swapTx: string }>> {
    const startTime = performance.now();
    const results = new Map();
    
    console.log('[Jupiter] 预加载买入交易，数量:', amounts.length, '个金额');

    // 并行获取所有报价
    const quotesStart = performance.now();
    const quotes = await Promise.all(
      amounts.map((amount) =>
        this.getBuyQuote(tokenMint, amount).catch(() => null)
      )
    );
    const quotesTime = performance.now() - quotesStart;
    const successQuotes = quotes.filter(q => q !== null).length;
    console.log('[Jupiter] 报价获取完成，成功:', successQuotes, '/', amounts.length, '耗时:', quotesTime.toFixed(2), 'ms');

    // 并行获取所有交易
    const swapsStart = performance.now();
    const swapPromises = quotes.map((quote, i) => {
      if (!quote) return null;
      return this.getSwapTransaction(quote, userPublicKey)
        .then((swap) => ({ amount: amounts[i], quote, swapTx: swap.swapTransaction }))
        .catch(() => null);
    });

    const swaps = await Promise.all(swapPromises);
    const swapsTime = performance.now() - swapsStart;
    const successSwaps = swaps.filter(s => s !== null).length;
    console.log('[Jupiter] 交易构建完成，成功:', successSwaps, '/', successQuotes, '耗时:', swapsTime.toFixed(2), 'ms');

    for (const swap of swaps) {
      if (swap) {
        results.set(swap.amount, { quote: swap.quote, swapTx: swap.swapTx });
      }
    }

    const totalTime = performance.now() - startTime;
    console.log('[Jupiter] ✓ 预加载完成，成功交易数:', results.size, '总耗时:', totalTime.toFixed(2), 'ms');

    return results;
  }

  // 预加载卖出交易 (返回多个百分比对应的交易)
  async preloadSellTrades(
    tokenMint: string,
    sellPresets: number[], // 卖出百分比数组，例如 [10, 30, 50, 100]
    decimals: number,
    rawTokenBalance: number, // 原始余额（最小单位）
    userPublicKey: string
  ): Promise<Map<number, { quote: JupiterQuote; swapTx: string }>> {
    const startTime = performance.now();
    const results = new Map();
    
    console.log('[Jupiter] 预加载卖出交易，数量:', sellPresets.length, '个百分比');
    console.log('[Jupiter] 原始余额:', rawTokenBalance.toString(), '精度:', decimals);

    // 计算每个百分比对应的UI卖出数量
    const sellAmounts = sellPresets.map(percent => {
      const rawSellAmount = Math.floor((rawTokenBalance * percent) / 100);
      const uiSellAmount = rawSellAmount / Math.pow(10, decimals);
      return { percent, uiSellAmount, rawSellAmount };
    });

    // 过滤掉数量为0的
    const validAmounts = sellAmounts.filter(a => a.rawSellAmount > 0);
    console.log('[Jupiter] 有效卖出数量:', validAmounts.length, '/', sellPresets.length);

    if (validAmounts.length === 0) {
      console.warn('[Jupiter] 没有有效的卖出数量，跳过预加载');
      return results;
    }

    // 并行获取所有报价
    const quotesStart = performance.now();
    const quotes = await Promise.all(
      validAmounts.map(({ percent, uiSellAmount }) =>
        this.getSellQuote(tokenMint, uiSellAmount, decimals)
          .then(quote => ({ percent, quote }))
          .catch(() => null)
      )
    );
    const quotesTime = performance.now() - quotesStart;
    const successQuotes = quotes.filter(q => q !== null).length;
    console.log('[Jupiter] 卖出报价获取完成，成功:', successQuotes, '/', validAmounts.length, '耗时:', quotesTime.toFixed(2), 'ms');

    // 并行获取所有交易
    const swapsStart = performance.now();
    const swapPromises = quotes.map((quoteData) => {
      if (!quoteData) return null;
      return this.getSwapTransaction(quoteData.quote, userPublicKey)
        .then((swap) => ({ 
          percent: quoteData.percent, 
          quote: quoteData.quote, 
          swapTx: swap.swapTransaction 
        }))
        .catch(() => null);
    });

    const swaps = await Promise.all(swapPromises);
    const swapsTime = performance.now() - swapsStart;
    const successSwaps = swaps.filter(s => s !== null).length;
    console.log('[Jupiter] 卖出交易构建完成，成功:', successSwaps, '/', successQuotes, '耗时:', swapsTime.toFixed(2), 'ms');

    for (const swap of swaps) {
      if (swap) {
        results.set(swap.percent, { quote: swap.quote, swapTx: swap.swapTx });
      }
    }

    const totalTime = performance.now() - startTime;
    console.log('[Jupiter] ✓ 卖出预加载完成，成功交易数:', results.size, '总耗时:', totalTime.toFixed(2), 'ms');

    return results;
  }

  // 获取Token信息 (decimals)
  async getTokenDecimals(mint: string): Promise<number> {
    // 使用Jupiter的token list缓存
    try {
      const response = await fetch(`https://tokens.jup.ag/token/${mint}`);
      if (response.ok) {
        const data = await response.json();
        return data.decimals || 9;
      }
    } catch {
      // fallback
    }
    return 9; // 默认9位小数
  }
}

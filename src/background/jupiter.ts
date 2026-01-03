import { JupiterQuote, JupiterSwapResponse, SOL_MINT, LAMPORTS_PER_SOL } from '../shared/types';

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap';

export class JupiterClient {
  private slippageBps: number;
  private priorityFee: number;

  constructor(slippageBps: number = 100, priorityFee: number = 100000) {
    this.slippageBps = slippageBps;
    this.priorityFee = priorityFee;
  }

  updateSettings(slippageBps: number, priorityFee: number) {
    this.slippageBps = slippageBps;
    this.priorityFee = priorityFee;
  }

  // 获取买入报价 (SOL -> Token)
  async getBuyQuote(tokenMint: string, solAmount: number): Promise<JupiterQuote> {
    const inputAmount = Math.floor(solAmount * LAMPORTS_PER_SOL);
    const url = new URL(JUPITER_QUOTE_API);
    url.searchParams.set('inputMint', SOL_MINT);
    url.searchParams.set('outputMint', tokenMint);
    url.searchParams.set('amount', inputAmount.toString());
    url.searchParams.set('slippageBps', this.slippageBps.toString());

    const response = await fetch(url.toString());
    if (!response.ok) throw new Error(`Jupiter quote failed: ${response.status}`);
    return response.json();
  }

  // 获取卖出报价 (Token -> SOL)
  async getSellQuote(tokenMint: string, tokenAmount: number, decimals: number): Promise<JupiterQuote> {
    const inputAmount = Math.floor(tokenAmount * Math.pow(10, decimals));
    const url = new URL(JUPITER_QUOTE_API);
    url.searchParams.set('inputMint', tokenMint);
    url.searchParams.set('outputMint', SOL_MINT);
    url.searchParams.set('amount', inputAmount.toString());
    url.searchParams.set('slippageBps', this.slippageBps.toString());

    const response = await fetch(url.toString());
    if (!response.ok) throw new Error(`Jupiter quote failed: ${response.status}`);
    return response.json();
  }

  // 获取Swap交易
  async getSwapTransaction(
    quote: JupiterQuote,
    userPublicKey: string
  ): Promise<JupiterSwapResponse> {
    const response = await fetch(JUPITER_SWAP_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: this.priorityFee,
      }),
    });

    if (!response.ok) throw new Error(`Jupiter swap failed: ${response.status}`);
    return response.json();
  }

  // 预加载买入交易 (返回多个金额的交易)
  async preloadBuyTrades(
    tokenMint: string,
    amounts: number[],
    userPublicKey: string
  ): Promise<Map<number, { quote: JupiterQuote; swapTx: string }>> {
    const results = new Map();

    // 并行获取所有报价
    const quotes = await Promise.all(
      amounts.map((amount) =>
        this.getBuyQuote(tokenMint, amount).catch(() => null)
      )
    );

    // 并行获取所有交易
    const swapPromises = quotes.map((quote, i) => {
      if (!quote) return null;
      return this.getSwapTransaction(quote, userPublicKey)
        .then((swap) => ({ amount: amounts[i], quote, swapTx: swap.swapTransaction }))
        .catch(() => null);
    });

    const swaps = await Promise.all(swapPromises);

    for (const swap of swaps) {
      if (swap) {
        results.set(swap.amount, { quote: swap.quote, swapTx: swap.swapTx });
      }
    }

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

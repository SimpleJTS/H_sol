// 配置类型
export interface Config {
  heliusApiKey: string;
  jupiterApiKey: string;
  privateKey: string; // 加密存储
  slippage: number; // 滑点 bps (100 = 1%)
  priorityFee: number; // 优先费 microLamports
  buyPresets: [number, number, number, number]; // 4个买入预设 (SOL)
  sellPresets: [number, number, number, number]; // 4个卖出预设 (%)
  autoLockMinutes: number;
  allowedSites: string[]; // 允许显示插件的网站列表（空数组表示所有网站）
}

// 默认配置
export const DEFAULT_CONFIG: Config = {
  heliusApiKey: '',
  jupiterApiKey: '',
  privateKey: '',
  slippage: 100, // 1%
  priorityFee: 100000, // 0.0001 SOL
  buyPresets: [0.36, 0.56, 0.86, 1.06],
  sellPresets: [10, 30, 50, 100],
  autoLockMinutes: 30,
  allowedSites: [], // 空数组表示所有网站都显示
};

// 钱包状态
export interface WalletState {
  address: string;
  balance: number; // SOL
  isLocked: boolean;
}

// 预加载的交易
export interface PreloadedTrade {
  ca: string;
  amount: number; // SOL for buy, % for sell
  type: 'buy' | 'sell';
  quote: JupiterQuote | null;
  swapTransaction: string | null; // base64 encoded
  timestamp: number;
}

// Jupiter Quote 响应
export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: any[];
}

// Jupiter Swap 响应
export interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
}

// 消息类型 - Content <-> Background 通信
export type MessageType =
  | 'GET_WALLET_STATE'
  | 'PRELOAD_TRADES'
  | 'EXECUTE_BUY'
  | 'EXECUTE_SELL'
  | 'GET_CONFIG'
  | 'SAVE_CONFIG'
  | 'IMPORT_WALLET'
  | 'REMOVE_WALLET'
  | 'GET_TOKEN_BALANCE';

export interface Message {
  type: MessageType;
  payload?: any;
}

export interface MessageResponse {
  success: boolean;
  data?: any;
  error?: string;
}

// 交易状态
export type TradeStatus = 'idle' | 'loading' | 'ready' | 'executing' | 'success' | 'error';

// SOL 常量
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const LAMPORTS_PER_SOL = 1_000_000_000;

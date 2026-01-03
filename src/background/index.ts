import { HeliusClient } from './helius';
import { JupiterClient } from './jupiter';
import { WalletManager } from './wallet';
import { getConfig, saveConfig } from '../shared/storage';
import { Message, MessageResponse, Config, PreloadedTrade, JupiterQuote } from '../shared/types';

// 全局实例
let helius: HeliusClient | null = null;
let jupiter: JupiterClient | null = null;
const wallet = new WalletManager();

// 预加载缓存
interface PreloadCache {
  ca: string;
  buyTrades: Map<number, { quote: JupiterQuote; swapTx: string }>;
  tokenDecimals: number;
  tokenBalance: number;
  timestamp: number;
}

let preloadCache: PreloadCache | null = null;
const CACHE_TTL = 10000; // 10秒过期

// 初始化
async function init() {
  const config = await getConfig();
  if (config.heliusApiKey) {
    helius = new HeliusClient(config.heliusApiKey);
    jupiter = new JupiterClient(config.slippage, config.priorityFee);
  }
  await wallet.hasStoredWallet();
  wallet.setAutoLock(config.autoLockMinutes);
  console.log('[SolSniper] Background initialized');
}

// 更新客户端配置
async function updateClients(config: Config) {
  if (config.heliusApiKey) {
    helius = new HeliusClient(config.heliusApiKey);
  }
  if (jupiter) {
    jupiter.updateSettings(config.slippage, config.priorityFee);
  } else if (config.heliusApiKey) {
    jupiter = new JupiterClient(config.slippage, config.priorityFee);
  }
  wallet.setAutoLock(config.autoLockMinutes);
}

// 预加载交易
async function preloadTrades(ca: string): Promise<void> {
  if (!helius || !jupiter || wallet.isLocked) {
    throw new Error('Not ready');
  }

  const config = await getConfig();
  const userAddress = wallet.publicKey;

  // 并行获取数据
  const [decimals, tokenBalance, buyTrades] = await Promise.all([
    jupiter.getTokenDecimals(ca),
    helius.getTokenBalance(userAddress, ca).catch(() => 0),
    jupiter.preloadBuyTrades(ca, config.buyPresets, userAddress),
  ]);

  preloadCache = {
    ca,
    buyTrades,
    tokenDecimals: decimals,
    tokenBalance,
    timestamp: Date.now(),
  };

  console.log('[SolSniper] Preloaded trades for', ca, 'buys:', buyTrades.size);
}

// 检查缓存是否有效
function isCacheValid(ca: string): boolean {
  return (
    preloadCache !== null &&
    preloadCache.ca === ca &&
    Date.now() - preloadCache.timestamp < CACHE_TTL
  );
}

// 执行买入
async function executeBuy(ca: string, amount: number): Promise<string> {
  if (!helius || !jupiter || wallet.isLocked) {
    throw new Error('Wallet locked or not configured');
  }

  let swapTx: string;

  // 检查缓存
  if (isCacheValid(ca) && preloadCache!.buyTrades.has(amount)) {
    console.log('[SolSniper] Using cached trade');
    swapTx = preloadCache!.buyTrades.get(amount)!.swapTx;
  } else {
    // 实时获取
    console.log('[SolSniper] Fetching fresh quote');
    const quote = await jupiter.getBuyQuote(ca, amount);
    const swap = await jupiter.getSwapTransaction(quote, wallet.publicKey);
    swapTx = swap.swapTransaction;
  }

  // 签名
  const signedTx = wallet.signTransaction(swapTx);

  // 发送
  const signature = await helius.sendTransaction(signedTx);
  console.log('[SolSniper] Buy tx sent:', signature);

  // 清除缓存
  preloadCache = null;

  return signature;
}

// 执行卖出
async function executeSell(ca: string, percent: number): Promise<string> {
  if (!helius || !jupiter || wallet.isLocked) {
    throw new Error('Wallet locked or not configured');
  }

  // 获取token余额
  let tokenBalance: number;
  let decimals: number;

  if (isCacheValid(ca)) {
    tokenBalance = preloadCache!.tokenBalance;
    decimals = preloadCache!.tokenDecimals;
  } else {
    [tokenBalance, decimals] = await Promise.all([
      helius.getTokenBalance(wallet.publicKey, ca),
      jupiter.getTokenDecimals(ca),
    ]);
  }

  if (tokenBalance === 0) {
    throw new Error('No token balance');
  }

  // 计算卖出数量
  const sellAmount = (tokenBalance * percent) / 100;

  // 获取报价和交易
  const quote = await jupiter.getSellQuote(ca, sellAmount, decimals);
  const swap = await jupiter.getSwapTransaction(quote, wallet.publicKey);

  // 签名
  const signedTx = wallet.signTransaction(swap.swapTransaction);

  // 发送
  const signature = await helius.sendTransaction(signedTx);
  console.log('[SolSniper] Sell tx sent:', signature);

  // 清除缓存
  preloadCache = null;

  return signature;
}

// 获取钱包状态
async function getWalletState() {
  const state = wallet.getState();
  let balance = 0;

  if (!wallet.isLocked && helius) {
    try {
      balance = await helius.getBalance(state.address);
    } catch (e) {
      console.error('[SolSniper] Failed to get balance:', e);
    }
  }

  return {
    ...state,
    balance,
  };
}

// 消息处理
chrome.runtime.onMessage.addListener(
  (message: Message, sender, sendResponse: (response: MessageResponse) => void) => {
    handleMessage(message)
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true; // 保持消息通道开放
  }
);

async function handleMessage(message: Message): Promise<any> {
  switch (message.type) {
    case 'GET_WALLET_STATE':
      return getWalletState();

    case 'GET_CONFIG':
      return getConfig();

    case 'SAVE_CONFIG':
      await saveConfig(message.payload);
      await updateClients(message.payload);
      return true;

    case 'UNLOCK_WALLET':
      return wallet.unlock(message.payload.password);

    case 'LOCK_WALLET':
      wallet.lock();
      return true;

    case 'PRELOAD_TRADES':
      await preloadTrades(message.payload.ca);
      return {
        ready: true,
        cached: preloadCache?.buyTrades.size || 0,
      };

    case 'EXECUTE_BUY':
      return executeBuy(message.payload.ca, message.payload.amount);

    case 'EXECUTE_SELL':
      return executeSell(message.payload.ca, message.payload.percent);

    case 'GET_TOKEN_BALANCE':
      if (!helius || wallet.isLocked) throw new Error('Not ready');
      return helius.getTokenBalance(wallet.publicKey, message.payload.ca);

    default:
      throw new Error('Unknown message type');
  }
}

// 处理钱包导入 (从popup)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'IMPORT_WALLET') {
    wallet
      .importKey(message.payload.privateKey, message.payload.password)
      .then((address) => sendResponse({ success: true, data: { address } }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

// 初始化
init();

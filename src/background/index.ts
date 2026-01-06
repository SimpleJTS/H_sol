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
  sellTrades: Map<number, { quote: JupiterQuote; swapTx: string }>; // 卖出交易缓存
  tokenDecimals: number;
  tokenBalance: number;
  timestamp: number;
}

let preloadCache: PreloadCache | null = null;
const CACHE_TTL = 10000; // 10秒过期
let cacheRefreshTimer: ReturnType<typeof setInterval> | null = null;
const CACHE_REFRESH_INTERVAL = 8000; // 8秒刷新一次（在过期前刷新）

// 初始化
async function init() {
  try {
    const config = await getConfig();
    if (config.heliusApiKey) {
      helius = new HeliusClient(config.heliusApiKey);
      jupiter = new JupiterClient(config.jupiterApiKey || '', config.slippage, config.priorityFee);
    }
    
    // 检查是否有存储的钱包，如果有则自动解锁
    const hasWallet = await wallet.hasStoredWallet();
    if (hasWallet) {
      const unlocked = await wallet.autoUnlock();
      if (unlocked) {
        console.log('[SolSniper] 钱包已自动恢复');
      } else {
        console.warn('[SolSniper] 钱包恢复失败，请重新导入');
      }
    }
    
    // 自动锁定功能已禁用
    wallet.setAutoLock(0);
    console.log('[SolSniper] Background initialized');
  } catch (error) {
    console.error('[SolSniper] 初始化失败:', error);
  }
}

// 更新客户端配置
async function updateClients(config: Config) {
  if (config.heliusApiKey) {
    helius = new HeliusClient(config.heliusApiKey);
  }
  if (jupiter) {
    jupiter.updateSettings(config.jupiterApiKey || '', config.slippage, config.priorityFee);
  } else if (config.heliusApiKey) {
    jupiter = new JupiterClient(config.jupiterApiKey || '', config.slippage, config.priorityFee);
  }
  // 自动锁定功能已禁用
  wallet.setAutoLock(0);
}

// 设置缓存定时刷新
function setupCacheRefresh(ca: string) {
  // 清除之前的定时器
  if (cacheRefreshTimer) {
    clearInterval(cacheRefreshTimer);
    cacheRefreshTimer = null;
  }

  // 设置新的定时器，在缓存过期前刷新
  cacheRefreshTimer = setInterval(async () => {
    // 检查缓存是否还存在且CA匹配
    if (preloadCache && preloadCache.ca === ca) {
      const age = Date.now() - preloadCache.timestamp;
      if (age < CACHE_TTL) {
        console.log('[SolSniper] 定时刷新缓存，当前缓存年龄:', age, 'ms');
        try {
          // 重新预加载（静默刷新，不抛出错误）
          await preloadTrades(ca);
        } catch (error: any) {
          console.warn('[SolSniper] 定时刷新缓存失败:', error.message || error);
          // 刷新失败不影响现有缓存
        }
      } else {
        console.log('[SolSniper] 缓存已过期，清除定时器');
        if (cacheRefreshTimer) {
          clearInterval(cacheRefreshTimer);
          cacheRefreshTimer = null;
        }
      }
    } else {
      // 缓存不存在或CA不匹配，清除定时器
      console.log('[SolSniper] 缓存不存在或CA不匹配，清除定时器');
      if (cacheRefreshTimer) {
        clearInterval(cacheRefreshTimer);
        cacheRefreshTimer = null;
      }
    }
  }, CACHE_REFRESH_INTERVAL);

  console.log('[SolSniper] 已设置缓存定时刷新，间隔:', CACHE_REFRESH_INTERVAL, 'ms');
}

// 清除缓存刷新定时器
function clearCacheRefresh() {
  if (cacheRefreshTimer) {
    clearInterval(cacheRefreshTimer);
    cacheRefreshTimer = null;
    console.log('[SolSniper] 已清除缓存刷新定时器');
  }
}

// 预加载交易
async function preloadTrades(ca: string): Promise<void> {
  const startTime = performance.now();
  try {
    console.log('[SolSniper] ========== 开始预加载交易 ==========');
    console.log('[SolSniper] CA:', ca);
    console.log('[SolSniper] 钱包地址:', wallet.publicKey);
    
    if (!helius || !jupiter) {
      throw new Error('Not ready');
    }

    const config = await getConfig();
    const userAddress = wallet.publicKey;
    console.log('[SolSniper] 买入预设金额:', config.buyPresets);
    console.log('[SolSniper] 卖出预设百分比:', config.sellPresets);

    // 并行获取基础数据
    const fetchStart = performance.now();
    const [decimals, tokenBalance, buyTrades] = await Promise.all([
      jupiter.getTokenDecimals(ca),
      helius.getTokenBalance(userAddress, ca).catch((error) => {
        console.error('[SolSniper] 获取token余额失败:', error);
        return 0;
      }),
      jupiter.preloadBuyTrades(ca, config.buyPresets, userAddress),
    ]);
    const fetchTime = performance.now() - fetchStart;

    // 如果token有余额，预加载卖出交易
    let sellTrades = new Map<number, { quote: JupiterQuote; swapTx: string }>();
    if (tokenBalance > 0) {
      console.log('[SolSniper] Token有余额，开始预加载卖出交易...');
      const sellStart = performance.now();
      try {
        // 获取原始余额用于计算卖出数量
        const rawTokenBalance = await helius.getRawTokenBalance(userAddress, ca);
        sellTrades = await jupiter.preloadSellTrades(ca, config.sellPresets, decimals, rawTokenBalance, userAddress);
        const sellTime = performance.now() - sellStart;
        console.log('[SolSniper] ✓ 卖出交易预加载完成，耗时:', sellTime.toFixed(2), 'ms, 成功数:', sellTrades.size);
      } catch (error: any) {
        console.warn('[SolSniper] 卖出交易预加载失败:', error.message || error);
        // 卖出预加载失败不影响整体流程
      }
    } else {
      console.log('[SolSniper] Token余额为0，跳过卖出交易预加载');
    }

    preloadCache = {
      ca,
      buyTrades,
      sellTrades,
      tokenDecimals: decimals,
      tokenBalance,
      timestamp: Date.now(),
    };

    const totalTime = performance.now() - startTime;
    console.log('[SolSniper] ========== 预加载完成 ==========');
    console.log('[SolSniper] Token精度:', decimals);
    console.log('[SolSniper] Token余额:', tokenBalance);
    console.log('[SolSniper] 预加载买入交易数:', buyTrades.size);
    console.log('[SolSniper] 预加载卖出交易数:', sellTrades.size);
    console.log('[SolSniper] 数据获取耗时:', fetchTime.toFixed(2), 'ms');
    console.log('[SolSniper] 总耗时:', totalTime.toFixed(2), 'ms');
    console.log('[SolSniper] ====================================');

    // 设置定时刷新缓存
    setupCacheRefresh(ca);
  } catch (error: any) {
    const totalTime = performance.now() - startTime;
    console.error('[SolSniper] ========== 预加载失败 ==========');
    console.error('[SolSniper] 错误:', error.message || error);
    console.error('[SolSniper] 失败耗时:', totalTime.toFixed(2), 'ms');
    console.error('[SolSniper] ====================================');
    throw error;
  }
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
  const startTime = performance.now();
  const timings: Record<string, number> = {};
  
  try {
    console.log('[SolSniper] ========== 开始买入交易 ==========');
    console.log('[SolSniper] CA:', ca);
    console.log('[SolSniper] 买入金额:', amount, 'SOL');
    console.log('[SolSniper] 钱包地址:', wallet.publicKey);
    
    if (!helius || !jupiter) {
      throw new Error('Wallet not configured');
    }

    let swapTx: string;
    let stepStart: number;

    // 检查缓存
    if (isCacheValid(ca) && preloadCache!.buyTrades.has(amount)) {
      console.log('[SolSniper] ✓ 使用缓存的交易数据');
      swapTx = preloadCache!.buyTrades.get(amount)!.swapTx;
      timings['使用缓存'] = 0;
    } else {
      // 实时获取
      console.log('[SolSniper] → 获取买入报价...');
      stepStart = performance.now();
      const quote = await jupiter.getBuyQuote(ca, amount);
      timings['获取报价'] = performance.now() - stepStart;
      console.log('[SolSniper] ✓ 报价获取成功，耗时:', timings['获取报价'].toFixed(2), 'ms');
      
      console.log('[SolSniper] → 构建交易...');
      stepStart = performance.now();
      const swap = await jupiter.getSwapTransaction(quote, wallet.publicKey);
      timings['构建交易'] = performance.now() - stepStart;
      console.log('[SolSniper] ✓ 交易构建成功，耗时:', timings['构建交易'].toFixed(2), 'ms');
      swapTx = swap.swapTransaction;
    }

    // 签名
    console.log('[SolSniper] → 签名交易...');
    stepStart = performance.now();
    const signedTx = wallet.signTransaction(swapTx);
    timings['签名交易'] = performance.now() - stepStart;
    console.log('[SolSniper] ✓ 交易签名成功，耗时:', timings['签名交易'].toFixed(2), 'ms');
    console.log('[SolSniper] 签名后交易长度:', signedTx.length, '字符');

    // 发送
    console.log('[SolSniper] → 发送交易到链上...');
    stepStart = performance.now();
    const signature = await helius.sendTransaction(signedTx);
    timings['发送交易'] = performance.now() - stepStart;
    console.log('[SolSniper] ✓ 交易发送成功，耗时:', timings['发送交易'].toFixed(2), 'ms');
    
    const totalTime = performance.now() - startTime;
    timings['总耗时'] = totalTime;
    
    console.log('[SolSniper] ========== 买入交易完成 ==========');
    console.log('[SolSniper] 交易签名:', signature);
    console.log('[SolSniper] 性能统计:', {
      ...timings,
      '总耗时': totalTime.toFixed(2) + 'ms',
      '平均速度': (totalTime / Object.keys(timings).length).toFixed(2) + 'ms/步骤'
    });
    console.log('[SolSniper] ====================================');

    // 清除缓存和定时器
    clearCacheRefresh();
    preloadCache = null;

    return signature;
  } catch (error: any) {
    const totalTime = performance.now() - startTime;
    console.error('[SolSniper] ========== 买入交易失败 ==========');
    console.error('[SolSniper] 错误信息:', error.message || error);
    console.error('[SolSniper] 失败耗时:', totalTime.toFixed(2), 'ms');
    console.error('[SolSniper] 已完成的步骤:', timings);
    console.error('[SolSniper] ====================================');
    throw error;
  }
}

// 执行卖出
async function executeSell(ca: string, percent: number): Promise<string> {
  const startTime = performance.now();
  const timings: Record<string, number> = {};
  
  try {
    console.log('[SolSniper] ========== 开始卖出交易 ==========');
    console.log('[SolSniper] CA:', ca);
    console.log('[SolSniper] 卖出百分比:', percent + '%');
    console.log('[SolSniper] 钱包地址:', wallet.publicKey);
    
    if (!helius || !jupiter) {
      throw new Error('Wallet not configured');
    }

    // 检查缓存中是否有预加载的卖出交易
    let swapTx: string;
    let stepStart: number;

    if (isCacheValid(ca) && preloadCache!.sellTrades.has(percent)) {
      console.log('[SolSniper] ✓ 使用缓存的卖出交易数据');
      swapTx = preloadCache!.sellTrades.get(percent)!.swapTx;
      timings['使用缓存'] = 0;
    } else {
      // 获取token余额
      let tokenBalance: number;
      let decimals: number;

      if (isCacheValid(ca)) {
        console.log('[SolSniper] ✓ 使用缓存的余额和精度信息');
        tokenBalance = preloadCache!.tokenBalance;
        decimals = preloadCache!.tokenDecimals;
        timings['获取余额(缓存)'] = 0;
      } else {
        console.log('[SolSniper] → 获取Token余额和精度...');
        stepStart = performance.now();
        [tokenBalance, decimals] = await Promise.all([
          helius.getTokenBalance(wallet.publicKey, ca),
          jupiter.getTokenDecimals(ca),
        ]);
        timings['获取余额'] = performance.now() - stepStart;
        console.log('[SolSniper] ✓ 余额获取成功，耗时:', timings['获取余额'].toFixed(2), 'ms');
        console.log('[SolSniper]   余额:', tokenBalance, '精度:', decimals);
      }

      if (tokenBalance === 0) {
        throw new Error('No token balance');
      }

      // 计算卖出数量
      // 为了避免精度丢失，使用原始余额（最小单位）来计算百分比
      // 然后转换为 UI 数量传递给 Jupiter API
      
      // 获取原始余额（最小单位）
      console.log('[SolSniper] → 获取原始余额（用于精确计算）...');
      stepStart = performance.now();
      const rawTokenBalance = await helius.getRawTokenBalance(wallet.publicKey, ca);
      timings['获取原始余额'] = performance.now() - stepStart;
      console.log('[SolSniper] ✓ 原始余额获取成功，耗时:', timings['获取原始余额'].toFixed(2), 'ms');
      
      if (rawTokenBalance === 0) {
        throw new Error('No token balance');
      }
      
      // 计算卖出百分比对应的原始数量（使用整数运算避免精度问题）
      const rawSellAmount = Math.floor((rawTokenBalance * percent) / 100);
      
      if (rawSellAmount === 0) {
        throw new Error('卖出数量太小，无法交易');
      }
      
      // 转换为 UI 数量（用于显示和日志）
      const sellAmount = rawSellAmount / Math.pow(10, decimals);
      
      console.log('[SolSniper] 卖出计算详情:', {
        'UI余额': tokenBalance,
        '原始余额': rawTokenBalance.toString(),
        '卖出百分比': percent + '%',
        '原始卖出数量': rawSellAmount.toString(),
        'UI卖出数量': sellAmount,
        '精度': decimals,
      });

      // 获取报价和交易（传入 UI 数量，内部会转换为原始数量）
      console.log('[SolSniper] → 获取卖出报价...');
      stepStart = performance.now();
      const quote = await jupiter.getSellQuote(ca, sellAmount, decimals);
      timings['获取报价'] = performance.now() - stepStart;
      console.log('[SolSniper] ✓ 报价获取成功，耗时:', timings['获取报价'].toFixed(2), 'ms');
      
      console.log('[SolSniper] → 构建交易...');
      stepStart = performance.now();
      const swap = await jupiter.getSwapTransaction(quote, wallet.publicKey);
      timings['构建交易'] = performance.now() - stepStart;
      console.log('[SolSniper] ✓ 交易构建成功，耗时:', timings['构建交易'].toFixed(2), 'ms');
      swapTx = swap.swapTransaction;
    }

    // 签名
    console.log('[SolSniper] → 签名交易...');
    stepStart = performance.now();
    const signedTx = wallet.signTransaction(swapTx);
    timings['签名交易'] = performance.now() - stepStart;
    console.log('[SolSniper] ✓ 交易签名成功，耗时:', timings['签名交易'].toFixed(2), 'ms');
    console.log('[SolSniper] 签名后交易长度:', signedTx.length, '字符');

    // 发送
    console.log('[SolSniper] → 发送交易到链上...');
    stepStart = performance.now();
    const signature = await helius.sendTransaction(signedTx);
    timings['发送交易'] = performance.now() - stepStart;
    console.log('[SolSniper] ✓ 交易发送成功，耗时:', timings['发送交易'].toFixed(2), 'ms');
    
    const totalTime = performance.now() - startTime;
    timings['总耗时'] = totalTime;
    
    console.log('[SolSniper] ========== 卖出交易完成 ==========');
    console.log('[SolSniper] 交易签名:', signature);
    console.log('[SolSniper] 性能统计:', {
      ...timings,
      '总耗时': totalTime.toFixed(2) + 'ms',
      '平均速度': (totalTime / Object.keys(timings).length).toFixed(2) + 'ms/步骤'
    });
    console.log('[SolSniper] ====================================');

    // 清除缓存和定时器
    clearCacheRefresh();
    preloadCache = null;

    return signature;
  } catch (error: any) {
    const totalTime = performance.now() - startTime;
    console.error('[SolSniper] ========== 卖出交易失败 ==========');
    console.error('[SolSniper] 错误信息:', error.message || error);
    console.error('[SolSniper] 失败耗时:', totalTime.toFixed(2), 'ms');
    console.error('[SolSniper] 已完成的步骤:', timings);
    console.error('[SolSniper] ====================================');
    throw error;
  }
}

// 获取钱包状态
async function getWalletState() {
  try {
    const state = wallet.getState();
    let balance = 0;

    // 如果有地址且 helius 已初始化，尝试获取余额
    if (state.address && helius) {
      try {
        balance = await helius.getBalance(state.address);
      } catch (e: any) {
        console.error('[SolSniper] 获取余额失败:', e);
        // 如果获取失败，保持 balance 为 0
      }
    }

    return {
      ...state,
      isLocked: false, // 锁定功能已禁用
      balance,
    };
  } catch (error: any) {
    console.error('[SolSniper] getWalletState 异常:', error);
    throw error;
  }
}

// 消息处理
chrome.runtime.onMessage.addListener(
  (message: Message, sender, sendResponse: (response: MessageResponse) => void) => {
    handleMessage(message)
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => {
        console.error('[SolSniper] 消息处理失败:', message.type, error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // 保持消息通道开放
  }
);

async function handleMessage(message: Message): Promise<any> {
  try {
    switch (message.type) {
      case 'GET_WALLET_STATE':
        return getWalletState();

      case 'GET_CONFIG':
        return getConfig();

      case 'SAVE_CONFIG':
        await saveConfig(message.payload);
        await updateClients(message.payload);
        return true;

      case 'IMPORT_WALLET':
        // 如果已有钱包，先删除旧钱包
        if (wallet.publicKey) {
          await wallet.remove();
        }
        const address = await wallet.importKey(message.payload.privateKey);
        return { address };

      case 'REMOVE_WALLET':
        await wallet.remove();
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
        if (!helius) throw new Error('Not ready');
        return helius.getTokenBalance(wallet.publicKey, message.payload.ca);

      default:
        throw new Error('Unknown message type');
    }
  } catch (error: any) {
    console.error('[SolSniper] handleMessage 错误:', message.type, error);
    throw error;
  }
}

// IMPORT_WALLET 现在由 handleMessage 统一处理

// 初始化
init();

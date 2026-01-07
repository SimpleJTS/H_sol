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
const CACHE_FRESH_THRESHOLD = 5000; // 5秒内认为是新鲜的，可以直接使用
let cacheRefreshTimer: ReturnType<typeof setInterval> | null = null;
const CACHE_REFRESH_INTERVAL = 8000; // 8秒刷新一次（在过期前刷新）

// 日志工具函数 - 同时输出到 background 控制台和页面控制台
function logToPage(level: 'log' | 'warn' | 'error', ...args: any[]) {
  // 输出到 background 控制台
  const consoleMethod = (console as any)[level] || console.log;
  consoleMethod('[SolSniper]', ...args);
  
  // 发送到 content script，输出到页面控制台
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'LOG',
          payload: { level, args }
        }).catch(() => {
          // 忽略错误（可能 content script 未加载）
        });
      }
    });
  });
}

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
        logToPage('log', '钱包已自动恢复');
      } else {
        logToPage('warn', '钱包恢复失败，请重新导入');
      }
    }
    
    // 自动锁定功能已禁用
    wallet.setAutoLock(0);
    logToPage('log', 'Background initialized');
  } catch (error) {
    logToPage('error', '初始化失败:', error);
  }
}

// 更新客户端配置
async function updateClients(config: Config) {
  // 如果 Helius API Key 存在，创建或更新 Helius 客户端
  if (config.heliusApiKey && config.heliusApiKey.trim()) {
    helius = new HeliusClient(config.heliusApiKey.trim());
    logToPage('log', 'Helius 客户端已更新');
  } else {
    // 如果 Helius API Key 为空，清除客户端
    helius = null;
    logToPage('warn', 'Helius API Key 为空，已清除客户端');
  }
  
  // 如果 Helius 已配置，创建或更新 Jupiter 客户端
  if (helius) {
    if (jupiter) {
      jupiter.updateSettings(config.jupiterApiKey || '', config.slippage, config.priorityFee);
      logToPage('log', 'Jupiter 客户端设置已更新');
    } else {
      jupiter = new JupiterClient(config.jupiterApiKey || '', config.slippage, config.priorityFee);
      logToPage('log', 'Jupiter 客户端已创建');
    }
  } else {
    // 如果 Helius 未配置，清除 Jupiter 客户端
    jupiter = null;
    logToPage('warn', 'Helius 未配置，已清除 Jupiter 客户端');
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
        logToPage('log', '定时刷新缓存，当前缓存年龄:', age, 'ms');
        try {
          // 重新预加载（静默刷新，不抛出错误）
          await preloadTrades(ca);
        } catch (error: any) {
          logToPage('warn', '定时刷新缓存失败:', error.message || error);
          // 刷新失败不影响现有缓存
        }
      } else {
        logToPage('log', '缓存已过期，清除定时器');
        if (cacheRefreshTimer) {
          clearInterval(cacheRefreshTimer);
          cacheRefreshTimer = null;
        }
      }
    } else {
      // 缓存不存在或CA不匹配，清除定时器
      logToPage('log', '缓存不存在或CA不匹配，清除定时器');
      if (cacheRefreshTimer) {
        clearInterval(cacheRefreshTimer);
        cacheRefreshTimer = null;
      }
    }
  }, CACHE_REFRESH_INTERVAL);

  logToPage('log', '已设置缓存定时刷新，间隔:', CACHE_REFRESH_INTERVAL, 'ms');
}

// 清除缓存刷新定时器
function clearCacheRefresh() {
  if (cacheRefreshTimer) {
    clearInterval(cacheRefreshTimer);
    cacheRefreshTimer = null;
    logToPage('log', '已清除缓存刷新定时器');
  }
}

// 预加载交易
async function preloadTrades(ca: string): Promise<void> {
  const startTime = performance.now();
  try {
    logToPage('log', '========== 开始预加载交易 ==========');
    logToPage('log', 'CA:', ca);
    logToPage('log', '钱包地址:', wallet.publicKey);
    
    // 检查并确保客户端已初始化
    if (!helius || !jupiter) {
      logToPage('warn', '客户端未初始化，尝试重新初始化...');
      const config = await getConfig();
      await updateClients(config);
      
      if (!helius || !jupiter) {
        throw new Error('Not ready: 请检查 Helius API Key 和 Jupiter API Key 是否正确配置');
      }
      logToPage('log', '客户端重新初始化成功');
    }

    const config = await getConfig();
    
    // 如果禁用缓存，跳过预加载
    if (config.enableCache === false) {
      logToPage('log', '缓存已禁用，跳过预加载');
      return;
    }
    const userAddress = wallet.publicKey;
    logToPage('log', '买入预设金额:', config.buyPresets);
    logToPage('log', '卖出预设百分比:', config.sellPresets);

    // 并行获取基础数据
    const fetchStart = performance.now();
    const [decimals, tokenBalance, buyTrades] = await Promise.all([
      jupiter.getTokenDecimals(ca),
      helius.getTokenBalance(userAddress, ca).catch((error) => {
        logToPage('error', '获取token余额失败:', error);
        return 0;
      }),
      jupiter.preloadBuyTrades(ca, config.buyPresets, userAddress),
    ]);
    const fetchTime = performance.now() - fetchStart;

    // 如果token有余额，预加载卖出交易
    // 注意：每次预加载都会重新获取最新的余额，确保数量准确
    let sellTrades = new Map<number, { quote: JupiterQuote; swapTx: string }>();
    if (tokenBalance > 0) {
      logToPage('log', 'Token有余额，开始预加载卖出交易...');
      logToPage('log', '当前Token余额:', tokenBalance, '(将使用最新余额预加载)');
      const sellStart = performance.now();
      try {
        // 重新获取原始余额用于计算卖出数量（确保使用最新余额）
        // 即使之前已经获取过，这里也要重新获取，因为余额可能已经变化
        const rawTokenBalance = await helius.getRawTokenBalance(userAddress, ca);
        logToPage('log', '最新原始余额:', rawTokenBalance.toString(), '(用于预加载卖出交易)');
        sellTrades = await jupiter.preloadSellTrades(ca, config.sellPresets, decimals, rawTokenBalance, userAddress);
        const sellTime = performance.now() - sellStart;
        logToPage('log', '✓ 卖出交易预加载完成，耗时:', sellTime.toFixed(2), 'ms, 成功数:', sellTrades.size);
      } catch (error: any) {
        logToPage('warn', '卖出交易预加载失败:', error.message || error);
        // 卖出预加载失败不影响整体流程
      }
    } else {
      logToPage('log', 'Token余额为0，跳过卖出交易预加载');
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
    logToPage('log', '========== 预加载完成 ==========');
    logToPage('log', 'Token精度:', decimals);
    logToPage('log', 'Token余额:', tokenBalance);
    logToPage('log', '预加载买入交易数:', buyTrades.size);
    logToPage('log', '预加载卖出交易数:', sellTrades.size);
    logToPage('log', '数据获取耗时:', fetchTime.toFixed(2), 'ms');
    logToPage('log', '总耗时:', totalTime.toFixed(2), 'ms');
    logToPage('log', '====================================');

    // 设置定时刷新缓存
    setupCacheRefresh(ca);
  } catch (error: any) {
    const totalTime = performance.now() - startTime;
    logToPage('error', '========== 预加载失败 ==========');
    logToPage('error', '错误:', error.message || error);
    logToPage('error', '失败耗时:', totalTime.toFixed(2), 'ms');
    logToPage('error', '====================================');
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
    logToPage('log', '========== 开始买入交易 ==========');
    logToPage('log', 'CA:', ca);
    logToPage('log', '买入金额:', amount, 'SOL');
    logToPage('log', '钱包地址:', wallet.publicKey);
    
    // 检查并确保客户端已初始化
    if (!helius || !jupiter) {
      logToPage('warn', '客户端未初始化，尝试重新初始化...');
      const config = await getConfig();
      await updateClients(config);
      
      if (!helius || !jupiter) {
        throw new Error('Wallet not configured: 请检查 Helius API Key 和 Jupiter API Key 是否正确配置');
      }
      logToPage('log', '客户端重新初始化成功');
    }

    let swapTx: string = '';
    let stepStart: number;
    let useCache = false;

    // 检查配置是否启用缓存
    const config = await getConfig();
    const cacheEnabled = config.enableCache !== false; // 默认 true

    // 检查缓存 - 只有在缓存新鲜时才使用（避免交易过期）
    if (cacheEnabled && isCacheValid(ca) && preloadCache!.buyTrades.has(amount)) {
      const cacheAge = Date.now() - preloadCache!.timestamp;
      if (cacheAge < CACHE_FRESH_THRESHOLD) {
        // 缓存新鲜，直接使用
        logToPage('log', '✓ 使用缓存的交易数据（缓存年龄:', cacheAge, 'ms）');
        swapTx = preloadCache!.buyTrades.get(amount)!.swapTx;
        timings['使用缓存'] = 0;
        useCache = true;
      } else {
        // 缓存不够新鲜，重新获取报价和构建交易（确保交易有效）
        logToPage('log', '⚠ 缓存不够新鲜（年龄:', cacheAge, 'ms），重新获取交易');
      }
    } else if (!cacheEnabled) {
      logToPage('log', '缓存已禁用，实时获取交易');
    }

    if (!useCache) {
      // 实时获取
      logToPage('log', '→ 获取买入报价...');
      stepStart = performance.now();
      const quote = await jupiter.getBuyQuote(ca, amount);
      timings['获取报价'] = performance.now() - stepStart;
      logToPage('log', '✓ 报价获取成功，耗时:', timings['获取报价'].toFixed(2), 'ms');
      
      logToPage('log', '→ 构建交易...');
      stepStart = performance.now();
      const swap = await jupiter.getSwapTransaction(quote, wallet.publicKey);
      timings['构建交易'] = performance.now() - stepStart;
      logToPage('log', '✓ 交易构建成功，耗时:', timings['构建交易'].toFixed(2), 'ms');
      swapTx = swap.swapTransaction;
    }

    // 签名
    logToPage('log', '→ 签名交易...');
    stepStart = performance.now();
    let signedTx: string;
    try {
      signedTx = wallet.signTransaction(swapTx);
      timings['签名交易'] = performance.now() - stepStart;
      logToPage('log', '✓ 交易签名成功，耗时:', timings['签名交易'].toFixed(2), 'ms');
      logToPage('log', '签名后交易长度:', signedTx.length, '字符');
    } catch (signError: any) {
      // 如果签名失败且使用了缓存，可能是交易过期，尝试重新获取
      if (useCache) {
        logToPage('warn', '⚠ 缓存交易签名失败，可能是交易过期，重新获取交易...');
        logToPage('warn', '错误:', signError.message || signError);
        
        // 重新获取报价和构建交易
        logToPage('log', '→ 重新获取买入报价...');
        stepStart = performance.now();
        const quote = await jupiter.getBuyQuote(ca, amount);
        timings['获取报价(重试)'] = performance.now() - stepStart;
        logToPage('log', '✓ 报价获取成功，耗时:', timings['获取报价(重试)'].toFixed(2), 'ms');
        
        logToPage('log', '→ 重新构建交易...');
        stepStart = performance.now();
        const swap = await jupiter.getSwapTransaction(quote, wallet.publicKey);
        timings['构建交易(重试)'] = performance.now() - stepStart;
        logToPage('log', '✓ 交易构建成功，耗时:', timings['构建交易(重试)'].toFixed(2), 'ms');
        swapTx = swap.swapTransaction;
        
        // 重新签名
        stepStart = performance.now();
        signedTx = wallet.signTransaction(swapTx);
        timings['签名交易(重试)'] = performance.now() - stepStart;
        logToPage('log', '✓ 交易签名成功，耗时:', timings['签名交易(重试)'].toFixed(2), 'ms');
      } else {
        throw signError;
      }
    }

    // 发送
    logToPage('log', '→ 发送交易到链上...');
    stepStart = performance.now();
    let signature: string;
    try {
      signature = await helius.sendTransaction(signedTx);
      timings['发送交易'] = performance.now() - stepStart;
      logToPage('log', '✓ 交易发送成功，耗时:', timings['发送交易'].toFixed(2), 'ms');
    } catch (sendError: any) {
      // 如果发送失败且使用了缓存，可能是交易过期，尝试重新获取
      if (useCache) {
        logToPage('warn', '⚠ 缓存交易发送失败，可能是交易过期，重新获取交易...');
        logToPage('warn', '错误:', sendError.message || sendError);
        
        // 重新获取报价和构建交易
        logToPage('log', '→ 重新获取买入报价...');
        stepStart = performance.now();
        const quote = await jupiter.getBuyQuote(ca, amount);
        timings['获取报价(重试)'] = performance.now() - stepStart;
        logToPage('log', '✓ 报价获取成功，耗时:', timings['获取报价(重试)'].toFixed(2), 'ms');
        
        logToPage('log', '→ 重新构建交易...');
        stepStart = performance.now();
        const swap = await jupiter.getSwapTransaction(quote, wallet.publicKey);
        timings['构建交易(重试)'] = performance.now() - stepStart;
        logToPage('log', '✓ 交易构建成功，耗时:', timings['构建交易(重试)'].toFixed(2), 'ms');
        swapTx = swap.swapTransaction;
        
        // 重新签名
        stepStart = performance.now();
        signedTx = wallet.signTransaction(swapTx);
        timings['签名交易(重试)'] = performance.now() - stepStart;
        logToPage('log', '✓ 交易签名成功，耗时:', timings['签名交易(重试)'].toFixed(2), 'ms');
        
        // 重新发送
        stepStart = performance.now();
        signature = await helius.sendTransaction(signedTx);
        timings['发送交易(重试)'] = performance.now() - stepStart;
        logToPage('log', '✓ 交易发送成功，耗时:', timings['发送交易(重试)'].toFixed(2), 'ms');
      } else {
        throw sendError;
      }
    }
    
    const totalTime = performance.now() - startTime;
    timings['总耗时'] = totalTime;
    
    logToPage('log', '========== 买入交易完成 ==========');
    logToPage('log', '交易签名:', signature);
    logToPage('log', '性能统计:', {
      ...timings,
      '总耗时': totalTime.toFixed(2) + 'ms',
      '平均速度': (totalTime / Object.keys(timings).length).toFixed(2) + 'ms/步骤'
    });
    logToPage('log', '====================================');

    // 清除缓存和定时器
    clearCacheRefresh();
    preloadCache = null;

    return signature;
  } catch (error: any) {
    const totalTime = performance.now() - startTime;
    logToPage('error', '========== 买入交易失败 ==========');
    logToPage('error', '错误信息:', error.message || error);
    logToPage('error', '失败耗时:', totalTime.toFixed(2), 'ms');
    logToPage('error', '已完成的步骤:', timings);
    logToPage('error', '====================================');
    throw error;
  }
}

// 执行卖出
async function executeSell(ca: string, percent: number): Promise<string> {
  const startTime = performance.now();
  const timings: Record<string, number> = {};
  let stepStart: number;
  
  try {
    logToPage('log', '========== 开始卖出交易 ==========');
    logToPage('log', 'CA:', ca);
    logToPage('log', '卖出百分比:', percent + '%');
    logToPage('log', '钱包地址:', wallet.publicKey);
    
    // 检查并确保客户端已初始化
    if (!helius || !jupiter) {
      logToPage('warn', '客户端未初始化，尝试重新初始化...');
      const config = await getConfig();
      await updateClients(config);
      
      if (!helius || !jupiter) {
        throw new Error('Wallet not configured: 请检查 Helius API Key 和 Jupiter API Key 是否正确配置');
      }
      logToPage('log', '客户端重新初始化成功');
    }

    // 卖出时始终获取最新的token余额（因为余额可能在预加载后发生了变化）
    // 即使使用缓存交易，也要重新获取余额以确保数量准确
    logToPage('log', '→ 获取最新Token余额和精度...');
    stepStart = performance.now();
    const [tokenBalance, decimals] = await Promise.all([
      helius.getTokenBalance(wallet.publicKey, ca),
      jupiter.getTokenDecimals(ca),
    ]);
    timings['获取余额'] = performance.now() - stepStart;
    logToPage('log', '✓ 余额获取成功，耗时:', timings['获取余额'].toFixed(2), 'ms');
    logToPage('log', '  最新余额:', tokenBalance, '精度:', decimals);

    if (tokenBalance === 0) {
      throw new Error('No token balance');
    }

    // 获取原始余额（最小单位）用于精确计算
    logToPage('log', '→ 获取最新原始余额（用于精确计算）...');
    stepStart = performance.now();
    const rawTokenBalance = await helius.getRawTokenBalance(wallet.publicKey, ca);
    timings['获取原始余额'] = performance.now() - stepStart;
    logToPage('log', '✓ 原始余额获取成功，耗时:', timings['获取原始余额'].toFixed(2), 'ms');
    logToPage('log', '  最新原始余额:', rawTokenBalance.toString());

    // 检查缓存中是否有预加载的卖出交易
    let swapTx: string = '';
    let useCache = false;

    // 检查配置是否启用缓存
    const config = await getConfig();
    const cacheEnabled = config.enableCache !== false; // 默认 true
    
    // 检查缓存 - 只有在缓存新鲜时才使用（避免交易过期）
    // 但即使使用缓存，也要验证余额是否匹配（如果余额变化太大，应该重新构建交易）
    if (cacheEnabled && isCacheValid(ca) && preloadCache!.sellTrades.has(percent)) {
      const cacheAge = Date.now() - preloadCache!.timestamp;
      const cachedBalance = preloadCache!.tokenBalance;
      const balanceDiff = Math.abs(tokenBalance - cachedBalance);
      const balanceChangePercent = cachedBalance > 0 ? (balanceDiff / cachedBalance) * 100 : 0;
      
      // 如果缓存新鲜且余额变化不大（<5%），可以使用缓存
      if (cacheAge < CACHE_FRESH_THRESHOLD && balanceChangePercent < 5) {
        logToPage('log', '✓ 使用缓存的卖出交易数据（缓存年龄:', cacheAge, 'ms, 余额变化:', balanceChangePercent.toFixed(2) + '%）');
        swapTx = preloadCache!.sellTrades.get(percent)!.swapTx;
        timings['使用缓存'] = 0;
        useCache = true;
      } else {
        if (balanceChangePercent >= 5) {
          logToPage('log', '⚠ 余额变化较大（', balanceChangePercent.toFixed(2) + '%），重新获取交易');
        } else {
          logToPage('log', '⚠ 缓存不够新鲜（年龄:', cacheAge, 'ms），重新获取交易');
        }
      }
    } else if (!cacheEnabled) {
      logToPage('log', '缓存已禁用，实时获取交易');
    }

    if (!useCache) {
      // 计算卖出数量
      // 为了避免精度丢失，使用原始余额（最小单位）来计算百分比
      // 然后转换为 UI 数量传递给 Jupiter API
      
      if (rawTokenBalance === 0) {
        throw new Error('No token balance');
      }
      
      // 计算卖出百分比对应的原始数量（使用整数运算避免精度问题）
      const rawSellAmount = Math.floor((rawTokenBalance * percent) / 100);
      
      if (rawSellAmount === 0) {
        throw new Error('卖出数量太小，无法交易');
      }
      
      // 转换为 UI 数量（用于显示和日志）
      // 注意：这里使用精确的除法，但传递给 Jupiter 时应该使用原始数量
      const sellAmount = rawSellAmount / Math.pow(10, decimals);
      
      logToPage('log', '卖出计算详情:', {
        'UI余额': tokenBalance,
        '原始余额': rawTokenBalance.toString(),
        '卖出百分比': percent + '%',
        '原始卖出数量': rawSellAmount.toString(),
        'UI卖出数量': sellAmount,
        '精度': decimals,
        '验证': {
          '原始数量转回UI': (rawSellAmount / Math.pow(10, decimals)),
          'UI数量转回原始': Math.floor(sellAmount * Math.pow(10, decimals)).toString(),
          '是否匹配': Math.floor(sellAmount * Math.pow(10, decimals)) === rawSellAmount
        }
      });

      // 获取报价和交易
      // 注意：直接传递原始数量给 getSellQuote，避免精度损失
      logToPage('log', '→ 获取卖出报价...');
      stepStart = performance.now();
      const quote = await jupiter.getSellQuote(ca, sellAmount, decimals);
      timings['获取报价'] = performance.now() - stepStart;
      logToPage('log', '✓ 报价获取成功，耗时:', timings['获取报价'].toFixed(2), 'ms');
      
      // 验证报价中的输入数量是否匹配
      if (quote.inAmount) {
        const quoteInputAmount = BigInt(quote.inAmount);
        const expectedInputAmount = BigInt(rawSellAmount);
        if (quoteInputAmount !== expectedInputAmount) {
          logToPage('warn', '⚠ 报价输入数量不匹配:', {
            '期望': expectedInputAmount.toString(),
            '实际': quoteInputAmount.toString(),
            '差异': (quoteInputAmount - expectedInputAmount).toString()
          });
        }
      }
      
      logToPage('log', '→ 构建交易...');
      stepStart = performance.now();
      const swap = await jupiter.getSwapTransaction(quote, wallet.publicKey);
      timings['构建交易'] = performance.now() - stepStart;
      logToPage('log', '✓ 交易构建成功，耗时:', timings['构建交易'].toFixed(2), 'ms');
      swapTx = swap.swapTransaction;
    }

    // 签名
    logToPage('log', '→ 签名交易...');
    stepStart = performance.now();
    let signedTx: string;
    try {
      signedTx = wallet.signTransaction(swapTx);
      timings['签名交易'] = performance.now() - stepStart;
      logToPage('log', '✓ 交易签名成功，耗时:', timings['签名交易'].toFixed(2), 'ms');
      logToPage('log', '签名后交易长度:', signedTx.length, '字符');
    } catch (signError: any) {
      // 如果签名失败且使用了缓存，可能是交易过期，尝试重新获取
      if (useCache) {
        logToPage('warn', '⚠ 缓存卖出交易签名失败，可能是交易过期，重新获取交易...');
        logToPage('warn', '错误:', signError.message || signError);
        
        // 重新获取余额和计算卖出数量
        logToPage('log', '→ 重新获取Token余额和精度...');
        stepStart = performance.now();
        const [tokenBalance, decimals] = await Promise.all([
          helius.getTokenBalance(wallet.publicKey, ca),
          jupiter.getTokenDecimals(ca),
        ]);
        timings['获取余额(重试)'] = performance.now() - stepStart;
        
        const rawTokenBalance = await helius.getRawTokenBalance(wallet.publicKey, ca);
        const rawSellAmount = Math.floor((rawTokenBalance * percent) / 100);
        const sellAmount = rawSellAmount / Math.pow(10, decimals);
        
        // 重新获取报价和构建交易
        logToPage('log', '→ 重新获取卖出报价...');
        stepStart = performance.now();
        const quote = await jupiter.getSellQuote(ca, sellAmount, decimals);
        timings['获取报价(重试)'] = performance.now() - stepStart;
        
        logToPage('log', '→ 重新构建交易...');
        stepStart = performance.now();
        const swap = await jupiter.getSwapTransaction(quote, wallet.publicKey);
        timings['构建交易(重试)'] = performance.now() - stepStart;
        swapTx = swap.swapTransaction;
        
        // 重新签名
        stepStart = performance.now();
        signedTx = wallet.signTransaction(swapTx);
        timings['签名交易(重试)'] = performance.now() - stepStart;
        logToPage('log', '✓ 交易签名成功，耗时:', timings['签名交易(重试)'].toFixed(2), 'ms');
      } else {
        throw signError;
      }
    }

    // 发送
    logToPage('log', '→ 发送交易到链上...');
    stepStart = performance.now();
    let signature: string;
    try {
      signature = await helius.sendTransaction(signedTx);
      timings['发送交易'] = performance.now() - stepStart;
      logToPage('log', '✓ 交易发送成功，耗时:', timings['发送交易'].toFixed(2), 'ms');
    } catch (sendError: any) {
      // 如果发送失败且使用了缓存，可能是交易过期，尝试重新获取
      if (useCache) {
        logToPage('warn', '⚠ 缓存卖出交易发送失败，可能是交易过期，重新获取交易...');
        logToPage('warn', '错误:', sendError.message || sendError);
        
        // 重新获取余额和计算卖出数量
        logToPage('log', '→ 重新获取Token余额和精度...');
        stepStart = performance.now();
        const [tokenBalance, decimals] = await Promise.all([
          helius.getTokenBalance(wallet.publicKey, ca),
          jupiter.getTokenDecimals(ca),
        ]);
        timings['获取余额(重试)'] = performance.now() - stepStart;
        
        const rawTokenBalance = await helius.getRawTokenBalance(wallet.publicKey, ca);
        const rawSellAmount = Math.floor((rawTokenBalance * percent) / 100);
        const sellAmount = rawSellAmount / Math.pow(10, decimals);
        
        // 重新获取报价和构建交易
        logToPage('log', '→ 重新获取卖出报价...');
        stepStart = performance.now();
        const quote = await jupiter.getSellQuote(ca, sellAmount, decimals);
        timings['获取报价(重试)'] = performance.now() - stepStart;
        
        logToPage('log', '→ 重新构建交易...');
        stepStart = performance.now();
        const swap = await jupiter.getSwapTransaction(quote, wallet.publicKey);
        timings['构建交易(重试)'] = performance.now() - stepStart;
        swapTx = swap.swapTransaction;
        
        // 重新签名
        stepStart = performance.now();
        signedTx = wallet.signTransaction(swapTx);
        timings['签名交易(重试)'] = performance.now() - stepStart;
        
        // 重新发送
        stepStart = performance.now();
        signature = await helius.sendTransaction(signedTx);
        timings['发送交易(重试)'] = performance.now() - stepStart;
        logToPage('log', '✓ 交易发送成功，耗时:', timings['发送交易(重试)'].toFixed(2), 'ms');
      } else {
        throw sendError;
      }
    }
    
    const totalTime = performance.now() - startTime;
    timings['总耗时'] = totalTime;
    
    logToPage('log', '========== 卖出交易完成 ==========');
    logToPage('log', '交易签名:', signature);
    logToPage('log', '性能统计:', {
      ...timings,
      '总耗时': totalTime.toFixed(2) + 'ms',
      '平均速度': (totalTime / Object.keys(timings).length).toFixed(2) + 'ms/步骤'
    });
    logToPage('log', '====================================');

    // 清除缓存和定时器
    clearCacheRefresh();
    preloadCache = null;

    return signature;
  } catch (error: any) {
    const totalTime = performance.now() - startTime;
    logToPage('error', '========== 卖出交易失败 ==========');
    logToPage('error', '错误信息:', error.message || error);
    logToPage('error', '失败耗时:', totalTime.toFixed(2), 'ms');
    logToPage('error', '已完成的步骤:', timings);
    logToPage('error', '====================================');
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
        logToPage('error', '获取余额失败:', e);
        // 如果获取失败，保持 balance 为 0
      }
    }

    return {
      ...state,
      isLocked: false, // 锁定功能已禁用
      balance,
    };
  } catch (error: any) {
    logToPage('error', 'getWalletState 异常:', error);
    throw error;
  }
}

// 消息处理
chrome.runtime.onMessage.addListener(
  (message: Message, sender, sendResponse: (response: MessageResponse) => void) => {
    handleMessage(message)
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => {
        logToPage('error', '消息处理失败:', message.type, error);
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
    logToPage('error', 'handleMessage 错误:', message.type, error);
    throw error;
  }
}

// IMPORT_WALLET 现在由 handleMessage 统一处理

// 初始化
init();

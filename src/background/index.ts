import { HeliusClient } from './helius';
import { PumpClient } from './pump';
import { RaydiumClient } from './raydium';
import { JitoClient, BundleStatus } from './jito';
import { WalletManager } from './wallet';
import { getConfig, saveConfig } from '../shared/storage';
import { Message, MessageResponse, Config, PreloadedTrade } from '../shared/types';
import { Transaction, VersionedTransaction, Connection, PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import bs58 from 'bs58';

// 全局实例
let helius: HeliusClient | null = null;
let pump: PumpClient | null = null;
let raydium: RaydiumClient | null = null;
let jito: JitoClient | null = null;
const wallet = new WalletManager();

// 预加载缓存
interface PreloadCache {
  ca: string;
  buyTrades: Map<number, { transaction: Transaction | VersionedTransaction }>;
  sellTrades: Map<number, { transaction: Transaction | VersionedTransaction }>; // 卖出交易缓存
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

// 判断 Token 类型（Pump 或 Raydium）
async function getTokenType(ca: string): Promise<'pump' | 'raydium'> {
  if (!helius) {
    return 'raydium'; // 默认返回 raydium
  }

  try {
    const mint = new PublicKey(ca);
    const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    
    // 尝试找到 bonding curve
    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mint.toBuffer()],
      PUMP_PROGRAM
    );
    
    const connection = new Connection(helius.rpcUrl, 'confirmed');
    const info = await connection.getAccountInfo(bondingCurve);
    
    if (!info) {
      logToPage('log', '[Market] 未找到 bonding curve，使用 Raydium');
      return 'raydium'; // 没有 bonding curve，使用 Raydium
    }
    
    // 检查数据长度
    let curveData: Buffer;
    if (Buffer.isBuffer(info.data)) {
      curveData = info.data;
    } else if (typeof info.data === 'string') {
      curveData = Buffer.from(info.data, 'base64');
    } else if (Array.isArray(info.data)) {
      curveData = Buffer.from(info.data);
    } else {
      logToPage('log', '[Market] Bonding curve 数据格式无效，使用 Raydium');
      return 'raydium';
    }
    
    // 如果数据长度为 0 或太短，不是有效的 Pump.fun token
    if (curveData.length < 24) {
      logToPage('log', '[Market] Bonding curve 数据太短，使用 Raydium');
      return 'raydium';
    }
    
    // 检查 bonding curve 的状态
    // data[64] === 1 表示已迁移到 Raydium
    if (curveData.length > 64) {
      return curveData[64] === 1 ? 'raydium' : 'pump';
    }
    
    return 'pump';
  } catch (error) {
    logToPage('warn', '[Market] 检测市场类型失败，使用 Raydium:', error);
    return 'raydium'; // 检测失败，使用 Raydium
  }
}

// 初始化
async function init() {
  try {
  const config = await getConfig();
  if (config.heliusApiKey) {
    helius = new HeliusClient(config.heliusApiKey);
      const rpcUrl = helius.rpcUrl || `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
      pump = new PumpClient(rpcUrl, config.priorityFee, config.slippage);
      raydium = new RaydiumClient(rpcUrl, config.priorityFee);
      
      // 初始化 Jito 客户端
      if (config.useJito) {
        jito = new JitoClient(rpcUrl, config.jitoTipAccount || '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmxvrDjjF');
        logToPage('log', 'Jito Bundle 客户端已初始化');
      }
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
    const rpcUrl = helius.rpcUrl || `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
    
    // 更新或创建 Pump 和 Raydium 客户端
    pump = new PumpClient(rpcUrl, config.priorityFee, config.slippage);
    raydium = new RaydiumClient(rpcUrl, config.priorityFee);
    
    // 更新或创建 Jito 客户端
    if (config.useJito) {
      jito = new JitoClient(rpcUrl, config.jitoTipAccount || '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmxvrDjjF');
      logToPage('log', 'Jito Bundle 客户端已更新');
    } else {
      jito = null;
    }
    
    logToPage('log', '客户端已更新');
  } else {
    // 如果 Helius API Key 为空，清除所有客户端
    helius = null;
    pump = null;
    raydium = null;
    jito = null;
    logToPage('warn', 'Helius API Key 为空，已清除所有客户端');
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
    if (!helius || !pump || !raydium) {
      logToPage('warn', '客户端未初始化，尝试重新初始化...');
      const config = await getConfig();
      await updateClients(config);
      
      if (!helius || !pump || !raydium) {
        throw new Error('Not ready: 请检查 Helius API Key 是否正确配置');
      }
      logToPage('log', '客户端重新初始化成功');
    }

  const config = await getConfig();
    const tokenType = await getTokenType(ca);
    logToPage('log', '检测到的市场类型:', tokenType);
    
    const usePump = tokenType === 'pump';
    
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
    const [decimals, tokenBalance] = await Promise.all([
      usePump 
        ? pump!.getTokenDecimals(ca)
        : raydium!.getTokenDecimals(ca),
      helius.getTokenBalance(userAddress, ca).catch((error) => {
        logToPage('error', '获取token余额失败:', error);
        return 0;
      }),
    ]);
    
    // 预加载买入交易
    const buyTrades = new Map<number, { transaction: Transaction | VersionedTransaction }>();
    for (const amount of config.buyPresets) {
      try {
        let tx: Transaction | VersionedTransaction;
        if (usePump) {
          tx = await pump!.buildBuyTransaction(ca, amount, userAddress);
        } else {
          // Raydium 直接合约调用
          tx = await raydium!.buildBuyTransaction(ca, amount, userAddress);
        }
        buyTrades.set(amount, { transaction: tx });
      } catch (error: any) {
        logToPage('warn', `预加载买入交易失败 (${amount} SOL):`, error.message);
      }
    }
    
    const fetchTime = performance.now() - fetchStart;

    // 如果token有余额，预加载卖出交易
    let sellTrades = new Map<number, { transaction: Transaction | VersionedTransaction }>();
    if (tokenBalance > 0) {
      logToPage('log', 'Token有余额，开始预加载卖出交易...');
      logToPage('log', '当前Token余额:', tokenBalance);
      const sellStart = performance.now();
      try {
        const rawTokenBalance = await helius.getRawTokenBalance(userAddress, ca);
        for (const percent of config.sellPresets) {
          try {
            const rawSellAmount = Math.floor((rawTokenBalance * percent) / 100);
            if (rawSellAmount > 0) {
              const sellAmount = rawSellAmount / Math.pow(10, decimals);
              let tx: Transaction | VersionedTransaction;
              if (usePump) {
                tx = await pump!.buildSellTransaction(ca, sellAmount, decimals, userAddress);
              } else {
                // Raydium 直接合约调用
                tx = await raydium!.buildSellTransaction(ca, sellAmount, decimals, userAddress);
              }
              sellTrades.set(percent, { transaction: tx });
            }
          } catch (error: any) {
            logToPage('warn', `预加载卖出交易失败 (${percent}%):`, error.message);
          }
        }
        const sellTime = performance.now() - sellStart;
        logToPage('log', '✓ 卖出交易预加载完成，耗时:', sellTime.toFixed(2), 'ms, 成功数:', sellTrades.size);
      } catch (error: any) {
        logToPage('warn', '卖出交易预加载失败:', error.message || error);
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
    if (!helius || !pump || !raydium) {
      logToPage('warn', '客户端未初始化，尝试重新初始化...');
      const config = await getConfig();
      await updateClients(config);
      
      if (!helius || !pump || !raydium) {
        throw new Error('Wallet not configured: 请检查 Helius API Key 是否正确配置');
      }
      logToPage('log', '客户端重新初始化成功');
    }

    const config = await getConfig();
    const tokenType = await getTokenType(ca);
    logToPage('log', '检测到的市场类型:', tokenType);
    
    const usePump = tokenType === 'pump';
    const client = usePump ? pump : raydium;
    
    if (!client) {
      throw new Error(`客户端未初始化: ${tokenType}`);
    }
    
    let transaction: Transaction | VersionedTransaction | null = null;
    let stepStart: number;
    let useCache = false;

    // 检查配置是否启用缓存
    const cacheEnabled = config.enableCache !== false; // 默认 true

    // 检查缓存 - 只有在缓存新鲜时才使用（避免交易过期）
    if (cacheEnabled && isCacheValid(ca) && preloadCache!.buyTrades.has(amount)) {
      const cacheAge = Date.now() - preloadCache!.timestamp;
      if (cacheAge < CACHE_FRESH_THRESHOLD) {
        // 缓存新鲜，直接使用
        logToPage('log', '✓ 使用缓存的交易数据（缓存年龄:', cacheAge, 'ms）');
        transaction = preloadCache!.buyTrades.get(amount)!.transaction;
        timings['使用缓存'] = 0;
        useCache = true;
      } else {
        // 缓存不够新鲜，重新构建交易（确保交易有效）
        logToPage('log', '⚠ 缓存不够新鲜（年龄:', cacheAge, 'ms），重新构建交易');
      }
    } else if (!cacheEnabled) {
      logToPage('log', '缓存已禁用，实时构建交易');
    }

    if (!useCache || !transaction) {
      // 直接合约调用
      logToPage('log', `→ 构建买入交易 (${usePump ? 'Pump.fun' : 'Raydium'})...`);
      stepStart = performance.now();
      transaction = await client.buildBuyTransaction(ca, amount, wallet.publicKey);
      timings['构建交易'] = performance.now() - stepStart;
      logToPage('log', '✓ 交易构建成功，耗时:', timings['构建交易'].toFixed(2), 'ms');
    }

    // 签名
    logToPage('log', '→ 签名交易...');
    stepStart = performance.now();
    
    if (!transaction) {
      throw new Error('交易未构建');
    }
    
    const signedTx = wallet.signTransactionObject(transaction);
    const serialized = signedTx instanceof VersionedTransaction 
      ? signedTx.serialize() 
      : signedTx.serialize();
    const signedTxBase58 = bs58.encode(serialized);
    
    timings['签名交易'] = performance.now() - stepStart;
    logToPage('log', '✓ 交易签名成功，耗时:', timings['签名交易'].toFixed(2), 'ms');

    // 发送交易（使用 Jito Bundle 或直接发送）
    logToPage('log', '→ 发送交易到链上...');
    stepStart = performance.now();
    let signature: string;
    let bundleStatus: BundleStatus | null = null;

    if (config.useJito && jito) {
      // 使用 Jito Bundle 发送
      logToPage('log', '使用 Jito Bundle 发送交易');
      bundleStatus = await jito.sendAndConfirmBundle([signedTxBase58], 30000);
      timings['发送交易'] = performance.now() - stepStart;
      
      // 如果 Jito 限流，降级到直接发送
      if (bundleStatus === null) {
        logToPage('warn', 'Jito Bundle 限流，降级到直接发送交易');
        signature = await helius.sendTransaction(signedTxBase58);
        timings['发送交易'] = performance.now() - stepStart;
        logToPage('log', '✓ 交易发送成功（降级模式），耗时:', timings['发送交易'].toFixed(2), 'ms');
        
        // 轮询确认交易
        logToPage('log', '→ 轮询确认交易...');
        stepStart = performance.now();
        await pollTransactionConfirmation(signature);
        timings['确认交易'] = performance.now() - stepStart;
        logToPage('log', '✓ 交易已确认，耗时:', timings['确认交易'].toFixed(2), 'ms');
      } else if (bundleStatus.status === 'landed' && bundleStatus.transactions && bundleStatus.transactions.length > 0) {
        signature = bundleStatus.transactions[0];
        logToPage('log', '✓ Bundle 已落地，交易签名:', signature);
      } else {
        throw new Error(`Bundle 失败: ${bundleStatus.status} - ${bundleStatus.error || '未知错误'}`);
      }
    } else {
      // 直接发送交易
      signature = await helius.sendTransaction(signedTxBase58);
      timings['发送交易'] = performance.now() - stepStart;
      logToPage('log', '✓ 交易发送成功，耗时:', timings['发送交易'].toFixed(2), 'ms');
      
      // 轮询确认交易
      logToPage('log', '→ 轮询确认交易...');
      stepStart = performance.now();
      await pollTransactionConfirmation(signature);
      timings['确认交易'] = performance.now() - stepStart;
      logToPage('log', '✓ 交易已确认，耗时:', timings['确认交易'].toFixed(2), 'ms');
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

// 轮询确认交易
async function pollTransactionConfirmation(signature: string, timeout: number = 30000): Promise<void> {
  const startTime = Date.now();
  const pollInterval = 1000; // 每秒轮询一次

  while (Date.now() - startTime < timeout) {
    try {
      if (!helius) {
        throw new Error('Helius 客户端未初始化');
      }
      
      const confirmed = await helius.confirmTransaction(signature, 1000);
      if (confirmed) {
        const elapsed = Date.now() - startTime;
        logToPage('log', '✓ 交易已确认，耗时:', elapsed, 'ms');
        return;
      }
      
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    } catch (error: any) {
      logToPage('warn', '轮询确认异常:', error.message);
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  throw new Error('交易确认超时');
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
    if (!helius || !pump || !raydium) {
      logToPage('warn', '客户端未初始化，尝试重新初始化...');
      const config = await getConfig();
      await updateClients(config);
      
      if (!helius || !pump || !raydium) {
        throw new Error('Wallet not configured: 请检查 Helius API Key 是否正确配置');
      }
      logToPage('log', '客户端重新初始化成功');
    }

    const config = await getConfig();
    const tokenType = await getTokenType(ca);
    logToPage('log', '检测到的市场类型:', tokenType);
    
    const usePump = tokenType === 'pump';

    // 卖出时始终获取最新的token余额（因为余额可能在预加载后发生了变化）
    logToPage('log', '→ 获取最新Token余额和精度...');
    stepStart = performance.now();
    const client = usePump ? pump : raydium;
    
    if (!client) {
      throw new Error(`客户端未初始化: ${tokenType}`);
    }
    
    const [tokenBalance, decimals] = await Promise.all([
      helius.getTokenBalance(wallet.publicKey, ca),
      client.getTokenDecimals(ca),
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

    // 检查缓存中是否有预加载的卖出交易
    let transaction: Transaction | VersionedTransaction | null = null;
    let useCache = false;

    // 检查配置是否启用缓存
    const cacheEnabled = config.enableCache !== false; // 默认 true
    
    // 检查缓存 - 只有在缓存新鲜时才使用（避免交易过期）
    if (cacheEnabled && isCacheValid(ca) && preloadCache!.sellTrades.has(percent)) {
      const cacheAge = Date.now() - preloadCache!.timestamp;
      const cachedBalance = preloadCache!.tokenBalance;
      const balanceDiff = Math.abs(tokenBalance - cachedBalance);
      const balanceChangePercent = cachedBalance > 0 ? (balanceDiff / cachedBalance) * 100 : 0;
      
      // 如果缓存新鲜且余额变化不大（<5%），可以使用缓存
      if (cacheAge < CACHE_FRESH_THRESHOLD && balanceChangePercent < 5) {
        logToPage('log', '✓ 使用缓存的卖出交易数据（缓存年龄:', cacheAge, 'ms, 余额变化:', balanceChangePercent.toFixed(2) + '%）');
        transaction = preloadCache!.sellTrades.get(percent)!.transaction;
        timings['使用缓存'] = 0;
        useCache = true;
      } else {
        if (balanceChangePercent >= 5) {
          logToPage('log', '⚠ 余额变化较大（', balanceChangePercent.toFixed(2) + '%），重新构建交易');
        } else {
          logToPage('log', '⚠ 缓存不够新鲜（年龄:', cacheAge, 'ms），重新构建交易');
        }
      }
    } else if (!cacheEnabled) {
      logToPage('log', '缓存已禁用，实时构建交易');
    }

    if (!useCache || !transaction) {
  // 计算卖出数量
      if (rawTokenBalance === 0) {
        throw new Error('No token balance');
      }
      
      const rawSellAmount = Math.floor((rawTokenBalance * percent) / 100);
      if (rawSellAmount === 0) {
        throw new Error('卖出数量太小，无法交易');
      }
      
      const sellAmount = rawSellAmount / Math.pow(10, decimals);
      
      // 直接合约调用
      logToPage('log', `→ 构建卖出交易 (${usePump ? 'Pump.fun' : 'Raydium'})...`);
      stepStart = performance.now();
      transaction = await client.buildSellTransaction(ca, sellAmount, decimals, wallet.publicKey);
      timings['构建交易'] = performance.now() - stepStart;
      logToPage('log', '✓ 交易构建成功，耗时:', timings['构建交易'].toFixed(2), 'ms');
    }

    // 签名
    logToPage('log', '→ 签名交易...');
    stepStart = performance.now();
    
    if (!transaction) {
      throw new Error('交易未构建');
    }
    
    const signedTx = wallet.signTransactionObject(transaction);
    const serialized = signedTx instanceof VersionedTransaction 
      ? signedTx.serialize() 
      : signedTx.serialize();
    const signedTxBase58 = bs58.encode(serialized);
    
    timings['签名交易'] = performance.now() - stepStart;
    logToPage('log', '✓ 交易签名成功，耗时:', timings['签名交易'].toFixed(2), 'ms');

    // 发送交易（使用 Jito Bundle 或直接发送）
    logToPage('log', '→ 发送交易到链上...');
    stepStart = performance.now();
    let signature: string;
    let bundleStatus: BundleStatus | null = null;

    if (config.useJito && jito) {
      // 使用 Jito Bundle 发送
      logToPage('log', '使用 Jito Bundle 发送交易');
      bundleStatus = await jito.sendAndConfirmBundle([signedTxBase58], 30000);
      timings['发送交易'] = performance.now() - stepStart;
      
      // 如果 Jito 限流，降级到直接发送
      if (bundleStatus === null) {
        logToPage('warn', 'Jito Bundle 限流，降级到直接发送交易');
        signature = await helius.sendTransaction(signedTxBase58);
        timings['发送交易'] = performance.now() - stepStart;
        logToPage('log', '✓ 交易发送成功（降级模式），耗时:', timings['发送交易'].toFixed(2), 'ms');
        
        // 轮询确认交易
        logToPage('log', '→ 轮询确认交易...');
        stepStart = performance.now();
        await pollTransactionConfirmation(signature);
        timings['确认交易'] = performance.now() - stepStart;
        logToPage('log', '✓ 交易已确认，耗时:', timings['确认交易'].toFixed(2), 'ms');
      } else if (bundleStatus.status === 'landed' && bundleStatus.transactions && bundleStatus.transactions.length > 0) {
        signature = bundleStatus.transactions[0];
        logToPage('log', '✓ Bundle 已落地，交易签名:', signature);
      } else {
        throw new Error(`Bundle 失败: ${bundleStatus.status} - ${bundleStatus.error || '未知错误'}`);
      }
    } else {
      // 直接发送交易
      signature = await helius.sendTransaction(signedTxBase58);
      timings['发送交易'] = performance.now() - stepStart;
      logToPage('log', '✓ 交易发送成功，耗时:', timings['发送交易'].toFixed(2), 'ms');
      
      // 轮询确认交易
      logToPage('log', '→ 轮询确认交易...');
      stepStart = performance.now();
      await pollTransactionConfirmation(signature);
      timings['确认交易'] = performance.now() - stepStart;
      logToPage('log', '✓ 交易已确认，耗时:', timings['确认交易'].toFixed(2), 'ms');
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
        logToPage('warn', '获取余额失败:', e.message || e);
        // 如果获取失败，保持 balance 为 0
      }
    }

    return {
      address: state.address || '',
      isLocked: false, // 锁定功能已禁用
      balance,
    };
  } catch (error: any) {
    logToPage('error', 'getWalletState 异常:', error);
    // 即使出错也返回默认状态，避免 UI 崩溃
    return {
      address: '',
      isLocked: false,
      balance: 0,
    };
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

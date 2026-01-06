import { Message, MessageResponse, Config, TradeStatus } from '../shared/types';

// 状态
let config: Config | null = null;
let walletState = { address: '', balance: 0, isLocked: false };
let currentCA = '';
let status: TradeStatus = 'idle';
let preloadTimeout: ReturnType<typeof setTimeout> | null = null;

// DOM元素
let panel: HTMLElement;
let balanceEl: HTMLElement;
let caInput: HTMLInputElement;
let statusDot: HTMLElement;
let statusText: HTMLElement;
let buyButtons: HTMLButtonElement[] = [];
let sellButtons: HTMLButtonElement[] = [];

// 发送消息到background
function sendMessage(message: Message): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: MessageResponse) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.success) {
        resolve(response.data);
      } else {
        reject(new Error(response?.error || '未知错误'));
      }
    });
  });
}

// 显示Toast
function showToast(message: string, type: 'success' | 'error' = 'success') {
  const existing = document.querySelector('.sol-sniper-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `sol-sniper-toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// 更新状态显示
function updateStatus(newStatus: TradeStatus, text?: string) {
  status = newStatus;
  if (!statusDot || !statusText) return;

  statusDot.className = 'sol-sniper-status-dot';

  switch (newStatus) {
    case 'ready':
      statusDot.classList.add('ready');
      statusText.textContent = text || '就绪';
      break;
    case 'loading':
      statusDot.classList.add('loading');
      statusText.textContent = text || '加载中...';
      break;
    case 'executing':
      statusDot.classList.add('loading');
      statusText.textContent = text || '执行中...';
      break;
    case 'error':
      statusDot.classList.add('error');
      statusText.textContent = text || '错误';
      break;
    default:
      statusText.textContent = text || '等待输入';
  }
}

// 更新按钮状态
function updateButtons(enabled: boolean) {
  const canTrade = enabled && currentCA.length >= 32;
  buyButtons.forEach(btn => btn.disabled = !canTrade);
  sellButtons.forEach(btn => btn.disabled = !canTrade);
}

// 预加载交易
async function preloadTrades() {
  if (!currentCA || currentCA.length < 32) return;

  updateStatus('loading', '预加载中...');
  updateButtons(false);

  try {
    const result = await sendMessage({ type: 'PRELOAD_TRADES', payload: { ca: currentCA } });
    updateStatus('ready', `就绪 (${result.cached}个已缓存)`);
    updateButtons(true);
  } catch (error: any) {
    updateStatus('error', error.message);
    updateButtons(false);
  }
}

// CA输入处理（防抖）
function handleCAInput(e: Event) {
  const input = e.target as HTMLInputElement;
  currentCA = input.value.trim();

  if (preloadTimeout) clearTimeout(preloadTimeout);

  if (currentCA.length >= 32) {
    updateStatus('loading', '准备中...');
    preloadTimeout = setTimeout(preloadTrades, 300);
  } else {
    updateStatus('idle', '请输入CA');
    updateButtons(false);
  }
}

// 执行买入
async function handleBuy(amount: number) {
  if (!currentCA) return;

  updateStatus('executing', `买入 ${amount} SOL...`);
  updateButtons(false);

  try {
    const signature = await sendMessage({
      type: 'EXECUTE_BUY',
      payload: { ca: currentCA, amount }
    });
    showToast(`买入成功! ${signature.slice(0, 8)}...`, 'success');
    updateStatus('ready', '成功!');
    refreshBalance();
  } catch (error: any) {
    console.error('[SolSniper] 买入失败:', error);
    showToast(`买入失败: ${error.message}`, 'error');
    updateStatus('error', error.message);
  }

  updateButtons(true);
}

// 执行卖出
async function handleSell(percent: number) {
  if (!currentCA) return;

  updateStatus('executing', `卖出 ${percent}%...`);
  updateButtons(false);

  try {
    const signature = await sendMessage({
      type: 'EXECUTE_SELL',
      payload: { ca: currentCA, percent }
    });
    showToast(`卖出成功! ${signature.slice(0, 8)}...`, 'success');
    updateStatus('ready', '成功!');
    refreshBalance();
  } catch (error: any) {
    console.error('[SolSniper] 卖出失败:', error);
    showToast(`卖出失败: ${error.message}`, 'error');
    updateStatus('error', error.message);
  }

  updateButtons(true);
}

// 刷新余额
async function refreshBalance() {
  try {
    walletState = await sendMessage({ type: 'GET_WALLET_STATE' });
    if (balanceEl) {
      const balance = walletState.balance || 0;
      balanceEl.textContent = balance.toFixed(4);
    }
    updateButtons(status === 'ready');
  } catch (error) {
    console.error('[SolSniper] 刷新余额失败:', error);
    // 即使失败也尝试显示当前余额
    if (balanceEl && walletState) {
      const balance = walletState.balance || 0;
      balanceEl.textContent = balance.toFixed(4);
    }
  }
}

// 锁定功能已移除

// 显示未配置提示
function showNotConfigured() {
  const body = panel.querySelector('.sol-sniper-body') as HTMLElement;
  body.innerHTML = `
    <div class="sol-sniper-locked">
      <div class="sol-sniper-locked-icon">⚙️</div>
      <div class="sol-sniper-locked-text">请先完成配置</div>
      <div class="sol-sniper-hint">点击右上角设置按钮<br>配置 API Key 和钱包</div>
    </div>
  `;
}

// 显示未导入钱包提示
function showNoWallet() {
  const body = panel.querySelector('.sol-sniper-body') as HTMLElement;
  body.innerHTML = `
    <div class="sol-sniper-locked">
      <div class="sol-sniper-locked-icon">👛</div>
      <div class="sol-sniper-locked-text">请先导入钱包</div>
      <div class="sol-sniper-hint">点击右上角设置按钮<br>导入您的钱包私钥</div>
    </div>
  `;
}

// 初始化交易界面
function initTradeUI() {
  const body = panel.querySelector('.sol-sniper-body') as HTMLElement;

  if (!config) {
    showNotConfigured();
    return;
  }

  body.innerHTML = `
    <div class="sol-sniper-balance">
      <button class="sol-sniper-refresh-btn" id="sol-refresh-balance-btn" title="刷新余额">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
        </svg>
      </button>
      <span class="sol-sniper-balance-value" id="sol-balance">0.00</span>
      <span class="sol-sniper-balance-unit">SOL</span>
    </div>

    <div class="sol-sniper-input-group">
      <input type="text" class="sol-sniper-input" placeholder="输入代币CA地址" id="sol-ca-input">
    </div>

    <div class="sol-sniper-section">
      <div class="sol-sniper-section-title">买入 (SOL)</div>
      <div class="sol-sniper-btn-group" id="sol-buy-btns"></div>
    </div>

    <div class="sol-sniper-section">
      <div class="sol-sniper-section-title">卖出 (%)</div>
      <div class="sol-sniper-btn-group" id="sol-sell-btns"></div>
    </div>

    <div class="sol-sniper-status">
      <span class="sol-sniper-status-dot" id="sol-status-dot"></span>
      <span class="sol-sniper-status-text" id="sol-status-text">等待输入</span>
    </div>
  `;

  // 绑定元素
  balanceEl = document.getElementById('sol-balance')!;
  caInput = document.getElementById('sol-ca-input') as HTMLInputElement;
  statusDot = document.getElementById('sol-status-dot')!;
  statusText = document.getElementById('sol-status-text')!;
  
  // 刷新余额按钮
  const refreshBtn = document.getElementById('sol-refresh-balance-btn')!;
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.classList.add('refreshing');
    try {
      await refreshBalance();
      showToast('余额已刷新', 'success');
    } catch (error: any) {
      showToast('刷新失败: ' + (error.message || '未知错误'), 'error');
    } finally {
      setTimeout(() => {
        refreshBtn.classList.remove('refreshing');
      }, 500);
    }
  });

  // 创建买入按钮
  const buyGroup = document.getElementById('sol-buy-btns')!;
  buyButtons = config.buyPresets.map(amount => {
    const btn = document.createElement('button');
    btn.className = 'sol-sniper-btn sol-sniper-btn-buy';
    btn.textContent = amount.toString();
    btn.disabled = true;
    btn.onclick = () => handleBuy(amount);
    buyGroup.appendChild(btn);
    return btn;
  });

  // 创建卖出按钮
  const sellGroup = document.getElementById('sol-sell-btns')!;
  sellButtons = config.sellPresets.map(percent => {
    const btn = document.createElement('button');
    btn.className = 'sol-sniper-btn sol-sniper-btn-sell';
    btn.textContent = `${percent}%`;
    btn.disabled = true;
    btn.onclick = () => handleSell(percent);
    sellGroup.appendChild(btn);
    return btn;
  });

  // 监听CA输入
  caInput.addEventListener('input', handleCAInput);
}

// 拖动功能
function makeDraggable(header: HTMLElement, panelRoot: HTMLElement) {
  let isDragging = false;
  let startX = 0, startY = 0;
  let panelX = 20, panelY = 20;

  // 从localStorage恢复位置
  const savedPos = localStorage.getItem('sol-sniper-position');
  if (savedPos) {
    try {
      const pos = JSON.parse(savedPos);
      panelX = pos.x;
      panelY = pos.y;
    } catch {}
  }
  panelRoot.style.right = `${panelX}px`;
  panelRoot.style.top = `${panelY}px`;

  header.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    header.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const dx = startX - e.clientX;
    const dy = e.clientY - startY;

    panelX += dx;
    panelY += dy;

    // 边界检查
    panelX = Math.max(0, Math.min(panelX, window.innerWidth - 280));
    panelY = Math.max(0, Math.min(panelY, window.innerHeight - 200));

    panelRoot.style.right = `${panelX}px`;
    panelRoot.style.top = `${panelY}px`;

    startX = e.clientX;
    startY = e.clientY;
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      header.style.cursor = 'move';
      localStorage.setItem('sol-sniper-position', JSON.stringify({ x: panelX, y: panelY }));
    }
  });
}

// 创建面板
function createPanel() {
  const root = document.createElement('div');
  root.id = 'sol-sniper-root';

  root.innerHTML = `
    <div class="sol-sniper-panel" id="sol-sniper-panel">
      <div class="sol-sniper-header" id="sol-sniper-header">
        <div class="sol-sniper-title">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#e94560"/><path d="M7 12h10M12 7l5 5-5 5" stroke="white" stroke-width="2" fill="none"/></svg>
          极速交易
        </div>
        <div class="sol-sniper-controls">
          <button class="sol-sniper-btn-icon" id="sol-settings-btn" title="设置">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
            </svg>
          </button>
          <button class="sol-sniper-btn-icon" id="sol-minimize-btn" title="最小化">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M5 12h14"/>
            </svg>
          </button>
          <button class="sol-sniper-btn-icon" id="sol-close-btn" title="关闭">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="sol-sniper-body"></div>
    </div>
  `;

  document.body.appendChild(root);

  panel = document.getElementById('sol-sniper-panel')!;
  const header = document.getElementById('sol-sniper-header')!;

  // 恢复面板大小
  const savedSize = localStorage.getItem('sol-sniper-size');
  if (savedSize) {
    try {
      const size = JSON.parse(savedSize);
      if (size.width && size.height) {
        panel.style.width = size.width + 'px';
        panel.style.height = size.height + 'px';
        console.log('[SolSniper] 恢复面板大小:', size.width, 'x', size.height);
      }
    } catch (error) {
      console.error('[SolSniper] 恢复面板大小失败:', error);
    }
  }

  // 监听面板大小变化（使用 ResizeObserver）
  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      // 防抖保存
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        localStorage.setItem('sol-sniper-size', JSON.stringify({ width, height }));
        console.log('[SolSniper] 保存面板大小:', width, 'x', height);
      }, 500);
    }
  });
  resizeObserver.observe(panel);

  // 拖动
  makeDraggable(header, root);

  // 最小化
  document.getElementById('sol-minimize-btn')!.onclick = () => {
    panel.classList.toggle('minimized');
  };

  // 关闭（隐藏）- 但不真正移除，只是隐藏
  document.getElementById('sol-close-btn')!.onclick = () => {
    root.style.display = 'none';
    // 设置标记，表示用户主动关闭（使用 sessionStorage 持久化）
    root.setAttribute('data-user-closed', 'true');
    sessionStorage.setItem('sol-sniper-user-closed', 'true');
  };

  // 设置按钮 - 打开popup
  document.getElementById('sol-settings-btn')!.onclick = () => {
    chrome.runtime.sendMessage({ type: 'OPEN_POPUP' });
  };

  return root;
}

// 注入样式
function injectStyles() {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('assets/content.css');
  document.head.appendChild(link);
}

// 初始化标志
let isInitialized = false;
let observer: MutationObserver | null = null;
let caExtractorObserver: MutationObserver | null = null;
let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

// 确保插件存在
function ensurePanelExists() {
  // 检查是否是用户主动关闭
  const userClosed = sessionStorage.getItem('sol-sniper-user-closed');
  if (userClosed === 'true') {
    return null; // 用户主动关闭，不自动恢复
  }
  
  // 检查网站是否允许（配置已加载的情况下）
  if (config && !isSiteAllowed()) {
    const root = document.getElementById('sol-sniper-root');
    if (root) {
      root.style.display = 'none';
    }
    return null;
  }
  
  let root = document.getElementById('sol-sniper-root');
  
  if (!root) {
    console.log('[SolSniper] 插件被移除，重新注入...');
    // 重新创建UI
    injectStyles();
    root = createPanel();
    // 重新初始化UI内容
    initializePanelContent();
    // 重新启动 CA 提取
    startCAExtraction();
  } else {
    // 确保插件可见（除非用户主动关闭或网站不允许）
    const rootClosed = root.getAttribute('data-user-closed');
    if (rootClosed !== 'true' && root.style.display === 'none') {
      // 再次检查网站是否允许
      if (!config || isSiteAllowed()) {
        root.style.display = '';
      }
    }
  }
  
  return root;
}

// 初始化面板内容
async function initializePanelContent() {
  try {
    // 获取配置和钱包状态
    [config, walletState] = await Promise.all([
      sendMessage({ type: 'GET_CONFIG' }),
      sendMessage({ type: 'GET_WALLET_STATE' })
    ]);

    // 再次检查网站是否允许（配置可能已更新）
    if (!isSiteAllowed()) {
      console.log('[SolSniper] 当前网站不在允许列表中');
      const root = document.getElementById('sol-sniper-root');
      if (root) {
        root.style.display = 'none';
      }
      return;
    }

    // 如果没有配置API key，显示配置提示
    if (!config || !config.heliusApiKey) {
      showNotConfigured();
      return;
    }

    // 根据钱包状态显示
    if (!walletState.address) {
      showNoWallet();
    } else {
      initTradeUI();
      refreshBalance();
      // UI 初始化后，启动 CA 自动提取
      setTimeout(() => {
        startCAExtraction();
      }, 500);
    }

    console.log('[SolSniper] 面板内容初始化完成');
  } catch (error) {
    console.error('[SolSniper] 面板内容初始化失败:', error);
    showNotConfigured();
  }
}

// 初始化
async function init() {
  // 避免重复初始化
  if (isInitialized) {
    ensurePanelExists();
    return;
  }

  // 等待页面加载完成
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      doInit();
    });
  } else {
    doInit();
  }
}

// 检查当前网站是否允许显示插件
function isSiteAllowed(): boolean {
  // 如果配置未加载，默认允许（避免初始化时被阻止）
  if (!config) {
    console.log('[SolSniper] 配置未加载，默认允许显示');
    return true;
  }
  
  // 如果允许列表为空，表示所有网站都允许
  if (!config.allowedSites || config.allowedSites.length === 0) {
    return true;
  }
  
  const currentUrl = window.location.href;
  const currentHost = window.location.hostname;
  
  // 检查是否匹配允许的网站
  const isAllowed = config.allowedSites.some(site => {
    try {
      const trimmedSite = site.trim();
      if (!trimmedSite) return false;
      
      // 如果是完整URL，检查是否匹配
      if (trimmedSite.startsWith('http://') || trimmedSite.startsWith('https://')) {
        return currentUrl.startsWith(trimmedSite) || currentUrl.includes(trimmedSite);
      }
      // 如果是域名，检查hostname
      return currentHost === trimmedSite || currentHost.endsWith('.' + trimmedSite);
    } catch {
      return false;
    }
  });
  
  console.log('[SolSniper] 网站检查:', {
    currentHost,
    allowedSites: config.allowedSites,
    isAllowed
  });
  
  return isAllowed;
}

// 从 AXIOM 页面提取 CA
function extractCAFromAxiom(): string | null {
  try {
    // 方法1: 从包含 "CA:" 的元素中提取
    const caElements = Array.from(document.querySelectorAll('*')).filter(el => {
      const text = el.textContent || '';
      return text.includes('CA:') && text.length < 200;
    });
    
    for (const el of caElements) {
      const text = el.textContent || '';
      // 查找 Solana 地址格式（Base58，通常32-44个字符）
      const addressMatch = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
      if (addressMatch) {
        const address = addressMatch[0];
        // 验证是否是有效的 Solana 地址长度
        if (address.length >= 32 && address.length <= 44) {
          console.log('[SolSniper] 从 AXIOM 页面提取到 CA:', address);
          return address;
        }
      }
    }
    
    // 方法2: 从 solscan.io 链接中提取
    const solscanLinks = Array.from(document.querySelectorAll('a[href*="solscan.io/account/"]'));
    for (const link of solscanLinks) {
      const href = (link as HTMLAnchorElement).href;
      const match = href.match(/solscan\.io\/account\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
      if (match && match[1]) {
        console.log('[SolSniper] 从 solscan 链接提取到 CA:', match[1]);
        return match[1];
      }
    }
    
    // 方法3: 查找包含完整地址的文本（不在链接中）
    const allText = document.body.textContent || '';
    // 查找类似 "FvrEADBjznCBv4hZ5YZ6akjf71xAJkTKoijVLg34pump" 的地址
    const addressPattern = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g;
    const matches = allText.match(addressPattern);
    if (matches) {
      // 优先选择长度接近44的地址（完整地址）
      const fullAddress = matches.find(addr => addr.length >= 40);
      if (fullAddress) {
        console.log('[SolSniper] 从页面文本提取到 CA:', fullAddress);
        return fullAddress;
      }
    }
    
    return null;
  } catch (error) {
    console.error('[SolSniper] 提取 CA 失败:', error);
    return null;
  }
}

// CA 提取防抖
let caExtractionTimeout: ReturnType<typeof setTimeout> | null = null;
let lastExtractedCA: string | null = null;

// 执行 CA 提取（带防抖）
function performCAExtraction(force: boolean = false) {
  if (!caInput) return;
  
  // 清除之前的定时器
  if (caExtractionTimeout) {
    clearTimeout(caExtractionTimeout);
  }
  
  // 防抖：延迟执行，避免频繁提取
  caExtractionTimeout = setTimeout(() => {
    const ca = extractCAFromAxiom();
    if (ca) {
      // 如果CA变化了，或者强制更新，则更新输入框
      if (force || ca !== lastExtractedCA) {
        console.log('[SolSniper] CA 已更新:', lastExtractedCA, '->', ca);
        caInput.value = ca;
        currentCA = ca;
        lastExtractedCA = ca;
        // 触发输入事件
        const event = new Event('input', { bubbles: true });
        caInput.dispatchEvent(event);
      }
    } else if (force && lastExtractedCA) {
      // 如果强制更新但没找到CA，清空之前的值
      console.log('[SolSniper] 未找到 CA，清空输入框');
      caInput.value = '';
      currentCA = '';
      lastExtractedCA = null;
    }
  }, 300); // 300ms 防抖
}

// 监听页面变化，自动提取 CA
function startCAExtraction() {
  // 只在 AXIOM 页面启用
  if (!window.location.hostname.includes('axiom.trade')) {
    return;
  }
  
  console.log('[SolSniper] 启动 CA 自动提取');
  
  // 立即尝试提取一次（延迟执行，确保 caInput 已初始化）
  setTimeout(() => {
    performCAExtraction(true);
  }, 500);
  
  // 监听 DOM 变化，自动提取 CA
  if (caExtractorObserver) {
    caExtractorObserver.disconnect();
  }
  
  // 使用更精确的观察器，监听包含 CA 的元素
  caExtractorObserver = new MutationObserver((mutations) => {
    // 检查是否有相关元素变化
    let shouldExtract = false;
    
    for (const mutation of mutations) {
      // 检查是否有节点添加或属性变化
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        // 检查新添加的节点是否包含 CA 相关信息
        for (const node of Array.from(mutation.addedNodes)) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as Element;
            const text = el.textContent || '';
            // 如果包含 CA: 或 solscan 链接，触发提取
            if (text.includes('CA:') || 
                el.querySelector('a[href*="solscan.io/account/"]') ||
                el.querySelector('a[href*="solscan.io/token/"]')) {
              shouldExtract = true;
              break;
            }
          }
        }
      }
      
      // 检查文本内容变化
      if (mutation.type === 'characterData' || mutation.type === 'childList') {
        const target = mutation.target as Element;
        if (target) {
          const text = target.textContent || '';
          if (text.includes('CA:') || text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/)) {
            shouldExtract = true;
            break;
          }
        }
      }
    }
    
    if (shouldExtract) {
      performCAExtraction(false);
    }
  });
  
  // 监听整个文档的变化，包括属性变化
  caExtractorObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: false,
  });
  
  // 监听 URL 变化（SPA 路由）
  let lastUrl = location.href;
  const urlCheckInterval = setInterval(() => {
    const currentUrl = location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      console.log('[SolSniper] 检测到 URL 变化，重新提取 CA');
      // URL 变化时强制重新提取
      setTimeout(() => {
        performCAExtraction(true);
      }, 1000);
    }
  }, 500);
  
  // 监听 popstate 事件（浏览器前进/后退）
  window.addEventListener('popstate', () => {
    console.log('[SolSniper] 检测到 popstate，重新提取 CA');
    setTimeout(() => {
      performCAExtraction(true);
    }, 500);
  });
  
  // 监听 pushState 和 replaceState（SPA 路由）
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  
  history.pushState = function(...args) {
    originalPushState.apply(history, args);
    console.log('[SolSniper] 检测到 pushState，重新提取 CA');
    setTimeout(() => {
      performCAExtraction(true);
    }, 500);
  };
  
  history.replaceState = function(...args) {
    originalReplaceState.apply(history, args);
    console.log('[SolSniper] 检测到 replaceState，重新提取 CA');
    setTimeout(() => {
      performCAExtraction(true);
    }, 500);
  };
}

async function doInit() {
  // 先创建UI（不检查网站，让用户看到插件）
  injectStyles();
  createPanel();
  
  // 初始化面板内容（这里会加载配置并检查网站）
  await initializePanelContent();
  
  // 如果网站不允许，会在 initializePanelContent 中隐藏
  // 如果允许，继续初始化
  
  // 启动 CA 自动提取
  startCAExtraction();
  
  isInitialized = true;
  console.log('[SolSniper] 初始化完成');

  // 监听 DOM 变化，确保插件不被移除
  observer = new MutationObserver((mutations) => {
    const root = document.getElementById('sol-sniper-root');
    if (!root) {
      // 检查是否是用户主动关闭
      const userClosed = sessionStorage.getItem('sol-sniper-user-closed');
      if (userClosed === 'true') {
        return; // 用户主动关闭，不自动恢复
      }
      
      console.log('[SolSniper] 检测到插件被移除，重新注入...');
      // 延迟重新注入，避免频繁触发
      setTimeout(() => {
        ensurePanelExists();
        initializePanelContent();
      }, 100);
    }
  });

  // 监听整个文档的变化
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // 监听页面导航（SPA）
  let lastUrl = location.href;
  const navObserver = new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      console.log('[SolSniper] 检测到页面导航，确保插件存在');
      // 检查是否是用户主动关闭
      const userClosed = sessionStorage.getItem('sol-sniper-user-closed');
      if (userClosed !== 'true') {
        setTimeout(() => {
          ensurePanelExists();
        }, 500);
      }
    }
  });
  navObserver.observe(document, { subtree: true, childList: true });
}

// 启动
init();

// 监听配置更新
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'CONFIG_UPDATED') {
    config = message.payload;
    console.log('[SolSniper] 配置已更新，重新检查网站权限');
    // 重新检查网站权限并更新显示
    if (isSiteAllowed()) {
      // 网站允许，确保插件显示
      const root = document.getElementById('sol-sniper-root');
      if (root) {
        root.style.display = '';
        root.removeAttribute('data-user-closed');
      }
      // 重新初始化UI
      if (panel) {
        initializePanelContent();
      }
    } else {
      // 网站不允许，隐藏插件
      const root = document.getElementById('sol-sniper-root');
      if (root) {
        root.style.display = 'none';
      }
    }
  }
});

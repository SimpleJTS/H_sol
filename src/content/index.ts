import { Message, MessageResponse, Config, TradeStatus } from '../shared/types';

// 状态
let config: Config | null = null;
let walletState = { address: '', balance: 0, isLocked: true };
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
  const canTrade = enabled && !walletState.isLocked && currentCA.length >= 32;
  buyButtons.forEach(btn => btn.disabled = !canTrade);
  sellButtons.forEach(btn => btn.disabled = !canTrade);
}

// 预加载交易
async function preloadTrades() {
  if (!currentCA || currentCA.length < 32 || walletState.isLocked) return;

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
  if (walletState.isLocked || !currentCA) return;

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
    showToast(`买入失败: ${error.message}`, 'error');
    updateStatus('error', error.message);
  }

  updateButtons(true);
}

// 执行卖出
async function handleSell(percent: number) {
  if (walletState.isLocked || !currentCA) return;

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
      balanceEl.textContent = walletState.balance.toFixed(4);
    }
    updateButtons(status === 'ready');
  } catch (error) {
    console.error('[SolSniper] 刷新余额失败:', error);
  }
}

// 显示密码输入
function showPasswordPrompt() {
  const body = panel.querySelector('.sol-sniper-body') as HTMLElement;
  body.innerHTML = `
    <div class="sol-sniper-locked">
      <div class="sol-sniper-locked-icon">🔒</div>
      <div class="sol-sniper-locked-text">钱包已锁定</div>
      <input type="password" class="sol-sniper-input" placeholder="输入密码" id="sol-sniper-password">
      <button class="sol-sniper-unlock-btn" id="sol-sniper-unlock">解锁</button>
    </div>
  `;

  const passwordInput = document.getElementById('sol-sniper-password') as HTMLInputElement;
  const unlockBtn = document.getElementById('sol-sniper-unlock') as HTMLButtonElement;

  unlockBtn.onclick = async () => {
    const password = passwordInput.value;
    if (!password) return;

    try {
      await sendMessage({ type: 'UNLOCK_WALLET', payload: { password } });
      initTradeUI();
      refreshBalance();
    } catch (error: any) {
      showToast(error.message, 'error');
    }
  };

  passwordInput.onkeypress = (e) => {
    if (e.key === 'Enter') unlockBtn.click();
  };
}

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
      <svg class="sol-sniper-balance-icon" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="#00d26a" stroke-width="2"/>
        <path d="M8 12h8M12 8v8" stroke="#00d26a" stroke-width="2" stroke-linecap="round"/>
      </svg>
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

  // 拖动
  makeDraggable(header, root);

  // 最小化
  document.getElementById('sol-minimize-btn')!.onclick = () => {
    panel.classList.toggle('minimized');
  };

  // 关闭（隐藏）
  document.getElementById('sol-close-btn')!.onclick = () => {
    root.style.display = 'none';
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

// 初始化
async function init() {
  // 避免重复注入
  if (document.getElementById('sol-sniper-root')) return;

  // 先创建UI
  injectStyles();
  createPanel();

  try {
    // 获取配置和钱包状态
    [config, walletState] = await Promise.all([
      sendMessage({ type: 'GET_CONFIG' }),
      sendMessage({ type: 'GET_WALLET_STATE' })
    ]);

    // 如果没有配置API key，显示配置提示
    if (!config || !config.heliusApiKey) {
      showNotConfigured();
      return;
    }

    // 根据钱包状态显示
    if (!walletState.address) {
      showNoWallet();
    } else if (walletState.isLocked) {
      showPasswordPrompt();
    } else {
      initTradeUI();
      refreshBalance();
    }

    console.log('[SolSniper] 初始化完成');
  } catch (error) {
    console.error('[SolSniper] 初始化失败:', error);
    showNotConfigured();
  }
}

// 启动
init();

// 监听配置更新
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'CONFIG_UPDATED') {
    config = message.payload;
    if (panel) {
      initTradeUI();
      refreshBalance();
    }
  }
});

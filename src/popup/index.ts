import { Config, DEFAULT_CONFIG, Message, MessageResponse } from '../shared/types';

// 状态
let config: Config = { ...DEFAULT_CONFIG };
let walletState = { address: '', balance: 0, isLocked: false };

// DOM元素
const heliusKeyInput = document.getElementById('helius-key') as HTMLInputElement;
const jupiterKeyInput = document.getElementById('jupiter-key') as HTMLInputElement;
const slippageInput = document.getElementById('slippage') as HTMLInputElement;
const priorityFeeInput = document.getElementById('priority-fee') as HTMLInputElement;

const buyInputs = [
  document.getElementById('buy-1') as HTMLInputElement,
  document.getElementById('buy-2') as HTMLInputElement,
  document.getElementById('buy-3') as HTMLInputElement,
  document.getElementById('buy-4') as HTMLInputElement,
];

const sellInputs = [
  document.getElementById('sell-1') as HTMLInputElement,
  document.getElementById('sell-2') as HTMLInputElement,
  document.getElementById('sell-3') as HTMLInputElement,
  document.getElementById('sell-4') as HTMLInputElement,
];

const walletSection = document.getElementById('wallet-status')!;
const importModal = document.getElementById('import-modal')!;
const saveBtn = document.getElementById('btn-save')!;
const allowedSitesInput = document.getElementById('allowed-sites') as HTMLTextAreaElement;
const enableCacheInput = document.getElementById('enable-cache') as HTMLInputElement;

// 发送消息
function sendMessage(message: Message): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: MessageResponse) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.success) {
        resolve(response.data);
      } else {
        reject(new Error(response?.error || '未知错误'));
      }
    });
  });
}

// 显示Toast
function showToast(message: string, type: 'success' | 'error' = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// 填充表单
function fillForm() {
  heliusKeyInput.value = config.heliusApiKey || '';
  jupiterKeyInput.value = config.jupiterApiKey || '';
  slippageInput.value = (config.slippage / 100).toString();
  priorityFeeInput.value = (config.priorityFee / 1_000_000_000).toFixed(4);

  buyInputs.forEach((input, i) => {
    input.value = config.buyPresets[i].toString();
  });

  sellInputs.forEach((input, i) => {
    input.value = config.sellPresets[i].toString();
  });

  // 填充允许的网站列表
  allowedSitesInput.value = (config.allowedSites || []).join('\n');
  
  // 填充缓存开关
  enableCacheInput.checked = config.enableCache !== false; // 默认 true
}

// 收集表单数据
function collectFormData(): Partial<Config> {
  // 解析允许的网站列表
  const allowedSites = allowedSitesInput.value
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  return {
    heliusApiKey: heliusKeyInput.value.trim(),
    jupiterApiKey: jupiterKeyInput.value.trim(),
    slippage: Math.round(parseFloat(slippageInput.value) * 100),
    priorityFee: Math.round(parseFloat(priorityFeeInput.value) * 1_000_000_000),
    buyPresets: buyInputs.map((input) => parseFloat(input.value)) as [number, number, number, number],
    sellPresets: sellInputs.map((input) => parseFloat(input.value)) as [number, number, number, number],
    allowedSites,
    enableCache: enableCacheInput.checked,
  };
}

// 更新钱包状态显示
function updateWalletStatus() {
  if (!walletState.address) {
    walletSection.innerHTML = `
      <div class="wallet-none">
        <p>尚未导入钱包</p>
        <button class="btn btn-primary btn-small" id="btn-import">导入钱包</button>
      </div>
    `;
    document.getElementById('btn-import')!.onclick = () => {
      importModal.classList.add('active');
    };
  } else {
    const balance = walletState.balance || 0;
    walletSection.innerHTML = `
      <div class="wallet-info">
        <span class="wallet-address">${walletState.address.slice(0, 8)}...${walletState.address.slice(-8)}</span>
        <span class="wallet-balance">${balance.toFixed(4)} SOL</span>
      </div>
      <div style="margin-top: 10px;">
        <button class="btn btn-danger btn-small" id="btn-remove-wallet">删除钱包</button>
      </div>
    `;
    document.getElementById('btn-remove-wallet')!.onclick = async () => {
      if (confirm('确定要删除此钱包吗？')) {
        try {
          await sendMessage({ type: 'REMOVE_WALLET' });
          walletState = { address: '', balance: 0, isLocked: false };
          updateWalletStatus();
          showToast('钱包已删除', 'success');
        } catch (error: any) {
          showToast(error.message, 'error');
        }
      }
    };
  }
}

// 保存设置
async function saveSettings() {
  const data = collectFormData();

  if (!data.heliusApiKey) {
    showToast('请输入 Helius API Key', 'error');
    return;
  }

  if (!data.jupiterApiKey) {
    showToast('请输入 Jupiter API Key', 'error');
    return;
  }

  try {
    await sendMessage({ type: 'SAVE_CONFIG', payload: data });
    config = { ...config, ...data };
    showToast('设置已保存!', 'success');

    // 通知content script更新
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'CONFIG_UPDATED', payload: config });
      }
    });
  } catch (error: any) {
    console.error('[Popup] 导入钱包失败:', error);
    showToast(error.message, 'error');
  }
}

// 导入钱包
async function importWallet() {
  const privateKeyInput = document.getElementById('private-key') as HTMLInputElement;
  const privateKey = privateKeyInput.value.trim();

  if (!privateKey) {
    showToast('请输入私钥', 'error');
    return;
  }

  try {
    const result = await sendMessage({
      type: 'IMPORT_WALLET',
      payload: { privateKey },
    });

    walletState = {
      address: result.address,
      balance: 0,
      isLocked: false, // 锁定功能已禁用
    };

    // 清空输入框
    privateKeyInput.value = '';

    importModal.classList.remove('active');
    updateWalletStatus();
    showToast('钱包导入成功!', 'success');

    // 刷新余额
    setTimeout(refreshWalletState, 500);
  } catch (error: any) {
    console.error('导入钱包失败:', error);
    showToast(error.message || '导入失败', 'error');
  }
}

// 锁定功能已移除

// 刷新钱包状态
async function refreshWalletState() {
  try {
    walletState = await sendMessage({ type: 'GET_WALLET_STATE' });
    updateWalletStatus();
  } catch (error) {
    console.error('获取钱包状态失败:', error);
  }
}

// 初始化
async function init() {
  try {
    // 加载配置和钱包状态
    [config, walletState] = await Promise.all([
      sendMessage({ type: 'GET_CONFIG' }),
      sendMessage({ type: 'GET_WALLET_STATE' }),
    ]);

    fillForm();
    updateWalletStatus();
  } catch (error) {
    console.error('初始化失败:', error);
    // 即使失败也显示默认表单
    fillForm();
    updateWalletStatus();
  }

  // 绑定事件
  saveBtn.onclick = saveSettings;

  document.getElementById('btn-cancel-import')!.onclick = () => {
    importModal.classList.remove('active');
  };

  document.getElementById('btn-confirm-import')!.onclick = importWallet;
}

init();

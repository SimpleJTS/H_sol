import { Config, DEFAULT_CONFIG, Message, MessageResponse } from '../shared/types';

// 状态
let config: Config = { ...DEFAULT_CONFIG };
let walletState = { address: '', balance: 0, isLocked: true };

// DOM元素
const heliusKeyInput = document.getElementById('helius-key') as HTMLInputElement;
const slippageInput = document.getElementById('slippage') as HTMLInputElement;
const priorityFeeInput = document.getElementById('priority-fee') as HTMLInputElement;
const autoLockInput = document.getElementById('auto-lock') as HTMLInputElement;

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
const lockBtn = document.getElementById('btn-lock')!;

// 发送消息
function sendMessage(message: Message): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: MessageResponse) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.success) {
        resolve(response.data);
      } else {
        reject(new Error(response?.error || 'Unknown error'));
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
  slippageInput.value = (config.slippage / 100).toString();
  priorityFeeInput.value = (config.priorityFee / 1_000_000_000).toFixed(4);
  autoLockInput.value = config.autoLockMinutes.toString();

  buyInputs.forEach((input, i) => {
    input.value = config.buyPresets[i].toString();
  });

  sellInputs.forEach((input, i) => {
    input.value = config.sellPresets[i].toString();
  });
}

// 收集表单数据
function collectFormData(): Partial<Config> {
  return {
    heliusApiKey: heliusKeyInput.value.trim(),
    slippage: Math.round(parseFloat(slippageInput.value) * 100),
    priorityFee: Math.round(parseFloat(priorityFeeInput.value) * 1_000_000_000),
    autoLockMinutes: parseInt(autoLockInput.value),
    buyPresets: buyInputs.map((input) => parseFloat(input.value)) as [number, number, number, number],
    sellPresets: sellInputs.map((input) => parseFloat(input.value)) as [number, number, number, number],
  };
}

// 更新钱包状态显示
function updateWalletStatus() {
  if (!walletState.address) {
    walletSection.innerHTML = `
      <div class="wallet-none">
        <p>No wallet imported</p>
        <button class="btn btn-primary btn-small" id="btn-import">Import Wallet</button>
      </div>
    `;
    document.getElementById('btn-import')!.onclick = () => {
      importModal.classList.add('active');
    };
    lockBtn.style.display = 'none';
  } else if (walletState.isLocked) {
    walletSection.innerHTML = `
      <div class="wallet-locked">
        <span>🔒</span>
        <span>Wallet Locked</span>
      </div>
      <div style="margin-top: 10px;">
        <small style="color: var(--text-secondary);">${walletState.address.slice(0, 8)}...${walletState.address.slice(-8)}</small>
      </div>
    `;
    lockBtn.textContent = 'Unlock';
    lockBtn.style.display = 'block';
  } else {
    walletSection.innerHTML = `
      <div class="wallet-info">
        <span class="wallet-address">${walletState.address.slice(0, 8)}...${walletState.address.slice(-8)}</span>
        <span class="wallet-balance">${walletState.balance.toFixed(4)} SOL</span>
      </div>
      <div style="margin-top: 10px;">
        <button class="btn btn-danger btn-small" id="btn-remove-wallet">Remove Wallet</button>
      </div>
    `;
    document.getElementById('btn-remove-wallet')!.onclick = async () => {
      if (confirm('Are you sure you want to remove this wallet?')) {
        // TODO: 实现删除钱包
        showToast('Wallet removed', 'success');
        walletState = { address: '', balance: 0, isLocked: true };
        updateWalletStatus();
      }
    };
    lockBtn.textContent = 'Lock Wallet';
    lockBtn.style.display = 'block';
  }
}

// 保存设置
async function saveSettings() {
  const data = collectFormData();

  if (!data.heliusApiKey) {
    showToast('Please enter Helius API key', 'error');
    return;
  }

  try {
    await sendMessage({ type: 'SAVE_CONFIG', payload: data });
    config = { ...config, ...data };
    showToast('Settings saved!', 'success');

    // 通知content script更新
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'CONFIG_UPDATED', payload: config });
      }
    });
  } catch (error: any) {
    showToast(error.message, 'error');
  }
}

// 导入钱包
async function importWallet() {
  const privateKey = (document.getElementById('private-key') as HTMLInputElement).value.trim();
  const password = (document.getElementById('wallet-password') as HTMLInputElement).value;
  const confirmPassword = (document.getElementById('wallet-password-confirm') as HTMLInputElement).value;

  if (!privateKey) {
    showToast('Please enter private key', 'error');
    return;
  }

  if (!password || password.length < 6) {
    showToast('Password must be at least 6 characters', 'error');
    return;
  }

  if (password !== confirmPassword) {
    showToast('Passwords do not match', 'error');
    return;
  }

  try {
    const result = await sendMessage({
      type: 'IMPORT_WALLET',
      payload: { privateKey, password },
    });

    walletState = {
      address: result.address,
      balance: 0,
      isLocked: false,
    };

    importModal.classList.remove('active');
    updateWalletStatus();
    showToast('Wallet imported!', 'success');

    // 刷新余额
    setTimeout(refreshWalletState, 500);
  } catch (error: any) {
    showToast(error.message, 'error');
  }
}

// 锁定/解锁钱包
async function toggleLock() {
  if (walletState.isLocked) {
    const password = prompt('Enter password to unlock:');
    if (!password) return;

    try {
      await sendMessage({ type: 'UNLOCK_WALLET', payload: { password } });
      walletState.isLocked = false;
      updateWalletStatus();
      showToast('Wallet unlocked!', 'success');
      refreshWalletState();
    } catch (error: any) {
      showToast(error.message, 'error');
    }
  } else {
    await sendMessage({ type: 'LOCK_WALLET' });
    walletState.isLocked = true;
    updateWalletStatus();
    showToast('Wallet locked', 'success');
  }
}

// 刷新钱包状态
async function refreshWalletState() {
  try {
    walletState = await sendMessage({ type: 'GET_WALLET_STATE' });
    updateWalletStatus();
  } catch (error) {
    console.error('Failed to get wallet state:', error);
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
    console.error('Failed to init popup:', error);
  }

  // 绑定事件
  saveBtn.onclick = saveSettings;
  lockBtn.onclick = toggleLock;

  document.getElementById('btn-cancel-import')!.onclick = () => {
    importModal.classList.remove('active');
  };

  document.getElementById('btn-confirm-import')!.onclick = importWallet;
}

init();

import { Config, DEFAULT_CONFIG } from './types';

const STORAGE_KEYS = {
  CONFIG: 'sol_sniper_config',
  ENCRYPTED_KEY: 'sol_sniper_encrypted_key',
  WALLET_ADDRESS: 'sol_sniper_wallet_address',
};

// 获取配置
export async function getConfig(): Promise<Config> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEYS.CONFIG, (result) => {
      const stored = result[STORAGE_KEYS.CONFIG];
      resolve(stored ? { ...DEFAULT_CONFIG, ...stored } : DEFAULT_CONFIG);
    });
  });
}

// 保存配置
export async function saveConfig(config: Partial<Config>): Promise<void> {
  const current = await getConfig();
  const updated = { ...current, ...config };
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEYS.CONFIG]: updated }, resolve);
  });
}

// 保存加密的私钥
export async function saveEncryptedKey(encryptedKey: string, address: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(
      {
        [STORAGE_KEYS.ENCRYPTED_KEY]: encryptedKey,
        [STORAGE_KEYS.WALLET_ADDRESS]: address,
      },
      resolve
    );
  });
}

// 获取加密的私钥
export async function getEncryptedKey(): Promise<{ encryptedKey: string; address: string } | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEYS.ENCRYPTED_KEY, STORAGE_KEYS.WALLET_ADDRESS], (result) => {
      if (result[STORAGE_KEYS.ENCRYPTED_KEY] && result[STORAGE_KEYS.WALLET_ADDRESS]) {
        resolve({
          encryptedKey: result[STORAGE_KEYS.ENCRYPTED_KEY],
          address: result[STORAGE_KEYS.WALLET_ADDRESS],
        });
      } else {
        resolve(null);
      }
    });
  });
}

// 清除钱包数据
export async function clearWallet(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove([STORAGE_KEYS.ENCRYPTED_KEY, STORAGE_KEYS.WALLET_ADDRESS], resolve);
  });
}

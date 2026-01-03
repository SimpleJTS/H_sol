import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { encrypt, decrypt } from '../shared/crypto';
import { saveEncryptedKey, getEncryptedKey, clearWallet } from '../shared/storage';

export class WalletManager {
  private keypair: Keypair | null = null;
  private address: string = '';
  private lockTimeout: ReturnType<typeof setTimeout> | null = null;
  private autoLockMs: number = 30 * 60 * 1000; // 30分钟

  get isLocked(): boolean {
    return this.keypair === null;
  }

  get publicKey(): string {
    return this.address;
  }

  // 设置自动锁定时间
  setAutoLock(minutes: number) {
    this.autoLockMs = minutes * 60 * 1000;
    this.resetLockTimer();
  }

  // 重置锁定计时器
  private resetLockTimer() {
    if (this.lockTimeout) {
      clearTimeout(this.lockTimeout);
    }
    if (this.keypair && this.autoLockMs > 0) {
      this.lockTimeout = setTimeout(() => this.lock(), this.autoLockMs);
    }
  }

  // 导入私钥并加密存储
  async importKey(privateKeyBase58: string, password: string): Promise<string> {
    try {
      // 验证私钥格式
      const secretKey = bs58.decode(privateKeyBase58);
      const keypair = Keypair.fromSecretKey(secretKey);
      const address = keypair.publicKey.toBase58();

      // 加密存储
      const encrypted = await encrypt(privateKeyBase58, password);
      await saveEncryptedKey(encrypted, address);

      // 解锁钱包
      this.keypair = keypair;
      this.address = address;
      this.resetLockTimer();

      return address;
    } catch (error) {
      throw new Error('私钥格式无效');
    }
  }

  // 解锁钱包
  async unlock(password: string): Promise<boolean> {
    const stored = await getEncryptedKey();
    if (!stored) throw new Error('未找到钱包');

    try {
      const privateKey = await decrypt(stored.encryptedKey, password);
      const secretKey = bs58.decode(privateKey);
      this.keypair = Keypair.fromSecretKey(secretKey);
      this.address = stored.address;
      this.resetLockTimer();
      return true;
    } catch {
      throw new Error('密码错误');
    }
  }

  // 锁定钱包
  lock() {
    this.keypair = null;
    if (this.lockTimeout) {
      clearTimeout(this.lockTimeout);
      this.lockTimeout = null;
    }
  }

  // 删除钱包
  async remove(): Promise<void> {
    this.lock();
    this.address = '';
    await clearWallet();
  }

  // 检查是否有存储的钱包
  async hasStoredWallet(): Promise<boolean> {
    const stored = await getEncryptedKey();
    if (stored) {
      this.address = stored.address;
      return true;
    }
    return false;
  }

  // 签名交易 (支持legacy和versioned)
  signTransaction(txBase64: string): string {
    if (!this.keypair) throw new Error('钱包已锁定');

    this.resetLockTimer();

    const txBuffer = Buffer.from(txBase64, 'base64');

    try {
      // 尝试作为 VersionedTransaction 解析
      const versionedTx = VersionedTransaction.deserialize(txBuffer);
      versionedTx.sign([this.keypair]);
      return Buffer.from(versionedTx.serialize()).toString('base64');
    } catch {
      // 回退到 Legacy Transaction
      const legacyTx = Transaction.from(txBuffer);
      legacyTx.sign(this.keypair);
      return legacyTx.serialize().toString('base64');
    }
  }

  // 获取状态
  getState() {
    return {
      address: this.address,
      isLocked: this.isLocked,
    };
  }
}

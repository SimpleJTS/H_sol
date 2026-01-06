import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { Buffer } from 'buffer';
import { encrypt, decrypt } from '../shared/crypto';
import { saveEncryptedKey, getEncryptedKey, clearWallet } from '../shared/storage';

export class WalletManager {
  private keypair: Keypair | null = null;
  private address: string = '';
  private lockTimeout: ReturnType<typeof setTimeout> | null = null;
  private autoLockMs: number = 30 * 60 * 1000; // 30分钟

  get isLocked(): boolean {
    // 锁定功能已完全禁用，钱包永远不锁定
    return false;
  }

  get publicKey(): string {
    return this.address;
  }

  // 设置自动锁定时间（已禁用）
  setAutoLock(minutes: number) {
    // 自动锁定功能已禁用
    this.autoLockMs = 0;
    this.resetLockTimer();
  }

  // 重置锁定计时器
  private resetLockTimer() {
    if (this.lockTimeout) {
      clearTimeout(this.lockTimeout);
      this.lockTimeout = null;
    }
    // 自动锁定功能已禁用，不再设置定时器
  }

  // 导入私钥并加密存储（使用默认密码）
  async importKey(privateKeyBase58: string, password?: string): Promise<string> {
    try {
      // 验证私钥格式
      if (!privateKeyBase58 || privateKeyBase58.trim().length === 0) {
        throw new Error('私钥不能为空');
      }

      const secretKey = bs58.decode(privateKeyBase58.trim());
      
      // 验证私钥长度（Solana私钥应该是64字节）
      if (secretKey.length !== 64) {
        throw new Error('私钥长度无效，应为64字节');
      }

      const keypair = Keypair.fromSecretKey(secretKey);
      const address = keypair.publicKey.toBase58();

      // 使用默认密码（如果未提供）
      const defaultPassword = password || 'sol-sniper-default-password';
      
      // 加密存储
      const encrypted = await encrypt(privateKeyBase58.trim(), defaultPassword);
      await saveEncryptedKey(encrypted, address);

      // 解锁钱包
      this.keypair = keypair;
      this.address = address;
      this.resetLockTimer();

      console.log('[Wallet] 钱包导入成功:', address);
      return address;
    } catch (error: any) {
      console.error('[Wallet] 导入钱包失败:', error);
      // 如果错误已经有消息，直接抛出；否则包装错误
      if (error.message) {
        throw error;
      }
      throw new Error(`导入钱包失败: ${error.toString()}`);
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

  // 检查是否有存储的钱包，如果有则自动解锁
  async hasStoredWallet(): Promise<boolean> {
    const stored = await getEncryptedKey();
    if (stored) {
      this.address = stored.address;
      // 自动解锁钱包（使用默认密码或存储的密码）
      // 注意：这里需要密码，但为了简化，我们假设钱包已经导入并解锁
      // 实际使用时，钱包导入后会自动解锁
      return true;
    }
    return false;
  }

  // 自动解锁钱包（在初始化时调用，使用默认密码）
  async autoUnlock(): Promise<boolean> {
    const stored = await getEncryptedKey();
    if (!stored) return false;

    try {
      const defaultPassword = 'sol-sniper-default-password';
      const privateKey = await decrypt(stored.encryptedKey, defaultPassword);
      const secretKey = bs58.decode(privateKey);
      this.keypair = Keypair.fromSecretKey(secretKey);
      this.address = stored.address;
      return true;
    } catch {
      return false;
    }
  }

  // 签名交易 (支持legacy和versioned)
  // 返回 base58 编码的字符串（Solana RPC 需要 base58）
  signTransaction(txBase64: string): string {
    const startTime = performance.now();
    if (!this.keypair) {
      // 如果keypair为空，尝试从存储中恢复
      throw new Error('钱包未初始化，请重新导入钱包');
    }

    try {
      console.log('[Wallet] → 开始签名交易，原始数据长度:', txBase64.length, '字符');
      const txBuffer = Buffer.from(txBase64, 'base64');

      try {
        // 尝试作为 VersionedTransaction 解析
        const parseStart = performance.now();
        const versionedTx = VersionedTransaction.deserialize(txBuffer);
        const parseTime = performance.now() - parseStart;
        console.log('[Wallet]   解析为 VersionedTransaction，耗时:', parseTime.toFixed(2), 'ms');
        
        const signStart = performance.now();
        versionedTx.sign([this.keypair]);
        const signTime = performance.now() - signStart;
        console.log('[Wallet]   签名完成，耗时:', signTime.toFixed(2), 'ms');
        
        const serializeStart = performance.now();
        const serialized = versionedTx.serialize();
        const signedTx = bs58.encode(serialized);
        const serializeTime = performance.now() - serializeStart;
        const totalTime = performance.now() - startTime;
        
        console.log('[Wallet] ✓ 交易签名成功 (VersionedTransaction)');
        console.log('[Wallet]   性能: 解析', parseTime.toFixed(2), 'ms, 签名', signTime.toFixed(2), 'ms, 序列化', serializeTime.toFixed(2), 'ms, 总计', totalTime.toFixed(2), 'ms');
        console.log('[Wallet]   签名后长度:', signedTx.length, '字符');
        return signedTx;
      } catch (versionedError) {
        console.log('[Wallet] VersionedTransaction 解析失败，尝试 Legacy Transaction');
        // 回退到 Legacy Transaction
        const parseStart = performance.now();
        const legacyTx = Transaction.from(txBuffer);
        const parseTime = performance.now() - parseStart;
        console.log('[Wallet]   解析为 Legacy Transaction，耗时:', parseTime.toFixed(2), 'ms');
        
        const signStart = performance.now();
        legacyTx.sign(this.keypair);
        const signTime = performance.now() - signStart;
        console.log('[Wallet]   签名完成，耗时:', signTime.toFixed(2), 'ms');
        
        const serializeStart = performance.now();
        const serialized = legacyTx.serialize();
        const signedTx = bs58.encode(serialized);
        const serializeTime = performance.now() - serializeStart;
        const totalTime = performance.now() - startTime;
        
        console.log('[Wallet] ✓ 交易签名成功 (Legacy Transaction)');
        console.log('[Wallet]   性能: 解析', parseTime.toFixed(2), 'ms, 签名', signTime.toFixed(2), 'ms, 序列化', serializeTime.toFixed(2), 'ms, 总计', totalTime.toFixed(2), 'ms');
        console.log('[Wallet]   签名后长度:', signedTx.length, '字符');
        return signedTx;
      }
    } catch (error: any) {
      const totalTime = performance.now() - startTime;
      console.error('[Wallet] 签名交易失败 (耗时:', totalTime.toFixed(2), 'ms):', error);
      throw new Error(`签名交易失败: ${error.message || error.toString()}`);
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

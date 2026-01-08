import { Connection, Transaction, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import { Buffer } from 'buffer';
import bs58 from 'bs58';

// Jito Bundle API 端点
const JITO_BUNDLE_API = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';

export interface JitoBundleResponse {
  uuid: string;
}

export interface BundleStatus {
  uuid: string;
  status: 'pending' | 'landed' | 'failed' | 'timeout';
  transactions?: string[]; // 交易签名数组
  error?: string;
}

export class JitoClient {
  private connection: Connection;
  private tipAccount: string; // Jito tip 账户

  constructor(rpcUrl: string, tipAccount: string = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmxvrDjjF') {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.tipAccount = tipAccount;
  }

  // 发送 Bundle（最多 5 个交易）
  // 返回 { bundleId: string } 或 null（如果限流，返回 null 以便降级）
  async sendBundle(signedTransactions: string[], retries: number = 3): Promise<string | null> {
    const startTime = performance.now();
    
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        if (signedTransactions.length === 0) {
          throw new Error('Bundle 不能为空');
        }
        if (signedTransactions.length > 5) {
          throw new Error('Bundle 最多只能包含 5 个交易');
        }

        // 如果不是第一次尝试，添加延迟
        if (attempt > 0) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // 指数退避，最多 5 秒
          console.log(`[Jito] 重试 ${attempt}/${retries}，等待 ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        console.log('[Jito] → 发送 Bundle，包含', signedTransactions.length, '个交易', attempt > 0 ? `(重试 ${attempt}/${retries})` : '');

        // Jito Bundle API 期望接收 base64 编码的交易数组
        // signedTransactions 是 base58 编码的字符串，需要解码后转换为 base64
        const transactions = signedTransactions.map(txBase58 => {
          try {
            // 解码 base58 得到 Buffer
            const txBuffer = bs58.decode(txBase58);
            // 转换为 base64
            return txBuffer.toString('base64');
          } catch (error: any) {
            console.error('[Jito] 交易编码转换失败:', error);
            throw new Error(`交易编码转换失败: ${error.message}`);
          }
        });

        const response = await fetch(JITO_BUNDLE_API, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendBundle',
            params: [transactions],
          }),
        });

        const fetchTime = performance.now() - startTime;

        if (!response.ok) {
          // 如果是 429 限流错误，尝试重试或返回 null
          if (response.status === 429) {
            const errorText = await response.text().catch(() => '');
            console.warn(`[Jito] 限流错误 (${response.status})，尝试 ${attempt + 1}/${retries}:`, errorText);
            if (attempt < retries - 1) {
              continue; // 继续重试
            } else {
              // 最后一次重试也失败，返回 null 以便降级
              console.warn('[Jito] 限流重试失败，将降级到直接发送交易');
              return null;
            }
          }
          
          const errorText = await response.text().catch(() => '');
          const errorMsg = `Jito Bundle 发送失败: ${response.status} ${errorText || response.statusText}`;
          console.error('[Jito] Bundle 发送失败 (耗时:', fetchTime.toFixed(2), 'ms):', errorMsg);
          throw new Error(errorMsg);
        }

        const data = await response.json();
        const totalTime = performance.now() - startTime;

        if (data.error) {
          // 检查是否是限流错误
          if (data.error.code === -32097 || (data.error.message && data.error.message.includes('rate limit'))) {
            console.warn(`[Jito] 限流错误，尝试 ${attempt + 1}/${retries}:`, data.error.message);
            if (attempt < retries - 1) {
              continue; // 继续重试
            } else {
              // 最后一次重试也失败，返回 null 以便降级
              console.warn('[Jito] 限流重试失败，将降级到直接发送交易');
              return null;
            }
          }
          
          console.error('[Jito] Bundle 发送失败 (耗时:', totalTime.toFixed(2), 'ms):', data.error);
          throw new Error(data.error.message || 'Bundle 发送失败');
        }

        const bundleId = data.result;
        console.log('[Jito] ✓ Bundle 发送成功，耗时:', totalTime.toFixed(2), 'ms, Bundle ID:', bundleId);
        return bundleId;
      } catch (error: any) {
        const totalTime = performance.now() - startTime;
        // 如果是最后一次尝试，抛出错误
        if (attempt === retries - 1) {
          console.error('[Jito] Bundle 发送异常 (耗时:', totalTime.toFixed(2), 'ms):', error);
          throw error;
        }
        // 否则继续重试
        console.warn(`[Jito] Bundle 发送异常，尝试 ${attempt + 1}/${retries}:`, error.message);
      }
    }
    
    // 所有重试都失败
    return null;
  }

  // 轮询 Bundle 状态
  async pollBundleStatus(bundleId: string, timeout: number = 30000): Promise<BundleStatus> {
    const startTime = Date.now();
    const pollInterval = 500; // 每 500ms 轮询一次

    console.log('[Jito] → 开始轮询 Bundle 状态，Bundle ID:', bundleId);

    while (Date.now() - startTime < timeout) {
      try {
        const response = await fetch(`${JITO_BUNDLE_API}/${bundleId}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          continue;
        }

        const data = await response.json();

        if (data.error) {
          console.warn('[Jito] 查询 Bundle 状态失败:', data.error);
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          continue;
        }

        const status: BundleStatus = data.result;

        if (status.status === 'landed') {
          const elapsed = Date.now() - startTime;
          console.log('[Jito] ✓ Bundle 已落地，耗时:', elapsed, 'ms');
          return status;
        }

        if (status.status === 'failed' || status.status === 'timeout') {
          const elapsed = Date.now() - startTime;
          console.warn('[Jito] ⚠ Bundle 失败或超时，耗时:', elapsed, 'ms, 状态:', status.status);
          return status;
        }

        // 状态为 pending，继续轮询
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      } catch (error: any) {
        console.warn('[Jito] 轮询 Bundle 状态异常:', error.message);
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }

    // 超时
    const elapsed = Date.now() - startTime;
    console.warn('[Jito] ⚠ Bundle 轮询超时，耗时:', elapsed, 'ms');
    return {
      uuid: bundleId,
      status: 'timeout',
      error: '轮询超时',
    };
  }

  // 发送 Bundle 并轮询确认
  async sendAndConfirmBundle(
    signedTransactions: string[],
    timeout: number = 30000
  ): Promise<BundleStatus> {
    const bundleId = await this.sendBundle(signedTransactions);
    return await this.pollBundleStatus(bundleId, timeout);
  }
}


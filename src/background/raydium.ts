import { Connection, PublicKey, Transaction, SystemProgram, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, getAccount, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Buffer } from 'buffer';
import { LAMPORTS_PER_SOL } from '../shared/types';

// Raydium 程序 ID
const RAYDIUM_AMM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CLMM = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');

export class RaydiumClient {
  private connection: Connection;
  private priorityFee: number;

  constructor(rpcUrl: string, priorityFee: number = 100000) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.priorityFee = priorityFee;
  }

  updateSettings(priorityFee: number) {
    this.priorityFee = priorityFee;
  }

  // 获取 Token 精度
  async getTokenDecimals(mint: string): Promise<number> {
    try {
      const mintPubkey = new PublicKey(mint);
      const mintInfo = await this.connection.getParsedAccountInfo(mintPubkey);
      if (mintInfo.value && 'parsed' in mintInfo.value.data) {
        return (mintInfo.value.data as any).parsed.info.decimals;
      }
      return 9; // 默认精度
    } catch (error) {
      console.warn('[Raydium] 获取精度失败，使用默认值 9:', error);
      return 9;
    }
  }

  // 构建买入交易 (SOL -> Token)
  async buildBuyTransaction(
    tokenMint: string,
    solAmount: number,
    userPublicKey: string
  ): Promise<Transaction> {
    const startTime = performance.now();
    try {
      console.log('[Raydium] 构建买入交易:', { tokenMint, solAmount, userPublicKey });
      
      const transaction = new Transaction();
      const userKey = new PublicKey(userPublicKey);
      const mintKey = new PublicKey(tokenMint);
      const solAmountLamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

      // 添加优先费指令
      const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: this.priorityFee,
      });
      transaction.add(priorityFeeIx);

      // 添加计算单元限制
      const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 200000,
      });
      transaction.add(computeLimitIx);

      // 获取或创建用户的 Token 账户
      const userTokenAccount = await getAssociatedTokenAddress(mintKey, userKey);
      
      try {
        await getAccount(this.connection, userTokenAccount);
      } catch {
        // Token 账户不存在，需要创建
        const createATAIx = createAssociatedTokenAccountInstruction(
          userKey,
          userTokenAccount,
          userKey,
          mintKey
        );
        transaction.add(createATAIx);
      }

      // Raydium 买入指令
      // 注意：这里需要根据实际的 Raydium 合约接口调整
      // 需要找到对应的流动性池地址
      const buyIx = new TransactionInstruction({
        programId: RAYDIUM_AMM_V4,
        keys: [
          { pubkey: userKey, isSigner: true, isWritable: true },
          { pubkey: mintKey, isSigner: false, isWritable: false },
          { pubkey: userTokenAccount, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([]), // 需要根据实际合约接口填充
      });

      transaction.add(buyIx);

      // 获取最新 blockhash
      const { blockhash } = await this.connection.getLatestBlockhash('finalized');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = userKey;

      const totalTime = performance.now() - startTime;
      console.log('[Raydium] ✓ 买入交易构建成功，耗时:', totalTime.toFixed(2), 'ms');
      
      return transaction;
    } catch (error: any) {
      const totalTime = performance.now() - startTime;
      console.error('[Raydium] 构建买入交易失败 (耗时:', totalTime.toFixed(2), 'ms):', error);
      throw error;
    }
  }

  // 构建卖出交易 (Token -> SOL)
  async buildSellTransaction(
    tokenMint: string,
    tokenAmount: number,
    decimals: number,
    userPublicKey: string
  ): Promise<Transaction> {
    const startTime = performance.now();
    try {
      console.log('[Raydium] 构建卖出交易:', { tokenMint, tokenAmount, decimals, userPublicKey });
      
      const transaction = new Transaction();
      const userKey = new PublicKey(userPublicKey);
      const mintKey = new PublicKey(tokenMint);
      const tokenAmountRaw = BigInt(Math.floor(tokenAmount * Math.pow(10, decimals)));

      // 添加优先费指令
      const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: this.priorityFee,
      });
      transaction.add(priorityFeeIx);

      // 添加计算单元限制
      const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 200000,
      });
      transaction.add(computeLimitIx);

      // 获取用户的 Token 账户
      const userTokenAccount = await getAssociatedTokenAddress(mintKey, userKey);

      // Raydium 卖出指令
      const sellIx = new TransactionInstruction({
        programId: RAYDIUM_AMM_V4,
        keys: [
          { pubkey: userKey, isSigner: true, isWritable: true },
          { pubkey: mintKey, isSigner: false, isWritable: false },
          { pubkey: userTokenAccount, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([]), // 需要根据实际合约接口填充
      });

      transaction.add(sellIx);

      // 获取最新 blockhash
      const { blockhash } = await this.connection.getLatestBlockhash('finalized');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = userKey;

      const totalTime = performance.now() - startTime;
      console.log('[Raydium] ✓ 卖出交易构建成功，耗时:', totalTime.toFixed(2), 'ms');
      
      return transaction;
    } catch (error: any) {
      const totalTime = performance.now() - startTime;
      console.error('[Raydium] 构建卖出交易失败 (耗时:', totalTime.toFixed(2), 'ms):', error);
      throw error;
    }
  }
}


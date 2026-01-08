import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
  ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
} from '@solana/spl-token';
import { Buffer } from 'buffer';
import { LAMPORTS_PER_SOL } from '../shared/types';

// Pump.fun 合约地址
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
const PUMP_FEE = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJtH1KH98hTi');
const PUMP_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');

export class PumpClient {
  private connection: Connection;
  private priorityFee: number;
  private slippageBps: number;

  constructor(rpcUrl: string, priorityFee: number = 200000, slippageBps: number = 2500) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.priorityFee = priorityFee;
    this.slippageBps = slippageBps;
  }

  updateSettings(priorityFee: number, slippageBps: number = 2500) {
    this.priorityFee = priorityFee;
    this.slippageBps = slippageBps;
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
      console.warn('[Pump] 获取精度失败，使用默认值 9:', error);
      return 9;
    }
  }

  // 构建买入交易 (SOL -> Token)
  async buildBuyTransaction(
    tokenMint: string,
    solAmount: number,
    userPublicKey: string
  ): Promise<VersionedTransaction> {
    const startTime = performance.now();
    try {
      console.log('[Pump] 构建买入交易:', { tokenMint, solAmount, userPublicKey });
      
      const mint = new PublicKey(tokenMint);
      const userKey = new PublicKey(userPublicKey);
      const solLamports = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL));

      // 找到 bonding curve
      const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), mint.toBuffer()],
        PUMP_PROGRAM
      );

      // 并行获取所有需要的数据
      const [curveInfo, blockhashInfo, userAta, bondingCurveAta, ataInfo] = await Promise.all([
        this.connection.getAccountInfo(bondingCurve),
        this.connection.getLatestBlockhash('confirmed'),
        getAssociatedTokenAddress(mint, userKey),
        getAssociatedTokenAddress(mint, bondingCurve, true),
        getAssociatedTokenAddress(mint, userKey).then(ata =>
          this.connection.getAccountInfo(ata)
        ),
      ]);

      if (!curveInfo) {
        throw new Error('Bonding curve not found');
      }

      // 确保 data 是 Buffer 类型
      let curveData: Buffer;
      if (Buffer.isBuffer(curveInfo.data)) {
        curveData = curveInfo.data;
      } else if (typeof curveInfo.data === 'string') {
        // 如果是 base64 字符串，需要解码
        curveData = Buffer.from(curveInfo.data, 'base64');
      } else if (Array.isArray(curveInfo.data)) {
        // 如果是数组，转换为 Buffer
        curveData = Buffer.from(curveInfo.data);
      } else {
        throw new Error('Invalid bonding curve data format');
      }

      // 检查 Buffer 长度是否足够（至少需要 24 字节：8 + 8 + 8）
      if (curveData.length < 24) {
        // 如果数据长度为 0，可能是账户不存在或不是 Pump.fun token
        if (curveData.length === 0) {
          throw new Error('Bonding curve account not found or empty. This token may not be a Pump.fun token.');
        }
        throw new Error(`Bonding curve data too short: ${curveData.length} bytes, expected at least 24`);
      }

      // 解析 curve 数据
      const virtualTokenReserves = curveData.readBigUInt64LE(8);
      const virtualSolReserves = curveData.readBigUInt64LE(16);

      // 计算预期代币
      const product = virtualTokenReserves * virtualSolReserves;
      const newSolReserves = virtualSolReserves + solLamports;
      const newTokenReserves = product / newSolReserves + 1n;
      const expectedTokens = virtualTokenReserves - newTokenReserves;
      const minTokens = (expectedTokens * BigInt(10000 - this.slippageBps)) / 10000n;

      console.log(`[Pump] 预期获得: ${expectedTokens}, 最少: ${minTokens}`);

      const instructions: TransactionInstruction[] = [];

      // Priority fee
      instructions.push(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 80000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityFee })
      );

      // 创建 ATA
      if (!ataInfo) {
        instructions.push(
          createAssociatedTokenAccountInstruction(
            userKey,
            userAta,
            userKey,
            mint
          )
        );
      }

      // Buy 指令
      const buyData = Buffer.alloc(24);
      buyData.write('66063d1201daebea', 'hex');
      buyData.writeBigUInt64LE(expectedTokens, 8);
      buyData.writeBigUInt64LE(solLamports, 16);

      instructions.push(
        new TransactionInstruction({
          keys: [
            { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
            { pubkey: PUMP_FEE, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bondingCurve, isSigner: false, isWritable: true },
            { pubkey: bondingCurveAta, isSigner: false, isWritable: true },
            { pubkey: userAta, isSigner: false, isWritable: true },
            { pubkey: userKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
            { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
          ],
          programId: PUMP_PROGRAM,
          data: buyData,
        })
      );

      const message = new TransactionMessage({
        payerKey: userKey,
        recentBlockhash: blockhashInfo.blockhash,
        instructions,
      }).compileToV0Message();

      const tx = new VersionedTransaction(message);

      const totalTime = performance.now() - startTime;
      console.log('[Pump] ✓ 买入交易构建成功，耗时:', totalTime.toFixed(2), 'ms');
      
      return tx;
    } catch (error: any) {
      const totalTime = performance.now() - startTime;
      console.error('[Pump] 构建买入交易失败 (耗时:', totalTime.toFixed(2), 'ms):', error);
      throw error;
    }
  }

  // 构建卖出交易 (Token -> SOL)
  async buildSellTransaction(
    tokenMint: string,
    tokenAmount: number,
    decimals: number,
    userPublicKey: string
  ): Promise<VersionedTransaction> {
    const startTime = performance.now();
    try {
      console.log('[Pump] 构建卖出交易:', { tokenMint, tokenAmount, decimals, userPublicKey });
      
      const mint = new PublicKey(tokenMint);
      const userKey = new PublicKey(userPublicKey);
      const tokenAmountRaw = BigInt(Math.floor(tokenAmount * Math.pow(10, decimals)));

      // 找到 bonding curve
      const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), mint.toBuffer()],
        PUMP_PROGRAM
      );

      const [curveInfo, blockhashInfo, userAta, bondingCurveAta] = await Promise.all([
        this.connection.getAccountInfo(bondingCurve),
        this.connection.getLatestBlockhash('confirmed'),
        getAssociatedTokenAddress(mint, userKey),
        getAssociatedTokenAddress(mint, bondingCurve, true),
      ]);

      if (!curveInfo) {
        throw new Error('Bonding curve not found');
      }

      // 确保 data 是 Buffer 类型
      let curveData: Buffer;
      if (Buffer.isBuffer(curveInfo.data)) {
        curveData = curveInfo.data;
      } else if (typeof curveInfo.data === 'string') {
        // 如果是 base64 字符串，需要解码
        curveData = Buffer.from(curveInfo.data, 'base64');
      } else if (Array.isArray(curveInfo.data)) {
        // 如果是数组，转换为 Buffer
        curveData = Buffer.from(curveInfo.data);
      } else {
        throw new Error('Invalid bonding curve data format');
      }

      // 检查 Buffer 长度是否足够（至少需要 24 字节：8 + 8 + 8）
      if (curveData.length < 24) {
        // 如果数据长度为 0，可能是账户不存在或不是 Pump.fun token
        if (curveData.length === 0) {
          throw new Error('Bonding curve account not found or empty. This token may not be a Pump.fun token.');
        }
        throw new Error(`Bonding curve data too short: ${curveData.length} bytes, expected at least 24`);
      }

      const virtualTokenReserves = curveData.readBigUInt64LE(8);
      const virtualSolReserves = curveData.readBigUInt64LE(16);

      // 计算预期 SOL
      const product = virtualTokenReserves * virtualSolReserves;
      const newTokenReserves = virtualTokenReserves + tokenAmountRaw;
      const newSolReserves = product / newTokenReserves + 1n;
      const expectedSol = virtualSolReserves - newSolReserves;
      const minSol = (expectedSol * BigInt(10000 - this.slippageBps)) / 10000n;

      console.log(`[Pump] 预期获得: ${expectedSol} lamports, 最少: ${minSol}`);

      const instructions: TransactionInstruction[] = [];

      instructions.push(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 80000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityFee })
      );

      // Sell 指令
      const sellData = Buffer.alloc(24);
      sellData.write('33e685a4017f83ad', 'hex');
      sellData.writeBigUInt64LE(tokenAmountRaw, 8);
      sellData.writeBigUInt64LE(minSol, 16);

      instructions.push(
        new TransactionInstruction({
          keys: [
            { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
            { pubkey: PUMP_FEE, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bondingCurve, isSigner: false, isWritable: true },
            { pubkey: bondingCurveAta, isSigner: false, isWritable: true },
            { pubkey: userAta, isSigner: false, isWritable: true },
            { pubkey: userKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
            { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
          ],
          programId: PUMP_PROGRAM,
          data: sellData,
        })
      );

      const message = new TransactionMessage({
        payerKey: userKey,
        recentBlockhash: blockhashInfo.blockhash,
        instructions,
      }).compileToV0Message();

      const tx = new VersionedTransaction(message);

      const totalTime = performance.now() - startTime;
      console.log('[Pump] ✓ 卖出交易构建成功，耗时:', totalTime.toFixed(2), 'ms');
      
      return tx;
    } catch (error: any) {
      const totalTime = performance.now() - startTime;
      console.error('[Pump] 构建卖出交易失败 (耗时:', totalTime.toFixed(2), 'ms):', error);
      throw error;
    }
  }
}


import {
  Horizon,
  Asset,
  Networks,
  TransactionBuilder,
  Operation,
  Account,
} from '@stellar/stellar-sdk';
import axios from 'axios';
import logger from '../utils/logger.js';

export interface AssetInfo {
  code: string;
  issuer?: string;
  isNative: boolean;
}

export interface LiquidityPool {
  id: string;
  type: 'constant_product' | 'stable' | 'concentrated';
  reserves: Array<{
    asset: AssetInfo;
    amount: string;
  }>;
  fee: number;
  trustlines: number;
  lastModified: Date;
}

export interface PathHop {
  asset: AssetInfo;
  poolId?: string;
  isIntermediate: boolean;
}

export interface PaymentPath {
  id: string;
  sourceAsset: AssetInfo;
  destinationAsset: AssetInfo;
  sourceAmount: string;
  destinationAmount: string;
  rate: number;
  priceImpact: number;
  fee: number;
  slippage: number;
  hops: PathHop[];
  optimal: boolean;
}

export interface PathFindOptions {
  sourceAsset: AssetInfo;
  destinationAsset: AssetInfo;
  amount: string;
  amountType: 'source' | 'destination';
  maximumSlippage?: number;
  maximumPriceImpact?: number;
  excludePoolTypes?: Array<'constant_product' | 'stable' | 'concentrated'>;
}

export interface PathPaymentParams {
  sourceAccount: string;
  destinationAccount: string;
  sourceAsset: AssetInfo;
  destinationAsset: AssetInfo;
  sourceAmount?: string;
  destinationAmount?: string;
  maximumSourceAmount: string;
  minimumDestinationAmount: string;
  path: PaymentPath;
  memo?: string;
}

export interface PathPaymentResult {
  success: boolean;
  txHash?: string;
  ledger?: number;
  actualSourceAmount?: string;
  actualDestinationAmount?: string;
  effectiveRate?: number;
  error?: string;
  partialFailure?: boolean;
  partialAmount?: string;
}

export interface LiquidityPoolStats {
  totalPools: number;
  totalLiquidityUSD: string;
  topPairs: Array<{
    base: string;
    quote: string;
    liquidity: string;
    volume24h: string;
  }>;
}

const HORIZON_URL = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const SOROSWAP_URL = process.env.SOROSWAP_API_URL || 'https://api.soroswap.finance';
const STELLARDEX_URL = process.env.STELLARDEX_API_URL;

const KNOWN_ASSETS: Record<string, AssetInfo> = {
  XLM: { code: 'XLM', isNative: true },
  USDC: {
    code: 'USDC',
    issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3KLQEH2Y6DFOUHD7I2DMSK7P',
    isNative: false,
  },
  EURT: {
    code: 'EURT',
    issuer: 'GAP5LETOF6IYPPQ2CLRQIH5TZ6XMPJCUAL7RDQZ6LTNWEKO7LFN6CXKS',
    isNative: false,
  },
  ARST: {
    code: 'ARST',
    issuer: 'GDVFDA2JCWWQPQQYGQJ36B3TT5HZGMPJQ6NE5JN6A7SPQRQWGCSTARS',
    isNative: false,
  },
  NGNC: {
    code: 'NGNC',
    issuer: 'GDGU46XQ2RVEGYYJXWNNGTIEGBBXP7WKJCIFSYEPVR2OFPJ4LDISPQRQ',
    isNative: false,
  },
  BRZC: {
    code: 'BRZC',
    issuer: 'GDVKSWQV6WNMKZDXQ4MMEE5JMN5GD4XDGBRBR5EC4UKFPQIL5J7WNCRL',
    isNative: false,
  },
};

function createStellarAsset(assetInfo: AssetInfo): Asset {
  if (assetInfo.isNative || assetInfo.code === 'XLM') {
    return Asset.native();
  }
  if (!assetInfo.issuer) {
    throw new Error(`Non-native asset ${assetInfo.code} requires an issuer`);
  }
  return new Asset(assetInfo.code, assetInfo.issuer);
}

function assetToInfo(asset: Asset): AssetInfo {
  if (asset.isNative()) {
    return { code: 'XLM', isNative: true };
  }
  return {
    code: asset.getCode(),
    issuer: asset.getIssuer(),
    isNative: false,
  };
}

function generatePathId(): string {
  return `path_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function calculatePriceImpact(
  sourceReserve: string,
  destinationReserve: string,
  sourceAmount: string
): number {
  const sr = parseFloat(sourceReserve);
  const dr = parseFloat(destinationReserve);
  const sa = parseFloat(sourceAmount);

  if (sr <= 0 || dr <= 0) return 0;

  const k = sr * dr;
  const newSr = sr + sa;
  const newDr = k / newSr;
  const outputDr = dr - newDr;
  const idealOutput = (dr / sr) * sa;

  if (idealOutput <= 0) return 0;
  return Math.max(0, ((idealOutput - outputDr) / idealOutput) * 100);
}

function calculateSlippage(expectedRate: number, actualRate: number): number {
  if (expectedRate <= 0) return 100;
  return Math.abs((expectedRate - actualRate) / expectedRate) * 100;
}

export class AssetPathPaymentService {
  private static horizonServer: Horizon.Server | null = null;

  private static getHorizonServer(): Horizon.Server {
    if (!this.horizonServer) {
      this.horizonServer = new Horizon.Server(HORIZON_URL);
    }
    return this.horizonServer;
  }

  static async findOptimalPath(options: PathFindOptions): Promise<PaymentPath[]> {
    const paths: PaymentPath[] = [];

    const horizonPaths = await this.findHorizonPaths(options);
    paths.push(...horizonPaths);

    if (options.sourceAsset.code !== 'XLM' && options.destinationAsset.code !== 'XLM') {
      const viaXlmPaths = await this.findIntermediatePaths(options, KNOWN_ASSETS.XLM);
      paths.push(...viaXlmPaths);
    }

    if (options.sourceAsset.code !== 'USDC' && options.destinationAsset.code !== 'USDC') {
      const viaUsdcPaths = await this.findIntermediatePaths(options, KNOWN_ASSETS.USDC);
      paths.push(...viaUsdcPaths);
    }

    const validPaths = paths.filter((p) => {
      if (options.maximumSlippage && p.slippage > options.maximumSlippage) {
        return false;
      }
      if (options.maximumPriceImpact && p.priceImpact > options.maximumPriceImpact) {
        return false;
      }
      return true;
    });

    validPaths.sort((a, b) => {
      const aRate = parseFloat(a.destinationAmount) / parseFloat(a.sourceAmount);
      const bRate = parseFloat(b.destinationAmount) / parseFloat(b.sourceAmount);
      return bRate - aRate;
    });

    if (validPaths.length > 0) {
      validPaths[0].optimal = true;
    }

    return validPaths;
  }

  private static async findHorizonPaths(options: PathFindOptions): Promise<PaymentPath[]> {
    try {
      const server = this.getHorizonServer();
      const sourceAsset = createStellarAsset(options.sourceAsset);
      const destAsset = createStellarAsset(options.destinationAsset);

      const endpoint =
        options.amountType === 'source'
          ? `/paths/strict-send?source_asset_type=${sourceAsset.isNative() ? 'native' : `credit_alphanum4`}&source_asset_code=${sourceAsset.getCode()}&source_asset_issuer=${sourceAsset.getIssuer() || ''}&source_amount=${options.amount}&destination_asset_type=${destAsset.isNative() ? 'native' : 'credit_alphanum4'}&destination_asset_code=${destAsset.getCode()}&destination_asset_issuer=${destAsset.getIssuer() || ''}`
          : `/paths/strict-receive?destination_asset_type=${destAsset.isNative() ? 'native' : 'credit_alphanum4'}&destination_asset_code=${destAsset.getCode()}&destination_asset_issuer=${destAsset.getIssuer() || ''}&destination_amount=${options.amount}&source_asset_type=${sourceAsset.isNative() ? 'native' : 'credit_alphanum4'}&source_asset_code=${sourceAsset.getCode()}&source_asset_issuer=${sourceAsset.getIssuer() || ''}`;

      const response = await axios.get(`${HORIZON_URL}${endpoint}`);
      const records = response.data._embedded?.records || [];

      return records.slice(0, 10).map((record: any) => {
        const sourceAmount = record.source_amount || options.amount;
        const destAmount = record.destination_amount || '0';
        const rate =
          parseFloat(sourceAmount) > 0 ? parseFloat(destAmount) / parseFloat(sourceAmount) : 0;

        const hops: PathHop[] = (record.path || []).map((asset: any) => ({
          asset: asset.isNative()
            ? { code: 'XLM', isNative: true }
            : { code: asset.asset_code, issuer: asset.asset_issuer, isNative: false },
          isIntermediate: true,
        }));

        return {
          id: generatePathId(),
          sourceAsset: options.sourceAsset,
          destinationAsset: options.destinationAsset,
          sourceAmount,
          destinationAmount: destAmount,
          rate,
          priceImpact: calculatePriceImpact('1000000', '1000000', sourceAmount),
          fee: parseFloat(sourceAmount) * 0.001,
          slippage: 0.5,
          hops: [
            { asset: options.sourceAsset, isIntermediate: false },
            ...hops,
            { asset: options.destinationAsset, isIntermediate: false },
          ],
          optimal: false,
        };
      });
    } catch (error) {
      logger.error('Failed to find Horizon paths', { error, options });
      return [];
    }
  }

  private static async findIntermediatePaths(
    options: PathFindOptions,
    intermediateAsset: AssetInfo
  ): Promise<PaymentPath[]> {
    try {
      const sourceToIntermediate = await this.findHorizonPaths({
        ...options,
        destinationAsset: intermediateAsset,
        amount: options.amount,
        amountType: options.amountType,
      });

      if (sourceToIntermediate.length === 0) return [];

      const bestSourceToIntermediate = sourceToIntermediate[0];
      const intermediateAmount = bestSourceToIntermediate.destinationAmount;

      const intermediateToDest = await this.findHorizonPaths({
        sourceAsset: intermediateAsset,
        destinationAsset: options.destinationAsset,
        amount: intermediateAmount,
        amountType: 'source',
      });

      if (intermediateToDest.length === 0) return [];

      const bestIntermediateToDest = intermediateToDest[0];
      const totalSourceAmount = parseFloat(bestSourceToIntermediate.sourceAmount);
      const totalDestAmount = parseFloat(bestIntermediateToDest.destinationAmount);
      const overallRate = totalDestAmount / totalSourceAmount;
      const combinedSlippage = bestSourceToIntermediate.slippage + bestIntermediateToDest.slippage;
      const combinedFee = bestSourceToIntermediate.fee + bestIntermediateToDest.fee;

      const combinedPath: PaymentPath = {
        id: generatePathId(),
        sourceAsset: options.sourceAsset,
        destinationAsset: options.destinationAsset,
        sourceAmount: bestSourceToIntermediate.sourceAmount,
        destinationAmount: bestIntermediateToDest.destinationAmount,
        rate: overallRate,
        priceImpact: Math.max(
          bestSourceToIntermediate.priceImpact,
          bestIntermediateToDest.priceImpact
        ),
        fee: combinedFee,
        slippage: combinedSlippage,
        hops: [
          { asset: options.sourceAsset, isIntermediate: false },
          { asset: intermediateAsset, poolId: bestSourceToIntermediate.id, isIntermediate: true },
          { asset: options.destinationAsset, isIntermediate: false },
        ],
        optimal: false,
      };

      return [combinedPath];
    } catch (error) {
      logger.error('Failed to find intermediate paths', { error, intermediateAsset });
      return [];
    }
  }

  static async executePathPayment(params: PathPaymentParams): Promise<PathPaymentResult> {
    try {
      const server = this.getHorizonServer();
      const sourceAccount = await server.loadAccount(params.sourceAccount);

      const sourceAsset = createStellarAsset(params.sourceAsset);
      const destAsset = createStellarAsset(params.destinationAsset);

      const pathAssets = params.path.hops
        .filter((h) => h.isIntermediate)
        .map((h) => createStellarAsset(h.asset));

      const maxSourceAmount = params.maximumSourceAmount;
      const minDestAmount = params.minimumDestinationAmount;

      const operation = Operation.pathPaymentStrictSend({
        sendAsset: sourceAsset,
        sendAmount: params.sourceAmount || maxSourceAmount,
        destination: params.destinationAccount,
        destAsset,
        destMin: minDestAmount,
        path: pathAssets,
      });

      const transaction = new TransactionBuilder(sourceAccount, {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      logger.info('Path payment transaction built', {
        sourceAccount: params.sourceAccount,
        destinationAccount: params.destinationAccount,
        sourceAsset: params.sourceAsset.code,
        destinationAsset: params.destinationAsset.code,
        sourceAmount: params.sourceAmount,
        minDestAmount,
      });

      return {
        success: true,
        txHash: transaction.hash().toString('hex'),
        effectiveRate:
          parseFloat(params.destinationAmount) / parseFloat(params.sourceAmount || '1'),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      if (errorMessage.includes('underfunded') || errorMessage.includes('insufficient')) {
        return {
          success: false,
          error: 'Insufficient balance for path payment',
          partialFailure: false,
        };
      }

      if (errorMessage.includes('no_path') || errorMessage.includes('path_')) {
        return {
          success: false,
          error: 'No valid path found between assets',
          partialFailure: true,
          partialAmount: '0',
        };
      }

      if (errorMessage.includes('exceeds') || errorMessage.includes('limit')) {
        return {
          success: false,
          error: 'Slippage tolerance exceeded',
          partialFailure: true,
        };
      }

      logger.error('Path payment execution failed', { error, params });
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  static async getLiquidityPools(assetPair?: {
    base: AssetInfo;
    quote: AssetInfo;
  }): Promise<LiquidityPool[]> {
    try {
      const poolsUrl = 'https://horizon-testnet.stellar.org/liquidity_pools';

      const response = await axios.get(poolsUrl, {
        params: assetPair
          ? {
              'reserves[asset_code]': assetPair.base.code,
              'reserves[asset_issuer]': assetPair.base.issuer || 'native',
            }
          : {},
      });

      const records = response.data._embedded?.records || [];

      return records.map((pool: any) => ({
        id: pool.id,
        type: 'constant_product' as const,
        reserves: pool.reserves.map((r: any) => ({
          asset: r.asset.isNative()
            ? { code: 'XLM', isNative: true }
            : { code: r.asset.asset_code, issuer: r.asset.asset_issuer, isNative: false },
          amount: r.amount,
        })),
        fee: parseFloat(pool.fee_bp || '30') / 100,
        trustlines: parseInt(pool.total_trustlines || '0', 10),
        lastModified: new Date(parseInt(pool.last_modified_ledger, 10) * 5),
      }));
    } catch (error) {
      logger.error('Failed to fetch liquidity pools', { error });
      return [];
    }
  }

  static async estimateSlippage(
    path: PaymentPath,
    amount: string
  ): Promise<{ estimatedSlippage: number; estimatedPriceImpact: number; estimatedOutput: string }> {
    const pools = await this.getLiquidityPools({
      base: path.sourceAsset,
      quote: path.destinationAsset,
    });

    if (pools.length === 0) {
      return {
        estimatedSlippage: path.slippage,
        estimatedPriceImpact: path.priceImpact,
        estimatedOutput: path.destinationAmount,
      };
    }

    const pool = pools[0];
    const sourceReserve = parseFloat(pool.reserves[0]?.amount || '0');
    const destReserve = parseFloat(pool.reserves[1]?.amount || '0');
    const inputAmount = parseFloat(amount);

    const k = sourceReserve * destReserve;
    const newSourceReserve = sourceReserve + inputAmount;
    const newDestReserve = k / newSourceReserve;
    const output = destReserve - newDestReserve;

    const priceImpact = calculatePriceImpact(
      pool.reserves[0].amount,
      pool.reserves[1].amount,
      amount
    );
    const expectedOutput = (destReserve / sourceReserve) * inputAmount;
    const slippage = calculateSlippage(expectedOutput, output);

    return {
      estimatedSlippage: slippage,
      estimatedPriceImpact: priceImpact,
      estimatedOutput: output.toString(),
    };
  }

  static async getSupportedAssets(): Promise<AssetInfo[]> {
    return Object.values(KNOWN_ASSETS);
  }

  static async getLiquidityPoolStats(): Promise<LiquidityPoolStats> {
    try {
      const response = await axios.get(`${HORIZON_URL}/liquidity_pools?limit=100`);
      const records = response.data._embedded?.records || [];

      const topPairs = new Map<string, { liquidity: number; volume: number }>();

      records.forEach((pool: any) => {
        if (pool.reserves && pool.reserves.length >= 2) {
          const base = pool.reserves[0].asset?.asset_code || 'XLM';
          const quote = pool.reserves[1].asset?.asset_code || 'XLM';
          const key = `${base}/${quote}`;
          const liquidity =
            parseFloat(pool.reserves[0].amount || '0') + parseFloat(pool.reserves[1].amount || '0');

          topPairs.set(key, {
            liquidity: (topPairs.get(key)?.liquidity || 0) + liquidity,
            volume: (topPairs.get(key)?.volume || 0) + liquidity * 0.1,
          });
        }
      });

      const sortedPairs = Array.from(topPairs.entries())
        .sort((a, b) => b[1].liquidity - a[1].liquidity)
        .slice(0, 10)
        .map(([pair, stats]) => {
          const [base, quote] = pair.split('/');
          return {
            base,
            quote,
            liquidity: stats.liquidity.toString(),
            volume24h: stats.volume.toString(),
          };
        });

      return {
        totalPools: records.length,
        totalLiquidityUSD: '10000000',
        topPairs: sortedPairs,
      };
    } catch (error) {
      logger.error('Failed to get liquidity pool stats', { error });
      return {
        totalPools: 0,
        totalLiquidityUSD: '0',
        topPairs: [],
      };
    }
  }
}

export const assetPathPaymentService = AssetPathPaymentService;

import { StellarService } from './stellarService.js';

export interface PaymentEntry {
  employeeId: string;
  employeeName: string;
  walletAddress: string;
  amount: string;
}

export interface ShortfallDetail {
  employeeId: string;
  employeeName: string;
  amount: string;
}

export interface PreflightResult {
  sufficient: boolean;
  distributionAccount: string;
  assetCode: string;
  availableBalance: string;
  totalRequired: string;
  shortfall: string;
  scheduledPayments: number;
  breakdown: ShortfallDetail[];
}

export class BalanceService {
  /**
   * Query Horizon for the balance of a given asset on an account.
   * Returns "0" and exists=false if the account has no trustline for the asset.
   * Pass assetCode='XLM' and assetIssuer=null (or '') to query the native balance.
   */
  static async getAssetBalance(
    accountPublicKey: string,
    assetCode: string,
    assetIssuer: string | null
  ): Promise<{ balance: string; exists: boolean }> {
    const server = StellarService.getServer();
    const account = await server.loadAccount(accountPublicKey);

    if (assetCode === 'XLM') {
      const nativeEntry = account.balances.find((b: any) => b.asset_type === 'native');
      return nativeEntry
        ? { balance: (nativeEntry as any).balance, exists: true }
        : { balance: '0', exists: false };
    }

    const entry = account.balances.find(
      (b: any) =>
        (b.asset_type === 'credit_alphanum12' || b.asset_type === 'credit_alphanum4') &&
        b.asset_code === assetCode &&
        b.asset_issuer === assetIssuer
    );

    if (!entry) {
      return { balance: '0', exists: false };
    }

    return { balance: (entry as any).balance, exists: true };
  }

  /**
   * @deprecated Use `getAssetBalance` instead.
   * Kept for backward-compatibility with existing callers that specify ORGUSD.
   */
  static async getOrgUsdBalance(
    accountPublicKey: string,
    assetIssuer: string
  ): Promise<{ balance: string; exists: boolean }> {
    return BalanceService.getAssetBalance(accountPublicKey, 'ORGUSD', assetIssuer);
  }

  /**
   * Run a preflight balance check before payroll execution.
   * Compares the distribution account's balance of `assetCode` against
   * the total of all scheduled payments. Returns a shortfall report when
   * the balance is insufficient.
   *
   * @param distributionAccount - Stellar public key of the paying account
   * @param assetCode           - Asset code to check ('USDC', 'EURC', 'ORGUSD', 'XLM', …)
   * @param assetIssuer         - Issuer address; null / '' for XLM
   * @param payments            - List of payment entries to total up
   */
  static async preflightCheck(
    distributionAccount: string,
    assetCode: string,
    assetIssuer: string | null,
    payments: PaymentEntry[]
  ): Promise<PreflightResult> {
    const { balance, exists } = await BalanceService.getAssetBalance(
      distributionAccount,
      assetCode,
      assetIssuer
    );

    const available = parseFloat(balance);
    const totalRequired = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);

    const shortfall = totalRequired - available;
    const sufficient = exists && available >= totalRequired;

    const breakdown: ShortfallDetail[] = payments.map((p) => ({
      employeeId: p.employeeId,
      employeeName: p.employeeName,
      amount: p.amount,
    }));

    return {
      sufficient,
      distributionAccount,
      assetCode,
      availableBalance: balance,
      totalRequired: totalRequired.toFixed(7),
      shortfall: sufficient ? '0' : shortfall.toFixed(7),
      scheduledPayments: payments.length,
      breakdown,
    };
  }
}

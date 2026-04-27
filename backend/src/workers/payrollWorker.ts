import { Worker, Job } from 'bullmq';
import { redisConnection, PAYROLL_QUEUE_NAME } from '../config/queue.js';
import { PayrollBonusService } from '../services/payrollBonusService.js';
import { PayrollJobData } from '../services/payrollQueueService.js';
import { StellarService } from '../services/stellarService.js';
import { PayrollAuditService } from '../services/payrollAuditService.js';
import { emitBulkUpdate } from '../services/socketService.js';
import { BalanceService } from '../services/balanceService.js';
import { webhookNotificationService } from '../services/webhookNotificationService.js';
import { NotificationQueueService } from '../services/notificationQueueService.js';
import { TransactionVerificationQueueService } from '../services/transactionVerificationQueueService.js';
import taxService from '../services/taxService.js';
import logger from '../utils/logger.js';
import { Keypair, Asset, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { getAssetIssuer } from '../config/assets.js';

/**
 * Worker to process payroll runs in the background.
 */
const notificationQueueService = new NotificationQueueService();
const txVerificationQueueService = TransactionVerificationQueueService;

export const payrollWorker = new Worker<PayrollJobData>(
  PAYROLL_QUEUE_NAME,
  async (job: Job<PayrollJobData>) => {
    const { payrollRunId } = job.data;
    logger.info(`Processing payroll run ${payrollRunId} (Job: ${job.id})`);

    try {
      // 1. Get payroll run and items
      const summary = await PayrollBonusService.getPayrollRunSummary(payrollRunId);
      if (!summary) {
        throw new Error(`Payroll run ${payrollRunId} not found`);
      }

      const { payroll_run, items } = summary;
      const batchId = payroll_run.batch_id;

      // Update status to processing
      await PayrollBonusService.updatePayrollRunStatus(payrollRunId, 'processing');
      emitBulkUpdate(batchId, 'processing', { progress: 0 });

      // 2. Prepare for blockchain transaction
      const distributionSecret = process.env.ORGUSD_DISTRIBUTION_SECRET;
      if (!distributionSecret) {
        throw new Error('ORGUSD_DISTRIBUTION_SECRET not configured on server');
      }

      const distributionKeypair = Keypair.fromSecret(distributionSecret);
      const assetCode = payroll_run.asset_code;
      const assetIssuer = assetCode !== 'XLM' ? getAssetIssuer(assetCode) : null;

      // 2a. Preflight balance check before execution for ORGUSD payroll runs.
      if (assetCode === 'ORGUSD') {
        if (!assetIssuer) {
          throw new Error('ORGUSD_ISSUER_PUBLIC not configured on server');
        }

        const preflightPayments = items.map((item) => ({
          employeeId: String(item.employee_id),
          employeeName:
            `${item.employee_first_name ?? ''} ${item.employee_last_name ?? ''}`.trim() ||
            item.employee_email ||
            `Employee #${item.employee_id}`,
          walletAddress: item.employee_wallet_address || 'N/A',
          amount: item.amount,
        }));

        const preflightResult = await BalanceService.preflightCheck(
          distributionKeypair.publicKey(),
          assetCode,
          assetIssuer,
          preflightPayments
        );

        if (!preflightResult.sufficient) {
          const shortfallReport = {
            payrollRunId,
            batchId,
            organizationId: payroll_run.organization_id,
            generatedAt: new Date().toISOString(),
            ...preflightResult,
          };

          await webhookNotificationService.dispatch(
            'balance.low',
            {
              message: 'Payroll aborted due to insufficient ORGUSD distribution balance.',
              shortfallReport,
            },
            payroll_run.organization_id
          );

          emitBulkUpdate(batchId, 'failed', {
            error: 'Insufficient ORGUSD balance. Payroll aborted before execution.',
            shortfallReport,
          });

          throw new Error(
            `Insufficient ORGUSD balance for payroll run ${payrollRunId}. ` +
              `Required: ${preflightResult.totalRequired}, Available: ${preflightResult.availableBalance}, ` +
              `Shortfall: ${preflightResult.shortfall}`
          );
        }
      }

      const asset = assetCode === 'XLM' ? Asset.native() : new Asset(assetCode, assetIssuer!);

      // 3. Group items into batches of 100 (Stellar transaction limit)
      const chunkSize = 100;
      const itemChunks = [];
      for (let i = 0; i < items.length; i += chunkSize) {
        itemChunks.push(items.slice(i, i + chunkSize));
      }

      let completedCount = 0;
      const totalItems = items.length;

      for (let i = 0; i < itemChunks.length; i++) {
        const chunk = itemChunks[i]!;
        logger.info(`Processing chunk ${i + 1}/${itemChunks.length} for run ${payrollRunId}`);

        try {
          const operations = [];
          

          for (const item of chunk) {
            if (!item.employee_wallet_address) {
              throw new Error(`Employee ${item.employee_id} has no wallet address`);
            }

            // Calculate and deduct taxes
            const taxResult = await taxService.calculateDeductions(
              payroll_run.organization_id,
              parseFloat(item.amount)
            );

            if (taxResult.total_tax > 0) {
              logger.info(`Applying tax deductions for employee ${item.employee_id}: Gross ${taxResult.gross_amount}, Tax ${taxResult.total_tax}, Net ${taxResult.net_amount}`);
              
              // Record each deduction for reporting
              for (const deduction of taxResult.deductions) {
                await taxService.recordDeduction(
                  payroll_run.organization_id,
                  item.employee_id,
                  null,
                  deduction.rule_id,
                  taxResult.gross_amount,
                  deduction.deducted_amount,
                  taxResult.net_amount,
                  payroll_run.period_start.toISOString(),
                  payroll_run.period_end.toISOString()
                );
              }
            }

            operations.push(
              Operation.payment({
                destination: item.employee_wallet_address,
                asset: asset,
                amount: taxResult.net_amount.toString(),
              })
            );
          }

          // Build and submit transaction
          const server = StellarService.getServer();
          const networkPassphrase = StellarService.getNetworkPassphrase();
          const account = await server.loadAccount(distributionKeypair.publicKey());

          const txBuilder = new TransactionBuilder(account, {
            fee: (1000 * operations.length).toString(),
            networkPassphrase,
          });

          operations.forEach((op) => txBuilder.addOperation(op));
          txBuilder.setTimeout(180);

          const tx = txBuilder.build();
          tx.sign(distributionKeypair);

          const result = await StellarService.submitTransaction(tx);
          logger.info(`Chunk ${i + 1} submitted successfully. Tx Hash: ${result.hash}`);

          // Verify on-chain & persist immutable audit record (async).
          try {
            await txVerificationQueueService.enqueue({
              txHash: result.hash,
              source: 'payroll',
              organizationId: payroll_run.organization_id,
            });
          } catch (enqueueError) {
            logger.warn('Failed to enqueue tx verification (continuing)', {
              txHash: result.hash,
              error: enqueueError instanceof Error ? enqueueError.message : 'Unknown error',
            });
          }

          // Update database for items in this chunk and log audit entries
          for (const item of chunk) {
            await PayrollBonusService.updateItemStatus(item.id, 'completed', result.hash);
            
            // Log successful transaction with item type
            await PayrollAuditService.logTransactionSucceeded(
              payroll_run.organization_id,
              payrollRunId,
              item.id,
              item.employee_id,
              result.hash,
              result.ledger || 0,
              item.amount,
              assetCode,
              item.item_type
            );
            
            // Enqueue notification job for this payment
            try {
              await notificationQueueService.enqueuePaymentNotification({
                transactionId: item.id,
                transactionHash: result.hash,
                employeeId: item.employee_id,
                organizationId: payroll_run.organization_id,
                amount: item.amount,
                assetCode: assetCode,
                timestamp: new Date().toISOString(),
              });
            } catch (notificationError) {
              // Log error but don't fail the payroll processing
              logger.error('Failed to enqueue notification', {
                transactionId: item.id,
                employeeId: item.employee_id,
                error: notificationError instanceof Error ? notificationError.message : 'Unknown error',
              });
            }
            
            completedCount++;
          }

          // Emit progress
          const progress = Math.round((completedCount / totalItems) * 100);
          emitBulkUpdate(batchId, 'processing', {
            progress,
            completedCount,
            totalItems,
            lastTxHash: result.hash
          });

        } catch (chunkError: any) {
          logger.error(`Failed to process chunk ${i + 1} for run ${payrollRunId}`, chunkError);

          for (const item of chunk) {
            await PayrollBonusService.updateItemStatus(item.id, 'failed');
            
            // Log failed transaction with item type
            await PayrollAuditService.logTransactionFailed(
              payroll_run.organization_id,
              payrollRunId,
              item.id,
              item.employee_id,
              'N/A',
              chunkError.message || 'Unknown error',
              item.amount,
              assetCode,
              item.item_type
            );
          }

          throw chunkError; // BullMQ will retry based on config
        }
      }

      // 4. Wrap up
      await PayrollBonusService.updatePayrollRunStatus(payrollRunId, 'completed');
      emitBulkUpdate(batchId, 'completed', { progress: 100, completedCount: totalItems });
      
      // Dispatch payroll.completed webhook
      void webhookNotificationService.dispatch('payroll.completed', {
        payrollRunId,
        batchId,
        organizationId: payroll_run.organization_id,
        completedCount: totalItems,
        assetCode
      }, payroll_run.organization_id);

      logger.info(`Successfully completed payroll run ${payrollRunId}`);
    } catch (error: any) {
      logger.error(`Critical failure in payroll worker for run ${payrollRunId}`, error);

      await PayrollBonusService.updatePayrollRunStatus(payrollRunId, 'failed');

      const summary = await PayrollBonusService.getPayrollRunSummary(payrollRunId);
      if (summary) {
        emitBulkUpdate(summary.payroll_run.batch_id, 'failed', {
          error: error.message,
        });

        // Dispatch payroll.failed webhook
        void webhookNotificationService.dispatch('payroll.failed', {
          payrollRunId,
          batchId: summary.payroll_run.batch_id,
          organizationId: summary.payroll_run.organization_id,
          error: error.message || 'Unknown error'
        }, summary.payroll_run.organization_id);
      }

      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: 1,
  }
);

payrollWorker.on('completed', (job) => {
  logger.info(`Payroll job ${job.id} completed successfully`);
});

payrollWorker.on('failed', (job, err) => {
  logger.error(`Payroll job ${job?.id} failed with error: ${err.message}`);
});

import { Router } from 'express';
import { DbScalingController } from '../controllers/dbScalingController.js';

const router = Router();
const ctrl = new DbScalingController();

/**
 * @swagger
 * tags:
 *   name: DB Scaling
 *   description: Database connection pool and performance monitoring (Issue #260 Part 15)
 */

/**
 * @swagger
 * /api/v1/db-scaling/pool:
 *   get:
 *     summary: Get current database connection pool stats
 *     tags: [DB Scaling]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Pool stats returned successfully
 *       500:
 *         description: Internal server error
 */
router.get('/pool', (req, res, next) => ctrl.getPoolStats(req, res, next));

/**
 * @swagger
 * /api/v1/db-scaling/health:
 *   get:
 *     summary: Database connectivity health check with latency
 *     tags: [DB Scaling]
 *     responses:
 *       200:
 *         description: Database is reachable
 *       503:
 *         description: Database is unreachable
 */
router.get('/health', (req, res, next) => ctrl.healthCheck(req, res, next));

/**
 * @swagger
 * /api/v1/db-scaling/slow-queries:
 *   get:
 *     summary: List queries exceeding a mean execution time threshold
 *     tags: [DB Scaling]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: threshold
 *         schema:
 *           type: number
 *         description: Mean execution time threshold in ms (default 1000)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: number
 *         description: Max rows to return (default 20, max 100)
 *     responses:
 *       200:
 *         description: Slow query list
 *       400:
 *         description: Invalid query parameters
 */
router.get('/slow-queries', (req, res, next) => ctrl.getSlowQueries(req, res, next));

/**
 * @swagger
 * /api/v1/db-scaling/index-usage:
 *   get:
 *     summary: Return index usage statistics from pg_stat_user_indexes
 *     tags: [DB Scaling]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Index usage data
 */
router.get('/index-usage', (req, res, next) => ctrl.getIndexUsage(req, res, next));

/**
 * @swagger
 * /api/v1/db-scaling/config:
 *   get:
 *     summary: Return current connection pool configuration
 *     tags: [DB Scaling]
 *     responses:
 *       200:
 *         description: Pool min/max configuration
 */
router.get('/config', (req, res) => ctrl.getPoolConfig(req, res));

// Issue #289 — table bloat
router.get('/table-bloat', (req, res, next) => ctrl.getTableBloat(req, res, next));

// Issue #290 — cache hit rate
router.get('/cache-hit-rate', (req, res, next) => ctrl.getCacheHitRate(req, res, next));

// Issue #291 — long-running transactions (?minDurationSec=10)
router.get('/long-running-transactions', (req, res, next) => ctrl.getLongRunningTransactions(req, res, next));

// Issue #292 — vacuum / analyse stats
router.get('/vacuum-stats', (req, res, next) => ctrl.getVacuumStats(req, res, next));

export default router;

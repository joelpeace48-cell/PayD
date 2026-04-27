import { Request, Response } from 'express';
import { Redis } from 'ioredis';
import { pool } from '../config/database.js';
import { config } from '../config/env.js';
import logger from '../utils/logger.js';

/**
 * Shared Redis client for health checks.
 * Uses a fail-fast strategy to prevent health check hangs.
 */
let redisClient: Redis | null = null;
if (config.REDIS_URL) {
  try {
    redisClient = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // Fail fast for health check
      commandTimeout: 1000,      // 1 second timeout
    });
    
    redisClient.on('error', (err) => {
      logger.warn('Health Check Redis client error:', err.message);
    });
  } catch (err) {
    logger.error('Failed to initialize Health Check Redis client', err);
  }
}

export interface DependencyStatus {
  status: 'connected' | 'disconnected' | 'not_configured' | 'unknown';
  error?: string;
  latencyMs?: number;
}

export interface HealthStatusResponse {
  status: 'ok' | 'degraded';
  timestamp: string;
  uptime: number;
  version: string;
  environment: {
    name: string;
    nodeVersion: string;
  };
  system: {
    memoryUsage: NodeJS.MemoryUsage;
    platform: string;
  };
  dependencies: {
    database: DependencyStatus;
    redis: DependencyStatus;
  };
}

/**
 * Controller for application health monitoring.
 * Provides a GET /api/health endpoint for infrastructure and observability.
 */
export class HealthController {
  /**
   * Performs a comprehensive health check of the application and its dependencies.
   * 
   * @param _req - Express Request (unused)
   * @param res - Express Response
   */
  static async getHealthStatus(_req: Request, res: Response) {
    const start = Date.now();
    const statusReport: HealthStatusResponse = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0',
      environment: {
        name: config.NODE_ENV,
        nodeVersion: process.version,
      },
      system: {
        memoryUsage: process.memoryUsage(),
        platform: process.platform,
      },
      dependencies: {
        database: { status: 'unknown' },
        redis: { status: 'unknown' },
      },
    };

    let isHealthy = true;

    // 1. PostgreSQL Check
    const dbStart = Date.now();
    try {
      await pool.query('SELECT 1');
      statusReport.dependencies.database = {
        status: 'connected',
        latencyMs: Date.now() - dbStart,
      };
    } catch (error: any) {
      isHealthy = false;
      statusReport.dependencies.database = {
        status: 'disconnected',
        error: error.message,
      };
      logger.error('Health Check: Database connection failed', error);
    }

    // 2. Redis Check
    if (redisClient) {
      const redisStart = Date.now();
      try {
        await redisClient.ping();
        statusReport.dependencies.redis = {
          status: 'connected',
          latencyMs: Date.now() - redisStart,
        };
      } catch (error: any) {
        isHealthy = false;
        statusReport.dependencies.redis = {
          status: 'disconnected',
          error: error.message,
        };
        logger.error('Health Check: Redis connection failed', error);
      }
    } else {
      statusReport.dependencies.redis = { status: 'not_configured' };
    }

    if (!isHealthy) {
      statusReport.status = 'degraded';
      return res.status(503).json(statusReport);
    }

    return res.status(200).json(statusReport);
  }
}

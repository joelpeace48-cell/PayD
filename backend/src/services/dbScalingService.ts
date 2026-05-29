import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger.js';

export interface PoolStats {
  activeConnections: number;
  idleConnections: number;
  waitingRequests: number;
  maxConnections: number;
}

export interface QueryResult<T> {
  data: T;
  durationMs: number;
  fromCache: boolean;
}

const POOL_MAX = Number(process.env.DB_POOL_MAX ?? 20);
const POOL_MIN = Number(process.env.DB_POOL_MIN ?? 2);

let prismaInstance: PrismaClient | null = null;

function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    prismaInstance = new PrismaClient({
      datasources: {
        db: { url: process.env.DATABASE_URL },
      },
      log: [
        { level: 'warn', emit: 'event' },
        { level: 'error', emit: 'event' },
      ],
    });

    prismaInstance.$on('warn' as never, (e: unknown) => {
      logger.warn({ event: e }, 'Prisma warning');
    });

    prismaInstance.$on('error' as never, (e: unknown) => {
      logger.error({ event: e }, 'Prisma error');
    });
  }
  return prismaInstance;
}

export class DbScalingService {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = getPrismaClient();
  }

  async getPoolStats(): Promise<PoolStats> {
    const result = await this.prisma.$queryRaw<
      Array<{ active: bigint; idle: bigint; waiting: bigint }>
    >`
      SELECT
        count(*) FILTER (WHERE state = 'active')  AS active,
        count(*) FILTER (WHERE state = 'idle')    AS idle,
        count(*) FILTER (WHERE wait_event IS NOT NULL) AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
    `;

    const row = result[0] ?? { active: 0n, idle: 0n, waiting: 0n };
    return {
      activeConnections: Number(row.active),
      idleConnections: Number(row.idle),
      waitingRequests: Number(row.waiting),
      maxConnections: POOL_MAX,
    };
  }

  async runHealthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      logger.error({ err }, 'DB health check failed');
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  async getSlowQueries(
    thresholdMs = 1000,
    limit = 20,
  ): Promise<Array<{ query: string; calls: number; avgMs: number; totalMs: number }>> {
    const rows = await this.prisma.$queryRaw<
      Array<{ query: string; calls: bigint; mean_exec_time: number; total_exec_time: number }>
    >`
      SELECT query, calls, mean_exec_time, total_exec_time
      FROM pg_stat_statements
      WHERE mean_exec_time > ${thresholdMs}
        AND query NOT LIKE '%pg_stat%'
      ORDER BY mean_exec_time DESC
      LIMIT ${limit}
    `;

    return rows.map((r) => ({
      query: r.query,
      calls: Number(r.calls),
      avgMs: Math.round(r.mean_exec_time),
      totalMs: Math.round(r.total_exec_time),
    }));
  }

  async getIndexUsage(): Promise<
    Array<{ table: string; index: string; scans: number; tuplesRead: number }>
  > {
    const rows = await this.prisma.$queryRaw<
      Array<{
        relname: string;
        indexrelname: string;
        idx_scan: bigint;
        idx_tup_read: bigint;
      }>
    >`
      SELECT relname, indexrelname, idx_scan, idx_tup_read
      FROM pg_stat_user_indexes
      ORDER BY idx_scan DESC
      LIMIT 50
    `;

    return rows.map((r) => ({
      table: r.relname,
      index: r.indexrelname,
      scans: Number(r.idx_scan),
      tuplesRead: Number(r.idx_tup_read),
    }));
  }

  getPoolConfig(): { min: number; max: number } {
    return { min: POOL_MIN, max: POOL_MAX };
  }

  /** #289 — Table bloat: dead-tuple ratio per table from pg_stat_user_tables. */
  async getTableBloat(): Promise<{ table: string; liveRows: number; deadRows: number; bloatRatio: number }[]> {
    const rows = await this.prisma.$queryRaw<Array<{ relname: string; n_live_tup: bigint; n_dead_tup: bigint }>>`
      SELECT relname, n_live_tup, n_dead_tup
      FROM pg_stat_user_tables
      ORDER BY n_dead_tup DESC
      LIMIT 20
    `;
    return rows.map(r => {
      const live = Number(r.n_live_tup);
      const dead = Number(r.n_dead_tup);
      return { table: r.relname, liveRows: live, deadRows: dead, bloatRatio: live + dead > 0 ? dead / (live + dead) : 0 };
    });
  }

  /** #290 — Buffer cache hit rates from pg_statio_user_tables. */
  async getCacheHitRate(): Promise<{ table: string; heapHitRate: number; idxHitRate: number }[]> {
    const rows = await this.prisma.$queryRaw<Array<{
      relname: string; heap_blks_hit: bigint; heap_blks_read: bigint; idx_blks_hit: bigint; idx_blks_read: bigint;
    }>>`
      SELECT relname, heap_blks_hit, heap_blks_read, idx_blks_hit, idx_blks_read
      FROM pg_statio_user_tables
      ORDER BY relname
    `;
    return rows.map(r => {
      const hh = Number(r.heap_blks_hit), hr = Number(r.heap_blks_read);
      const ih = Number(r.idx_blks_hit),  ir = Number(r.idx_blks_read);
      return {
        table: r.relname,
        heapHitRate: hh + hr > 0 ? hh / (hh + hr) : 1,
        idxHitRate:  ih + ir > 0 ? ih / (ih + ir) : 1,
      };
    });
  }

  /** #291 — Long-running transactions from pg_stat_activity. */
  async getLongRunningTransactions(minDurationSec = 10): Promise<{ pid: number; duration: string; state: string; query: string }[]> {
    const rows = await this.prisma.$queryRaw<Array<{ pid: number; duration: string; state: string; query: string }>>`
      SELECT pid,
             (now() - xact_start)::text AS duration,
             state,
             left(query, 120) AS query
      FROM pg_stat_activity
      WHERE xact_start IS NOT NULL
        AND now() - xact_start > (${minDurationSec} || ' seconds')::interval
        AND state != 'idle'
      ORDER BY duration DESC
    `;
    return rows;
  }

  /** #292 — Vacuum / analyse timestamps from pg_stat_user_tables. */
  async getVacuumStats(): Promise<{ table: string; lastVacuum: string | null; lastAutoVacuum: string | null; lastAnalyze: string | null }[]> {
    const rows = await this.prisma.$queryRaw<Array<{
      relname: string; last_vacuum: Date | null; last_autovacuum: Date | null; last_analyze: Date | null;
    }>>`
      SELECT relname, last_vacuum, last_autovacuum, last_analyze
      FROM pg_stat_user_tables
      ORDER BY relname
    `;
    return rows.map(r => ({
      table: r.relname,
      lastVacuum:     r.last_vacuum    ? r.last_vacuum.toISOString()    : null,
      lastAutoVacuum: r.last_autovacuum ? r.last_autovacuum.toISOString() : null,
      lastAnalyze:    r.last_analyze   ? r.last_analyze.toISOString()   : null,
    }));
  }
}

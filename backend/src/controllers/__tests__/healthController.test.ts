import request from 'supertest';
import express from 'express';
import { HealthController } from '../healthController.js';
import { pool } from '../../config/database.js';
import { Redis } from 'ioredis';

jest.mock('../../config/env', () => ({
  config: {
    DATABASE_URL: 'postgres://mock',
    REDIS_URL: 'redis://mock',
    NODE_ENV: 'test',
  },
}));

jest.mock('../../config/database.js', () => ({
  pool: {
    query: jest.fn(),
  },
}));

jest.mock('ioredis', () => {
  const mRedis = { 
    ping: jest.fn(),
    on: jest.fn(),
  };
  return { Redis: jest.fn(() => mRedis) };
});

const app = express();
app.get('/api/health', HealthController.getHealthStatus);
app.get('/api/v1/health', HealthController.getHealthStatus);
app.get('/health', HealthController.getHealthStatus);

describe('HealthController health endpoints', () => {
  let redisClient: any;

  beforeEach(() => {
    redisClient = new Redis();
    jest.clearAllMocks();
  });

  it('returns 200 OK from /api/health when database and redis are healthy', async () => {
    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
    redisClient.ping.mockResolvedValueOnce('PONG');

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.environment.name).toBe('test');
    expect(response.body.system.memoryUsage).toBeDefined();
    expect(response.body.system.platform).toBeDefined();
    expect(response.body.dependencies.database.status).toBe('connected');
    expect(response.body.dependencies.database.latencyMs).toBeDefined();
    expect(response.body.dependencies.redis.status).toBe('connected');
    expect(response.body.dependencies.redis.latencyMs).toBeDefined();
  });

  it('keeps the legacy /health endpoint working', async () => {
    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
    redisClient.ping.mockResolvedValueOnce('PONG');

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('returns 200 OK from /api/v1/health when database and redis are healthy', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    redisClient.ping.mockResolvedValueOnce('PONG');

    const response = await request(app).get('/api/v1/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.dependencies.database.status).toBe('connected');
    expect(response.body.dependencies.redis.status).toBe('connected');
  });

  it('returns 503 Degraded when Postgres goes down', async () => {
    (pool.query as jest.Mock).mockRejectedValueOnce(new Error('Connection forced closed'));
    redisClient.ping.mockResolvedValueOnce('PONG');

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('degraded');
    expect(response.body.dependencies.database.status).toBe('disconnected');
    expect(response.body.dependencies.database.error).toBe('Connection forced closed');
  });

  it('returns 503 Degraded when Redis fails', async () => {
    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
    redisClient.ping.mockRejectedValueOnce(new Error('Redis timeout'));

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('degraded');
    expect(response.body.dependencies.redis.status).toBe('disconnected');
    expect(response.body.dependencies.redis.error).toBe('Redis timeout');
  });
});

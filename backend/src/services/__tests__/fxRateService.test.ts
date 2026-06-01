import { getOrgUsdRates, FX_RATES_CACHE_KEY, FX_RATES_CACHE_TTL_SEC } from '../fxRateService.js';
import { getRedisClient } from '../rateLimitService.js';

jest.mock('../rateLimitService.js', () => ({
  getRedisClient: jest.fn(),
}));

describe('fxRateService.getOrgUsdRates', () => {
  const mockedGetRedisClient = getRedisClient as jest.MockedFunction<typeof getRedisClient>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns cached payload from Redis when present', async () => {
    const cachedPayload = {
      base: 'ORGUSD',
      quoteBase: 'USD',
      fetchedAt: '2026-03-24T00:00:00.000Z',
      provider: 'open.er-api.com',
      rates: { USD: 1, NGN: 1500, ORGUSD: 1 },
      cacheTtlSeconds: FX_RATES_CACHE_TTL_SEC,
    };

    const redisMock = {
      get: jest.fn().mockResolvedValue(JSON.stringify(cachedPayload)),
      setex: jest.fn(),
    };
    mockedGetRedisClient.mockReturnValue(redisMock as any);

    const result = await getOrgUsdRates();

    expect(redisMock.get).toHaveBeenCalledWith(FX_RATES_CACHE_KEY);
    expect(redisMock.setex).not.toHaveBeenCalled();
    expect(result).toEqual(cachedPayload);
  });

  it('fetches from provider and writes to Redis cache on miss', async () => {
    const redisMock = {
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue('OK'),
    };
    mockedGetRedisClient.mockReturnValue(redisMock as any);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: 'success',
        rates: { USD: 1, NGN: 1510, EUR: 0.9 },
      }),
    } as any);

    const result = await getOrgUsdRates();

    expect(result.base).toBe('ORGUSD');
    expect(result.quoteBase).toBe('USD');
    expect(result.provider).toBe('open.er-api.com');
    expect(result.rates.USD).toBe(1);
    expect(result.rates.ORGUSD).toBe(1);
    expect(result.rates.NGN).toBe(1510);
    expect(redisMock.setex).toHaveBeenCalledTimes(1);
    expect(redisMock.setex).toHaveBeenCalledWith(
      FX_RATES_CACHE_KEY,
      FX_RATES_CACHE_TTL_SEC,
      expect.any(String)
    );
  });

  it('falls back to Coinbase when primary provider fails', async () => {
    const redisMock = {
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue('OK'),
    };
    mockedGetRedisClient.mockReturnValue(redisMock as any);

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            rates: {
              USD: '1.0',
              NGN: '1499.1',
              EUR: '0.87',
            },
          },
        }),
      } as any);

    const result = await getOrgUsdRates();

    expect(result.provider).toBe('api.coinbase.com');
    expect(result.rates.USD).toBe(1);
    expect(result.rates.ORGUSD).toBe(1);
    expect(result.rates.NGN).toBeCloseTo(1499.1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

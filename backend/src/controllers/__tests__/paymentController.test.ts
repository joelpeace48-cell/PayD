import express from 'express';
import request from 'supertest';
import { PaymentController } from '../paymentController.js';
import { AnchorService } from '../../services/anchorService.js';

jest.mock('../../services/anchorService.js', () => ({
  AnchorService: {
    authenticate: jest.fn(),
    getSEP24Info: jest.fn(),
    getSEP31Info: jest.fn(),
    initiateSEP24Withdrawal: jest.fn(),
    getSEP24Transaction: jest.fn(),
  },
}));

jest.mock('@stellar/stellar-sdk', () => ({
  Keypair: {
    fromSecret: jest.fn((secret: string) => ({
      publicKey: () => (secret === 'SVALID' ? 'GSENDER' : 'GBAD'),
    })),
  },
}));

describe('PaymentController SEP-24 endpoints', () => {
  const app = express();
  app.use(express.json());
  app.post('/sep24/withdraw/interactive', PaymentController.initiateSEP24Withdrawal);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the interactive URL in JSON mode', async () => {
    (AnchorService.authenticate as jest.Mock).mockResolvedValueOnce('sep10-token');
    (AnchorService.initiateSEP24Withdrawal as jest.Mock).mockResolvedValueOnce({
      id: 'withdraw-1',
      url: 'https://anchor.example/interactive/withdraw-1',
    });

    const response = await request(app)
      .post('/sep24/withdraw/interactive')
      .send({
        domain: 'anchor.example',
        secretKey: 'SVALID',
        senderPublicKey: 'GSENDER',
        transactionData: { asset_code: 'USD', lang: 'en' },
      });

    expect(response.status).toBe(200);
    expect(response.body.interactiveUrl).toBe('https://anchor.example/interactive/withdraw-1');
  });

  it('redirects to the interactive URL when redirect mode is requested', async () => {
    (AnchorService.authenticate as jest.Mock).mockResolvedValueOnce('sep10-token');
    (AnchorService.initiateSEP24Withdrawal as jest.Mock).mockResolvedValueOnce({
      id: 'withdraw-1',
      interactive_url: 'https://anchor.example/interactive/withdraw-1',
    });

    const response = await request(app)
      .post('/sep24/withdraw/interactive')
      .send({
        domain: 'anchor.example',
        secretKey: 'SVALID',
        senderPublicKey: 'GSENDER',
        transactionData: { asset_code: 'USD' },
        redirect: true,
      });

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('https://anchor.example/interactive/withdraw-1');
  });
});

# Reseats backend

Reseats is one place for receipts and after-sale help.

The focused MVP supports:

- merchant POS receipt creation
- QR-code receipt claiming
- manual JPEG, PNG, WebP, or PDF receipt uploads
- a customer receipt vault
- return, warranty, and complaint cases tied to proof of purchase
- merchant refunds and signed webhooks

Automatic consumer-card monitoring and brand-plus-last-four matching are intentionally not exposed. Stripe cannot observe purchases made on arbitrary consumer cards, and last four digits are not a safe ownership identifier.

## Run locally

```bash
cd backend
npm install
cp .env.example .env
npm run migrate
npm run dev
```

## Main endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/pos/transactions` | Merchant creates a receipt |
| POST | `/v1/receipts/claim` | Customer claims a QR receipt |
| POST | `/v1/receipts/manual` | Customer uploads a receipt |
| GET | `/v1/receipts` | Customer receipt vault |
| GET | `/v1/receipts/:id/document` | View uploaded proof |
| POST | `/v1/receipts/:id/help` | Start return, warranty, or complaint help |
| GET | `/v1/help_cases` | List the customer's help cases |

Manual documents are limited to 1 MB in this MVP. Move them to object storage before large-scale production use.

## Deployment

Deploy the `backend` directory as a long-running Node service. Apply migrations before starting and verify both `/healthz` and `/readyz`. Required production variables are documented in `.env.example`.

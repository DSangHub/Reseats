export type ReceiptSource = 'pos' | 'card' | 'email' | 'manual' | 'import';
export type ReceiptStatus =
  | 'pending'
  | 'complete'
  | 'voided'
  | 'refunded'
  | 'partially_refunded';
export type CardStatus = 'active' | 'disconnected' | 'expired' | 'error';
export type CardTxnStatus = 'pending' | 'posted' | 'reversed' | 'declined';

export interface MerchantRow {
  id: string;
  name: string;
  slug: string;
  status: 'pending' | 'active' | 'suspended';
  display_name: string | null;
  timezone: string;
}

export interface MerchantAuth {
  merchant: MerchantRow;
  apiKeyId: string;
  mode: 'live' | 'test';
  scopes: string[];
}

export interface PaymentTender {
  brand?: string;
  last4?: string;
  fingerprint?: string;
  auth_code?: string;
  entry_mode?: string;
  network?: string;
}

export interface ReceiptRow {
  id: string;
  user_id: string | null;
  merchant_id: string | null;
  location_id: string | null;
  source: ReceiptSource;
  status: ReceiptStatus;
  external_id: string | null;
  merchant_name: string;
  subtotal_cents: number;
  tax_cents: number;
  tip_cents: number;
  discount_cents: number;
  total_cents: number;
  refunded_cents: number;
  currency: string;
  purchased_at: Date;
  payment: PaymentTender;
  raw: Record<string, unknown>;
  metadata: Record<string, unknown>;
  card_transaction_id: string | null;
  claim_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface LineItemRow {
  id: string;
  receipt_id: string;
  position: number;
  description: string;
  sku: string | null;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  tax_cents: number;
}

export interface CardRow {
  id: string;
  user_id: string;
  connection_id: string | null;
  provider: string;
  provider_card_id: string;
  brand: string;
  last4: string;
  exp_month: number | null;
  exp_year: number | null;
  nickname: string | null;
  fingerprint: string;
  status: CardStatus;
  created_at: Date;
}

export interface CardTransactionRow {
  id: string;
  card_id: string;
  user_id: string;
  provider: string;
  provider_transaction_id: string;
  amount_cents: number;
  currency: string;
  descriptor: string;
  normalized_descriptor: string;
  merchant_category_code: string | null;
  status: CardTxnStatus;
  transacted_at: Date;
  authorization_code: string | null;
  raw: Record<string, unknown>;
  receipt_id: string | null;
}

import { createHmac, publicEncrypt, timingSafeEqual, constants, randomUUID } from "node:crypto";

export type MobileMoneyProvider = "mpesa" | "ecocash";

export interface PaymentInitiation {
  amount: number;
  currency: "LSL";
  phone: string;
  merchantReference: string;
  callbackUrl: string;
}

export interface ProviderPaymentResult {
  providerTransactionId: string;
  providerConversationId?: string;
  thirdPartyConversationId?: string;
  status: "pending" | "paid" | "failed";
  message?: string;
}

export interface ProviderWebhookResult {
  providerTransactionId: string;
  providerConversationId?: string;
  thirdPartyConversationId?: string;
  merchantReference?: string;
  status: "paid" | "failed" | "pending";
  transactionReference?: string;
}

class ProviderNotConfiguredError extends Error {
  constructor(provider: MobileMoneyProvider) {
    super(`${provider.toUpperCase()} payment integration is not configured. Add its approved merchant API credentials.`);
    this.name = "ProviderNotConfiguredError";
  }
}

function getProviderConfig(provider: MobileMoneyProvider) {
  const prefix = provider === "mpesa" ? "MPESA" : "ECOCASH";
  return {
    endpoint: process.env[`${prefix}_PAYMENTS_URL`]?.trim(),
    apiKey: process.env[`${prefix}_API_KEY`]?.trim(),
    webhookSecret: process.env[`${prefix}_WEBHOOK_SECRET`]?.trim(),
  };
}

let mpesaSession: { key: string; expiresAt: number } | null = null;

function mpesaPublicKeyPem(publicKey: string): string {
  const normalized = publicKey
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  const lines = normalized.match(/.{1,64}/g)?.join("\n") || normalized;
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
}

function mpesaEncryptedApiKey(apiKey: string, publicKey: string): string {
  return publicEncrypt(
    {
      key: mpesaPublicKeyPem(publicKey),
      padding: constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(apiKey, "utf8"),
  ).toString("base64");
}

function mpesaBaseUrl(): string {
  const explicit = process.env.MPESA_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const environment = (process.env.MPESA_ENVIRONMENT || "sandbox").toLowerCase();
  return environment === "production"
    ? "https://openapi.m-pesa.com/openapi/ipg/v2"
    : "https://openapi.m-pesa.com/sandbox/ipg/v2";
}

async function getMpesaSessionKey(): Promise<string> {
  const apiKey = process.env.MPESA_API_KEY?.trim();
  const publicKey = process.env.MPESA_PUBLIC_KEY?.trim();
  const market = process.env.MPESA_MARKET?.trim();

  if (!apiKey || !publicKey || !market) {
    throw new ProviderNotConfiguredError("mpesa");
  }

  if (mpesaSession && mpesaSession.expiresAt > Date.now()) return mpesaSession.key;

  const sessionUrl = process.env.MPESA_SESSION_URL?.trim()
    || `${mpesaBaseUrl()}/${market}/getSession/`;
  const response = await fetch(sessionUrl, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${mpesaEncryptedApiKey(apiKey, publicKey)}`,
      "Origin": process.env.MPESA_ORIGIN?.trim() || "*",
    },
  });
  const data = await response.json().catch(() => ({}));
  const sessionKey = String(data.output_SessionID || data.output_SessionKey || "");
  if (!response.ok || !sessionKey || (data.output_ResponseCode && data.output_ResponseCode !== "INS-0")) {
    throw new Error(`M-Pesa session request failed (${data.output_ResponseDesc || response.status})`);
  }

  const ttlSeconds = Math.max(60, Number(process.env.MPESA_SESSION_TTL_SECONDS || 300));
  mpesaSession = { key: sessionKey, expiresAt: Date.now() + (ttlSeconds - 30) * 1000 };
  return sessionKey;
}

async function initiateMpesaPayment(input: PaymentInitiation): Promise<ProviderPaymentResult> {
  const market = process.env.MPESA_MARKET?.trim();
  const country = process.env.MPESA_COUNTRY?.trim();
  const currency = process.env.MPESA_CURRENCY?.trim();
  const serviceProviderCode = process.env.MPESA_SERVICE_PROVIDER_CODE?.trim();

  if (!market || !country || !currency || !serviceProviderCode) {
    throw new ProviderNotConfiguredError("mpesa");
  }

  const transactionReference = input.merchantReference.slice(-20);
  const thirdPartyConversationID = randomUUID().replace(/-/g, "").slice(0, 20);
  const paymentUrl = process.env.MPESA_PAYMENTS_URL?.trim()
    || `${mpesaBaseUrl()}/${market}/c2bPayment/singleStage/`;
  const response = await fetch(paymentUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${await getMpesaSessionKey()}`,
      "Origin": process.env.MPESA_ORIGIN?.trim() || "*",
    },
    body: JSON.stringify({
      input_Amount: input.amount.toFixed(2),
      input_CustomerMSISDN: input.phone,
      input_Country: country,
      input_Currency: currency,
      input_ServiceProviderCode: serviceProviderCode,
      input_TransactionReference: transactionReference,
      input_ThirdPartyConversationID: thirdPartyConversationID,
      input_PurchasedItemsDesc: "U-GO ride",
    }),
  });
  const data = await response.json().catch(() => ({}));
  const responseCode = String(data.output_ResponseCode || "");
  if (!response.ok || (responseCode && !["INS-0", "INS-A-0"].includes(responseCode))) {
    throw new Error(`M-Pesa payment request failed (${data.output_ResponseDesc || response.status})`);
  }

  return {
    providerTransactionId: String(data.output_TransactionID || data.output_ThirdPartyConversationID || thirdPartyConversationID),
    providerConversationId: typeof data.output_ConversationID === "string" ? data.output_ConversationID : undefined,
    thirdPartyConversationId: typeof data.output_ThirdPartyConversationID === "string"
      ? data.output_ThirdPartyConversationID : thirdPartyConversationID,
    status: "pending",
    message: String(data.output_ResponseDesc || "Approve the M-Pesa prompt on your phone."),
  };
}

function requireMpesaTransactionConfig() {
  const market = process.env.MPESA_MARKET?.trim();
  const country = process.env.MPESA_COUNTRY?.trim();
  const currency = process.env.MPESA_CURRENCY?.trim();
  const serviceProviderCode = process.env.MPESA_SERVICE_PROVIDER_CODE?.trim();
  if (!market || !country || !currency || !serviceProviderCode) {
    throw new ProviderNotConfiguredError("mpesa");
  }
  return { market, country, currency, serviceProviderCode };
}

export async function queryMpesaTransaction(input: {
  transactionId?: string;
  conversationId?: string;
  thirdPartyConversationId?: string;
}) {
  const { market, country, serviceProviderCode } = requireMpesaTransactionConfig();
  const queryReference = input.transactionId || input.conversationId;
  if (!queryReference || !input.thirdPartyConversationId) {
    throw new Error("M-Pesa transaction and conversation references are required");
  }

  const url = new URL(
    process.env.MPESA_QUERY_URL?.trim()
      || `${mpesaBaseUrl()}/${market}/queryTransactionStatus/`
  );
  url.searchParams.set("input_QueryReference", queryReference);
  url.searchParams.set("input_ServiceProviderCode", serviceProviderCode);
  url.searchParams.set("input_ThirdPartyConversationID", input.thirdPartyConversationId);
  url.searchParams.set("input_Country", country);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${await getMpesaSessionKey()}`,
      "Origin": process.env.MPESA_ORIGIN?.trim() || "*",
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (data.output_ResponseCode && data.output_ResponseCode !== "INS-0")) {
    throw new Error(`M-Pesa status query failed (${data.output_ResponseDesc || response.status})`);
  }

  const transactionStatus = String(data.output_ResponseTransactionStatus || "").toLowerCase();
  return {
    providerTransactionId: String(data.output_OriginalTransactionID || input.transactionId || ""),
    providerConversationId: typeof data.output_ConversationID === "string" ? data.output_ConversationID : input.conversationId,
    thirdPartyConversationId: typeof data.output_ThirdPartyConversationID === "string"
      ? data.output_ThirdPartyConversationID : input.thirdPartyConversationId,
    status: ["completed", "success", "successful", "paid"].includes(transactionStatus)
      ? "paid" as const
      : ["failed", "cancelled", "rejected", "expired"].includes(transactionStatus)
        ? "failed" as const : "pending" as const,
    message: data.output_ResponseDesc,
  };
}

export async function reverseMpesaTransaction(input: {
  transactionId: string;
  amount?: number;
  thirdPartyConversationId: string;
}) {
  const { market, country, serviceProviderCode } = requireMpesaTransactionConfig();
  const url = process.env.MPESA_REVERSAL_URL?.trim()
    || `${mpesaBaseUrl()}/${market}/reversal/`;
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${await getMpesaSessionKey()}`,
      "Origin": process.env.MPESA_ORIGIN?.trim() || "*",
    },
    body: JSON.stringify({
      ...(input.amount ? { input_ReversalAmount: input.amount.toFixed(2) } : {}),
      input_Country: country,
      input_TransactionID: input.transactionId,
      input_ServiceProviderCode: serviceProviderCode,
      input_ThirdPartyConversationID: input.thirdPartyConversationId,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (data.output_ResponseCode && data.output_ResponseCode !== "INS-0")) {
    throw new Error(`M-Pesa reversal failed (${data.output_ResponseDesc || response.status})`);
  }
  return {
    transactionId: String(data.output_TransactionID || input.transactionId),
    message: data.output_ResponseDesc,
  };
}

function providerStatus(value: unknown): ProviderPaymentResult["status"] {
  const status = String(value || "pending").toLowerCase();
  if (["paid", "success", "successful", "completed"].includes(status)) return "paid";
  if (["failed", "failure", "rejected", "cancelled"].includes(status)) return "failed";
  return "pending";
}

export async function initiateMobileMoneyPayment(
  provider: MobileMoneyProvider,
  input: PaymentInitiation,
): Promise<ProviderPaymentResult> {
  if (provider === "mpesa") return initiateMpesaPayment(input);

  const config = getProviderConfig(provider);
  if (!config.endpoint || !config.apiKey) throw new ProviderNotConfiguredError(provider);

  // The approved provider contract is configured server-side. Never send a
  // wallet PIN or ask the rider for one; the provider owns that authorization.
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(input),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${provider.toUpperCase()} payment request failed (${response.status})`);
  }

  const providerTransactionId = String(
    data.transactionId || data.transactionReference || data.providerTransactionId || data.id || ""
  );
  if (!providerTransactionId) {
    throw new Error(`${provider.toUpperCase()} response did not include a transaction ID`);
  }

  return {
    providerTransactionId,
    status: providerStatus(data.status),
    message: typeof data.message === "string" ? data.message : undefined,
  };
}

export function verifyProviderWebhook(
  provider: MobileMoneyProvider,
  rawBody: unknown,
  signature: string | undefined,
): boolean {
  const secret = getProviderConfig(provider).webhookSecret;
  // The M-Pesa callback specification does not define an HMAC header. Its
  // callback is accepted only after matching the supplied conversation IDs
  // against the transaction stored for the ride.
  if (provider === "mpesa" && !secret) return true;
  if (!secret || !signature || !Buffer.isBuffer(rawBody)) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const supplied = signature.replace(/^sha256=/i, "");
  if (expected.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export function parseProviderWebhook(payload: any): ProviderWebhookResult {
  const resultCode = String(payload.input_ResultCode || "");
  const status = ["INS-0", "INS-GAR-0"].includes(resultCode)
    ? "paid"
    : resultCode ? "failed" : providerStatus(payload.status || payload.result || payload.state);
  return {
    providerTransactionId: String(payload.input_TransactionID || payload.transactionId || payload.transactionReference || payload.id || ""),
    providerConversationId: typeof payload.input_OriginalConversationID === "string"
      ? payload.input_OriginalConversationID : typeof payload.conversationId === "string" ? payload.conversationId : undefined,
    thirdPartyConversationId: typeof payload.input_ThirdPartyConversationID === "string"
      ? payload.input_ThirdPartyConversationID : undefined,
    merchantReference: typeof payload.merchantReference === "string"
      ? payload.merchantReference
      : typeof payload.externalReference === "string" ? payload.externalReference : undefined,
    status,
    transactionReference: typeof payload.transactionReference === "string"
      ? payload.transactionReference : typeof payload.input_TransactionID === "string" ? payload.input_TransactionID : undefined,
  };
}

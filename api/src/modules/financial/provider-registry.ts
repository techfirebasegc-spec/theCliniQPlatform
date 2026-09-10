const supportedProviderKeys = ['RAZORPAY'] as const;

export type PaymentProviderKey = (typeof supportedProviderKeys)[number];

/**
 * Resolves a non-secret provider identifier at startup. This registry never
 * constructs a provider, loads credentials, or authorizes a network call.
 */
export function resolvePaymentProviderKey(value: string): PaymentProviderKey {
  if ((supportedProviderKeys as readonly string[]).includes(value)) return value as PaymentProviderKey;
  throw new Error('Unsupported payment provider configuration.');
}

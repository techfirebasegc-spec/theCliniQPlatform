import type { DatabaseHealth } from '../../infrastructure/database.js';

export type ProviderPaymentAccountKind = 'DOCTOR' | 'CLINIC';
export type ProviderPaymentAccountStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
export type ProviderPaymentAccountVerificationStatus = 'NOT_SUBMITTED' | 'PENDING' | 'VERIFIED' | 'REJECTED';

export type ProviderPaymentAccount = {
  id: string;
  providerKind: ProviderPaymentAccountKind;
  doctorProfileId: string | null;
  clinicId: string | null;
  paymentProvider: string;
  externalAccountReference: string;
  status: ProviderPaymentAccountStatus;
  verificationStatus: ProviderPaymentAccountVerificationStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateProviderPaymentAccount = Omit<ProviderPaymentAccount, 'createdAt' | 'updatedAt'>;

/** Persistence boundary only; onboarding and settlement execution remain out of scope. */
export class PostgresProviderPaymentAccountRepository {
  public constructor(private readonly database: Pick<DatabaseHealth, 'query'>) {}

  public async create(input: CreateProviderPaymentAccount): Promise<ProviderPaymentAccount> {
    const result = await this.database.query<Record<string, unknown>>(`INSERT INTO provider_payment_accounts
      (id,provider_kind,doctor_profile_id,clinic_id,payment_provider,external_account_reference,status,verification_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id,provider_kind,doctor_profile_id,clinic_id,payment_provider,external_account_reference,status,verification_status,created_at,updated_at`, [
      input.id, input.providerKind, input.doctorProfileId, input.clinicId, input.paymentProvider,
      input.externalAccountReference, input.status, input.verificationStatus,
    ]);
    const row = result.rows[0];
    if (!row) throw new Error('Provider payment account was not created.');
    return providerPaymentAccount(row);
  }

  public async find(id: string): Promise<ProviderPaymentAccount | null> {
    return this.findOne('id=$1', [id]);
  }

  public async findActiveDoctor(doctorProfileId: string, paymentProvider: string): Promise<ProviderPaymentAccount | null> {
    return this.findOne("doctor_profile_id=$1 AND payment_provider=$2 AND status='ACTIVE'", [doctorProfileId, paymentProvider]);
  }

  public async findActiveClinic(clinicId: string, paymentProvider: string): Promise<ProviderPaymentAccount | null> {
    return this.findOne("clinic_id=$1 AND payment_provider=$2 AND status='ACTIVE'", [clinicId, paymentProvider]);
  }

  public async findSettlementReadyDoctor(doctorProfileId: string, paymentProvider: string): Promise<ProviderPaymentAccount | null> {
    return this.findOne("doctor_profile_id=$1 AND payment_provider=$2 AND status='ACTIVE' AND verification_status='VERIFIED'", [doctorProfileId, paymentProvider]);
  }

  public async findSettlementReadyClinic(clinicId: string, paymentProvider: string): Promise<ProviderPaymentAccount | null> {
    return this.findOne("clinic_id=$1 AND payment_provider=$2 AND status='ACTIVE' AND verification_status='VERIFIED'", [clinicId, paymentProvider]);
  }

  private async findOne(where: string, values: string[]): Promise<ProviderPaymentAccount | null> {
    const result = await this.database.query<Record<string, unknown>>(`SELECT id,provider_kind,doctor_profile_id,clinic_id,payment_provider,external_account_reference,status,verification_status,created_at,updated_at FROM provider_payment_accounts WHERE ${where}`, values);
    return result.rows[0] ? providerPaymentAccount(result.rows[0]) : null;
  }
}

function providerPaymentAccount(row: Record<string, unknown>): ProviderPaymentAccount {
  return {
    id: String(row.id), providerKind: row.provider_kind as ProviderPaymentAccountKind,
    doctorProfileId: row.doctor_profile_id === null ? null : String(row.doctor_profile_id),
    clinicId: row.clinic_id === null ? null : String(row.clinic_id),
    paymentProvider: String(row.payment_provider), externalAccountReference: String(row.external_account_reference),
    status: row.status as ProviderPaymentAccountStatus, verificationStatus: row.verification_status as ProviderPaymentAccountVerificationStatus,
    createdAt: new Date(String(row.created_at)), updatedAt: new Date(String(row.updated_at)),
  };
}

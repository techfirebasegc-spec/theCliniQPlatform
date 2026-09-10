import { describe, expect, it } from 'vitest';
import { ServiceExposureError, ServiceExposureService, type ServiceExposure, type ServiceExposureRepository } from '../src/modules/service-exposures/service-exposures.js';
import type { ServiceOffering } from '../src/modules/service-offerings/service-offerings.js';

const doctorOffering: ServiceOffering = { id: 'offering-doctor', owner: { kind: 'DOCTOR', doctorProfileId: 'doctor-a' }, name: 'Doctor service', description: null, status: 'ACTIVE' };
const clinicOffering: ServiceOffering = { id: 'offering-clinic', owner: { kind: 'CLINIC', clinicId: 'clinic-a', tenantId: 'tenant-a' }, name: 'Clinic service', description: null, status: 'ACTIVE' };

class Repository implements ServiceExposureRepository {
  public exposures = new Map<string, ServiceExposure>();
  async transaction<T>(operation: Parameters<ServiceExposureRepository['transaction']>[0]): Promise<T> { return operation({ query: async () => ({ rows: [], rowCount: 0 }) }); }
  async find(id: string) { return this.exposures.get(id) ?? null; }
  async findDoctorOwnedOffering(offeringId: string, accountId: string) { return offeringId === doctorOffering.id && accountId === 'doctor-account' ? doctorOffering : null; }
  async findOffering(offeringId: string) { return offeringId === doctorOffering.id ? doctorOffering : offeringId === clinicOffering.id ? clinicOffering : null; }
  async create(_database: unknown, exposure: ServiceExposure) { if ([...this.exposures.values()].some((item) => item.serviceOfferingId === exposure.serviceOfferingId)) throw { code: '23505' }; this.exposures.set(exposure.id, exposure); }
  async transition(_database: unknown, id: string, from: ServiceExposure['status'], to: ServiceExposure['status']) { const current=this.exposures.get(id); if (!current || current.status !== from) return null; const updated={...current,status:to}; this.exposures.set(id,updated); return updated; }
}

function setup() {
  const repository = new Repository(); const events: unknown[]=[];
  const context = { require: async (accountId: string, tenantId: string, permission: string) => { if (accountId !== 'clinic-owner' && accountId !== 'clinic-admin' || tenantId !== 'tenant-a' || permission !== 'clinic.manage') throw new Error('FORBIDDEN'); return { id:'membership',accountId,tenantId,role:'CLINIC_OWNER' as const,status:'ACTIVE' as const }; } };
  return { repository, events, service: new ServiceExposureService(repository, context, { append: async (event) => { events.push(event); } }) };
}

describe('theCliniQ Phase 5 Service Exposure', () => {
  it('lets only the owning doctor create and lifecycle-manage a doctor-owned exposure', async () => {
    const { service }=setup();
    const exposure=await service.create('doctor-account',doctorOffering.id);
    await expect(service.publish('doctor-account',exposure.id)).resolves.toMatchObject({status:'PUBLISHED'});
    await expect(service.unpublish('doctor-account',exposure.id)).resolves.toMatchObject({status:'UNPUBLISHED'});
    await expect(service.publish('doctor-account',exposure.id)).resolves.toMatchObject({status:'PUBLISHED'});
    await expect(service.unpublish('other-doctor',exposure.id)).rejects.toBeInstanceOf(ServiceExposureError);
  });

  it('uses clinic.manage for clinic-owned exposure and denies staff, patients, and network participants', async () => {
    const { service }=setup();
    const exposure=await service.create('clinic-owner',clinicOffering.id);
    await expect(service.publish('clinic-admin',exposure.id)).resolves.toMatchObject({status:'PUBLISHED'});
    for (const account of ['clinic-staff','patient-account','network-participant']) await expect(service.unpublish(account,exposure.id)).rejects.toBeInstanceOf(ServiceExposureError);
  });

  it('allows only approved lifecycle transitions and audits lifecycle outcomes', async () => {
    const { service, events }=setup(); const exposure=await service.create('doctor-account',doctorOffering.id);
    await expect(service.unpublish('doctor-account',exposure.id)).rejects.toMatchObject({code:'CONFLICT'});
    await service.publish('doctor-account',exposure.id); await service.unpublish('doctor-account',exposure.id); await service.publish('doctor-account',exposure.id);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({eventType:'SERVICE_EXPOSURE_CREATED'}),expect.objectContaining({eventType:'SERVICE_EXPOSURE_PUBLISHED'}),expect.objectContaining({eventType:'SERVICE_EXPOSURE_UNPUBLISHED'}),expect.objectContaining({eventType:'SERVICE_EXPOSURE_REPUBLISHED'}),expect.objectContaining({eventType:'SERVICE_EXPOSURE_LIFECYCLE_DENIED',outcome:'DENIED'})]));
  });

  it('keeps one exposure per Offering and derives doctor/clinic provider context from the Offering', async () => {
    const { service }=setup(); const doctor=await service.create('doctor-account',doctorOffering.id); const clinic=await service.create('clinic-owner',clinicOffering.id);
    expect(doctor).toMatchObject({provider:doctorOffering.owner,status:'DRAFT'}); expect(clinic).toMatchObject({provider:clinicOffering.owner,status:'DRAFT'});
    await expect(service.create('doctor-account',doctorOffering.id)).rejects.toMatchObject({code:'CONFLICT'});
  });
});

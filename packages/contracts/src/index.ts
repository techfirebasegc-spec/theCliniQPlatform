export type ServiceStatus = 'ok' | 'unavailable';

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export interface HealthResponse {
  status: 'ok';
  service: 'cliniq-core-api';
}

export interface ReadinessResponse {
  status: ServiceStatus;
  dependencies: {
    database: ServiceStatus;
    redis: ServiceStatus;
  };
}

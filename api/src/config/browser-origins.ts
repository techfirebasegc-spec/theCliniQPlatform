export const localPatientDevelopmentOrigin = 'http://localhost:3000';
export const localAdminDevelopmentOrigin = 'http://localhost:3001';
export const localProviderDevelopmentOrigin = 'http://localhost:3002';

export function browserOrigins(webUrl: string): string[] {
  const origins = webUrl === 'https://thecliniq.co.in'
    ? [webUrl, 'https://www.thecliniq.co.in']
    : [webUrl];
  return [...origins, localPatientDevelopmentOrigin, localAdminDevelopmentOrigin, localProviderDevelopmentOrigin];
}

export function requiresCrossSiteSessionCookie(origin: string | undefined): boolean {
  return origin === localPatientDevelopmentOrigin || origin === localAdminDevelopmentOrigin || origin === localProviderDevelopmentOrigin;
}

export function isLocalProviderDevelopmentOrigin(origin: string | undefined): boolean {
  return origin === localProviderDevelopmentOrigin;
}

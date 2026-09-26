export const localAdminDevelopmentOrigin = 'http://localhost:3001';

export function browserOrigins(webUrl: string): string[] {
  const origins = webUrl === 'https://thecliniq.co.in'
    ? [webUrl, 'https://www.thecliniq.co.in']
    : [webUrl];
  return [...origins, localAdminDevelopmentOrigin];
}

export function requiresCrossSiteSessionCookie(origin: string | undefined): boolean {
  return origin === localAdminDevelopmentOrigin;
}

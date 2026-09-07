'use client';

import { useEffect, useState } from 'react';

type Status = 'checking' | 'available' | 'unavailable';

export function StatusIndicator() {
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    const controller = new AbortController();
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000';

    void fetch(`${apiUrl}/health`, { signal: controller.signal })
      .then((response) => setStatus(response.ok ? 'available' : 'unavailable'))
      .catch(() => setStatus('unavailable'));

    return () => controller.abort();
  }, []);

  return <p><span className={`status status--${status}`} aria-hidden="true">●</span> API {status}</p>;
}

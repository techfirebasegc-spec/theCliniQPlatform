import { StatusIndicator } from './status-indicator';

export default function HomePage() {
  return (
    <main>
      <p className="eyebrow">CliniQ Platform</p>
      <h1>Technical foundation</h1>
      <p>This workspace is ready for the approved platform foundation. Product screens will preserve the existing CliniQ experience when they are implemented in later phases.</p>
      <section aria-labelledby="status-title">
        <h2 id="status-title">Status</h2>
        <p><span aria-hidden="true">●</span> Web application shell available</p>
        <StatusIndicator />
        <p>API health endpoint: <code>/health</code></p>
      </section>
    </main>
  );
}

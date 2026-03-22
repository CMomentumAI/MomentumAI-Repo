/**
 * Root landing page — minimal placeholder for a backend-API-only deployment.
 *
 * Momentum is a REST API backend. The frontend client is a separate service.
 * This page exists solely so Next.js has a root route to render; all
 * meaningful functionality is in /api/**.
 */

export default function Home() {
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 480,
        margin: "10vh auto",
        padding: "0 1rem",
      }}
    >
      <h1 style={{ fontSize: "1.5rem", fontWeight: 600 }}>Momentum API</h1>
      <p style={{ color: "#666", marginTop: "0.5rem" }}>
        Backend API server. All endpoints are under <code>/api/</code>.
      </p>
      <p style={{ marginTop: "1rem" }}>
        <a href="/api/health" style={{ color: "#0070f3" }}>
          → /api/health
        </a>
      </p>
    </main>
  );
}

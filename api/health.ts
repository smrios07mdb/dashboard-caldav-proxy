// Public uptime probe — no auth, no CORS needed.
export default {
  fetch(_req: Request): Response {
    return Response.json({ ok: true });
  },
};

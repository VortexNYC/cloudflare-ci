export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, canary: true });
    }
    return new Response("canary");
  },
};

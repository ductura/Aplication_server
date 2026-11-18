import { NO_STORE } from "../http/methods.js";
import { requireAdmin } from "./require-admin.js";

const DENIED = {
  401: { body: { error: "unauthorized" }, headers: { "WWW-Authenticate": "Bearer" } },
  403: { body: { error: "forbidden" }, headers: {} },
};

// GET /api/admin/me for a given identity source. The response never echoes the
// identity it was given.
export function createAdminMeHandler(getIdentity) {
  return async function GET(request) {
    const decision = requireAdmin(await getIdentity(request));
    if (!decision.ok) {
      const { body, headers } = DENIED[decision.status];
      return Response.json(body, { status: decision.status, headers: { ...NO_STORE, ...headers } });
    }
    return Response.json({ role: decision.role }, { headers: NO_STORE });
  };
}

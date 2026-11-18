// GET /api/admin/ja: the signed-in platform admin, or 401.
import { ja, ostaleMetode } from "../../../../admin/prijava.js";

export const GET = ja;
const { OPTIONS, nedopusteno } = ostaleMetode("GET, HEAD, OPTIONS");
export { OPTIONS, nedopusteno as POST, nedopusteno as PUT, nedopusteno as PATCH, nedopusteno as DELETE };

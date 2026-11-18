// POST /api/admin/prijava: platform admin login (admin/prijava.js).
import { napraviPrijavu, ostaleMetode } from "../../../../admin/prijava.js";

export const POST = napraviPrijavu();
const { OPTIONS, nedopusteno } = ostaleMetode("POST, OPTIONS");
export { OPTIONS, nedopusteno as GET, nedopusteno as PUT, nedopusteno as PATCH, nedopusteno as DELETE };

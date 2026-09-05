import { boot, frames, exec } from "./b_lib";
import { cl } from "../../src/client/client";
boot(["-basedir","/home/buzzkill/Projects/qfiles/q1-basedir","-game","e2e_b","-nosound"]);
frames(5);
exec("disconnect", 3);
const seq = process.argv.slice(2);
for (const s of seq) {
  console.log(">>>", s, "| maxclients before:", cl.maxclients);
  try { exec(s, 30); } catch (e) { const { cls } = require("../../src/client/client"); console.log("CRASH on", s, ":", String(e), "maxclients=", cl.maxclients, "levelname=", JSON.stringify(cl.levelname), "cls.state=", cls.state, "cls.signon=", cls.signon); process.exit(2); }
  console.log("<<<", s, "ok | levelname:", cl.levelname, "maxclients:", cl.maxclients);
}
console.log("ALL OK");
process.exit(0);

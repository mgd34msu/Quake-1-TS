import { boot, frames, exec } from "./b_lib";
boot(["-basedir","/home/buzzkill/Projects/qfiles/q1-basedir","-game","e2e_b","-nosound"]);
frames(5);
const seq = process.argv.slice(2);
for (const s of seq) { console.log(">>>", s); exec(s, 30); }
console.log("DONE");
process.exit(0);

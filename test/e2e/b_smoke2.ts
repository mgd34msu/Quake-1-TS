import { boot, frames, exec } from "./b_lib";
boot(["-basedir", "/home/buzzkill/Projects/qfiles/q1-basedir", "-game", "e2e_b", "-nosound"]);
frames(10);
exec("map e1m1", 30);
exec("screenshot", 5);
frames(5);
console.log("done");
process.exit(0);

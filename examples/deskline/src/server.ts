import { app } from "./app.js";
import { db } from "./db.js";

Bun.serve({ port: Number(process.env.PORT ?? 3210), fetch: app.fetch });
console.log("deskline on", process.env.PORT ?? 3210);

process.on("SIGTERM", async () => {
  await db.close();
  process.exit(0);
});

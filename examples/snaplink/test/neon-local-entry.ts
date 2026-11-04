/**
 * Test-only entry: points the Neon driver at the local endpoint, then serves
 * the example Worker unchanged.
 *
 * `NEON_LOCAL` is `host:port` of `startNeonLocal` from the repository harness.
 * The endpoint speaks plain HTTP and WebSocket and talks to Postgres with
 * password auth, so TLS and pipelined connect are off.
 *
 * In this repository `node_modules/okmodel` is a symlink to the repository
 * root, so the bundled adapter imports the root's copy of the driver. The
 * config must be set on that copy.
 */

import { neonConfig } from "../../../node_modules/@neondatabase/serverless/index.mjs";

import app from "../src/index.ts";

type LocalBindings = CloudflareBindings & { NEON_LOCAL: string };

export default {
  fetch(request: Request, env: LocalBindings, ctx: ExecutionContext) {
    neonConfig.fetchEndpoint = `http://${env.NEON_LOCAL}/sql`;
    neonConfig.wsProxy = `${env.NEON_LOCAL}/v2`;
    neonConfig.useSecureWebSocket = false;
    neonConfig.forceDisablePgSSL = true;
    neonConfig.pipelineConnect = false;
    neonConfig.pipelineTLS = false;
    return app.fetch(request, env, ctx);
  },
};

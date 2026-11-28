/**
 * `okm doctor` delivery self-test.
 *
 * The lines say whether push works on the configured URL and why. They do not
 * include the host. A notification queue at or above half full adds OKM2212.
 */

import { open } from "../../adapters/pg/postgresjs.js";
import { armListen } from "../../runtime/client.js";
import { explainDelivery, queueWarning } from "../../runtime/watch.js";
import { driverUrl } from "./driver-url.js";
import { finishQuiet } from "./lost.js";

armListen(1, () =>
  import("../../runtime/listen-postgresjs.js").then((mod) => mod.openPostgresJsListen),
);

/**
 * Runs the self-test against `url` and returns the doctor lines.
 *
 * @param url - Target URL, or `listenUrl` when the target is pooled
 * @returns Text ending in a newline. Empty when the connection cannot open
 */
export async function watchDoctorText(url: string): Promise<string> {
  const pool = open({ url: driverUrl(url), max: 1 });
  try {
    const report = await explainDelivery(pool, url);
    const line = report.ok
      ? `watch: push works on this URL (${report.reason}).`
      : `watch: push does not work on this URL (${report.reason}).`;
    const warning = queueWarning(report.queue);
    return warning === undefined ? `${line}\n` : `${line}\n${warning}\n`;
  } finally {
    await finishQuiet(() => pool.close());
  }
}

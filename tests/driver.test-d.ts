import type { DriverPool } from "../src/contracts/driver.js";
import { expectTypeOf } from "expect-type";

expectTypeOf<DriverPool["batch"]>().toBeFunction();
expectTypeOf<DriverPool["stats"]>().toBeFunction();

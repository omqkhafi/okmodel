import type { NeonMode } from "../src/runtime/pg/neon.js";
import { expectTypeOf } from "expect-type";

expectTypeOf<NeonMode>().toEqualTypeOf<"websocket" | "http">();

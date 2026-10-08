import { Effect } from "effect";
import { credential, failure, main, print } from "./gateway-runtime.ts";

main(
  Effect.gen(function* () {
    if (process.argv.length !== 3) return yield* failure("usage: llm-gateway-credential gatewai");
    yield* print(yield* credential(process.argv[2], process.env.HOME || ""));
  }),
);

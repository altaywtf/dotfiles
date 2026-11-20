import { Effect, Option, Schema } from "effect";

export const dropInvalid = <S extends Schema.Top>(schema: S) =>
  Schema.catchDecoding<S>(() => Effect.succeed(Option.none()))(schema);

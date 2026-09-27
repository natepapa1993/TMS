import "./load-env";
import { sqlClient } from "./client";
import { seedDemo } from "./seed-lib";

seedDemo()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sqlClient.end({ timeout: 2 }));

import "./load-env";
import { runMigrations } from "./migrate-lib";

runMigrations()
  .then(() => console.log("migrations applied"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

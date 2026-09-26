import { config } from "dotenv";
// .env.local wins over .env; real deployments set variables in the environment and never ship these files
config({ path: [".env.local", ".env"], quiet: true });

import "../db/load-env";
(process.env as Record<string, string>).NODE_ENV = "test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

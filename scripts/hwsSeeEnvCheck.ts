/**
 * HWS SEE — offline check of environment variables before a Preview / Production deployment.
 *
 *   npm run see:env-check -- --target=preview
 *   node --env-file=.env.preview.local --no-warnings scripts/hwsSeeEnvCheck.ts --target=production
 *
 * Reads process.env only, never connects to Supabase / R2 / Vercel and never prints secret values.
 * Exit code 1 when a required variable is missing or invalid.
 */
import { checkSeeEnvironment, formatSeeEnvReport, type SeeEnvTarget } from "../lib/see/envCheck.ts";

const argument = process.argv.find((value) => value.startsWith("--target="))?.split("=")[1];
const target: SeeEnvTarget = argument === "preview" || argument === "development" ? argument : "production";
const findings = checkSeeEnvironment(process.env, target);
console.log(formatSeeEnvReport(findings, target));
process.exitCode = findings.some((finding) => finding.level === "error") ? 1 : 0;

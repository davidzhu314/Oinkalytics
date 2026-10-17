import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { config } from "./src/config.ts";

const tag = (s?: string) => (s ? `${s.slice(0, 8)}…(${s.length} chars)` : "MISSING");
console.log("project:", tag(config.projectId), " secret:", tag(config.projectSecret));

try {
  const app = await Spectrum({
    projectId: config.projectId!,
    projectSecret: config.projectSecret!,
    providers: [imessage.config()],
  });
  console.log("\nAUTH OK");
  console.log("project name:", (app as any).config?.profile?.name ?? "(none reported)");
  await app.stop();
} catch (err) {
  console.log("\nAUTH FAILED:", (err as Error).message);
}

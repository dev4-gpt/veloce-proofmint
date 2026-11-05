// The Veloce h1 surface (see src/lib/h1/tasks.ts). OFF unless FORGE_H1_ENABLED=true: while off, every path here is a plain 404.
// A host-started round runs after the reply with `after()`, inside this function's time limit.
import { after } from "next/server";
import { h1Config } from "@/lib/h1/manifest";
import { handleH1 } from "@/lib/h1/tasks";
import { runHostRound } from "@/lib/roundJob";

export const maxDuration = 300;

async function handle(req: Request, ctx: { params: Promise<{ op: string }> }): Promise<Response> {
  const settings = h1Config();
  if (!settings.ok) {
    // off: invisible; on but wrongly set up: say so without detail (the operator checks the settings)
    return Response.json({ ok: false, error: settings.reason === "off" ? "not_found" : "unavailable" }, { status: settings.reason === "off" ? 404 : 503 });
  }
  const { op } = await ctx.params;
  return handleH1(req, op, { config: settings.config, schedule: (fn) => after(fn), run: runHostRound });
}

export { handle as GET, handle as POST };

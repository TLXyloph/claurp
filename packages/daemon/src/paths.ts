import { homedir } from "node:os";
import { join } from "node:path";

export function claurpHome(): string {
  return process.env.CLAURP_HOME ?? join(homedir(), ".claurp");
}
export function modelPath(...parts: string[]): string {
  return join(claurpHome(), "models", ...parts);
}

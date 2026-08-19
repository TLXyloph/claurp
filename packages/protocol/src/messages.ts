import { z } from "zod";

export const PROTOCOL_VERSION = 1;

const base = z.object({ v: z.literal(PROTOCOL_VERSION) });

// ---- senses → daemon ----
export const SensesHello = base.extend({
  type: z.literal("hello"),
  client: z.string().min(1),
  protocol: z.literal(PROTOCOL_VERSION),
});
export const PttMsg = base.extend({
  type: z.literal("ptt"),
  action: z.enum(["down", "up"]),
});
export const PermissionResponseMsg = base.extend({
  type: z.literal("permission.response"),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  decision: z.enum(["allow", "deny", "always"]),
});

export const SensesToDaemon = z.discriminatedUnion("type", [
  SensesHello,
  PttMsg,
  PermissionResponseMsg,
]);
export type SensesToDaemonMsg = z.infer<typeof SensesToDaemon>;

// ---- daemon → senses ----
export const DaemonHelloAck = base.extend({
  type: z.literal("hello.ack"),
  daemonVersion: z.string(),
});
export const StateMsg = base.extend({
  type: z.literal("state"),
  mode: z.enum(["idle", "listening", "working", "needs-you", "disconnected"]),
});
export const TranscriptPartial = base.extend({
  type: z.literal("transcript.partial"),
  text: z.string(),
});
export const TranscriptFinal = base.extend({
  type: z.literal("transcript.final"),
  text: z.string(),
});
export const EarconMsg = base.extend({
  type: z.literal("earcon"),
  kind: z.enum(["wake-ack", "shutter", "permission-ask", "done"]),
});
export const HudSessionMsg = base.extend({
  type: z.literal("hud.session"),
  sessionId: z.string(),
  label: z.string(),
  state: z.enum(["spawning", "working", "needs-permission", "needs-input", "done", "failed", "handed-off"]),
  permissionMode: z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]),
  narration: z.string().optional(),
});
export const HudPermissionMsg = base.extend({
  type: z.literal("hud.permission"),
  sessionId: z.string(),
  requestId: z.string(),
  tool: z.string(),
  detail: z.string(),
  spoken: z.string(),
});
export const NotifyMsg = base.extend({
  type: z.literal("notify"),
  title: z.string(),
  body: z.string(),
  sessionId: z.string().optional(),
  requestId: z.string().optional(),
  actions: z.array(z.enum(["allow", "deny", "open-terminal"])).default([]),
});
export const SpeakStopMsg = base.extend({ type: z.literal("speak.stop") });

export const DaemonToSenses = z.discriminatedUnion("type", [
  DaemonHelloAck,
  StateMsg,
  TranscriptPartial,
  TranscriptFinal,
  EarconMsg,
  HudSessionMsg,
  HudPermissionMsg,
  NotifyMsg,
  SpeakStopMsg,
]);
export type DaemonToSensesMsg = z.infer<typeof DaemonToSenses>;

export function parseSensesMsg(json: unknown): SensesToDaemonMsg {
  return SensesToDaemon.parse(json);
}
export function parseDaemonMsg(json: unknown): DaemonToSensesMsg {
  return DaemonToSenses.parse(json);
}

// ---- binary frames: [1 byte type][little-endian PCM16 payload] ----
export const BIN_MIC_PCM16_16K = 0x01;
export const BIN_TTS_PCM16_24K = 0x02;

export function encodeBinaryFrame(type: number, payload: Int16Array): Buffer {
  const buf = Buffer.alloc(1 + payload.length * 2);
  buf.writeUInt8(type, 0);
  for (let i = 0; i < payload.length; i++) buf.writeInt16LE(payload[i], 1 + i * 2);
  return buf;
}

export function decodeBinaryFrame(buf: Buffer): { type: number; pcm: Int16Array } {
  if (buf.length < 1 || (buf.length - 1) % 2 !== 0) throw new Error("malformed binary frame");
  const type = buf.readUInt8(0);
  const pcm = new Int16Array((buf.length - 1) / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(1 + i * 2);
  return { type, pcm };
}

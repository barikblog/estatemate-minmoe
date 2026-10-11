/**
 * What kind of device agent an `isapi_agents` row is.
 *
 * Migration 0026 put a CHECK on `agent_kind` (`'bridge','esp32'`) and SQLite
 * cannot widen a CHECK in place, so migration 0027 adds `agent_kind_ext` for
 * the kinds that came later. Every read goes through `agentKindSql()`, so the
 * rest of the Worker only ever sees one value: the effective kind.
 *
 * Two families matter to the rules, and they must treat every kind the same:
 *
 *  - **bridge hosts** run the LAN bridge (`isapi-bridge/agent.mjs`, the Windows
 *    agent, or the Android bridge) and dial terminals. They get a bridge setup
 *    file from Download setup, which rotates the agent secret.
 *  - **gate controllers** are the gate: they read a Wiegand reader, decide from
 *    a cached credential snapshot and drive a relay, and they never dial a
 *    terminal. They serve exactly one terminal, get their own kind of download
 *    (a program with no secret, and a config that rotates that agent's secret),
 *    and a bridge installer must be refused for them before anything rotates.
 */
export type AgentKind = 'bridge' | 'esp32' | 'pi_bridge' | 'pi_gate';

export const AGENT_KINDS: readonly AgentKind[] = ['bridge', 'esp32', 'pi_bridge', 'pi_gate'];
export const BRIDGE_AGENT_KINDS: readonly AgentKind[] = ['bridge', 'pi_bridge'];
export const CONTROLLER_AGENT_KINDS: readonly AgentKind[] = ['esp32', 'pi_gate'];

export function isBridgeKind(kind: string): boolean {
  return (BRIDGE_AGENT_KINDS as readonly string[]).includes(kind);
}

export function isControllerKind(kind: string): boolean {
  return (CONTROLLER_AGENT_KINDS as readonly string[]).includes(kind);
}

/**
 * The SQL expression that yields the effective agent kind for a row, including
 * the alias prefix (`a.agent_kind_ext`) the caller selects with.
 */
export function agentKindSql(alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  return `COALESCE(${prefix}agent_kind_ext,${prefix}agent_kind)`;
}

export function normalizeAgentKind(value: unknown): AgentKind {
  const kind = String(value ?? '').trim().toLowerCase();
  return (AGENT_KINDS as readonly string[]).includes(kind) ? (kind as AgentKind) : 'bridge';
}

/** The label the portal shows for a kind (the "Runs on" column). */
export function agentKindLabel(kind: string): string {
  switch (normalizeAgentKind(kind)) {
    case 'esp32': return 'ESP32 gate controller';
    case 'pi_bridge': return 'Raspberry Pi (bridge)';
    case 'pi_gate': return 'Raspberry Pi gate controller';
    default: return '';
  }
}

/**
 * What the agent form's "Runs on" value means when an agent is created.
 *
 * `platform` keeps its original CHECK list (`windows`,`linux`,`darwin`,`other`)
 * and is never widened: a controller is stored as `other` (an ESP32 is not any
 * of the four) and a Pi bridge is a Linux host. The kind carries the rest.
 */
export interface AgentKindChoice {
  kind: AgentKind;
  platform: 'windows' | 'linux' | 'darwin' | 'other';
}

const REQUESTED_KINDS: Record<string, AgentKindChoice> = {
  windows: { kind: 'bridge', platform: 'windows' },
  linux: { kind: 'bridge', platform: 'linux' },
  darwin: { kind: 'bridge', platform: 'darwin' },
  other: { kind: 'bridge', platform: 'other' },
  esp32: { kind: 'esp32', platform: 'other' },
  pi_bridge: { kind: 'pi_bridge', platform: 'linux' },
  pi_gate: { kind: 'pi_gate', platform: 'other' },
};

/** The `platform` values the Add agent form may send (they are not DB platforms). */
export const REQUESTED_AGENT_PLATFORMS = Object.keys(REQUESTED_KINDS);

export function resolveRequestedAgentKind(requested: string | undefined): AgentKindChoice | null {
  const value = (requested ?? 'windows').trim().toLowerCase();
  return REQUESTED_KINDS[value] ?? null;
}

/** The part of `agent_kind_ext` to write for a kind (null = legacy column only). */
export function agentKindExtFor(kind: AgentKind): 'pi_bridge' | 'pi_gate' | null {
  return kind === 'pi_bridge' || kind === 'pi_gate' ? kind : null;
}

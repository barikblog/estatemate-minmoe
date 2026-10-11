/**
 * The two files a Raspberry Pi gate controller is built from, as the portal
 * hands them out (Device agent > Raspberry Pi gate controller row):
 *
 *  - the program (`EstateMateGate.mjs`): a short banner naming the agent it was
 *    downloaded for, followed by `pi-gate/EstateMateGate.mjs` byte for byte -
 *    the very file the host tests run and `src/pi-gate-program.ts` embeds. It
 *    holds no secret, so it can be shared, re-downloaded and kept in version
 *    control.
 *  - the config (`estatemate-gate.json`): the agent ID and secret, the portal
 *    URL and the EstateMate device ID of the one terminal linked to the agent.
 *    Generating it rotates the agent secret (src/index.ts), exactly like a
 *    bridge setup file.
 *
 * When the agent has no linked terminal - or more than one - there is no single
 * device ID to give the gate. The config is still produced, but as a file the
 * program refuses to start from (its `error` field says what to do), and no
 * secret is rotated or written.
 */
import { PI_GATE_PROGRAM } from './pi-gate-program';

export const PI_GATE_PROGRAM_FILENAME = 'EstateMateGate.mjs';
export const PI_GATE_CONFIG_FILENAME = 'estatemate-gate.json';

export interface PiGateAgentInfo {
  id: string;
  name: string;
}

export interface PiGateLinkedTerminal {
  deviceId: string;
  name: string;
  gateName: string | null;
}

/** Text that is safe inside a JS line comment: one line, no comment terminator. */
function commentText(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\*\//g, '* /').replace(/[^\x20-\x7e]/g, '?').trim().slice(0, 120);
}

export type PiGateConfigResult =
  | { ready: true; content: string; terminal: PiGateLinkedTerminal }
  | { ready: false; content: string; reason: 'no_terminal' | 'several_terminals' };

function terminalLabel(terminal: PiGateLinkedTerminal): string {
  return `${terminal.name}${terminal.gateName ? ` - ${terminal.gateName}` : ''} (${terminal.deviceId})`;
}

/** The program, with a banner naming the agent it was downloaded for. */
export function renderPiGateProgram(agent: PiGateAgentInfo, generatedAt: Date): string {
  return [
    `// Downloaded from EstateMate on ${generatedAt.toISOString()} for the Raspberry Pi`,
    `// gate controller agent "${commentText(agent.name)}" (${commentText(agent.id)}). It holds no secret: put it`,
    `// next to the estatemate-gate.json from Device agent > Download Pi gate config.`,
    '',
    PI_GATE_PROGRAM,
  ].join('\n');
}

const DEFAULT_PINS = {
  chip: 'gpiochip0',
  wiegandD0: 17,
  wiegandD1: 18,
  relay: 25,
  relayActiveHigh: true,
  exitButton: 27,
};

/**
 * Explains, as a config file the program refuses to start from, why no config
 * could be made. Returned without rotating anything.
 */
export function renderPiGateConfigProblem(
  agent: PiGateAgentInfo,
  terminals: PiGateLinkedTerminal[],
  generatedAt: Date,
): PiGateConfigResult {
  const none = terminals.length === 0;
  const error = none
    ? 'No terminal is connected to this Raspberry Pi gate controller yet, so there is no EstateMate device ID to give the gate. Register the gate under Terminals & devices, connect it to this agent under Device agent (any LAN address - the Pi gate never dials it), then download the config again.'
    : `${terminals.length} terminals are connected to this Raspberry Pi gate controller, but one controller drives one gate. Disconnect all but one under Device agent > Connected terminals, then download the config again.`;
  const content = `${JSON.stringify({
    error,
    agent: { id: agent.id, name: agent.name },
    generatedAt: generatedAt.toISOString(),
    secretRotated: false,
    note: 'This file was generated to explain a problem, not to run a gate. The agent secret was NOT rotated and is not in this file.',
    steps: none
      ? [
        'Terminals & devices > Register device: add the gate (any model name).',
        'Device agent > Connect terminal: choose that terminal and this agent. Any LAN address will do - the gate never dials it.',
        'Download Pi gate config again.',
      ]
      : ['Device agent > Connected terminals: disconnect all but one terminal.', 'Download Pi gate config again.'],
    terminals: terminals.map((terminal) => ({ deviceId: terminal.deviceId, name: terminal.name, gateName: terminal.gateName })),
  }, null, 2)}\n`;
  return { ready: false, content, reason: none ? 'no_terminal' : 'several_terminals' };
}

/** The usable config for an agent with exactly one linked terminal. */
export function renderPiGateConfig(
  agent: PiGateAgentInfo,
  terminal: PiGateLinkedTerminal,
  workerUrl: string,
  secret: string,
  generatedAt: Date,
): PiGateConfigResult {
  const content = `${JSON.stringify({
    _comment: [
      'EstateMate Raspberry Pi gate controller configuration.',
      `Agent: ${commentText(agent.name)} (${agent.id}); terminal: ${commentText(terminalLabel(terminal))}.`,
      `Generated ${generatedAt.toISOString()}.`,
      '',
      'This file holds the agent secret. Keep it on the Pi and nowhere else: not in Git,',
      'not on a shared drive. Downloading a new config rotates the secret, so a Pi still',
      'running the previous file stops being accepted.',
      '',
      'Edit the GPIO numbers below to match your wiring. Everything else has a default:',
      'doorNo 1 (the door the portal commands address), stateDir /var/lib/estatemate-pi-gate,',
      'label "Raspberry Pi gate controller".',
    ],
    workerUrl,
    agentId: agent.id,
    agentSecret: secret,
    deviceId: terminal.deviceId,
    doorNo: 1,
    stateDir: '/var/lib/estatemate-pi-gate',
    gpio: { backend: 'libgpiod', ...DEFAULT_PINS },
  }, null, 2)}\n`;
  return { ready: true, content, terminal };
}

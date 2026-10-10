/**
 * The two files an ESP32 gate controller is built from, as the portal hands
 * them out (Device agent > ESP32 agent row):
 *
 *  - the sketch (`EstateMateGate.ino`): the canonical source from
 *    esp32-gate/EstateMateGate/, byte for byte the file the host tests compile,
 *    with a short banner naming the agent it was downloaded for. It holds no
 *    secret, so it can be shared, re-downloaded and kept in version control.
 *  - the config (`secrets.h`): the agent ID and secret, the portal URL and the
 *    EstateMate device ID of the one terminal linked to the agent. Generating it
 *    rotates the agent secret (src/index.ts), exactly like a bridge setup file.
 *
 * When the agent has no linked terminal - or more than one - there is no single
 * device ID to give the gate. The config is still produced, but as a file that
 * refuses to compile and says what to do, and no secret is rotated or written.
 */
import { ESP32_GATE_SKETCH } from './esp32-gate-sketch';

export const ESP32_SKETCH_FILENAME = 'EstateMateGate.ino';
export const ESP32_CONFIG_FILENAME = 'secrets.h';

export interface Esp32AgentInfo {
  id: string;
  name: string;
}

export interface Esp32LinkedTerminal {
  deviceId: string;
  name: string;
  gateName: string | null;
}

/** Text that is safe inside a C comment: one line, no comment terminator. */
function commentText(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\*\//g, '* /').replace(/[^\x20-\x7e]/g, '?').trim().slice(0, 120);
}

/** A C string literal body: printable ASCII only, quotes and backslashes escaped. */
function cString(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** The sketch, with a banner naming the agent it was downloaded for. */
export function renderEsp32Sketch(agent: Esp32AgentInfo, generatedAt: Date): string {
  return [
    `// Downloaded from EstateMate on ${generatedAt.toISOString()} for the ESP32 agent`,
    `// "${commentText(agent.name)}" (${commentText(agent.id)}). It holds no secret: pair it with the`,
    `// secrets.h from Device agent > Download ESP32 config, in the same folder.`,
    '',
    ESP32_GATE_SKETCH,
  ].join('\n');
}

const WIRING_DEFAULTS = `// 3. Wiring and behaviour (optional). These are the defaults; uncomment a line
//    to change it. 5 V Wiegand readers need a level shifter on D0/D1.
// #define ESTATEMATE_WIEGAND_D0_PIN 26
// #define ESTATEMATE_WIEGAND_D1_PIN 27
// #define ESTATEMATE_RELAY_PIN 25
// #define ESTATEMATE_RELAY_ACTIVE_HIGH 1
// #define ESTATEMATE_EXIT_BUTTON_PIN 33      // to GND; -1 disables
// #define ESTATEMATE_READER_LED_PIN -1       // reader LED line (active low)
// #define ESTATEMATE_READER_BUZZER_PIN -1    // reader beeper line (active low)
// #define ESTATEMATE_DOOR_OPEN_MS 3000
// #define ESTATEMATE_DOOR_NO 1               // door number portal commands address
// #define ESTATEMATE_MAX_CARDS 0             // 0 = 100000 with PSRAM, 8000 without
// #define ESTATEMATE_NTP_SERVER_1 "pool.ntp.org"
// #define ESTATEMATE_NTP_SERVER_2 "time.google.com"
// A portal on a custom domain whose certificate is not from Google Trust
// Services, Let's Encrypt, SSL.com or Sectigo needs its root here:
// #define ESTATEMATE_CUSTOM_CA_PEM "-----BEGIN CERTIFICATE-----\\n...\\n-----END CERTIFICATE-----\\n"
`;

export type Esp32ConfigResult =
  | { ready: true; content: string; terminal: Esp32LinkedTerminal }
  | { ready: false; content: string; reason: 'no_terminal' | 'several_terminals' };

function terminalLabel(terminal: Esp32LinkedTerminal): string {
  return commentText(`${terminal.name}${terminal.gateName ? ` - ${terminal.gateName}` : ''} (${terminal.deviceId})`);
}

/**
 * Explains, as a file that refuses to compile, why no config could be made.
 * Returned without rotating anything.
 */
export function renderEsp32ConfigProblem(
  agent: Esp32AgentInfo,
  terminals: Esp32LinkedTerminal[],
  generatedAt: Date,
): Esp32ConfigResult {
  const none = terminals.length === 0;
  const lines = [
    '/*',
    ' * EstateMate ESP32 gate controller - secrets.h (NOT USABLE YET)',
    ` * Agent: ${commentText(agent.name)} (${commentText(agent.id)})`,
    ` * Generated ${generatedAt.toISOString()}`,
    ' *',
  ];
  if (none) {
    lines.push(
      ' * No terminal is connected to this agent, so there is no EstateMate device ID',
      ' * to give the gate. The agent secret was NOT rotated and is not in this file.',
      ' *',
      ' * 1. Terminals & devices > Register device: add the gate (any model name).',
      ' * 2. Device agent > Connect terminal: choose that terminal and this agent.',
      ' *    Any LAN address will do - the ESP32 never dials it.',
      ' * 3. Download ESP32 config again.',
      ' */',
      '#error "No terminal is connected to this ESP32 agent yet, so there is no device ID. Register the gate under Terminals & devices, connect it to this agent under Device agent (any LAN address - the ESP32 never dials it), then download the ESP32 config again."',
      '',
    );
  } else {
    lines.push(
      ` * ${terminals.length} terminals are connected to this agent, but an ESP32 controls one`,
      ' * gate. Disconnect all but one under Device agent > Connected terminals, then',
      ' * download the config again. The agent secret was NOT rotated.',
      ' *',
      ...terminals.map((terminal) => ` *   - ${terminalLabel(terminal)}`),
      ' */',
      '#error "Several terminals are connected to this ESP32 agent; an ESP32 controls exactly one gate. Disconnect the others under Device agent, then download the ESP32 config again."',
      '',
    );
  }
  return { ready: false, content: lines.join('\n'), reason: none ? 'no_terminal' : 'several_terminals' };
}

/** The usable config for an agent with exactly one linked terminal. */
export function renderEsp32Config(
  agent: Esp32AgentInfo,
  terminal: Esp32LinkedTerminal,
  workerUrl: string,
  secret: string,
  generatedAt: Date,
): Esp32ConfigResult {
  const content = [
    '/*',
    ' * EstateMate ESP32 gate controller - secrets.h',
    ` * Agent:    ${commentText(agent.name)} (${commentText(agent.id)})`,
    ` * Terminal: ${terminalLabel(terminal)}`,
    ` * Portal:   ${commentText(workerUrl)}`,
    ` * Generated ${generatedAt.toISOString()}`,
    ' *',
    ' * This file holds the agent secret. Keep it next to EstateMateGate.ino on the',
    ' * computer that flashes the board, and nowhere else: not in Git, not on a',
    ' * shared drive. Downloading a new config rotates the secret, so the previous',
    ' * file (and any board flashed with it) stops being accepted.',
    ' */',
    '#pragma once',
    '#define ESTATEMATE_CONFIG_VERSION 1',
    '',
    '// 1. Wi-Fi at the gate (2.4 GHz). Fill in both values, then set',
    '//    ESTATEMATE_WIFI_CONFIGURED to 1 - the sketch will not compile until you do.',
    '#define ESTATEMATE_WIFI_SSID "YOUR_WIFI_NAME"',
    '#define ESTATEMATE_WIFI_PASSWORD "YOUR_WIFI_PASSWORD"',
    '#define ESTATEMATE_WIFI_CONFIGURED 0',
    '',
    '// 2. EstateMate. Filled in by the portal; do not edit.',
    `#define ESTATEMATE_WORKER_URL "${cString(workerUrl)}"`,
    `#define ESTATEMATE_AGENT_ID "${cString(agent.id)}"`,
    `#define ESTATEMATE_AGENT_SECRET "${cString(secret)}"`,
    `#define ESTATEMATE_DEVICE_ID "${cString(terminal.deviceId)}"`,
    '',
    WIRING_DEFAULTS,
  ].join('\n');
  return { ready: true, content, terminal };
}

import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';
import { imageToPdfBlob } from './pdf';

/**
 * Renders the issued visitor pass to a bitmap so it can be shared as an image
 * or wrapped into a one-page PDF. Everything is drawn locally — no service,
 * no upload — and the QR/Code 128 payloads are the same credential the gate
 * scanner already accepts.
 */

export interface PassShareSource {
  credential: string;
  visitorName: string;
  host: string;
  property: string;
  pin: string;
  fromText: string;
  untilText: string;
  gateText: string;
  portalName: string;
  shortName: string;
}

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled';

const WIDTH = 900;
const PAD = 56;
const INK = '#14213d';
const MUTED = '#68748a';
const BLUE = '#1769e0';
const LINE = '#dfe6ef';
const FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const POLICY = 'Security must scan and review this pass before accepting entry. Device recognition requires a compatible, configured reader.';
const FOOTER = 'Powered by sornix.com.ng';

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The QR code could not be rendered for sharing'));
    image.src = dataUrl;
  });
}

function base64ToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function renderVisitorPassCanvas(source: PassShareSource): Promise<HTMLCanvasElement> {
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) throw new Error('Canvas is not available in this browser');
  probe.font = `400 19px ${FONT}`;
  const policyLines = wrapText(probe, POLICY, WIDTH - PAD * 2);

  if (!source.credential) throw new Error('This pass has no credential to share');
  const qrDataUrl = await QRCode.toDataURL(source.credential, {
    width: 300,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: INK, light: '#ffffff' },
  });
  const qrImage = await loadImage(qrDataUrl);

  const barcodeCanvas = document.createElement('canvas');
  JsBarcode(barcodeCanvas, source.credential, {
    format: 'CODE128',
    displayValue: false,
    height: 96,
    width: 3,
    margin: 0,
    background: '#ffffff',
    lineColor: INK,
  });

  const qrSize = 300;
  const maxBarcodeWidth = WIDTH - PAD * 2 - 120;
  const barcodeWidth = Math.min(barcodeCanvas.width, maxBarcodeWidth);
  const barcodeHeight = Math.max(1, Math.round(barcodeCanvas.height * (barcodeWidth / Math.max(1, barcodeCanvas.width))));

  const gaps = { afterHeader: 34, afterTitle: 30, afterQr: 26, afterBarcode: 22, afterCredential: 28, afterPin: 26, afterDates: 26 };
  const headerHeight = 96;
  const titleHeight = source.host ? 128 : 86;
  const credentialHeight = 78;
  const pinHeight = source.pin ? 62 : 0;
  const datesHeight = 96;
  const gateHeight = source.gateText ? 34 : 0;
  const policyHeight = policyLines.length * 29;
  const footerHeight = 78;

  const height = PAD * 2 + headerHeight + gaps.afterHeader + titleHeight + gaps.afterTitle
    + qrSize + gaps.afterQr + barcodeHeight + gaps.afterBarcode + credentialHeight + gaps.afterCredential
    + pinHeight + (pinHeight ? gaps.afterPin : 0) + datesHeight + gaps.afterDates
    + gateHeight + policyHeight + footerHeight;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser');
  canvas.width = WIDTH;
  canvas.height = height;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, WIDTH - 6, height - 6);

  const text = (value: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = 'left'): void => {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(value, x, y);
  };
  const centered = (value: string, y: number, font: string, color: string): void => text(value, WIDTH / 2, y, font, color, 'center');
  const panel = (x: number, y: number, width: number, panelHeight: number, fill: string): void => {
    const radius = 12;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + panelHeight, radius);
    ctx.arcTo(x + width, y + panelHeight, x, y + panelHeight, radius);
    ctx.arcTo(x, y + panelHeight, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  const rule = (y: number): void => {
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, y);
    ctx.lineTo(WIDTH - PAD, y);
    ctx.stroke();
  };

  let y = PAD;

  // Header: portal mark, pass type and portal name.
  const markSize = 74;
  panel(PAD, y, markSize, markSize, BLUE);
  text(source.shortName || 'EM', PAD + markSize / 2, y + markSize / 2 + 9, `800 26px ${FONT}`, '#ffffff', 'center');
  text('ESTATE VISITOR PASS', PAD + markSize + 24, y + 32, `800 15px ${FONT}`, BLUE);
  text(source.portalName || 'EstateMate', PAD + markSize + 24, y + 62, `700 26px ${FONT}`, INK);
  y += headerHeight + gaps.afterHeader;

  // Visitor and host.
  text(source.visitorName || 'Visitor', PAD, y + 40, `800 46px ${FONT}`, INK);
  y += 62;
  if (source.host) {
    text(`Host:  ${source.host}`, PAD, y + 26, `600 23px ${FONT}`, INK);
    text(`Property:  ${source.property || '—'}`, PAD, y + 58, `600 23px ${FONT}`, INK);
    y += 66;
  }
  y += gaps.afterTitle;
  rule(y);
  y += 30;

  // QR then Code 128 — the two scanner formats the gate accepts.
  const qrX = (WIDTH - qrSize) / 2;
  ctx.drawImage(qrImage, qrX, y, qrSize, qrSize);
  y += qrSize + gaps.afterQr;

  ctx.drawImage(barcodeCanvas, (WIDTH - barcodeWidth) / 2, y, barcodeWidth, barcodeHeight);
  y += barcodeHeight + gaps.afterBarcode;

  centered(source.credential, y + 42, `800 40px ${FONT}`, INK);
  centered('Unique visitor number', y + 70, `500 17px ${FONT}`, MUTED);
  y += credentialHeight + gaps.afterCredential;

  if (source.pin) {
    const pinLabel = `Keypad PIN:  ${source.pin}`;
    ctx.font = `700 24px ${FONT}`;
    const pinWidth = Math.max(280, ctx.measureText(pinLabel).width + 56);
    panel((WIDTH - pinWidth) / 2, y, pinWidth, 54, '#eef4fc');
    centered(pinLabel, y + 36, `700 24px ${FONT}`, INK);
    y += pinHeight + gaps.afterPin;
  }

  // Validity window and gate scope.
  const boxWidth = (WIDTH - PAD * 2 - 20) / 2;
  panel(PAD, y, boxWidth, 88, '#f1f5fa');
  panel(PAD + boxWidth + 20, y, boxWidth, 88, '#f1f5fa');
  text('VALID FROM', PAD + 18, y + 30, `800 13px ${FONT}`, MUTED);
  text(source.fromText, PAD + 18, y + 62, `700 20px ${FONT}`, INK);
  text('VALID UNTIL', PAD + boxWidth + 38, y + 30, `800 13px ${FONT}`, MUTED);
  text(source.untilText, PAD + boxWidth + 38, y + 62, `700 20px ${FONT}`, INK);
  y += datesHeight + gaps.afterDates;

  if (source.gateText) {
    centered(source.gateText, y + 20, `700 20px ${FONT}`, BLUE);
    y += gateHeight;
  }

  ctx.textAlign = 'center';
  for (const line of policyLines) {
    text(line, WIDTH / 2, y + 22, `400 19px ${FONT}`, MUTED, 'center');
    y += 29;
  }

  y += 26;
  rule(y);
  centered(FOOTER, y + 44, `700 19px ${FONT}`, MUTED);

  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The pass image could not be generated'))),
      type,
      quality,
    );
  });
}

export async function visitorPassImageBlob(source: PassShareSource): Promise<Blob> {
  return canvasToBlob(await renderVisitorPassCanvas(source), 'image/png');
}

export async function visitorPassPdfBlob(source: PassShareSource): Promise<Blob> {
  const canvas = await renderVisitorPassCanvas(source);
  const jpeg = base64ToBytes(canvas.toDataURL('image/jpeg', 0.92));
  return imageToPdfBlob(jpeg, canvas.width, canvas.height, `Visitor pass ${source.credential}`);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

type ShareCapableNavigator = Navigator & {
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
};

/** Uses the native share sheet where the device supports files, otherwise saves the file. */
export async function sharePassFile(blob: Blob, filename: string, title: string): Promise<ShareOutcome> {
  const navigatorRef = navigator as ShareCapableNavigator;
  const file = new File([blob], filename, { type: blob.type });
  if (navigatorRef.canShare?.({ files: [file] }) && navigatorRef.share) {
    try {
      await navigatorRef.share({ files: [file], title });
      return 'shared';
    } catch (reason) {
      if (reason instanceof Error && reason.name === 'AbortError') return 'cancelled';
      // A rejected share sheet must not lose the pass — fall through to a download.
    }
  }
  downloadBlob(blob, filename);
  return 'downloaded';
}

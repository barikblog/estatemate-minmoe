/**
 * Minimal single-image PDF writer.
 *
 * EstateMate deliberately adds no paid service and no heavyweight dependency,
 * so a generated visitor pass is embedded straight into a one-page A4 PDF as a
 * JPEG. Only the pieces a viewer needs are emitted: catalog, page tree, page,
 * image XObject, content stream and document info.
 */

const PAGE_WIDTH = 595.28; // A4 portrait, in points
const PAGE_HEIGHT = 841.89;
const MARGIN = 24;

function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function imageToPdfBlob(jpeg: Uint8Array, imageWidth: number, imageHeight: number, title: string): Blob {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;

  const write = (chunk: string | Uint8Array): void => {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    chunks.push(bytes);
    length += bytes.byteLength;
  };
  const beginObject = (id: number): void => {
    offsets[id] = length;
    write(`${id} 0 obj\n`);
  };
  const endObject = (): void => write('endobj\n');

  const scale = Math.min((PAGE_WIDTH - MARGIN * 2) / imageWidth, (PAGE_HEIGHT - MARGIN * 2) / imageHeight);
  const drawnWidth = imageWidth * scale;
  const drawnHeight = imageHeight * scale;
  const x = (PAGE_WIDTH - drawnWidth) / 2;
  const y = (PAGE_HEIGHT - drawnHeight) / 2;
  const content = `q\n${drawnWidth.toFixed(2)} 0 0 ${drawnHeight.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im0 Do\nQ\n`;
  const contentBytes = encoder.encode(content);

  // The binary marker comment tells tooling the file is not plain text.
  write('%PDF-1.4\n');
  write(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  beginObject(1);
  write('<< /Type /Catalog /Pages 2 0 R >>\n');
  endObject();

  beginObject(2);
  write('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n');
  endObject();

  beginObject(3);
  write(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH.toFixed(2)} ${PAGE_HEIGHT.toFixed(2)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\n`);
  endObject();

  beginObject(4);
  write(`<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>\nstream\n`);
  write(jpeg);
  write('\nendstream\n');
  endObject();

  beginObject(5);
  write(`<< /Length ${contentBytes.byteLength} >>\nstream\n`);
  write(contentBytes);
  write('\nendstream\n');
  endObject();

  beginObject(6);
  write(`<< /Title (${escapePdfText(title)}) /Producer (EstateMate) >>\n`);
  endObject();

  const xrefOffset = length;
  const objectCount = 7; // objects 0..6
  let xref = `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
  for (let id = 1; id < objectCount; id += 1) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objectCount} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  write(xref);

  return new Blob(chunks as BlobPart[], { type: 'application/pdf' });
}

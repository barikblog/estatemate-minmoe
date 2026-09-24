import { describe, expect, it } from 'vitest';
import { imageToPdfBlob } from '../apps/web/src/pdf';

/** A real (1x1) JPEG so the embedded stream is genuine DCTDecode data. */
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

function jpegBytes(): Uint8Array {
  const binary = atob(TINY_JPEG_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function asText(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

describe('visitor pass PDF writer', () => {
  it('produces a structurally valid single-page PDF around the pass image', async () => {
    const jpeg = jpegBytes();
    const blob = imageToPdfBlob(jpeg, 900, 1300, 'Visitor pass 588662384335');
    expect(blob.type).toBe('application/pdf');

    const bytes = await blobBytes(blob);
    const text = asText(bytes);
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);

    // Every xref entry must point exactly at its object definition.
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)?.[1]);
    expect(Number.isInteger(startxref)).toBe(true);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');

    const entries = [...text.slice(startxref).matchAll(/^(\d{10}) (\d{5}) ([nf]) $/gm)];
    expect(entries).toHaveLength(7); // free entry plus objects 1..6
    entries.slice(1).forEach((entry, index) => {
      const id = index + 1;
      const offset = Number(entry[1]);
      expect(entry[3]).toBe('n');
      expect(text.slice(offset, offset + `${id} 0 obj`.length)).toBe(`${id} 0 obj`);
    });

    expect(text).toContain('<< /Type /Catalog /Pages 2 0 R >>');
    expect(text).toContain('/Type /Page /Parent 2 0 R');
    expect(text).toContain('/Size 7 /Root 1 0 R /Info 6 0 R');
    expect(text).toContain('/Title (Visitor pass 588662384335)');
    expect(text).toContain('/Im0 Do');
  });

  it('embeds the image as an untouched DCTDecode stream of the exact length', async () => {
    const jpeg = jpegBytes();
    const blob = imageToPdfBlob(jpeg, 900, 1300, 'Visitor pass');
    const bytes = await blobBytes(blob);
    const text = asText(bytes);

    const header = /\/Filter \/DCTDecode \/Length (\d+) >>\nstream\n/.exec(text);
    expect(header).not.toBeNull();
    expect(Number(header?.[1])).toBe(jpeg.byteLength);

    const streamStart = (header?.index ?? 0) + (header?.[0].length ?? 0);
    const embedded = bytes.slice(streamStart, streamStart + jpeg.byteLength);
    expect(Array.from(embedded)).toEqual(Array.from(jpeg));
    expect(asText(bytes.slice(streamStart, streamStart + 2))).toBe('\xff\xd8'); // JPEG start of image
  });

  it('fits the page inside A4 and escapes the title', async () => {
    const blob = imageToPdfBlob(jpegBytes(), 900, 1300, 'Pass (draft) \\ final');
    const text = asText(await blobBytes(blob));
    expect(text).toContain('/MediaBox [0 0 595.28 841.89]');
    expect(text).toContain('/Title (Pass \\(draft\\) \\\\ final)');

    const drawn = /q\n([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm/.exec(text);
    expect(drawn).not.toBeNull();
    expect(Number(drawn?.[1])).toBeLessThanOrEqual(595.28 - 48);
    expect(Number(drawn?.[2])).toBeLessThanOrEqual(841.89 - 48);
    expect(Number(drawn?.[3])).toBeGreaterThanOrEqual(24);
    expect(Number(drawn?.[4])).toBeGreaterThanOrEqual(24);
  });
});

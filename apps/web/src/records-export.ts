import { money, readableDate } from './api';
import { imageToPdfBlob } from './pdf';

export type Column = [string, string, ('date' | 'money')?];
export type Row = Record<string, unknown>;

function escapeXml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function exportRecordsToExcel(filename: string, sheetTitle: string, columns: Column[], rows: Row[]): void {
  const safeTitle = (sheetTitle || 'Records').replace(/[\\/?*[\]]/g, ' ').slice(0, 31);
  const rowsXml = rows.map((row) => {
    const cells = columns.map(([key, , format]) => {
      const val = row[key];
      if (format === 'money') {
        const num = Number(val ?? 0) / 100;
        return `<Cell ss:StyleID="Money"><Data ss:Type="Number">${num.toFixed(2)}</Data></Cell>`;
      }
      if (format === 'date') {
        return `<Cell ss:StyleID="Date"><Data ss:Type="String">${escapeXml(readableDate(val))}</Data></Cell>`;
      }
      return `<Cell ss:StyleID="Default"><Data ss:Type="String">${escapeXml(val ?? '')}</Data></Cell>`;
    }).join('');
    return `<Row>${cells}</Row>`;
  }).join('\n');

  const headersXml = `<Row ss:StyleID="Header">${columns.map((c) => `<Cell><Data ss:Type="String">${escapeXml(c[1])}</Data></Cell>`).join('')}</Row>`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="Header">
   <Font ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#1E3A8A" ss:Pattern="Solid"/>
   <Alignment ss:Horizontal="Left" ss:Vertical="Center"/>
  </Style>
  <Style ss:ID="Default">
   <Alignment ss:Vertical="Center"/>
  </Style>
  <Style ss:ID="Money">
   <NumberFormat ss:Format="#,##0.00"/>
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
  </Style>
  <Style ss:ID="Date">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="${escapeXml(safeTitle)}">
  <Table>
   ${headersXml}
   ${rowsXml}
  </Table>
 </Worksheet>
</Workbook>`;

  const blob = new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.xls') ? filename : `${filename}.xls`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export async function exportRecordsToPdf(filename: string, title: string, columns: Column[], rows: Row[]): Promise<void> {
  const canvas = document.createElement('canvas');
  const width = 1200;
  const colCount = Math.max(1, columns.length);
  const rowHeight = 32;
  const headerHeight = 40;
  const bannerHeight = 110;
  const footerHeight = 50;
  const maxRows = Math.min(rows.length, 60); // Clean single/two-page fit
  const contentHeight = bannerHeight + headerHeight + (maxRows * rowHeight) + footerHeight + 20;
  const height = Math.max(800, contentHeight);

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // Banner
  ctx.fillStyle = '#1E3A8A';
  ctx.fillRect(0, 0, width, 8);

  ctx.fillStyle = '#0F172A';
  ctx.font = 'bold 24px system-ui, -apple-system, sans-serif';
  ctx.fillText(title, 40, 50);

  ctx.fillStyle = '#64748B';
  ctx.font = '14px system-ui, -apple-system, sans-serif';
  ctx.fillText(`Generated: ${new Date().toLocaleString()}  •  Records: ${rows.length}${rows.length > maxRows ? ` (showing first ${maxRows})` : ''}`, 40, 80);

  // Table header
  const tableX = 40;
  const tableWidth = width - 80;
  const colWidth = tableWidth / colCount;
  let y = bannerHeight;

  ctx.fillStyle = '#F1F5F9';
  ctx.fillRect(tableX, y, tableWidth, headerHeight);
  ctx.strokeStyle = '#CBD5E1';
  ctx.lineWidth = 1;
  ctx.strokeRect(tableX, y, tableWidth, headerHeight);

  ctx.fillStyle = '#1E293B';
  ctx.font = 'bold 13px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'left';
  columns.forEach((col, i) => {
    const colX = tableX + (i * colWidth) + 10;
    ctx.fillText(col[1].toUpperCase(), colX, y + 25);
  });

  // Table rows
  y += headerHeight;
  ctx.font = '12px system-ui, -apple-system, sans-serif';
  for (let idx = 0; idx < maxRows; idx += 1) {
    const row = rows[idx]!;
    if (idx % 2 === 1) {
      ctx.fillStyle = '#F8FAFC';
      ctx.fillRect(tableX, y, tableWidth, rowHeight);
    }
    ctx.strokeStyle = '#E2E8F0';
    ctx.strokeRect(tableX, y, tableWidth, rowHeight);

    columns.forEach((col, cIdx) => {
      const [key, , format] = col;
      const colX = tableX + (cIdx * colWidth) + 10;
      let text = String(row[key] ?? '—');
      if (format === 'money') text = money(row[key]);
      else if (format === 'date') text = readableDate(row[key]);
      else if (typeof row[key] === 'boolean') text = row[key] ? 'Yes' : 'No';

      ctx.fillStyle = '#334155';
      const cellMax = colWidth - 20;
      let displayText = text;
      if (ctx.measureText(displayText).width > cellMax) {
        while (displayText.length > 3 && ctx.measureText(`${displayText}…`).width > cellMax) {
          displayText = displayText.slice(0, -1);
        }
        displayText = `${displayText}…`;
      }
      ctx.fillText(displayText, colX, y + 20);
    });
    y += rowHeight;
  }

  // Footer
  y += 25;
  ctx.fillStyle = '#64748B';
  ctx.font = 'bold 12px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Powered by sornix.com.ng (WhatsApp: +2348100065868)', width / 2, y + 15);

  const jpegBlob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92);
  });
  if (!jpegBlob) return;

  const arrayBuffer = await jpegBlob.arrayBuffer();
  const pdfBlob = imageToPdfBlob(new Uint8Array(arrayBuffer), width, height, title);
  const pdfUrl = URL.createObjectURL(pdfBlob);
  const link = document.createElement('a');
  link.href = pdfUrl;
  link.download = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(pdfUrl);
}

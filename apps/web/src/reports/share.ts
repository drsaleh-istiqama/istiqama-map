/**
 * Share a print view (project card, donor / country / summary report) as a PDF file.
 *
 * The document element is rendered to an image by the browser itself (`html-to-image`, SVG
 * foreignObject — Arabic shaping and RTL stay exactly as on screen) and cut into A4 pages by
 * `jspdf`. Both libraries are loaded on demand, so the app's start-up size does not change.
 *
 *  - Phones (Web Share API with files): the system share sheet opens with the PDF attached —
 *    WhatsApp, e-mail, Telegram, …
 *  - Elsewhere: the PDF is downloaded; the caller then offers WhatsApp / e-mail with a short
 *    message, and the user attaches the downloaded file.
 *
 * What is shared is what the page shows (salaries only if the user chose to include them).
 */

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled';

const A4_W_MM = 210;
const A4_H_MM = 297;
const MARGIN_MM = 8;
/** 210 mm at 96 dpi: the CSS width of an A4 page. */
const A4_PX = 794;

/** A file name safe on every system, keeping Arabic letters. */
export function pdfFileName(title: string): string {
  const base = title
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base || 'report'}.pdf`;
}

/** Renders `element` into an A4 PDF file (one image slice per page). */
export async function buildPdf(element: HTMLElement, fileName: string): Promise<File> {
  const [{ toCanvas }, { jsPDF }] = await Promise.all([import('html-to-image'), import('jspdf')]);
  if (typeof document !== 'undefined' && document.fonts) await document.fonts.ready;
  // Lay the document out at A4 width while it is captured (a phone shows it narrower, and
  // the PDF would be a cropped phone screen); the page gets its own style back afterwards.
  const previous = element.getAttribute('style');
  element.style.width = `${A4_PX}px`;
  element.style.maxWidth = 'none';
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  let canvas: HTMLCanvasElement;
  try {
    const width = Math.max(element.scrollWidth, A4_PX);
    const height = element.scrollHeight;
    canvas = await toCanvas(element, {
      pixelRatio: 2,
      backgroundColor: '#ffffff',
      width,
      height,
      // The page centres the document with auto margins and a shadow; the image must not.
      style: { margin: '0', boxShadow: 'none' },
    });
  } finally {
    if (previous === null) element.removeAttribute('style');
    else element.setAttribute('style', previous);
  }
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  const imgW = A4_W_MM - 2 * MARGIN_MM;
  const pxPerMm = canvas.width / imgW;
  const pageHpx = Math.max(1, Math.floor((A4_H_MM - 2 * MARGIN_MM) * pxPerMm));
  for (let y = 0, page = 0; y < canvas.height; y += pageHpx, page++) {
    const h = Math.min(pageHpx, canvas.height - y);
    const slice = document.createElement('canvas');
    slice.width = canvas.width;
    slice.height = h;
    const ctx = slice.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, slice.width, slice.height);
    ctx.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
    if (page > 0) pdf.addPage();
    pdf.addImage(
      slice.toDataURL('image/jpeg', 0.88),
      'JPEG',
      MARGIN_MM,
      MARGIN_MM,
      imgW,
      h / pxPerMm,
    );
  }
  return new File([pdf.output('blob')], fileName, { type: 'application/pdf' });
}

function download(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** True when this browser can hand a PDF file to the system share sheet. */
export function canShareFiles(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.canShare !== 'function') return false;
  try {
    const probe = new File(['%PDF'], 'probe.pdf', { type: 'application/pdf' });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/** Builds the PDF and shares it (share sheet) or downloads it. */
export async function sharePdf(
  element: HTMLElement,
  title: string,
  text: string,
): Promise<ShareOutcome> {
  const file = await buildPdf(element, pdfFileName(title));
  if (canShareFiles() && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text });
      return 'shared';
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') return 'cancelled';
      // Share refused (no user gesture left after a slow render, …): fall back to a download.
    }
  }
  download(file);
  return 'downloaded';
}

/** WhatsApp with a ready message (the user attaches the downloaded PDF). */
export function whatsappUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/** E-mail compose window with subject and message. */
export function mailUrl(subject: string, body: string): string {
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

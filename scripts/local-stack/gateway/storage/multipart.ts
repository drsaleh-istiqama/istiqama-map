/**
 * multipart/form-data parser for buffered bodies (browser uploads through storage-js are
 * FormData with the fields `cacheControl`, optional `metadata`, then the file part).
 * Large files should use TUS or a raw request body, both of which are streamed.
 */
export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

export function multipartBoundary(contentType: string | undefined): string | null {
  if (!contentType || !/^multipart\/form-data/i.test(contentType)) return null;
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

export function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const first = Buffer.from(`--${boundary}`);
  // Inside the body a delimiter always starts on a new line (RFC 2046 §5.1.1).
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const parts: MultipartPart[] = [];

  let pos = body.indexOf(first);
  if (pos < 0 || (pos > 0 && body.indexOf(delimiter) !== pos - 2)) {
    // tolerate a preamble, but the first delimiter must start a line
    pos = body.indexOf(delimiter);
    if (pos < 0) return parts;
    pos += 2;
  }
  let start = pos + first.length;
  for (;;) {
    // "--" right after the delimiter closes the body
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    else break; // malformed
    const next = body.indexOf(delimiter, start - 2);
    if (next < 0) break;
    const headerEnd = body.indexOf('\r\n\r\n', start - 2);
    if (headerEnd >= 0 && headerEnd <= next) {
      const headerText = body.subarray(start, Math.max(start, headerEnd)).toString('utf8');
      const data = body.subarray(Math.min(headerEnd + 4, next), next);
      const headers = new Map<string, string>();
      for (const line of headerText.split('\r\n')) {
        const i = line.indexOf(':');
        if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
      }
      const disposition = headers.get('content-disposition') ?? '';
      const name = /\bname="([^"]*)"/i.exec(disposition)?.[1] ?? '';
      const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
      const contentType = headers.get('content-type');
      parts.push({
        name,
        ...(filename !== undefined ? { filename } : {}),
        ...(contentType !== undefined ? { contentType } : {}),
        data,
      });
    }
    start = next + delimiter.length;
  }
  return parts;
}

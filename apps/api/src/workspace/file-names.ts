import { BadRequestException } from '@nestjs/common';

/** Multipart parsers may hand a UTF-8 file name over as Latin-1 ("Ghi chÃº"): read those bytes as UTF-8 again. */
function utf8Name(name: string): string {
  if (/[^\u0000-ÿ]/.test(name) || !/[\u0080-ÿ]/.test(name)) return name;
  const bytes = Buffer.from(name, 'latin1');
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : name;
}

/** A file name a person gave, made safe for any disk: no folders, no reserved characters, at most 120 characters. */
export function safeFileName(name: string): string {
  const base = utf8Name(name).split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  const out = cleaned.length > 120 ? cleaned.slice(cleaned.length - 120) : cleaned;
  if (!out || out === '.' || out === '..') throw new BadRequestException({ code: 'bad_name', message: 'Tên file không hợp lệ' });
  return out;
}

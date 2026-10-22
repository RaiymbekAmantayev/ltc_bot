/**
 * Нормализация телефона: берём последние 10 цифр.
 * Так +7 701 123-45-67, 8 (701) 123 45 67 и 7011234567 дают один ключ.
 * В одном поле может быть несколько номеров через ; , / или перенос строки.
 */
export function phoneKeys(raw) {
  if (!raw) return [];
  const keys = new Set();
  for (const part of String(raw).split(/[;,/\n]+/)) {
    const digits = part.replace(/\D/g, '');
    if (digits.length >= 10) keys.add(digits.slice(-10));
  }
  return [...keys];
}

export const phoneKey = (raw) => phoneKeys(raw)[0] ?? null;

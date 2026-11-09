/** 全角数字・記号を半角にし、区切り文字（ハイフン・空白など）を除く */
function compact(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[\s\-‐‑‒–—―ー−_.,]/g, "")
    .trim();
}

export type Identifier =
  | { kind: "corporate_number"; value: string }
  | { kind: "registration_number"; value: string };

/**
 * 法人番号（13桁）またはインボイス登録番号（T+13桁）を正規化して判別する。
 * 例: "T1-1803-0101-8771" → registration_number "T1180301018771"
 */
export function parseIdentifier(input: string): Identifier | null {
  const s = compact(input).toUpperCase();
  if (/^T\d{13}$/.test(s)) return { kind: "registration_number", value: s };
  if (/^\d{13}$/.test(s)) return { kind: "corporate_number", value: s };
  return null;
}

/** インボイス登録番号を正規化する。13桁の数字だけなら T を補う。 */
export function parseRegistrationNumber(input: string): string | null {
  const id = parseIdentifier(input);
  if (!id) return null;
  return id.kind === "registration_number" ? id.value : `T${id.value}`;
}

/** 日付を YYYY-MM-DD に正規化する（"2024/10/1" "2024年10月1日" も受け付ける） */
export function parseDate(input: string): string | null {
  const s = input.normalize("NFKC").trim();
  const m = s.match(/^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const t = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

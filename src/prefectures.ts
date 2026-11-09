/** JIS X 0401 都道府県コード → 都道府県名 */
export const PREFECTURES: Record<string, string> = {
  "01": "北海道", "02": "青森県", "03": "岩手県", "04": "宮城県", "05": "秋田県",
  "06": "山形県", "07": "福島県", "08": "茨城県", "09": "栃木県", "10": "群馬県",
  "11": "埼玉県", "12": "千葉県", "13": "東京都", "14": "神奈川県", "15": "新潟県",
  "16": "富山県", "17": "石川県", "18": "福井県", "19": "山梨県", "20": "長野県",
  "21": "岐阜県", "22": "静岡県", "23": "愛知県", "24": "三重県", "25": "滋賀県",
  "26": "京都府", "27": "大阪府", "28": "兵庫県", "29": "奈良県", "30": "和歌山県",
  "31": "鳥取県", "32": "島根県", "33": "岡山県", "34": "広島県", "35": "山口県",
  "36": "徳島県", "37": "香川県", "38": "愛媛県", "39": "高知県", "40": "福岡県",
  "41": "佐賀県", "42": "長崎県", "43": "熊本県", "44": "大分県", "45": "宮崎県",
  "46": "鹿児島県", "47": "沖縄県",
};

const ROMAJI: Record<string, string> = {
  hokkaido: "01", aomori: "02", iwate: "03", miyagi: "04", akita: "05", yamagata: "06",
  fukushima: "07", ibaraki: "08", tochigi: "09", gunma: "10", saitama: "11", chiba: "12",
  tokyo: "13", kanagawa: "14", niigata: "15", toyama: "16", ishikawa: "17", fukui: "18",
  yamanashi: "19", nagano: "20", gifu: "21", shizuoka: "22", aichi: "23", mie: "24",
  shiga: "25", kyoto: "26", osaka: "27", hyogo: "28", nara: "29", wakayama: "30",
  tottori: "31", shimane: "32", okayama: "33", hiroshima: "34", yamaguchi: "35",
  tokushima: "36", kagawa: "37", ehime: "38", kochi: "39", fukuoka: "40", saga: "41",
  nagasaki: "42", kumamoto: "43", oita: "44", miyazaki: "45", kagoshima: "46", okinawa: "47",
};

export function prefectureName(code: string | null | undefined): string | null {
  if (!code) return null;
  return PREFECTURES[code] ?? null;
}

/**
 * 「大阪」「大阪府」「27」「osaka」などを都道府県コードに変換する。
 * 解釈できなければ null。
 */
export function toPrefectureCode(input: string): string | null {
  const s = input.normalize("NFKC").trim();
  if (/^\d{1,2}$/.test(s)) {
    const code = s.padStart(2, "0");
    return PREFECTURES[code] ? code : null;
  }
  const lower = s.toLowerCase().replace(/[\s-]/g, "").replace(/(prefecture|ken|fu|to)$/, "");
  if (ROMAJI[lower]) return ROMAJI[lower];
  for (const [code, name] of Object.entries(PREFECTURES)) {
    if (s === name) return code;
    const stem = name === "北海道" ? name : name.replace(/[都府県]$/, "");
    if (s === stem) return code;
  }
  return null;
}

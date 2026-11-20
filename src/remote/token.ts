import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

// リモート版はDBを持たない。クライアント登録・認可コード・トークンはすべて
// サーバー秘密鍵で AES-256-GCM 暗号化した自己完結の文字列にする。
// 改ざんは GCM の認証タグで検出し、typ で用途の取り違え（認可コードをアクセストークンとして使う等）を防ぐ。

export type TokenType = "client" | "authreq" | "code" | "access" | "refresh" | "google";

export type Sealed<T> = T & { typ: TokenType; exp?: number };

const VERSION_PREFIX = "b1.";

export class TokenSealer {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (!secret || secret.length < 32) {
      throw new Error("MCP_TOKEN_SECRET は32文字以上にしてください。");
    }
    this.key = createHash("sha256").update(`bango-mcp-remote:${secret}`).digest();
  }

  seal<T extends Record<string, unknown>>(typ: TokenType, payload: T, ttlSeconds?: number, nowMs = Date.now()): string {
    const body: Sealed<T> = { ...payload, typ };
    if (ttlSeconds !== undefined) body.exp = Math.floor(nowMs / 1000) + ttlSeconds;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(typ));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return VERSION_PREFIX + Buffer.concat([iv, tag, encrypted]).toString("base64url");
  }

  /** 改ざん・期限切れ・用途違いはすべて null（理由を呼び出し側に漏らさない） */
  open<T extends Record<string, unknown>>(typ: TokenType, token: string | undefined | null, nowMs = Date.now()): Sealed<T> | null {
    if (!token || !token.startsWith(VERSION_PREFIX) || token.length > 8192) return null;
    let raw: Buffer;
    try {
      raw = Buffer.from(token.slice(VERSION_PREFIX.length), "base64url");
    } catch {
      return null;
    }
    if (raw.length < 12 + 16 + 1) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(typ));
      decipher.setAuthTag(raw.subarray(12, 28));
      const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
      const body = JSON.parse(json) as Sealed<T>;
      if (body.typ !== typ) return null;
      if (body.exp !== undefined && body.exp * 1000 <= nowMs) return null;
      return body;
    } catch {
      return null;
    }
  }
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * scripts/env-crypt.ts (Task 144 · P0) — SAO LƯU .env MÃ HOÁ cho repo
 *
 * BỐI CẢNH (#113 đã dỡ theo P0 docs/SECURITY.md): .env (plaintext secret)
 * KHÔNG còn được track trong git. Để giữ nguyên quyền năng "khôi phục tức thì
 * sau sandbox reset" (yêu cầu gốc của chủ sở hữu ở #113/a8adea4), file
 * .env được mã hoá AES-256-GCM thành .env.enc (an toàn để commit), giải mã
 * lại bằng passphrase chỉ chủ sở hữu giữ.
 *
 * Cách dùng:
 *   bun run scripts/env-crypt.ts encrypt [--force]   # .env → .env.enc
 *   bun run scripts/env-crypt.ts decrypt [--force]   # .env.enc → .env
 *   bun run scripts/env-crypt.ts verify              # so .env.enc ↔ .env
 *   bun run env:backup  /  bun run env:restore       # alias ở package.json
 *
 * Passphrase (ưu tiên theo thứ tự):
 *   1. --pass <cụm từ>          (lưu ý: --pass sẽ nằm trong shell history)
 *   2. env ENV_CRYPT_PASS       (dùng khi tự động hoá)
 *   3. file .env.passphrase     (gitignored — tạo bằng lệnh rekey dưới)
 *   4. gợi ý tạo mới: bun run scripts/env-crypt.ts rekey
 *
 * Crypto: scrypt N=2^14 · r=8 · p=1 (256-bit key từ passphrase) +
 * AES-256-GCM (IV 12 byte random, tag 16 byte — xác thực toàn vẹn).
 * Mỗi lần encrypt sinh salt + IV mới (không tái sử dụng nonce).
 * 0 dependency ngoài node:crypto — chạy được trên Bun & Node ≥ 18.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const ENC_PATH = join(ROOT, ".env.enc");
const PASS_PATH = join(ROOT, ".env.passphrase");
const MAGIC = "ENVCRYPT1";
const SCRYPT = { N: 1 << 14, r: 8, p: 1, keylen: 32 } as const;

type Mode = "encrypt" | "decrypt" | "verify" | "rekey";

function die(msg: string): never {
  console.error(`[env-crypt] LỖI: ${msg}`);
  process.exit(1);
}

function info(msg: string): void {
  console.log(`[env-crypt] ${msg}`);
}

/** Đọc passphrase theo thứ tự ưu tiên — không bao giờ log giá trị. */
function resolvePassphrase(needNew: boolean): string {
  const argvPass = (() => {
    const i = process.argv.indexOf("--pass");
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : "";
  })();
  if (argvPass) return argvPass;
  if (process.env.ENV_CRYPT_PASS) return process.env.ENV_CRYPT_PASS;
  if (existsSync(PASS_PATH)) {
    const pass = readFileSync(PASS_PATH, "utf8").trim();
    if (pass) return pass;
  }
  if (needNew) die("không tìm thấy passphrase (thiếu --pass / ENV_CRYPT_PASS / .env.passphrase)");
  return "";
}

/** Sinh passphrase ngẫu nhiên 32 ký tự dễ chép (không ký tự dễ nhầm 0O1lI). */
function newPassphrase(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(32);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function keyFrom(pass: string, salt: Buffer): Buffer {
  return scryptSync(pass, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
}

function encryptTo(plain: string, pass: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(pass, salt), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [MAGIC, salt.toString("base64"), iv.toString("base64"), ct.toString("base64"), tag.toString("base64")].join(".");
}

function decryptFrom(payload: string, pass: string): string {
  const parts = payload.trim().split(".");
  if (parts.length !== 5 || parts[0] !== MAGIC) {
    die(".env.enc sai định dạng (mong đợi ENVCRYPT1 · salt · iv · ct · tag)");
  }
  const [, saltB, ivB, ctB, tagB] = parts;
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(pass, Buffer.from(saltB, "base64")), Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]).toString("utf8");
  } catch {
    die("giải mã thất bại — SAI PASSPHRASE hoặc file .env.enc hỏng (GCM tag không khớp)");
  }
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function mode(): Mode {
  const m = process.argv[2] as Mode;
  if (m === "encrypt" || m === "decrypt" || m === "verify" || m === "rekey") return m;
  die(`thiếu lệnh (encrypt | decrypt | verify | rekey) — vd: bun run scripts/env-crypt.ts encrypt`);
}

function main(): void {
  const m = mode();

  if (m === "rekey") {
    const pass = newPassphrase();
    writeFileSync(PASS_PATH, pass + "\n", { mode: 0o600 });
    info(`đã sinh passphrase mới → .env.passphrase (chmod 600, gitignored)`);
    info("HÀNH ĐỘNG CẦN LÀM: lưu nội dung file này vào password manager NGAY —");
    info("nó là chìa khoá duy nhất giải mã .env.enc sau sandbox reset.");
    return;
  }

  if (m === "encrypt") {
    if (!existsSync(ENV_PATH)) die("không có .env để mã hoá");
    const pass = resolvePassphrase(true);
    const payload = encryptTo(readFileSync(ENV_PATH, "utf8"), pass);
    writeFileSync(ENC_PATH, `# ENVCRYPT v1 — aes-256-gcm(scrypt 2^14) · khôi phục: bun run env:restore\n${payload}\n`);
    info(`đã mã hoá .env → .env.enc (${payload.length} ký tự payload) — an toàn để commit`);
    return;
  }

  if (m === "decrypt") {
    if (!existsSync(ENC_PATH)) die("không có .env.enc để giải mã");
    if (existsSync(ENV_PATH) && !hasFlag("--force")) {
      die(".env đã tồn tại trên đĩa — thêm --force để ghi đè (cẩn thận khi .env chưa được backup)");
    }
    const pass = resolvePassphrase(true);
    const line = readFileSync(ENC_PATH, "utf8").split("\n").find((l) => l.startsWith(MAGIC));
    if (!line) die(".env.enc không chứa dòng payload ENVCRYPT1");
    const plain = decryptFrom(line, pass);
    writeFileSync(ENV_PATH, plain, { mode: 0o600 });
    info(`đã giải mã .env.enc → .env (${plain.length} ký tự, chmod 600)`);
    info("next: bun install (nếu mới clone) rồi bun run dev — cấu hình đã về chỗ cũ như #113");
    return;
  }

  // verify — so khớp .env.enc ↔ .env hiện có trên đĩa
  if (!existsSync(ENC_PATH) || !existsSync(ENV_PATH)) {
    die("cần cả .env và .env.enc cùng tồn tại để verify");
  }
  const passV = resolvePassphrase(true);
  const lineV = readFileSync(ENC_PATH, "utf8").split("\n").find((l) => l.startsWith(MAGIC));
  if (!lineV) die(".env.enc không chứa dòng payload ENVCRYPT1");
  const diskBuf = Buffer.from(readFileSync(ENV_PATH, "utf8"));
  const plainBuf = Buffer.from(decryptFrom(lineV, passV));
  const same = diskBuf.length === plainBuf.length && timingSafeEqual(diskBuf, plainBuf);
  if (same) info("PASS — .env.enc giải mã ra đúng .env trên đĩa (byte-identical)");
  else die("FAIL — .env.enc và .env trên đĩa KHÁC nhau — chạy lại: bun run env:backup");
}

main();

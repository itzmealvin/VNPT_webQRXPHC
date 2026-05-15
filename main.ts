import type { Context } from "hono";
import { Hono } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { logger } from "hono/logger";

const app = new Hono();

const config = {
  port: Number(Bun.env.PORT || 3000),
  maxUploadBytes: Number(Bun.env.MAX_UPLOAD_BYTES || 20 * 1024 * 1024),
  rateLimit: {
    requests: Number(Bun.env.RATE_LIMIT_REQUESTS || 60),
    windowMs: Number(Bun.env.RATE_LIMIT_WINDOW_MS || 60 * 1_000),
  },
};

const ENV_VARS = [
  "VNPT_TOKEN_ID",
  "VNPT_TOKEN_KEY",
  "VNPT_USERNAME",
  "VNPT_PASSWORD",
] as const;
for (const varName of ENV_VARS) {
  if (!Bun.env[varName]) {
    throw new Error(`Environment variable ${varName} is not set.`);
  }
}

const BASE_URL = "https://api.idg.vnpt.vn";
const LOGIN_URL = `${BASE_URL}/auth/oauth/token`;
const FILE_URL = `${BASE_URL}/file-service/v1/addFile`;
const SCAN_URL = `${BASE_URL}/rpa-service/aidigdoc/v1/ocr/scan`;

async function getFileFromRequest(c: Context) {
  const body = await c.req.formData();
  const file = body.get("file");
  if (!(file instanceof File)) {
    return {
      errorResponse: c.json({ error: "Thiếu trường tệp trong form-data" }, 400),
    };
  }

  if (file.size > config.maxUploadBytes) {
    return { errorResponse: c.json({ error: "Tệp tin quá lớn" }, 413) };
  }

  return { file };
}

async function getAccessToken() {
  const loginPayload = {
    client_id: "clientapp",
    client_secret: "password",
    username: Bun.env.VNPT_USERNAME,
    password: Bun.env.VNPT_PASSWORD,
    grant_type: "password",
  };

  const response = await fetch(LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(loginPayload),
  });
  if (!response.ok) {
    throw new Error(`Login thất bại: ${response.status}`);
  }

  const json = (await response.json()) as { access_token: string };
  const accessToken = json.access_token;
  if (!accessToken)
    throw new Error("Không nhận được access_token từ LOGIN_URL");
  return String(accessToken);
}

async function uploadFileToFileUrl(file: File, accessToken: string) {
  const formData = new FormData();
  formData.append("file", file, file.name);
  formData.append("title", "");
  formData.append("description", "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };
  if (Bun.env.VNPT_TOKEN_ID) headers["Token-id"] = Bun.env.VNPT_TOKEN_ID;
  if (Bun.env.VNPT_TOKEN_KEY) headers["Token-key"] = Bun.env.VNPT_TOKEN_KEY;

  const response = await fetch(FILE_URL, {
    method: "POST",
    headers,
    body: formData,
  });
  if (!response.ok) {
    throw new Error(`Upload FILE_URL thất bại: ${response.status}`);
  }

  return response.json();
}

async function scanFile(scanPayload: unknown, accessToken: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  if (Bun.env.VNPT_TOKEN_ID) headers["Token-id"] = Bun.env.VNPT_TOKEN_ID;
  if (Bun.env.VNPT_TOKEN_KEY) headers["Token-key"] = Bun.env.VNPT_TOKEN_KEY;

  const response = await fetch(SCAN_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(scanPayload),
  });
  if (!response.ok) {
    throw new Error(`SCAN_URL thất bại: ${response.status}`);
  }
  return response.json();
}

function extractFieldsFromText(text: string) {
  const normalized = text
    .replace(/\r/g, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  const cleanCapture = (value: string) =>
    value.replace(/^[\s:;,\-._]+|[\s:;,\-._]+$/g, "").trim();

  const soQDMatch =
    normalized.match(
      /\b(?:s[o0]|so\s*quyet\s*dinh|quyet\s*dinh)\s*[:;\-]?\s*([a-z0-9./-]{1,80})\s*\/\s*q[d0o]\s*-?\s*xphc\b/i,
    ) || normalized.match(/\b([a-z0-9./-]{1,80})\s*\/\s*q[d0o]\s*-?\s*xphc\b/i);

  const soQDPrefix = soQDMatch?.[1] ?? "";
  const soQD = soQDPrefix
    ? `${cleanCapture(soQDPrefix)}/QD-XPHC`.replace(/\s+/g, "").toUpperCase()
    : "";

  const amountMatch =
    normalized.match(
      /\b(?:cu\s*the|so\s*tien|muc\s*phat|phat\s*tien)\s*(?:la)?\s*[:;\-]?\s*([\d.,\s]{3,})\s*(?:d[o0]ng|vnd)\b/i,
    ) || normalized.match(/\b([\d]{1,3}(?:[.,\s]\d{3})+)\s*(?:d[o0]ng|vnd)\b/i);

  const soTienRaw = amountMatch?.[1] || "";

  return {
    soQD,
    soTien: normalizeAmount(soTienRaw),
  };
}

function normalizeAmount(value: string) {
  return (value || "").replace(/[^\d]/g, "");
}

async function handleExtract(c: Context) {
  try {
    const { file, errorResponse } = await getFileFromRequest(c);
    if (errorResponse) return errorResponse;

    const accessToken = await getAccessToken();
    const uploaded = (await uploadFileToFileUrl(file, accessToken)) as {
      object: { hash: string; fileType: string };
    };
    const scanPayload = {
      file_hash: uploaded.object.hash,
      file_type: uploaded.object.fileType,
      details: false,
      token: "",
      client_session: "",
    };
    const scanned = (await scanFile(scanPayload, accessToken)) as {
      object: { paragraphs: Array<string[]> };
    };

    const fields = extractFieldsFromText(
      scanned.object.paragraphs.flatMap((p) => p.join(" ")).join("\n"),
    );

    return c.json({ fields });
  } catch (error) {
    console.error("OCR extract failed:", error);
    return c.json({ error: "Trích xuất OCR thất bại" }, 500);
  }
}

app.use("*", logger());

app.get("/api/health", (c) =>
  c.json({ status: "OK", uptime: Math.round(process.uptime()) }),
);

app.post(
  "/api/extract",
  rateLimiter({
    windowMs: config.rateLimit.windowMs,
    limit: config.rateLimit.requests,
    keyGenerator: (c) => c.req.header("x-forwarded-for") ?? "",
  }),
  bodyLimit({
    maxSize: config.maxUploadBytes,
    onError: (c) => c.json({ error: "Tệp tin quá lớn" }, 413),
  }),
  handleExtract,
);

app.use("/*", serveStatic({ root: "./" }));
app.get("*", serveStatic({ path: "./index.html" }));

export default app;
export const port = config.port;
